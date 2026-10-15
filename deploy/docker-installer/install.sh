#!/bin/sh
# Linux AMD64 installer. Public images only; no passwords or terms are supplied.
set -eu
set -f

SHOP_IMAGE=isle204/zspace-shop:2026.10.15-r3
UI_IMAGE=isle204/zspace-ui:2026.10.15-r5
DOCKER_SOCKET=/var/run/docker.sock
PROJECT_NAME=zspace-suite
NAS_IP=
DATA_ROOT=
SHOP_ONLY=0
CHECK_ONLY=0
WAIT_SECONDS=180

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'HELP'
Usage: sh install.sh [--ip NAS_LAN_IP] [--shop-only] [--project-name NAME]
                     [--data-root /data_disk/new-directory] [--check] [--help]

Install the Space UI and standalone shop on a Linux AMD64 NAS with Docker
20.10 or newer. No host Compose, Node.js, Go or Python installation is needed.

  --ip             Local private IPv4 address; otherwise detected from SSH/route.
  --shop-only      Install only the standalone shop (LAN port 18443).
  --project-name   New dedicated project, default zspace-suite (max 40 chars).
  --data-root      Optional new dedicated data directory passed to the bootstrap.
                   The bootstrap validates the actual NAS disk before using it.
  --check          Read-only preflight; no images pulled or Docker resources made.
  --help           Show this help.

Existing project resources are never adopted or deleted. A repeated install
stops and preserves everything. Use the existing webpage to manage a working
installation. A different project name does not bypass occupied LAN ports.
HELP
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --check) CHECK_ONLY=1; shift ;;
        --shop-only) SHOP_ONLY=1; shift ;;
        --ip|--project-name|--data-root)
            option=$1
            [ "$#" -ge 2 ] || die "${option} requires a value; use --help."
            [ -n "$2" ] || die "${option} requires a nonempty value; use --help."
            case "$option" in
                --ip) NAS_IP=$2 ;;
                --project-name) PROJECT_NAME=$2 ;;
                --data-root) DATA_ROOT=$2 ;;
            esac
            shift 2 ;;
        *) die "Unknown option; use --help." ;;
    esac
done

# Validate all user input before any Docker access. Values are always quoted;
# none is interpreted as shell code or sourced from another file.
case "$PROJECT_NAME" in ''|*[!a-z0-9_-]*) die 'Invalid project name: use lowercase letters, digits, _ and -.' ;; esac
case "$PROJECT_NAME" in [a-z0-9]*) ;; *) die 'Project name must start with a letter or digit.' ;; esac
[ "${#PROJECT_NAME}" -le 40 ] || die 'Project name is longer than 40 characters.'
if [ -n "$DATA_ROOT" ]; then
    case "$DATA_ROOT" in
        /|*[!A-Za-z0-9/_.-]*|*/|*//*|*/./*|*/../*|*/.|*/..) die 'Invalid dedicated data path.' ;;
        /*) ;;
        *) die 'Data root must be an absolute dedicated path.' ;;
    esac
    case "$DATA_ROOT" in
        /root|/root/*|/home|/home/*|/boot|/boot/*|/zspace|/zspace/*|/usr|/usr/*|/etc|/etc/*|/bin|/bin/*|/sbin|/sbin/*|/var|/var/*|/opt|/opt/*|/run|/run/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*)
            die 'Data root must be on a NAS data disk, outside system directories.' ;;
    esac
fi

private_ipv4() {
    case "$1" in ''|*[!0-9.]*) return 1 ;; esac
    printf '%s\n' "$1" | awk -F. '
        NF != 4 { exit 1 }
        { for (i = 1; i <= 4; i++) {
            if ($i == "" || $i + 0 > 255 || (length($i) > 1 && substr($i, 1, 1) == "0")) exit 1
          }
          if ($1 == 10 || ($1 == 172 && $2 >= 16 && $2 <= 31) || ($1 == 192 && $2 == 168)) exit 0
          exit 1
        }'
}
if [ -n "$NAS_IP" ]; then
    private_ipv4 "$NAS_IP" || die 'The IP must be a canonical private LAN IPv4 address.'
fi

[ "$(uname -s)" = Linux ] || die 'This installer requires Linux AMD64.'
case "$(uname -m)" in x86_64|amd64) ;; *) die 'This release requires AMD64 (x86_64).' ;; esac
command -v ip >/dev/null 2>&1 || die 'The Linux ip command is required to verify the local NAS address.'
LOCAL_IPS=$(ip -4 -o addr show | awk '{split($4, address, "/"); if (address[1] != "") print address[1]}')
is_local_ip() { printf '%s\n' "$LOCAL_IPS" | awk -v wanted="$1" '$0 == wanted { found=1 } END { exit !found }'; }

if [ -z "$NAS_IP" ]; then
    # SSH_CONNECTION contains client IP/port and the server IP/port. Only the
    # server address is a candidate, and it must also occur on a local interface.
    set -- ${SSH_CONNECTION:-}
    if [ "$#" -eq 4 ] && private_ipv4 "$3" && is_local_ip "$3"; then NAS_IP=$3; fi
    if [ -z "$NAS_IP" ]; then
        route_candidates=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<NF; i++) if ($i == "src") print $(i+1)}' | sort -u)
        set -- $route_candidates
        if [ "$#" -eq 1 ] && private_ipv4 "$1" && is_local_ip "$1"; then NAS_IP=$1; fi
    fi
    if [ -z "$NAS_IP" ]; then
        candidates=
        for address in $LOCAL_IPS; do
            if private_ipv4 "$address"; then candidates="${candidates} ${address}"; fi
        done
        set -- $candidates
        [ "$#" -eq 1 ] || die 'Cannot choose one local LAN IPv4 address. Re-run with --ip NAS_LAN_IP.'
        NAS_IP=$1
    fi
fi
is_local_ip "$NAS_IP" || die 'The requested IP is not assigned to this NAS.'

# Never allow a remote context, API override or TLS setting to change the target.
# Public pulls do not need a user-supplied Docker configuration directory.
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_API_VERSION DOCKER_TLS_VERIFY DOCKER_TLS \
    DOCKER_CERT_PATH DOCKER_CONFIG DOCKER_DEFAULT_PLATFORM DOCKER_CUSTOM_HEADERS
command -v docker >/dev/null 2>&1 || die 'Docker CLI is missing. Enable Docker on the NAS first.'
[ -S "$DOCKER_SOCKET" ] || die 'The local /var/run/docker.sock Unix socket is missing. Enable Docker on this NAS first.'
d() { docker --host "unix://${DOCKER_SOCKET}" "$@"; }
SERVER_VERSION=$(d version --format '{{.Server.Version}}' 2>/dev/null) || die 'Cannot access local Docker. Enable Docker and use an account with Docker permission, or run this script with sudo.'
printf '%s\n' "$SERVER_VERSION" | awk -F. '
    NR == 1 && /^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9_.+-]+)?$/ {
        ok = ($1 + 0 > 20 || ($1 + 0 == 20 && $2 + 0 >= 10))
    }
    END {exit !(ok && NR == 1)}' || die 'Docker server version is missing, invalid or older than 20.10; upgrade Docker first.'
SERVER_INFO=$(d info --format '{{.OSType}}|{{.Architecture}}|{{.DockerRootDir}}' 2>/dev/null) || die 'Cannot inspect the local Docker server; check Docker permission (sudo if necessary).'
case "$SERVER_INFO" in linux\|x86_64\|/*|linux\|amd64\|/*) ;; *) die 'The local Docker server must be Linux AMD64.' ;; esac
if [ -n "$DATA_ROOT" ]; then
    CACHE_ROOT=${SERVER_INFO#*|}; CACHE_ROOT=${CACHE_ROOT#*|}
    case "$DATA_ROOT/" in "$CACHE_ROOT/"*) die 'Shop data must be separate from the Docker cache.' ;; esac
    case "$CACHE_ROOT/" in "$DATA_ROOT/"*) die 'Shop data must be separate from the Docker cache.' ;; esac
fi

no_resource() {
    kind=$1; shift
    if [ "$kind" = container ]; then
        matches=$(d container ls --all "$@" --format '{{.ID}}') || die 'Docker container inspection failed; all resources were preserved.'
    else
        matches=$(d "$kind" ls "$@" --format '{{.Name}}') || die 'Docker resource inspection failed; all resources were preserved.'
    fi
    [ -z "$matches" ] || die "Project ${PROJECT_NAME} conflicts with existing ${kind} resources. All resources were preserved; use the existing installation or a new --project-name."
}
# Docker may collapse contiguous mappings into host port ranges. Only published
# TCP mappings reserve the TCP endpoints used here; an exposed-only/UDP port does not.
PORT_CHECK='
BEGIN { RS="[,[:space:]]+" }
/\/tcp$/ && index($0,"->") {
    split($0, sides, "->")
    n=split(sides[1], host, ":")
    if (host[n] ~ /^[0-9]+(-[0-9]+)?$/) {
        split(host[n], bounds, "-")
        low=bounds[1]+0
        high=(bounds[2] == "" ? low : bounds[2]+0)
        if (p+0 >= low && p+0 <= high) found=1
    }
}
END { exit !found }
'
check_docker_resources() {
    no_resource container --filter "label=com.docker.compose.project=${PROJECT_NAME}"
    for suffix in shop ui installer; do no_resource container --filter "name=^/${PROJECT_NAME}-${suffix}\$"; done
    no_resource volume --filter "label=com.docker.compose.project=${PROJECT_NAME}"
    for suffix in shop-control ui-data; do no_resource volume --filter "name=^${PROJECT_NAME}_${suffix}\$"; done
    no_resource network --filter "label=com.docker.compose.project=${PROJECT_NAME}"
    no_resource network --filter "name=^${PROJECT_NAME}_default\$"
    published=$(d container ls --all --format '{{.Ports}}') || die 'Cannot inspect Docker port reservations.'
    for port in $PORTS; do
        if printf '%s\n' "$published" | awk -v p="$port" "$PORT_CHECK"; then
            die "LAN port ${port} is already reserved by a Docker container. All resources were preserved."
        fi
    done
}
PORTS=18443
[ "$SHOP_ONLY" -eq 1 ] || PORTS='18443 18436'
check_docker_resources
if command -v ss >/dev/null 2>&1; then
    listeners=$(ss -ltn) || die 'Cannot inspect listening TCP ports.'
elif command -v netstat >/dev/null 2>&1; then
    listeners=$(netstat -ltn) || die 'Cannot inspect listening TCP ports.'
else
    die 'ss or netstat is required to check for occupied LAN ports.'
fi
for port in $PORTS; do
    if printf '%s\n' "$listeners" | awk -v p="$port" '{local=$4; sub(/^.*:/, "", local); if (local == p) found=1} END {exit !found}'; then
        die "LAN port ${port} is already listening. All resources were preserved."
    fi
done
printf 'Preflight passed: Docker %s, NAS %s, project %s.\n' "$SERVER_VERSION" "$NAS_IP" "$PROJECT_NAME"
if [ "$CHECK_ONLY" -eq 1 ]; then
    printf 'Check only: no image pulls or Docker resource changes. Data-disk attestation runs during bootstrap.\n'
    exit 0
fi

printf 'Pulling the pinned AMD64 release images...\n'
d pull --platform linux/amd64 "$SHOP_IMAGE" || die 'Shop image pull failed. Existing data and resources were preserved.'
if [ "$SHOP_ONLY" -eq 0 ]; then
    d pull --platform linux/amd64 "$UI_IMAGE" || die 'UI image pull failed. Existing data and resources were preserved.'
fi

compose_input() {
    cat <<YAML
services:
  shop:
    image: ${SHOP_IMAGE}
    pull_policy: never
    platform: linux/amd64
    container_name: ${PROJECT_NAME}-shop
    network_mode: bridge
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stop_grace_period: 45s
    labels:
      io.space-store.service: space-store
      io.space.role: standalone-shop-bootstrap
    environment:
      NAS_IP: ${NAS_IP}
      SHOP_PORT: "18443"
YAML
    [ "$SHOP_ONLY" -eq 1 ] || printf '      SHOP_UI_ORIGIN: http://%s:18436\n' "$NAS_IP"
    [ -z "$DATA_ROOT" ] || printf '      SHOP_DATA_ROOT: %s\n' "$DATA_ROOT"
    cat <<YAML
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - shop-control:/control
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
YAML
    if [ "$SHOP_ONLY" -eq 0 ]; then
        cat <<YAML
  ui:
    image: ${UI_IMAGE}
    pull_policy: never
    platform: linux/amd64
    container_name: ${PROJECT_NAME}-ui
    network_mode: bridge
    user: "10001:10001"
    init: true
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    labels:
      io.space-store.service: space-store
      io.space.role: ui
    ports: ["${NAS_IP}:18436:18436"]
    environment:
      NAS_ORIGIN: http://${NAS_IP}:5055
      UI_PUBLIC_ORIGIN: http://${NAS_IP}:18436
      SPACE_STORE_ENDPOINT: http://${NAS_IP}:18443
    volumes: [ui-data:/data]
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
    depends_on:
      shop:
        condition: service_healthy
YAML
    fi
    cat <<YAML
volumes:
  shop-control:
    name: ${PROJECT_NAME}_shop-control
YAML
    if [ "$SHOP_ONLY" -eq 0 ]; then
        printf '  ui-data:\n    name: %s_ui-data\n' "$PROJECT_NAME"
    fi
}

# A fixed, reviewed command (never eval/source) runs after Docker atomically
# acquires the helper name. Recheck before Compose so a delayed second installer
# cannot adopt an installation completed between the initial check and this run.
# Values are literal positional parameters, and stdin is only public Compose YAML.
RUNNER_COMMAND='
set -eu
project=$1
shop_only=$2
wait_seconds=$3
port_check=$4
d() { /usr/local/bin/docker --host unix:///var/run/docker.sock "$@"; }
empty() {
    kind=$1; shift
    if [ "$kind" = container ]; then
        rows=$(d container ls --all "$@" --format "{{.ID}}")
    else
        rows=$(d "$kind" ls "$@" --format "{{.Name}}")
    fi
    if [ -n "$rows" ]; then
        printf "%s\n" "Project resources appeared during installation; all resources were preserved." >&2
        exit 1
    fi
}
# The named running helper itself is expected; the other containers must not exist.
# A Compose-project label query does not match this unlabelled ephemeral helper.
empty container --filter "label=com.docker.compose.project=${project}"
for suffix in shop ui; do empty container --filter "name=^/${project}-${suffix}\$"; done
empty volume --filter "label=com.docker.compose.project=${project}"
for suffix in shop-control ui-data; do empty volume --filter "name=^${project}_${suffix}\$"; done
empty network --filter "label=com.docker.compose.project=${project}"
empty network --filter "name=^${project}_default\$"
ports=18443
[ "$shop_only" -eq 1 ] || ports="18443 18436"
published=$(d container ls --all --format "{{.Ports}}")
for port in $ports; do
    if printf "%s\n" "$published" | awk -v p="$port" "$port_check"; then
        printf "%s\n" "A required LAN port became reserved; all resources were preserved." >&2
        exit 1
    fi
done
exec /usr/local/bin/docker --host unix:///var/run/docker.sock compose \
    --project-name "$project" --project-directory /tmp --file - \
    up --detach --no-recreate --pull never --wait --wait-timeout "$wait_seconds"
'

printf 'Starting services and waiting up to %s seconds for health checks...\n' "$WAIT_SECONDS"
if ! compose_input | d run --rm -i --name "${PROJECT_NAME}-installer" \
    --platform linux/amd64 --pull never --read-only --cap-drop=ALL \
    --security-opt=no-new-privileges:true --network=none --no-healthcheck \
    --tmpfs /tmp:rw,noexec,nosuid,size=32m \
    --env HOME=/tmp --env DOCKER_CONFIG=/tmp/docker \
    --mount "type=bind,src=${DOCKER_SOCKET},dst=/var/run/docker.sock" \
    --entrypoint /bin/sh "$SHOP_IMAGE" -c "$RUNNER_COMMAND" installer \
    "$PROJECT_NAME" "$SHOP_ONLY" "$WAIT_SECONDS" "$PORT_CHECK"; then
    die "Installation did not reach readiness. All created data, volumes and service containers were preserved. Inspect: docker --host unix:///var/run/docker.sock logs ${PROJECT_NAME}-shop. Do not delete its control volume or data directory."
fi

# Do not equate a successful Compose invocation with a healthy deployment.
SERVICES=shop
[ "$SHOP_ONLY" -eq 1 ] || SERVICES='shop ui'
for service in $SERVICES; do
    state=$(d container inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${PROJECT_NAME}-${service}") || die 'Cannot verify the service health; all resources were preserved.'
    [ "$state" = 'running|healthy' ] || die "Service ${service} is not healthy. Installation is incomplete; all resources were preserved."
done
printf 'Installation ready.\n'
if [ "$SHOP_ONLY" -eq 0 ]; then printf 'UI:   http://%s:18436\n' "$NAS_IP"; fi
printf 'Shop: http://%s:18443\n' "$NAS_IP"
printf 'Open the webpage to create the first account and review the terms. No credentials were generated.\n'
