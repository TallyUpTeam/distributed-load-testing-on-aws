FROM loadimpact/k6

USER root

# Install python3, pip, and awscli
RUN apk --no-cache add \
    python3 \
    python3-dev \
    py3-pip \
    build-base \
  && pip3 install --no-cache-dir awscli

ADD ./load-test.sh defaults.json /k6-tests/
RUN chmod 755 /k6-tests/load-test.sh
ADD ./dist/* /k6-tests/dist/

ENTRYPOINT ["sh", "-c", "/k6-tests/load-test.sh"]
