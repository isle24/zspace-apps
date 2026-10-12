#!/bin/sh
set -eu
umask 077
if [ -z "${SPACE_CLOUD_DATABASE_URL:-}" ]; then
  task_secret="${SPACE_DB_PASSWORD_FILE:-/run/secrets/postgres_password}"
  [ -r "$task_secret" ] || { echo 'PostgreSQL password secret is unavailable' >&2; exit 1; }
  # File-backed Compose secrets keep their host UID/GID. With cap_drop=ALL,
  # container root cannot read an ordinary host user's 0600 file directly.
  task_secret_owner="$(stat -c '%u:%g' "$task_secret")"
  task_password="$(su-exec "$task_secret_owner" cat "$task_secret")"
  # Keyword DSNs need single quotes and backslashes escaped, never logged.
  task_password="$(printf '%s' "$task_password" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")"
  export SPACE_CLOUD_DATABASE_URL="host=${SPACE_DB_HOST:-postgres} port=5432 user=${SPACE_DB_USER:-zstore} dbname=${SPACE_DB_NAME:-zstore} sslmode=disable password='$task_password'"
  unset task_password
fi
: "${SPACE_PUBLIC_ORIGIN:?Set SPACE_PUBLIC_ORIGIN to the public HTTP(S) origin}"
export SPACE_ADMIN_2FA_REQUIRED="${SPACE_ADMIN_2FA_REQUIRED:-1}"
exec su-exec space:space space-gateway --listen=0.0.0.0:18442 --data-dir=/data --web-root=/web \
  --engine=disabled --catalog-only --api-only --public-origin="$SPACE_PUBLIC_ORIGIN"
