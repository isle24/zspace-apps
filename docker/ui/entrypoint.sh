#!/bin/sh
set -eu
umask 077
: "${NAS_ORIGIN:?Set the fixed canonical NAS_ORIGIN, for example http://192.168.3.56:5055}"
task_gateway_pid=
task_proxy_pid=
task_endpoint="${SPACE_STORE_ENDPOINT:-}"
# Preserve the triggering exit status while stopping only our own children.
task_stop() {
  task_exit_status=$?
  trap - TERM INT EXIT
  [ -z "$task_proxy_pid" ] || kill -TERM "$task_proxy_pid" 2>/dev/null || true
  [ -z "$task_gateway_pid" ] || kill -TERM "$task_gateway_pid" 2>/dev/null || true
  [ -z "$task_proxy_pid" ] || wait "$task_proxy_pid" 2>/dev/null || true
  [ -z "$task_gateway_pid" ] || wait "$task_gateway_pid" 2>/dev/null || true
  exit "$task_exit_status"
}
trap task_stop EXIT
trap 'exit 0' TERM
trap 'exit 130' INT
# Existing installations may persist the explicitly selected controller.
if [ -z "$task_endpoint" ] && [ -f /data/client-store-endpoint ]; then
  task_endpoint="$(cat /data/client-store-endpoint)"
fi
if [ -z "$task_endpoint" ]; then
  : "${UI_PUBLIC_ORIGIN:?Set the browser-visible UI HTTP(S) origin for same-origin NAS identity}"
  # The UI's fallback has no installation engine or host filesystem access.
  space-gateway --listen=127.0.0.1:18435 --data-dir=/data --web-root=/web \
    --engine=disabled --nas-origin="$UI_PUBLIC_ORIGIN" --nas-admin-only \
    --public-origin="$UI_PUBLIC_ORIGIN" &
  task_gateway_pid=$!
  task_endpoint=http://127.0.0.1:18435
fi
space-proxy --listen=0.0.0.0:18436 --web=/web --nas="$NAS_ORIGIN" --store="$task_endpoint" &
task_proxy_pid=$!
# POSIX sh has no portable wait -n. Poll the two owned children, then use wait
# to recover the exited child's status. Unexpected daemon exit 0 is a failure.
if [ -z "$task_gateway_pid" ]; then
  task_status=0
  wait "$task_proxy_pid" || task_status=$?
  task_proxy_pid=
  [ "$task_status" -ne 0 ] || task_status=1
  exit "$task_status"
fi
while :; do
  if ! kill -0 "$task_proxy_pid" 2>/dev/null; then
    task_status=0
    wait "$task_proxy_pid" || task_status=$?
    task_proxy_pid=
    [ "$task_status" -ne 0 ] || task_status=1
    exit "$task_status"
  fi
  if ! kill -0 "$task_gateway_pid" 2>/dev/null; then
    task_status=0
    wait "$task_gateway_pid" || task_status=$?
    task_gateway_pid=
    [ "$task_status" -ne 0 ] || task_status=1
    exit "$task_status"
  fi
  sleep 1
done
