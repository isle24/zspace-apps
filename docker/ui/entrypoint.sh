#!/bin/sh
set -eu
umask 077
: "${NAS_ORIGIN:?Set the fixed canonical NAS_ORIGIN, for example http://192.168.3.56:5055}"
task_gateway_pid=
task_proxy_pid=
task_endpoint="${SPACE_STORE_ENDPOINT:-}"
# Existing installations may persist the explicitly selected controller.
if [ -z "$task_endpoint" ] && [ -f /data/client-store-endpoint ]; then
  task_endpoint="$(cat /data/client-store-endpoint)"
fi
if [ -z "$task_endpoint" ]; then
  # The UI's fallback has no installation engine or host filesystem access.
  space-gateway --listen=127.0.0.1:18435 --data-dir=/data --web-root=/web \
    --engine=disabled --nas-origin="$NAS_ORIGIN" --nas-admin-only &
  task_gateway_pid=$!
  task_endpoint=http://127.0.0.1:18435
fi
task_stop() {
  trap - TERM INT EXIT
  [ -z "$task_proxy_pid" ] || kill -TERM "$task_proxy_pid" 2>/dev/null || true
  [ -z "$task_gateway_pid" ] || kill -TERM "$task_gateway_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap task_stop TERM INT EXIT
space-proxy --listen=0.0.0.0:18436 --web=/web --nas="$NAS_ORIGIN" --store="$task_endpoint" &
task_proxy_pid=$!
task_status=0
wait "$task_proxy_pid" || task_status=$?
exit "$task_status"
