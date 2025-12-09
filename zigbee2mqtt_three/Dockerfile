ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.19
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nginx

COPY rootfs /
RUN chmod a+x /entrypoint.sh

EXPOSE 8101

ENTRYPOINT ["/entrypoint.sh"]
