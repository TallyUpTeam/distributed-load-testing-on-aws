#!/bin/bash

# Build the docker image
docker build -t load-test:latest .

# Get the newest bucket created by running the distributed-load-testing-on-aws CloudFormation template
S3_BUCKET=$(aws s3api list-buckets --output json --query 'max_by(Buckets[?starts_with(Name, `loadtesting-scenariosbucket`)], &CreationDate).Name' | tr -d '"')

# If no bucket, create a temp one
if [[ -z "${S3_BUCKET}" ]]; then
    S3_BUCKET=loadtesting-scenariosbucket
    aws s3 mb s3://${S3_BUCKET}
fi

# Upload the config file for our local test run's 'scenario'
TEST_ID=$(date | md5 -r | head -c 9)
aws s3 cp config.json s3://${S3_BUCKET}/test-scenarios/${TEST_ID}.json

# Run the docker image container with the same environment as our ECS task definition would provide
TASK_INDEX=0
AWS_ACCESS_KEY_ID=$(aws --profile default configure get aws_access_key_id)
AWS_SECRET_ACCESS_KEY=$(aws --profile default configure get aws_secret_access_key)
docker run -it \
    --env S3_BUCKET=${S3_BUCKET} \
    --env TEST_ID=${TEST_ID} \
    --env TASK_INDEX=${TASK_INDEX} \
    --env AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID} \
    --env AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY} \
    load-test:latest
