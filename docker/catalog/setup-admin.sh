#!/bin/sh
set -eu
umask 077
set +x
export LC_ALL=C
task_pid=
cleanup() {
  task_status=$?
  trap - EXIT INT TERM
  unset task_password task_confirm
  [ -z "$task_pid" ] || kill -TERM "$task_pid" 2>/dev/null || true
  [ -z "$task_pid" ] || wait "$task_pid" 2>/dev/null || true
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { printf '%s\n' "$*" >&2; exit 1; }
json_escape() {
  printf '%s' "$1" | awk '
    BEGIN { for (i=1;i<32;i++) control[sprintf("%c",i)]=sprintf("\\u%04x",i) }
    { if(NR>1) printf "\\n"; for(i=1;i<=length($0);i++) {
      c=substr($0,i,1); if(c=="\\") printf "\\\\"; else if(c=="\"") printf "\\\"";
      else if(c in control) printf "%s",control[c]; else printf "%s",c;
    } }
  '
}
space-gateway --listen=127.0.0.1:18542 --data-dir=/data --engine=disabled >/dev/null 2>&1 &
task_pid=$!
task_wait=0
until wget -qO- http://127.0.0.1:18542/api/health >/dev/null 2>&1; do
  kill -0 "$task_pid" 2>/dev/null || fail 'Cannot acquire catalog metadata; stop catalog before setup.'
  task_wait=$((task_wait+1))
  [ "$task_wait" -lt 30 ] || fail 'Setup gateway health check timed out.'
  sleep 1
done
task_state="$(wget -qO- http://127.0.0.1:18542/api/store/bootstrap)"
case "$task_state" in
  *'"configured":true'*) printf 'Administrator already configured; original credentials preserved.\n'; exit 0 ;;
  *'"configured":false'*) ;;
  *) fail 'Cannot verify administrator setup state.' ;;
esac
printf 'Administrator username: ' >&2
IFS= read -r task_username || fail 'Username was not supplied.'
case "$task_username" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_-]*) fail 'Invalid username.' ;; esac
[ "${#task_username}" -le 64 ] || fail 'Username is too long.'
printf 'Administrator password (12-72 bytes): ' >&2
IFS= read -r -s task_password || fail 'Password was not supplied.'
printf '\nConfirm password: ' >&2
IFS= read -r -s task_confirm || fail 'Confirmation was not supplied.'
printf '\n' >&2
[ "$task_password" = "$task_confirm" ] || fail 'Passwords do not match; setup was not submitted.'
[ "${#task_password}" -ge 12 ] && [ "${#task_password}" -le 72 ] || fail 'Password must contain 12-72 bytes.'
printf '{"username":"%s","password":"%s"}' "$(json_escape "$task_username")" "$(json_escape "$task_password")" |
  wget --post-file=/dev/stdin --header='Content-Type: application/json' -q -O /dev/null http://127.0.0.1:18542/api/store/setup
unset task_password task_confirm
printf 'Administrator configured. Start catalog, then bind two-factor authentication at /admin/.\n'
