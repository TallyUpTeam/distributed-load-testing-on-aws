# Description

ECS container source that uses the [`k6` load testing framework](https://grafana.com/docs/k6/latest/) running a Typescript application to mimic a simple client 'bot' in each `k6` VU (virtual user). The client code exercises the TallyUp API in a semi-random fashion, simulating user actions.

## Components/Architecture
See [parent project README](../../README.md) for CloudFormation archicture, although some of the details have changed in our `tallyup-master` branch of this repo. We no longer use `blazemeter`, `Taurus`, or `bzt`, instead basing this containter code on a `grafana/xk6` Dockerhub image built on top of an Alpine Linux distro.

## Data Flows

Logging output during the k6 run is uploaded to CloudWatch because the ECS containers use the `awslogs` log driver. The CloudWatch dashboard displays a real-time metric derived from this log output using a CloudWatch metric filter defined by the CloudFormation stack.

When `k6` finishes, it writes its own metric output to a JSON result file, which the container uploads to S3 before terminating. This uploaded JSON file is parsed by a Lambda function and written into DynamoDB to be displayed by the dashboard.

## Results

## Testing Locally

This folder is technically a Node.js project with the following scripts defined in its `package.json` file (run these commands using `yarn <command>`):

- `build`  
Uses `Webpack` to transpile the Typescript source files into the `./dist` folder.

- `build:docker`  
First performs a build into `./dist` and then executes a `docker build` command to build a Docker image locally

- `start`  
First performs a build into `./dist` and then launches `k6` on the local machine

- `start:docker`  
First builds the image and then executes a `docker run` command to launch a container running that image locally. In addition to testing the VU scripts, this is useful to test the Dockerfile and the data flows associated with downloading a config before a test run and uploading results after the run completes. Before launching the container, the current `./config.json` file is uploaded to an S3 bucket the same way the console web application uploads a generated config for a test 'scenario'. The container's `load-test.sh` entrypoint will then download this file before running `k6`.

## Building

The entire application (console web app, CloudFormation infrastructure stack, lambda functions, database, S3 buckets, etc., not just this container source) is built using the `../../deployment/build-s3-dist.sh` bash script.

One of its actions is to first build and then upload the contents of this folder as a zip file to an S3 bucket. A CodeBuild pipeline then creates a Docker image from the uploaded zip file and stores it in an ECR repository ready to be used by ECS when launching new Fargate task instances.

After running `build-s3-dist.sh` in the `../../deployment` folder, upload the generated CloudFormation template file, `../../deployment/global-s3-assets/distributed-load-testing-on-aws.template`, to the CloudFormation console in AWS and run it to create or update the AWS infrastructure stack for the application. This will need to be done after also making any changes to the React dashboard application in `../console/src`.

## Running

## Cheat Sheet

Run a shell in an image container, overriding the defined entrypoint:

    docker run -it --entrypoint /bin/sh grafana/xk6
