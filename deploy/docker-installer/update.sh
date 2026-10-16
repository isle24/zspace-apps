#!/bin/sh
# Update an existing default SSD Compose installation; never reinstall or delete data.
set -eu
case "${1:-}" in
    --help|-h)
        printf '%s\n' 'Usage: sh update.sh' 'Updates the unique /data_*/zspace-suite/compose.yaml using the bundled Compose CLI.'
        exit 0 ;;
    '') [ "$#" -eq 0 ] || exit 2 ;;
    *) printf '%s\n' 'Unknown argument; use --help.' >&2; exit 2 ;;
esac
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
set -- /data_*/zspace-suite/compose.yaml
[ "$#" -eq 1 ] && [ -f "$1" ] && [ ! -L "$1" ] && [ ! -L "${1%/*}" ] ||
    die 'Cannot find one default installation. Use your original Compose file and project name; nothing was changed.'
compose_file=$1
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_API_VERSION DOCKER_TLS_VERIFY DOCKER_TLS \
    DOCKER_CERT_PATH DOCKER_CONFIG DOCKER_DEFAULT_PLATFORM DOCKER_CUSTOM_HEADERS
d() { docker --host unix:///var/run/docker.sock "$@"; }
version=$(d version --format '{{.Server.Version}}') || die 'Docker access failed. Run this saved script with sudo if required.'
printf '%s\n' "$version" | awk -F. 'NF >= 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {ok=($1>20 || ($1==20 && $2>=10))} END {exit !ok}' ||
    die 'Docker 20.10 or newer is required.'
engine=$(d info --format '{{.OSType}}|{{.Architecture}}') || die 'Cannot inspect the local Docker engine.'
case "$engine" in linux\|amd64|linux\|x86_64) ;; *) die 'Linux AMD64 Docker is required.' ;; esac
d pull --platform linux/amd64 isle204/zspace-shop:latest || die 'Shop pull failed; the installation was preserved.'
d pull --platform linux/amd64 isle204/zspace-ui:latest || die 'UI pull failed; the installation was preserved.'
shop_image=$(d image inspect --format '{{.Id}}' isle204/zspace-shop:latest)
printf '%s\n' "$shop_image" | awk 'length($0)==71 && $0 ~ /^sha256:[a-f0-9]+$/ {ok=1} END {exit !ok}' || die 'Cannot verify the pulled shop image identity.'
printf 'Updating the saved Compose project: %s\n' "$compose_file"
d run --rm --pull never --name zspace-suite-updater --network none \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --cgroupns private --ipc private --tmpfs /tmp:rw,noexec,nosuid,size=32m \
    --env HOME=/tmp --env DOCKER_CONFIG=/tmp/docker \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    --mount "type=bind,src=$compose_file,dst=/deploy/compose.yaml,readonly" \
    --entrypoint /usr/local/bin/docker "$shop_image" \
    --host unix:///var/run/docker.sock compose --project-name zspace-suite \
    --project-directory /deploy --file /deploy/compose.yaml \
    up --detach --pull never --wait --wait-timeout 180 ||
    die 'Update did not reach readiness. Data was preserved; inspect zspace-suite-shop logs.'
printf '%s\n' 'Update ready. Refresh the UI; if prompted, send and enter the official NAS verification code.'
