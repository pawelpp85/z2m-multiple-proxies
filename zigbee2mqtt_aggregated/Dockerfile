ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.19
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY rootfs/app/package.json /app/package.json
RUN npm install --omit=dev

COPY rootfs /
RUN chmod a+x /entrypoint.sh

EXPOSE 8102

ENTRYPOINT ["/entrypoint.sh"]
