#!/bin/sh
# Linux AMD64 installer. Public images only; no passwords or terms are supplied.
set -eu
set -f

SHOP_IMAGE=isle204/zspace-shop:latest
UI_IMAGE=isle204/zspace-ui:latest
DOCKER_SOCKET=/var/run/docker.sock
DATA_MOUNT_PATTERN='^/data_[A-Za-z0-9]+$'
BTRFS_SYSFS_ROOT=/sys/fs/btrfs
PROJECT_NAME=zspace-suite
NAS_IP=
DATA_ROOT=
INSTALL_DIR=
SHOP_ONLY=0
CHECK_ONLY=0
WAIT_SECONDS=180

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'HELP'
Usage: sh install.sh [--ip NAS_LAN_IP] [--shop-only] [--project-name NAME]
                     [--install-dir /data_ssd/new-directory] [--check] [--help]

Install the Space UI and standalone shop on a Linux AMD64 NAS with Docker
20.10 or newer. No host Compose, Node.js, Go or Python installation is needed.

  --ip             Local private IPv4 address; otherwise detected from SSH/route.
  --shop-only      Install only the standalone shop (LAN port 18443).
  --project-name   New dedicated project, default zspace-suite (max 40 chars).
  --install-dir    New directory directly on a verified SSD data mount.
                   Default: <SSD with most available space>/<project name>.
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
        --ip|--project-name|--data-root|--install-dir)
            option=$1
            [ "$#" -ge 2 ] || die "${option} requires a value; use --help."
            [ -n "$2" ] || die "${option} requires a nonempty value; use --help."
            case "$option" in
                --ip) NAS_IP=$2 ;;
                --project-name) PROJECT_NAME=$2 ;;
                --data-root) DATA_ROOT=$2 ;;
                --install-dir) INSTALL_DIR=$2 ;;
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
if [ -n "$INSTALL_DIR" ]; then
    case "$INSTALL_DIR" in /|*[!A-Za-z0-9/_.-]*|*/|*//*|*/./*|*/../*|*/.|*/..) die 'Invalid installation directory.' ;; /*) ;; *) die 'Installation directory must be absolute.' ;; esac
fi
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
CACHE_ROOT=${SERVER_INFO#*|}; CACHE_ROOT=${CACHE_ROOT#*|}
if [ -n "$DATA_ROOT" ]; then
    CACHE_ROOT=${SERVER_INFO#*|}; CACHE_ROOT=${CACHE_ROOT#*|}
    case "$DATA_ROOT/" in "$CACHE_ROOT/"*) die 'Shop data must be separate from the Docker cache.' ;; esac
    case "$CACHE_ROOT/" in "$DATA_ROOT/"*) die 'Shop data must be separate from the Docker cache.' ;; esac
fi

# Read actual data mounts and every underlying disk. In particular, ROTA=0 on
# bcache is not proof of SSD storage: its HDD ancestors still reject the mount.
for tool in findmnt lsblk df stat sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || die "The Linux ${tool} command is required to identify SSD storage."
done
MOUNT_TABLE=$(findmnt -e -rn -o TARGET,SOURCE,FSTYPE,OPTIONS) || die 'Cannot read mounted NAS data disks.'
filesystem_members() {
    fs_mount=$1; fs_source=${2%%\[*}; fs_type=$3
    case "$fs_source" in /dev/*) ;; *) return 1 ;; esac
    if [ "$fs_type" != btrfs ]; then printf '%s\n' "$fs_source"; return; fi
    fs_uuid=$(findmnt -e -rn -T "$fs_mount" -o UUID) || return 1
    case "$fs_uuid" in ''|*[!a-fA-F0-9-]*) return 1 ;; esac
    [ "${#fs_uuid}" -eq 36 ] || return 1
    fs_base=$BTRFS_SYSFS_ROOT/$fs_uuid
    fs_infos=$(ls "$fs_base/devinfo" 2>/dev/null) || return 1
    fs_devices=$(ls "$fs_base/devices" 2>/dev/null) || return 1
    fs_count=0; fs_device_count=0; fs_members=
    for fs_info in $fs_infos; do
        case "$fs_info" in ''|*[!0-9]*) return 1 ;; esac
        [ "$(cat "$fs_base/devinfo/$fs_info/missing")" = 0 ] || return 1
        fs_count=$((fs_count + 1))
    done
    for fs_device in $fs_devices; do
        case "$fs_device" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
        fs_number=$(cat "$fs_base/devices/$fs_device/dev") || return 1
        printf '%s\n' "$fs_number" | awk '/^[0-9]+:[0-9]+$/ {ok=1} END {exit !(ok && NR==1)}' || return 1
        fs_members="${fs_members} /dev/block/${fs_number}"
        fs_device_count=$((fs_device_count + 1))
    done
    [ "$fs_count" -gt 0 ] && [ "$fs_count" -eq "$fs_device_count" ] || return 1
    printf '%s\n' "$fs_members"
}
disk_ancestry() { lsblk -snrp -o NAME,TYPE,ROTA,PKNAME "$1"; }
effective_mount_matches() {
    findmnt -e -rn -T "$1" -o TARGET,SOURCE,FSTYPE,OPTIONS | awk -v p="$1" -v s="$2" -v t="$3" -v o="$4" '$1==p && $2==s && $3==t && $4==o {ok++} END {exit !(NR==1 && ok==1)}'
}
SYSTEM_DISKS=
while read -r mount_path mount_source mount_type mount_options; do
    case "$mount_path" in /|/boot|/boot/*|/rom|/overlay|/zspace|/zspace/applications/logs|/usr|/etc|/var|/home|/root)
        case "$mount_source" in /dev/*)
            system_members=$(filesystem_members "$mount_path" "$mount_source" "$mount_type") || die 'Cannot verify all members of the NAS system filesystem.'
            for member in $system_members; do
                ancestry=$(disk_ancestry "$member") || die 'Cannot verify the NAS system disk ancestry.'
                SYSTEM_DISKS="$SYSTEM_DISKS $(printf '%s\n' "$ancestry" | awk '$2=="disk" {print $1}')"
            done ;;
        esac ;;
    esac
done <<MOUNTS
$MOUNT_TABLE
MOUNTS
SSD_ROOT=; SSD_FREE=-1; SSD_SOURCE=; SSD_TYPE=; SSD_OPTIONS=
while read -r mount_path mount_source mount_type mount_options; do
    printf '%s\n' "$mount_path" | awk -v p="$DATA_MOUNT_PATTERN" '$0 ~ p {ok=1} END {exit !ok}' || continue
    case "$mount_type" in ext4|xfs|btrfs) ;; *) continue ;; esac
    case ",$mount_options," in *,ro,*) continue ;; esac
    printf '%s\n' "$MOUNT_TABLE" | awk -v p="$mount_path" '$1==p {n++} END {exit !(n==1)}' || continue
    effective_mount_matches "$mount_path" "$mount_source" "$mount_type" "$mount_options" || continue
    if [ -n "$INSTALL_DIR" ] && [ "${INSTALL_DIR%/*}" != "$mount_path" ]; then continue; fi
    members=$(filesystem_members "$mount_path" "$mount_source" "$mount_type") || continue
    candidate_ok=1
    for member in $members; do
        ancestry=$(disk_ancestry "$member") || { candidate_ok=0; break; }
        printf '%s\n' "$ancestry" | awk '$2=="disk" {n++; if ($3!="0" || $1 ~ /\/((zram|ram|loop)[0-9]+)$/) bad=1} END {exit !(n>0 && !bad)}' || { candidate_ok=0; break; }
        disks=$(printf '%s\n' "$ancestry" | awk '$2=="disk" {print $1}')
        for device in $disks; do
            for system_device in $SYSTEM_DISKS; do
                if [ "$device" = "$system_device" ]; then candidate_ok=0; fi
            done
        done
    done
    [ "$candidate_ok" -eq 1 ] || continue
    free_kb=$(df -Pk "$mount_path" | awk 'NR==2 && $4 ~ /^[0-9]+$/ {print $4}')
    case "$free_kb" in ''|*[!0-9]*) continue ;; esac
    if [ "$free_kb" -gt "$SSD_FREE" ]; then
        SSD_ROOT=$mount_path; SSD_FREE=$free_kb; SSD_SOURCE=$mount_source; SSD_TYPE=$mount_type; SSD_OPTIONS=$mount_options
    fi
done <<MOUNTS
$MOUNT_TABLE
MOUNTS
[ -n "$SSD_ROOT" ] || die 'No verified writable SSD data disk was found. System disks, HDDs, mixed caches and unverified Btrfs members are preserved.'
INSTALL_DIR=${INSTALL_DIR:-$SSD_ROOT/$PROJECT_NAME}
case "${INSTALL_DIR##*/}" in [A-Za-z0-9]*) ;; *) die 'Installation directory name must start with a letter or digit.' ;; esac
[ ! -e "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ] || die "Installation directory already exists: ${INSTALL_DIR}. All files were preserved."
PARENT_ID=$(stat -c '%d:%i' "$SSD_ROOT") || die 'Cannot verify the SSD mount identity.'
effective_mount_matches "$SSD_ROOT" "$SSD_SOURCE" "$SSD_TYPE" "$SSD_OPTIONS" || die 'The effective SSD mount changed; all files were preserved.'
[ "$(stat -c '%d:%i' "$SSD_ROOT")" = "$PARENT_ID" ] || die 'The SSD directory identity changed; all files were preserved.'
INSTALL_UID=$(id -u); INSTALL_GID=$(id -g)
if [ "$INSTALL_UID" -eq 0 ]; then
    case "${SUDO_UID:-}:${SUDO_GID:-}" in *[!0-9:]*|:*|*:) ;; *)
        if [ "$SUDO_UID" -gt 0 ] && [ "$SUDO_UID" -le 2147483647 ] && [ "$SUDO_GID" -le 2147483647 ]; then
            INSTALL_UID=$SUDO_UID; INSTALL_GID=$SUDO_GID
        fi ;;
    esac
fi
DATA_ROOT=${DATA_ROOT:-$INSTALL_DIR/runtime}
case "$DATA_ROOT/" in "$CACHE_ROOT/"*) die 'Shop data must be separate from the Docker cache.' ;; esac
case "$CACHE_ROOT/" in "$DATA_ROOT/"*) die 'Shop data must be separate from the Docker cache.' ;; esac
[ "$DATA_ROOT" != "$INSTALL_DIR" ] || die 'Shop data must use a separate new runtime directory.'
CLIENT_VERSION=$(d version --format '{{.Client.Version}}') || die 'Cannot verify the Docker CLI version.'
NONRECURSIVE=$(printf '%s\n' "$CLIENT_VERSION" | awk -F. 'NR==1 && /^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9_.+-]+)?$/ {valid=($1>20 || ($1==20 && $2>=10)); option=($1>=25 ? "bind-recursive=disabled" : "bind-nonrecursive=true")} END {if (!valid || NR!=1) exit 1; print option}') || die 'Docker CLI 20.10 or newer is required.'
SSD_PROPAGATION=rprivate
case "$CACHE_ROOT/" in "$SSD_ROOT/"*) SSD_PROPAGATION=rslave ;; esac
printf 'Detected NAS IP: %s\nSSD data disk: %s\nCompose file: %s/compose.yaml\n' "$NAS_IP" "$SSD_ROOT" "$INSTALL_DIR"

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
    printf 'Check only: no files, image pulls or Docker resource changes.\n'
    exit 0
fi

printf 'Pulling the current AMD64 release images...\n'
d pull --platform linux/amd64 "$SHOP_IMAGE" || die 'Shop image pull failed. Existing data and resources were preserved.'
if [ "$SHOP_ONLY" -eq 0 ]; then
    d pull --platform linux/amd64 "$UI_IMAGE" || die 'UI image pull failed. Existing data and resources were preserved.'
fi

compose_input() {
    cat <<YAML
name: "${PROJECT_NAME}"
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
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ${INSTALL_DIR}/shop-control
YAML
    if [ "$SHOP_ONLY" -eq 0 ]; then
        cat <<YAML
  ui-data:
    name: ${PROJECT_NAME}_ui-data
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ${INSTALL_DIR}/ui-data
YAML
    fi
}

PREPARE_CODE='
import hashlib,os,stat,sys
directory,expected_parent,owner,group,project,expected_sha,shop_only=sys.argv[1:]
owner,group=int(owner),int(group)
parent,leaf=os.path.split(directory)
if not leaf or leaf in (".","..") or not parent.startswith("/"): raise ValueError("Invalid new installation directory")
raw=sys.stdin.buffer.read(65537)
if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=expected_sha: raise ValueError("Compose content changed; no files were created")
fd=os.open("/",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    for part in parent.split("/")[1:]:
        if not part or part in (".",".."): raise ValueError("Invalid SSD parent path")
        entry=os.fstat(fd)
        if entry.st_mode & 0o022 and not (entry.st_uid==0 and entry.st_mode & stat.S_ISVTX): raise ValueError("SSD ancestor is writable by other accounts")
        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
        os.close(fd);fd=child
    entry=os.fstat(fd)
    if str(entry.st_dev)+":"+str(entry.st_ino)!=expected_parent: raise ValueError("SSD mount identity changed; no files were created")
    if entry.st_mode & 0o022: raise ValueError("SSD parent must not be writable by other accounts")
    os.mkdir(leaf,0o700,dir_fd=fd)
    created=os.open(leaf,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    try:
        targets=[("shop-control",0,0)]
        if shop_only!="1": targets.append(("ui-data",10001,10001))
        for name,uid,gid in targets:
            os.mkdir(name,0o700,dir_fd=created)
            target=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=created)
            try: os.fchmod(target,0o700);os.fchown(target,uid,gid);os.fsync(target)
            finally: os.close(target)
        output=os.open("compose.yaml",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=created)
        with os.fdopen(output,"wb") as stream:
            stream.write(raw);stream.flush();os.fchmod(stream.fileno(),0o644);os.fchown(stream.fileno(),owner,group);os.fsync(stream.fileno())
        os.fchmod(created,0o755);os.fchown(created,owner,group);os.fsync(created);os.fsync(fd)
    finally: os.close(created)
finally: os.close(fd)
'

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
prepare_code=$5
install_dir=$6
parent_identity=$7
install_uid=$8
install_gid=$9
compose_sha=${10}
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
/usr/local/bin/python3 -c "$prepare_code" "$install_dir" "$parent_identity" "$install_uid" "$install_gid" "$project" "$compose_sha" "$shop_only"
exec /usr/local/bin/docker --host unix:///var/run/docker.sock compose \
    --project-name "$project" --project-directory "$install_dir" --file "$install_dir/compose.yaml" \
    up --detach --no-recreate --pull never --wait --wait-timeout "$wait_seconds"
'

printf 'Starting services and waiting up to %s seconds for health checks...\n' "$WAIT_SECONDS"
COMPOSE_CONTENT=$(compose_input)
COMPOSE_SHA=$(printf '%s\n' "$COMPOSE_CONTENT" | sha256sum | awk '{print $1}')
if ! printf '%s\n' "$COMPOSE_CONTENT" | d run --rm -i --name "${PROJECT_NAME}-installer" \
    --platform linux/amd64 --pull never --read-only --cap-drop=ALL \
    --cap-add=CHOWN \
    --security-opt=no-new-privileges:true --network=none --no-healthcheck \
    --tmpfs /tmp:rw,noexec,nosuid,size=32m \
    --env HOME=/tmp --env DOCKER_CONFIG=/tmp/docker \
    --mount "type=bind,src=${DOCKER_SOCKET},dst=/var/run/docker.sock" \
    --mount "type=bind,src=${SSD_ROOT},dst=${SSD_ROOT},bind-propagation=${SSD_PROPAGATION},${NONRECURSIVE}" \
    --entrypoint /bin/sh "$SHOP_IMAGE" -c "$RUNNER_COMMAND" installer \
    "$PROJECT_NAME" "$SHOP_ONLY" "$WAIT_SECONDS" "$PORT_CHECK" "$PREPARE_CODE" \
    "$INSTALL_DIR" "$PARENT_ID" "$INSTALL_UID" "$INSTALL_GID" "$COMPOSE_SHA"; then
    die "Installation did not reach readiness. Any new files, volumes and containers were preserved. Compose: ${INSTALL_DIR}/compose.yaml. Inspect: docker --host unix:///var/run/docker.sock logs ${PROJECT_NAME}-shop."
fi

# Do not equate a successful Compose invocation with a healthy deployment.
SERVICES=shop
[ "$SHOP_ONLY" -eq 1 ] || SERVICES='shop ui'
for service in $SERVICES; do
    state=$(d container inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${PROJECT_NAME}-${service}") || die 'Cannot verify the service health; all resources were preserved.'
    [ "$state" = 'running|healthy' ] || die "Service ${service} is not healthy. Installation is incomplete; all resources were preserved."
done
printf 'Installation ready.\n'
printf 'Compose file saved: %s/compose.yaml\n' "$INSTALL_DIR"
if [ "$SHOP_ONLY" -eq 0 ]; then printf 'UI:   http://%s:18436\n' "$NAS_IP"; fi
printf 'Shop: http://%s:18443\n' "$NAS_IP"
printf 'Open the webpage to create the first account and review the terms. No credentials were generated.\n'
