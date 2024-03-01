FROM grafana/xk6:latest

USER root

# Customize the k6 binary with additional extension modules
RUN GCO_ENABLED=0 xk6 build \
    --output /k6-tests/k6 \
    --with github.com/LeonAdato/xk6-output-statsd@latest \
    --with github.com/szkiba/xk6-yaml@latest

# Install python3, pip, and awscli
RUN apk --no-cache add \
    python3 \
    python3-dev \
    py3-pip \
    build-base \
  && pip3 install --no-cache-dir awscli

ADD ./load-test.sh ./defaults.json /k6-tests/
RUN chmod 755 /k6-tests/load-test.sh
ADD ./dist/* /k6-tests/dist/

WORKDIR /k6-tests

ENTRYPOINT ["sh", "-c", "/k6-tests/load-test.sh"]
