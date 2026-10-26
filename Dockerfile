# syntax=docker/dockerfile:1.7
# Redis Console — production image.
#  - multi-stage: dev dependencies and build tooling never reach the final image
#  - final image: node:24-slim, runs as the unprivileged `node` user (uid 1000)
#  - read-only root filesystem friendly: the only writable path is /data (SQLite sessions/users/audit)
#  - the server serves the built SPA (apps/web/dist) from the same origin
#  - no npm / corepack / pnpm in the final image
# Pin the base image by digest in your registry mirror for reproducible builds.
ARG NODE_IMAGE=node:24-slim
ARG PNPM_VERSION=11.7.0

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /src

# ---------------------------------------------------------------------------
# Full install (dev deps included) to build the SPA. The SPA is static files, so this stage runs on the build
# machine's own platform: a multi-arch build does not emulate Vite.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @rconsole/web... --filter @rconsole/server...
COPY tsconfig.base.json THIRD-PARTY-NOTICES ./
# vite.config.ts takes its dev ports from here (and emits THIRD-PARTY-NOTICES into dist).
COPY scripts/dev-ports.ts scripts/
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server
RUN pnpm --filter @rconsole/web build \
 && test -f apps/web/dist/index.html \
 && test -f apps/web/dist/THIRD-PARTY-NOTICES.txt \
 && find apps/web/dist -name '*.map' -delete

# ---------------------------------------------------------------------------
# Production dependencies of the server only (keeps the workspace layout so
# @rconsole/shared resolves through a relative symlink, outside node_modules,
# which Node's native type stripping requires).
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @rconsole/server...

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# Remove package managers from the runtime image (not needed, smaller attack surface).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn* /opt/yarn* \
 && mkdir -p /data /etc/rconsole && chown node:node /data
WORKDIR /app
COPY --from=prod-deps --chown=root:root /src/node_modules ./node_modules
COPY --from=prod-deps --chown=root:root /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps --chown=root:root /src/packages/shared/node_modules ./packages/shared/node_modules
# Licence and notices of Redis Console and of everything it redistributes (also served as /THIRD-PARTY-NOTICES.txt).
COPY --chown=root:root LICENSE NOTICE THIRD-PARTY-NOTICES ./
COPY --chown=root:root package.json ./
COPY --chown=root:root packages/shared/package.json packages/shared/
COPY --chown=root:root packages/shared/src packages/shared/src
COPY --chown=root:root apps/server/package.json apps/server/
COPY --chown=root:root apps/server/src apps/server/src
COPY --from=build --chown=root:root /src/apps/web/dist apps/web/dist

ENV NODE_ENV=production \
    RCONSOLE_CONFIG=/etc/rconsole/config.json \
    RCONSOLE_DATA_DIR=/data \
    NODE_OPTIONS="--disable-proto=throw --max-old-space-size=512"
USER node
EXPOSE 4000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.RCONSOLE_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "apps/server/src/main.ts"]
