# 小爱小爱 relay. Node runs the TypeScript directly; the image adds production deps only.
#   docker build -t xiaoaixiaoai-relay .
#   docker run -d -p 7420:7420 -v xiaoaixiaoai-data:/data xiaoaixiaoai-relay
# deploy/docker/compose.yml runs it with HTTPS (Caddy) or a Cloudflare Tunnel.
# Any Node >= 22.18 image with a `node` user (uid 1000) works as the base (--build-arg NODE_IMAGE=...).
ARG NODE_IMAGE=node:24-alpine

# The dependencies are plain JavaScript: install them once on the build machine's platform and
# copy them into every target platform, so multi-arch builds need no emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE NOTICE.md ./
# The pnpm version pinned in package.json ("packageManager"), unless the base image has pnpm.
RUN command -v pnpm >/dev/null 2>&1 || npm install -g --no-fund --no-audit "$(node -p 'require("./package.json").packageManager')"
COPY packages packages
COPY apps/relay apps/relay
RUN --mount=type=cache,id=xiaoaixiaoai-pnpm,target=/pnpm-store \
    pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /pnpm-store --filter "@xiaoaixiaoai/relay..." \
 && rm -rf apps/relay/test packages/*/test \
 && mkdir -p /out /data \
 && printf '#!/bin/sh\nexec node --no-warnings /app/apps/relay/src/container.ts "$@"\n' > /out/xiaoaixiaoai-relay \
 && chmod 755 /out/xiaoaixiaoai-relay

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.title="XiaoAiXiaoAi relay"
ENV NODE_ENV=production \
    POCKET_HOST=0.0.0.0 \
    POCKET_PORT=7420 \
    POCKET_DB=/data/relay.db \
    XIAOAIXIAOAI_INSTALL=docker
WORKDIR /app
# Code stays owned by root and read-only for the relay; only /data is writable.
COPY --from=build /app /app
COPY --from=build /out/xiaoaixiaoai-relay /usr/local/bin/xiaoaixiaoai-relay
COPY --from=build --chown=1000:1000 /data /data
VOLUME /data
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.POCKET_PORT||7420)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The relay runs as `node` (uid 1000): src/container.ts gives it /data, then drops root before
# any relay code runs, so root-owned platform volumes work too. `--user 1000` works as well.
CMD ["node", "--no-warnings", "apps/relay/src/container.ts"]
