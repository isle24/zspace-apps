# syntax=docker/dockerfile:1.7
# Central catalog API + administrator UI, built from repository source.
FROM --platform=$BUILDPLATFORM node:26-alpine AS web-build
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/client/package.json ./apps/client/package.json
COPY apps/store/package.json ./apps/store/package.json
COPY apps/catalog-admin/package.json ./apps/catalog-admin/package.json
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"
RUN --mount=type=cache,id=space-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @space/catalog-admin --filter @space/store
COPY apps/store ./apps/store
COPY apps/catalog-admin ./apps/catalog-admin
RUN pnpm --filter @space/catalog-admin build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS go-build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/space-gateway ./cmd/space-gateway

FROM alpine:3.23
RUN apk add --no-cache ca-certificates su-exec \
    && addgroup -g 10001 space && adduser -D -H -u 10001 -G space space \
    && mkdir /data && chown space:space /data && chmod 0700 /data
COPY --from=go-build --chmod=0555 /out/space-gateway /usr/local/bin/space-gateway
COPY --from=web-build /src/apps/catalog-admin/dist /web
COPY --chmod=0555 docker/catalog/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=0555 docker/catalog/setup-admin.sh /usr/local/bin/setup-admin
# Read the host's 0600 Compose secret, then entrypoint drops to UID 10001.
EXPOSE 18442
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:18442/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
