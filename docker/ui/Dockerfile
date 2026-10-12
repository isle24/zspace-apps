# syntax=docker/dockerfile:1.7
# Build from repository source: docker build -f docker/ui/Dockerfile .
FROM --platform=$BUILDPLATFORM node:26-alpine AS web-build
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/client/package.json ./apps/client/package.json
COPY apps/store/package.json ./apps/store/package.json
COPY apps/catalog-admin/package.json ./apps/catalog-admin/package.json
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"
RUN --mount=type=cache,id=space-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @space/client --filter @space/store
COPY apps/client ./apps/client
COPY apps/store ./apps/store
COPY scripts/assemble-ui-web.mjs ./scripts/assemble-ui-web.mjs
RUN pnpm --filter @space/client build && pnpm --filter @space/store build \
    && node scripts/assemble-ui-web.mjs /web

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS go-build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/space-gateway ./cmd/space-gateway
WORKDIR /src/proxy
COPY deploy/nas-appstore/proxy/go.mod deploy/nas-appstore/proxy/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY deploy/nas-appstore/proxy ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/space-proxy .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates \
    && addgroup -g 10001 space && adduser -D -H -u 10001 -G space space \
    && mkdir /data && chown space:space /data && chmod 0700 /data
COPY --from=go-build --chmod=0555 /out/space-gateway /out/space-proxy /usr/local/bin/
COPY --from=web-build /web /web
COPY --chmod=0555 docker/ui/entrypoint.sh /usr/local/bin/entrypoint.sh
USER 10001:10001
EXPOSE 18436
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:18436/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
