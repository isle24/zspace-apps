#!/bin/sh
set -eu
mkdir -p /data && chmod 700 /data
store_endpoint="${SPACE_STORE_ENDPOINT:-}"
if [ -z "$store_endpoint" ] && [ -f /data/client-store-endpoint ]; then
  store_endpoint="$(cat /data/client-store-endpoint)"
fi
if [ -z "$store_endpoint" ]; then
  space-gateway --listen=127.0.0.1:18435 --data-dir=/data --web-root=/web --engine=disabled &
  store_endpoint=http://127.0.0.1:18435
fi
exec space-proxy --listen=0.0.0.0:18436 --web=/web --nas="${NAS_ORIGIN:?需要设置 NAS_ORIGIN}" --store="$store_endpoint"
