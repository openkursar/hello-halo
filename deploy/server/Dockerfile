# Halo Server: the headless Linux build of Halo (HALO_SERVER_MODE=1), serving
# the full UI and the HTTP/WebSocket API on one port.
#
# Build the app bundle from the repository root first:
#   npm ci
#   npm run build:server        # writes bundle/halo-bundle.tgz.part-* here
# then build the image from this directory:
#   docker build -t halo-server deploy/server
#
# Building the image needs network access for the base image and the packages below.
# The base is pinned to Debian 12: newer Debian releases renamed several of these packages.
FROM python:3.12-slim-bookworm

# Libraries Electron/Chromium links against even when headless, fonts so web
# pages render text (CJK included), and tini to reap the agent's child processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git tini \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
      libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
      fonts-dejavu-core fonts-wqy-microhei \
 && rm -rf /var/lib/apt/lists/*

COPY bundle/ /tmp/halo-bundle/
RUN mkdir -p /app \
 && cat /tmp/halo-bundle/halo-bundle.tgz.part-* | tar xz -C /app \
 && rm -rf /tmp/halo-bundle \
 && test -x /app/linux-unpacked/halo

COPY docker-entrypoint.sh /usr/local/bin/halo-entrypoint
RUN chmod +x /usr/local/bin/halo-entrypoint

# HOME=/tmp keeps every write under /tmp unless HALO_DATA_DIR points at a mounted
# volume, so the image also starts on platforms with a read-only root filesystem.
ENV HALO_SERVER_MODE=1 \
    PORT=8080 \
    HOME=/tmp

EXPOSE 8080
ENTRYPOINT ["tini", "--", "halo-entrypoint"]
