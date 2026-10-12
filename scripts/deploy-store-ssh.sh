#!/usr/bin/env bash
# Additive standalone-store deployment. No container or service is replaced.
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-store-ssh.sh --alias NAME --deploy-root ABS_PATH --storage-root ABS_PATH [--port 18435] [--engine local|disabled] [--publish-host 0.0.0.0] [--access-host HOST] [--public-origin https://store.example] [--nas-origin http://nas.example:5055]

Both remote directories must already exist, belong to the SSH user and have
mode 0700. The deployment root must be empty on first use. Existing releases,
metadata, logs and processes are preserved. A running store blocks deployment.
Application ports publish on 0.0.0.0 by default; access-host defaults to the
selected usable alias host. public-origin is an optional bare HTTP(S) origin.
nas-origin is an optional fixed canonical NAS identity provider, disabled by default.
No credentials are accepted. Run --help without contacting a server.
USAGE
}
fail() { printf '%s\n' "Deployment stopped: $*" >&2; exit 1; }
shell_quote() {
  local task_rest=$1
  printf "'"
  while [[ "$task_rest" == *"'"* ]]; do
    printf '%s' "${task_rest%%\'*}"
    printf '%s' "'\"'\"'"
    task_rest=${task_rest#*\'}
  done
  printf "%s'" "$task_rest"
}
remote_command() {
  local task_arg
  printf 'python3 -c '
  shell_quote "$task_remote_python"
  for task_arg in "$@"; do printf ' '; shell_quote "$task_arg"; done
}

task_alias= task_deploy_root= task_storage_root= task_port=18435 task_engine=local
task_publish_host=0.0.0.0 task_access_host= task_public_origin= task_nas_origin=
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --alias|--deploy-root|--storage-root|--port|--engine|--publish-host|--access-host|--public-origin|--nas-origin)
      (($# >= 2)) || fail "Missing value for $1"
      case "$1" in
        --alias) task_alias=$2 ;;
        --deploy-root) task_deploy_root=$2 ;;
        --storage-root) task_storage_root=$2 ;;
        --port) task_port=$2 ;;
        --engine) task_engine=$2 ;;
        --publish-host) task_publish_host=$2 ;;
        --access-host) task_access_host=$2 ;;
        --public-origin) task_public_origin=$2 ;;
        --nas-origin) task_nas_origin=$2 ;;
      esac
      shift 2 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ -n "$task_alias" && -n "$task_deploy_root" && -n "$task_storage_root" ]] || { usage >&2; exit 1; }
[[ "$task_alias" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail 'Invalid SSH alias'
[[ "$task_port" =~ ^[0-9]{1,5}$ ]] || fail 'Port must contain one to five decimal digits'
task_port=$((10#$task_port))
((task_port >= 1024 && task_port <= 65535 && task_port != 5055)) || fail 'Use a non-system port other than the official 5055'
case "$task_engine" in local|disabled) ;; *) fail 'NAS deployment engine must be local or disabled' ;; esac
for task_tool in sshbind ssh python3 pnpm go tar; do
  command -v "$task_tool" >/dev/null 2>&1 || fail "Missing local tool: $task_tool"
done
python3 - "$task_deploy_root" "$task_storage_root" <<'PY'
import os, sys
for path in sys.argv[1:]:
    if not path.startswith('/') or path == '/' or os.path.normpath(path) != path or any(c in path for c in '\x00\r\n,'):
        sys.exit('Remote directories must be canonical absolute paths without control characters or commas')
PY
task_nas_validator=$(cat <<'PY'
import ipaddress, re, sys, urllib.parse

def validate_nas_origin(value):
    if value:
        invalid = 'NAS origin must be a canonical bare HTTP(S) origin'
        try:
            if len(value) > 2048 or not re.fullmatch(r'https?://[^/?#\s\\]+', value) or re.search(r'[\x00-\x20\x7f]', value):
                raise ValueError(invalid)
            parsed = urllib.parse.urlsplit(value)
            if parsed.username is not None or parsed.password is not None or not parsed.hostname:
                raise ValueError(invalid)
            name = parsed.hostname
            try:
                address = ipaddress.ip_address(name)
                if address.is_unspecified:
                    raise ValueError(invalid)
                name = str(address)
            except ValueError:
                if ':' in name or re.fullmatch(r'[0-9.]+', name) or len(name) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*', name):
                    raise ValueError(invalid)
            authority = '[' + name + ']' if ':' in name else name
            port = parsed.port
            if port is not None:
                if not 1 <= port <= 65535 or (parsed.scheme, port) in (('http', 80), ('https', 443)):
                    raise ValueError(invalid)
                authority += ':' + str(port)
            if value != parsed.scheme + '://' + authority:
                raise ValueError(invalid)
        except ValueError:
            raise ValueError(invalid)
PY
)
python3 -c "$task_nas_validator"$'\ntry:\n    validate_nas_origin(sys.argv[1])\nexcept ValueError:\n    sys.exit("NAS origin must be a canonical bare HTTP(S) origin")\n' "$task_nas_origin"
task_root="$(cd "$(dirname "$0")/.." && pwd)"

# Read only the selected usable entry; never copy key paths or credentials.
task_host="$(sshbind list --json | python3 -c '
import json,sys
alias=sys.argv[1]
items=[s for s in json.load(sys.stdin).get("servers",[]) if s.get("name")==alias and s.get("usable") is True]
if len(items)!=1: sys.exit("Selected sshbind alias is absent or unusable")
print(items[0]["host"])
' "$task_alias")"
if [[ -z "$task_access_host" ]]; then task_access_host=$task_host; fi
task_addressing="$(python3 - "$task_publish_host" "$task_access_host" "$task_public_origin" <<'PY'
import ipaddress, re, sys, urllib.parse
def host(value, publish=False):
    if not value or '%' in value:
        raise ValueError('Host must not contain a zone, URL, port or credentials')
    try:
        address = ipaddress.ip_address(value)
        if not publish and address.is_unspecified:
            raise ValueError('Access host must not be a wildcard address')
        return str(address)
    except ValueError:
        if publish or len(value) > 253 or re.fullmatch(r'[0-9.]+', value) or not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*', value):
            raise ValueError('Publish host must be an IP; access host must be a DNS name or reachable IP')
        return value.lower()
def public_origin(value):
    if not value:
        return ''
    if not re.fullmatch(r'https?://[^/?#\s\\]+/?', value) or re.search(r'[\x00-\x20\x7f]', value):
        raise ValueError('Public origin must be a bare HTTP(S) origin')
    parsed = urllib.parse.urlsplit(value)
    if parsed.username is not None or parsed.password is not None or not parsed.hostname:
        raise ValueError('Public origin must not contain credentials')
    name = host(parsed.hostname)
    port = parsed.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('Invalid public origin port')
    authority = '[' + name + ']' if ':' in name else name
    if port is not None and (parsed.scheme, port) not in (('http', 80), ('https', 443)):
        authority += ':' + str(port)
    return parsed.scheme + '://' + authority
try:
    print('\t'.join((host(sys.argv[1], True), host(sys.argv[2]), public_origin(sys.argv[3]))))
except ValueError as error:
    sys.exit(str(error))
PY
)"
IFS=$'\t' read -r task_publish_host task_access_host task_public_origin <<< "$task_addressing"

task_remote_python=$(cat <<'PY'
import fcntl, hashlib, io, ipaddress, json, os, platform, re, socket, stat, subprocess, sys, tarfile, time, urllib.parse, urllib.request

class DeploymentError(RuntimeError):
    pass

def stop(message):
    raise DeploymentError(message)

def validate_addresses(publish, access, public):
    if '%' in publish or not publish:
        stop('Invalid publish host')
    ipaddress.ip_address(publish)
    if not access or '%' in access:
        stop('Invalid access host')
    try:
        address = ipaddress.ip_address(access)
        if address.is_unspecified:
            stop('Access host must not be a wildcard')
    except ValueError:
        if len(access) > 253 or re.fullmatch(r'[0-9.]+', access) or not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*', access):
            stop('Invalid access host')
    if public:
        if not re.fullmatch(r'https?://[^/?#\s\\]+', public) or re.search(r'[\x00-\x20\x7f]', public):
            stop('Public origin must be a bare HTTP(S) origin')
        parsed = urllib.parse.urlsplit(public)
        if parsed.username is not None or parsed.password is not None or not parsed.hostname or (parsed.port is not None and not 1 <= parsed.port <= 65535):
            stop('Invalid public origin')


def store_arguments(executable, listen, web, metadata, engine, storage, publish, access, public, nas):
    validate_nas_origin(nas)
    arguments = [executable, '--listen', listen, '--web-root', web, '--data-dir', metadata, '--engine', engine, '--storage-root', storage, '--publish-host', publish, '--access-host', access]
    if public:
        arguments.extend(['--public-origin', public])
    if nas:
        arguments.extend(['--nas-origin', nas])
    return arguments

def directory(path, private=True):
    if not path.startswith('/') or os.path.normpath(path) != path or path == '/' or any(c in path for c in '\x00\r\n,'):
        stop('Unsafe directory argument')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/')[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        entry = os.fstat(fd)
        if private and (entry.st_uid != os.getuid() or stat.S_IMODE(entry.st_mode) != 0o700 or not os.access(path, os.W_OK | os.X_OK)):
            stop('Chosen directory must belong to the SSH user and have mode 0700')
        return entry
    finally:
        os.close(fd)

def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        entry = os.fstat(handle.fileno())
        if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid() or stat.S_IMODE(entry.st_mode) != 0o600 or entry.st_size > 65536:
            stop('Unexpected deployment record; inspect manually')
        return json.load(handle)

def new_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())

def process_state(pid):
    with open('/proc/%d/stat' % pid) as handle:
        fields = handle.read().rsplit(') ', 1)[1].split()
        return fields[0], fields[19]

def start_ticks(pid):
    return process_state(pid)[1]

def check_processes(root, metadata, storage):
    # PID records include Linux process start time, so a reused PID is not owned.
    run = os.path.join(root, 'run')
    if os.path.lexists(run):
        directory(run)
        for name in os.listdir(run):
            if not name.endswith('.json'):
                stop('Unexpected run-directory entry; inspect manually')
            record = read_json(os.path.join(run, name))
            if record.get('service') != 'space-store' or record.get('dataDir') != metadata:
                stop('Unexpected service record; inspect manually')
            validate_nas_origin(record.get('nasOrigin', ''))
            pid = record.get('pid')
            if not isinstance(pid, int) or pid <= 0:
                stop('Invalid PID record; inspect manually')
            try:
                state, ticks = process_state(pid)
            except FileNotFoundError:
                continue
            # A zombie has exited, but /proc can retain stat until its parent reaps it.
            # Its exe is already absent; do not mistake that for a live identity conflict.
            if state == 'Z':
                continue
            if ticks != record.get('startTicks'):
                continue
            if os.stat('/proc/%d' % pid).st_uid != os.getuid() or os.path.realpath('/proc/%d/exe' % pid) != record.get('executable'):
                stop('Live process identity differs from its record; inspect manually')
            with open('/proc/%d/cmdline' % pid, 'rb') as handle:
                command = handle.read(65536).split(b'\0')
            for key, flag in (('dataDir', '--data-dir'), ('storageRoot', '--storage-root'), ('listen', '--listen'), ('engine', '--engine'), ('publishHost', '--publish-host'), ('accessHost', '--access-host'), ('publicOrigin', '--public-origin')):
                if key not in record or (key in ('publicOrigin', 'nasOrigin') and record[key] == ''):
                    continue
                value = str(record[key]).encode()
                option = flag.encode()
                if option + b'=' + value not in command and not any(command[i] == option and command[i + 1] == value for i in range(len(command) - 1)):
                    stop('Live process configuration differs from its record; inspect manually')
            # Go uses the last occurrence. Compare that effective optional value,
            # including the disabled default, rather than accepting any matching flag.
            nas_value = b''
            for index, argument in enumerate(command):
                if argument.startswith(b'--nas-origin=') or argument.startswith(b'-nas-origin='):
                    nas_value = argument.split(b'=', 1)[1]
                elif argument in (b'--nas-origin', b'-nas-origin') and index + 1 < len(command):
                    nas_value = command[index + 1]
            if nas_value != str(record.get('nasOrigin', '')).encode():
                stop('Live process configuration differs from its record; inspect manually')
            stop('Store is already running (PID %d); process, metadata and releases preserved' % pid)
    # Also refuse a store started manually without a PID record.
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            base = '/proc/' + name
            if process_state(int(name))[0] == 'Z':
                continue
            if os.stat(base).st_uid != os.getuid():
                continue
            with open(base + '/cmdline', 'rb') as handle:
                args = handle.read(65536).split(b'\0')
            def argument_is(flag, value):
                return flag + b'=' + value in args or any(args[i] == flag and args[i + 1] == value for i in range(len(args) - 1))
            owns_data = argument_is(b'--data-dir', metadata.encode())
            same_storage = argument_is(b'--storage-root', storage.encode())
            executable = os.path.realpath(base + '/exe')
            if (owns_data or same_storage) and os.path.basename(executable) == 'space-store':
                stop('Another store is using this metadata or storage root; inspect manually before deployment')
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass

def port_available(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            # Match Go's restart semantics after an orderly TCP close. Do not use
            # SO_REUSEPORT: an actual listener must still block this deployment.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('0.0.0.0', port))
            probe.listen(1)
        except OSError:
            stop('Chosen port is occupied; no existing process or container will be stopped')

def preflight(root, storage, port, engine):
    if os.getuid() == 0:
        stop('Run as the configured non-root SSH user')
    root_stat = directory(root)
    directory(storage)
    metadata = os.path.join(root, 'metadata')
    marker = os.path.join(root, '.space-store-deploy.json')
    if os.path.lexists(marker):
        record = read_json(marker)
        if record != {'schema': 1, 'service': 'space-store', 'root': root, 'uid': os.getuid(), 'device': root_stat.st_dev, 'inode': root_stat.st_ino}:
            stop('Deployment root ownership marker differs; do not take over this directory')
        for name in ('releases', 'metadata', 'logs', 'run'):
            path = os.path.join(root, name)
            if os.path.lexists(path):
                directory(path)
    elif os.listdir(root):
        stop('First deployment requires an empty dedicated directory; existing files are preserved')
    check_processes(root, metadata, storage)
    port_available(port)
    if engine == 'local':
        host = os.environ.get('DOCKER_HOST', '')
        endpoint = json.loads(subprocess.check_output(['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], text=True, stderr=subprocess.DEVNULL, timeout=15))
        if (host and not host.startswith('unix://')) or not endpoint.startswith('unix://'):
            stop('Docker must use a local Unix socket')
        subprocess.check_output(['docker', 'info', '--format', '{{json .ServerVersion}}'], stderr=subprocess.DEVNULL, timeout=20)
        subprocess.check_output(['docker', 'ps', '--format', '{{.ID}}'], stderr=subprocess.DEVNULL, timeout=20)
    return root_stat

def deploy(root, storage, release_id, port, engine, publish, access, public, nas, expected_sha):
    # Verify again after the local build; preflight never grants permission to kill.
    root_stat = preflight(root, storage, port, engine)
    blob = sys.stdin.buffer.read((200 << 20) + 1)
    if len(blob) > 200 << 20 or hashlib.sha256(blob).hexdigest() != expected_sha:
        stop('Transfer size or checksum differs; no release was written')
    archive = tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz')
    members = archive.getmembers()
    names = set()
    if not members or len(members) > 10000 or sum(m.size for m in members) > 200 << 20:
        stop('Unexpected release archive')
    for member in members:
        name = member.name
        valid_name = name in ('space-store', 'release.json') or name.startswith('web/')
        if not member.isfile() or not valid_name or name in names or os.path.normpath(name) != name or name.startswith('/') or '..' in name.split('/') or member.size > 100 << 20:
            stop('Unsafe or duplicate release archive entry')
        names.add(name)
    if not {'space-store', 'release.json', 'web/store.html'}.issubset(names) or 'web/index.html' in names:
        stop('Archive is not a standalone store')
    manifest = json.load(archive.extractfile('release.json'))
    expected_arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if manifest.get('service') != 'space-store' or manifest.get('release') != release_id or manifest.get('arch') != expected_arch:
        stop('Release architecture or identity differs')
    marker = os.path.join(root, '.space-store-deploy.json')
    if not os.path.lexists(marker):
        new_json(marker, {'schema': 1, 'service': 'space-store', 'root': root, 'uid': os.getuid(), 'device': root_stat.st_dev, 'inode': root_stat.st_ino})
    lock_path = os.path.join(root, '.space-store-deploy.lock')
    try:
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(lock_fd, 'r+') as lock:
        entry = os.fstat(lock.fileno())
        if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid() or stat.S_IMODE(entry.st_mode) != 0o600:
            stop('Unexpected deployment lock; inspect manually')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            stop('Another deployment is in progress')
        preflight(root, storage, port, engine)
        for name in ('releases', 'metadata', 'logs', 'run'):
            path = os.path.join(root, name)
            if not os.path.lexists(path):
                os.mkdir(path, 0o700)
            directory(path)
        release = os.path.join(root, 'releases', release_id)
        os.mkdir(release, 0o700)  # Exclusive: never overwrite a previous release.
        for member in members:
            target = os.path.join(release, member.name)
            parent = os.path.dirname(target)
            if not os.path.exists(parent):
                os.makedirs(parent, mode=0o700)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if member.name == 'space-store' else 0o600)
            with os.fdopen(fd, 'wb') as handle:
                source = archive.extractfile(member)
                while True:
                    block = source.read(1 << 20)
                    if not block:
                        break
                    handle.write(block)
        executable = os.path.join(release, 'space-store')
        metadata = os.path.join(root, 'metadata')
        listen = '0.0.0.0:%d' % port
        log_path = os.path.join(root, 'logs', release_id + '.log')
        log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        # A final collision check limits the race; the Go listener also fails closed.
        port_available(port)
        arguments = store_arguments(executable, listen, os.path.join(release, 'web'), metadata, engine, storage, publish, access, public, nas)
        with os.fdopen(log_fd, 'wb') as log:
            process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=release, start_new_session=True, close_fds=True)
        record_path = os.path.join(root, 'run', release_id + '.json')
        new_json(record_path, {'schema': 1, 'service': 'space-store', 'release': release_id, 'pid': process.pid, 'startTicks': start_ticks(process.pid), 'executable': executable, 'dataDir': metadata, 'storageRoot': storage, 'listen': listen, 'engine': engine, 'publishHost': publish, 'accessHost': access, 'publicOrigin': public, 'nasOrigin': nas, 'log': log_path})
        health = None
        for attempt in range(40):
            if process.poll() is not None:
                stop('Store exited during startup; release, metadata and log preserved for inspection')
            try:
                request = urllib.request.Request('http://127.0.0.1:%d/api/health' % port)
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(request, timeout=1) as response:
                    health = json.load(response)
                data = health.get('data', {})
                if health.get('ok') is True and data.get('service') == 'space-store' and isinstance(data.get('instanceId'), str):
                    break
                health = None
            except Exception:
                health = None
            time.sleep(0.25)
        if health is None:
            stop('Health was not confirmed; process and all files preserved, inspect the recorded PID and log')
        # Compare the instance with the new process ready event, not a pre-existing HTTP service.
        ready = None
        with open(log_path) as log:
            for line in log:
                try:
                    item = json.loads(line)
                    if item.get('event') == 'ready':
                        ready = item
                        break
                except json.JSONDecodeError:
                    continue
        if ready is None or ready.get('instanceId') != health['data']['instanceId'] or process.poll() is not None:
            stop('HTTP process identity was not confirmed; inspect recorded PID and log')
        print(json.dumps({'ok': True, 'service': 'space-store', 'release': release_id, 'pid': process.pid, 'port': port, 'metadata': metadata, 'log': log_path, 'engine': engine, 'publishHost': publish, 'accessHost': access, 'publicOrigin': public, 'nasOrigin': nas}))

try:
    phase, root, storage, release_id, port, engine, publish, access, public, nas = sys.argv[1:11]
    port = int(port)
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}', release_id) or port < 1024 or port > 65535 or port == 5055 or engine not in ('local', 'disabled'):
        stop('Invalid deployment arguments')
    validate_addresses(publish, access, public)
    try:
        validate_nas_origin(nas)
    except ValueError:
        stop('NAS origin must be a canonical bare HTTP(S) origin')
    if phase == 'probe':
        preflight(root, storage, port, engine)
        machine = platform.machine()
        if machine not in ('x86_64', 'aarch64'):
            stop('Unsupported NAS architecture')
        print(json.dumps({'arch': machine, 'uid': os.getuid()}))
    elif phase == 'deploy':
        deploy(root, storage, release_id, port, engine, publish, access, public, nas, sys.argv[11])
    else:
        stop('Unknown deployment phase')
except DeploymentError as error:
    print('Deployment stopped: ' + str(error), file=sys.stderr)
    sys.exit(1)
except subprocess.TimeoutExpired:
    print('Deployment stopped: Required NAS command timed out; inspect connection and permissions', file=sys.stderr)
    sys.exit(1)
except subprocess.CalledProcessError:
    print('Deployment stopped: Required NAS command failed; inspect connection and permissions', file=sys.stderr)
    sys.exit(1)
except OSError as error:
    print('Deployment stopped: Required NAS path or process could not be inspected (errno %d)' % (error.errno or 0), file=sys.stderr)
    sys.exit(1)
except ValueError:
    print('Deployment stopped: Invalid deployment record or arguments; inspect manually', file=sys.stderr)
    sys.exit(1)
except Exception:
    print('Deployment stopped: Unexpected deployment failure; inspect the preserved process record and log', file=sys.stderr)
    sys.exit(1)
PY
)
task_remote_python="$task_nas_validator"$'\n'"$task_remote_python"

task_release="$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
task_probe_command="$(remote_command probe "$task_deploy_root" "$task_storage_root" "$task_release" "$task_port" "$task_engine" "$task_publish_host" "$task_access_host" "$task_public_origin" "$task_nas_origin")"
printf 'Checking selected SSH alias, dedicated directories and port %s…\n' "$task_port"
task_probe="$(sshbind exec --json "$task_alias" "$task_probe_command" | python3 -c '
import json,re,sys
result=json.load(sys.stdin)
if result.get("exit_code")!=0:
    safe_reasons={
        "Invalid publish host", "Invalid access host", "Access host must not be a wildcard", "Public origin must be a bare HTTP(S) origin", "Invalid public origin", "NAS origin must be a canonical bare HTTP(S) origin", "Invalid deployment arguments",
        "Unsafe directory argument", "Chosen directory must belong to the SSH user and have mode 0700", "Unexpected deployment record; inspect manually", "Unexpected run-directory entry; inspect manually", "Unexpected service record; inspect manually", "Invalid PID record; inspect manually",
        "Live process identity differs from its record; inspect manually", "Live process configuration differs from its record; inspect manually", "Another store is using this metadata or storage root; inspect manually before deployment",
        "Chosen port is occupied; no existing process or container will be stopped", "Run as the configured non-root SSH user", "Deployment root ownership marker differs; do not take over this directory", "First deployment requires an empty dedicated directory; existing files are preserved", "Docker must use a local Unix socket", "Unsupported NAS architecture",
        "Required NAS command timed out; inspect connection and permissions", "Required NAS command failed; inspect connection and permissions", "Invalid deployment record or arguments; inspect manually", "Unexpected deployment failure; inspect the preserved process record and log",
    }
    for line in str(result.get("stderr", "")).splitlines():
        if not line.startswith("Deployment stopped: "):
            continue
        reason=line.removeprefix("Deployment stopped: ")
        owned_pid=re.fullmatch(r"Store is already running \(PID [1-9][0-9]*\); process, metadata and releases preserved",reason)
        errno=re.fullmatch(r"Required NAS path or process could not be inspected \(errno [0-9]+\)",reason)
        if reason in safe_reasons or owned_pid or errno:
            sys.exit("Remote preflight failed: "+reason)
    sys.exit("Remote preflight failed; no deployment performed. Inspect the selected directories, process and port.")
state=json.loads(result["stdout"])
if state.get("arch") not in ("x86_64","aarch64"): sys.exit("Unsupported NAS architecture")
print(state["arch"])
')"
case "$task_probe" in x86_64) task_arch=amd64 ;; aarch64) task_arch=arm64 ;; *) fail 'Unsupported NAS architecture' ;; esac
task_artifacts="$(mktemp -d "${TMPDIR:-/tmp}/space-store-release.XXXXXXXX")"
task_artifacts="$(cd "$task_artifacts" && pwd -P)"
printf 'Building %s release in %s…\n' "$task_arch" "$task_artifacts"
(
  cd "$task_root/server"
  CGO_ENABLED=0 go build -trimpath -o "$task_artifacts/storage-diagnostics" ./cmd/storage-diagnostics
  CGO_ENABLED=0 GOOS=linux GOARCH="$task_arch" go build -trimpath -o "$task_artifacts/space-store" ./cmd/space-gateway
)

# Reuse the backend's read-only volume/cache policy instead of duplicating it.
# These checks create only isolated local diagnostic metadata, never NAS files.
check_storage() {
  "$task_artifacts/storage-diagnostics" --alias "$task_alias" --root "$1" | python3 -c '
import json,sys
output=json.load(sys.stdin)
result=output.get("data",{})
root=output.get("rootInspection",{})
candidate=root.get("data",{}).get("storage",{})
if result.get("dockerStorageSafe") is not True or root.get("ok") is not True or candidate.get("installAllowed") is not True:
    sys.exit("Storage or Docker cache policy failed; no NAS files were written")
print("Read-only storage and Docker-cache checks passed")
'
}
check_storage "$task_deploy_root"
if [[ "$task_storage_root" != "$task_deploy_root" ]]; then check_storage "$task_storage_root"; fi
(
  cd "$task_root"
  pnpm --filter @space/client typecheck
  pnpm --filter @space/client exec vite build --manifest --outDir "$task_artifacts/frontend"
)

# Bundle only the store entry and its Vite dependency closure, excluding the client entry.
python3 - "$task_artifacts" "$task_root/apps/client/public" "$task_release" "$task_arch" <<'PY'
import json, pathlib, sys, tarfile, time
artifacts, public, release, arch = sys.argv[1:]
base = pathlib.Path(artifacts)
frontend = base / 'frontend'
manifest = json.loads((frontend / '.vite/manifest.json').read_text())
if 'store.html' not in manifest:
    sys.exit('Vite did not produce the standalone store entry')
entries = set()
files = {'store.html'}
def visit(key):
    if key in entries:
        return
    entries.add(key)
    entry = manifest[key]
    files.add(entry['file'])
    files.update(entry.get('css', []))
    files.update(entry.get('assets', []))
    for imported in entry.get('imports', []) + entry.get('dynamicImports', []):
        visit(imported)
visit('store.html')
public_root = pathlib.Path(public)
if public_root.is_dir():
    files.update(str(path.relative_to(public_root)) for path in public_root.rglob('*') if path.is_file())
if 'index.html' in files or manifest.get('index.html', {}).get('file') in files:
    sys.exit('Client entry unexpectedly belongs to the store dependency graph')
release_info = base / 'release.json'
release_info.write_text(json.dumps({'service': 'space-store', 'release': release, 'arch': arch, 'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}) + '\n')
with tarfile.open(base / 'release.tar.gz', 'w:gz') as archive:
    archive.add(base / 'space-store', arcname='space-store', recursive=False)
    archive.add(release_info, arcname='release.json', recursive=False)
    for name in sorted(files):
        source = frontend / name
        if source.is_symlink() or not source.is_file() or '..' in pathlib.PurePosixPath(name).parts or name.startswith('/'):
            sys.exit('Unsafe or missing built store asset')
        archive.add(source, arcname='web/' + name, recursive=False)
PY
task_checksum="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$task_artifacts/release.tar.gz")"
task_deploy_command="$(remote_command deploy "$task_deploy_root" "$task_storage_root" "$task_release" "$task_port" "$task_engine" "$task_publish_host" "$task_access_host" "$task_public_origin" "$task_nas_origin" "$task_checksum")"
printf 'Transferring additive release %s and starting its own user process…\n' "$task_release"
# sshbind handles management. Direct SSH is only the binary stdin transfer,
# using its existing alias/config, BatchMode and connection timeout.
ssh -o BatchMode=yes -o ConnectTimeout=15 "$task_alias" "$task_deploy_command" < "$task_artifacts/release.tar.gz"
printf '\nLocal build artifacts retained: %s\n' "$task_artifacts"
task_store_host=$task_access_host
if [[ "$task_store_host" == *:* ]]; then task_store_host="[$task_store_host]"; fi
printf 'Store: http://%s:%s/ (use the SSH loopback tunnel for first administrator setup)\n' "$task_store_host" "$task_port"
printf 'Application published IP: %s; application access host: %s\n' "$task_publish_host" "$task_access_host"
if [[ -n "$task_public_origin" ]]; then printf 'Configured public browser origin: %s (proxy/HTTPS acceptance remains separate)\n' "$task_public_origin"; fi
printf 'First setup tunnel: ssh -o BatchMode=yes -o ConnectTimeout=15 -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18436:127.0.0.1:%s %s\n' "$task_port" "$task_alias"
printf 'Then open http://127.0.0.1:18436/ and enter a separate store administrator password in the browser.\n'
