#!/usr/bin/env python3
"""Initialize and supervise only this standalone shop's attested runtime.

No adoption, deletion, password configuration or arbitrary Docker commands.
The existing managed runtime remains the sole application installation engine.
"""
import ctypes
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request

RELEASE = 'shop-2026.10.16-r1'
SOCKET = '/var/run/docker.sock'
CONTROL = Path('/control')


def canonical(path):
    if not isinstance(path, str) or not path.startswith('/') or path == '/' or os.path.normpath(path) != path or re.search(r'[\x00-\x20\x7f,]', path):
        raise ValueError('Invalid dedicated data path')
    if re.match(r'^/(root|home|boot|zspace|usr|etc|bin|sbin|var|opt|run|proc|sys|dev)(/|$)', path):
        raise ValueError('A NAS data disk is required')
    return path


def configuration(env, info, control_source):
    ip = ipaddress.ip_address(env.get('NAS_IP', ''))
    if ip.version != 4 or not any(ip in ipaddress.ip_network(network) for network in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('NAS_IP must be the NAS LAN IPv4 address')
    port = int(env.get('SHOP_PORT', '18443'))
    if not 1024 <= port <= 65535 or port == 5055:
        raise ValueError('Invalid shop port')
    if info.get('OSType') != 'linux' or info.get('Architecture') not in ('x86_64', 'amd64'):
        raise ValueError('This release requires a Linux AMD64 NAS')
    raw_version = info.get('ServerVersion')
    version = re.fullmatch(r'(\d+)\.(\d+)\.\d+(?:[-+~.][0-9A-Za-z][0-9A-Za-z.+~_-]*)?', raw_version) if isinstance(raw_version, str) else None
    if not version or tuple(map(int, version.groups())) < (20, 10):
        raise ValueError('Docker 20.10 or newer is required')
    if info.get('Driver') not in ('overlay2', 'fuse-overlayfs', 'vfs', 'btrfs', 'zfs') or 'containerd' in json.dumps(info.get('DriverStatus', [])).lower():
        raise ValueError('The Docker image cache location must be verifiable')
    cache = canonical(info.get('DockerRootDir', ''))
    suffix = hashlib.sha256(control_source.encode()).hexdigest()[:12]
    # ZSpace's /data_*/data/udata/real contains separate btrfs user-data
    # subvolumes. Its stat device can differ from the host mount identity.
    # Put the new owned directory on the physical /data_* mount instead.
    disk = re.match(r'^(/data_[A-Za-z0-9]+)(?:/|$)', cache)
    default_parent = disk.group(1) if disk else str(Path(cache).parent)
    root = canonical(env.get('SHOP_DATA_ROOT') or str(Path(default_parent) / ('space-shop-' + suffix)))
    if root == cache or root.startswith(cache + '/') or cache.startswith(root + '/'):
        raise ValueError('Shop data and Docker cache must be separate')
    uid = int(env.get('SHOP_UID', '10001')); gid = int(env.get('SHOP_GID', '10001'))
    if not 1 <= uid <= 2147483647 or not 1 <= gid <= 2147483647:
        raise ValueError('The shop runtime must use a non-root account')
    config = {'root': root, 'cache': cache, 'ip': str(ip), 'port': port, 'uid': uid, 'gid': gid}
    ui_origin = env.get('SHOP_UI_ORIGIN', '')
    if ui_origin:
        if re.search(r'[\x00-\x20\x7f]', ui_origin):
            raise ValueError('SHOP_UI_ORIGIN must be a bare HTTP(S) origin')
        try:
            origin = urllib.parse.urlsplit(ui_origin)
            valid = (origin.scheme in ('http', 'https') and origin.hostname and '*' not in origin.hostname
                     and origin.username is None and origin.password is None
                     and origin.path in ('', '/') and not origin.query and not origin.fragment
                     and (origin.port is None or 1 <= origin.port <= 65535))
        except ValueError:
            valid = False
        if not valid:
            raise ValueError('SHOP_UI_ORIGIN must be a bare HTTP(S) origin without credentials')
        canonical_origin = origin.scheme + '://' + origin.netloc
        try:
            host_module().validate_nas_origin(canonical_origin)
            try:
                ipaddress.ip_address(origin.hostname)
            except ValueError:
                # WHATWG treats a numeric final label as an IPv4 address,
                # including hexadecimal numbers and the empty 0x suffix.
                # Only the canonical IP literals accepted above are stable.
                if re.fullmatch(r'(?:[0-9]+|0x[0-9a-f]*)', origin.hostname.rsplit('.', 1)[-1]):
                    raise ValueError('Noncanonical browser IPv4 host')
        except ValueError:
            raise ValueError('SHOP_UI_ORIGIN must use a canonical browser origin, for example http://192.168.3.56:18436 or https://shop.example') from None
        config['uiOrigin'] = canonical_origin
    return config


def directory_no_links(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in Path(path).parts[1:]:
            try: child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError: raise ValueError('Directory identity could not be verified') from None
            os.close(fd); fd = child
            entry = os.fstat(fd)
            if entry.st_mode & 0o022 and not (entry.st_uid == 0 and entry.st_mode & stat.S_ISVTX):
                raise ValueError('Directory ancestor is writable by other accounts')
        return os.fstat(fd)
    finally:
        os.close(fd)


def initialize(root, uid, gid, intent=None):
    # The caller mounts only the selected existing parent into a short-lived
    # initializer. Never chmod/chown/adopt an existing user directory.
    directory_no_links(str(Path(root).parent))
    if intent is not None and not re.fullmatch('[a-f0-9]{64}', intent):
        raise ValueError('Invalid directory ownership intent')
    existing = os.path.lexists(root)
    if existing and intent is None:
        raise ValueError('The selected data directory already exists; all data was preserved')
    if not existing: os.mkdir(root, 0o700)
    entry = directory_no_links(root)
    if entry.st_uid not in (os.getuid(), uid) or entry.st_gid not in (os.getgid(), gid) or stat.S_IMODE(entry.st_mode) != 0o700:
        raise ValueError('Directory ownership changed; all data was preserved')
    marker = {'schema': 1, 'intentId': intent, 'root': root, 'device': entry.st_dev, 'inode': entry.st_ino, 'uid': uid, 'gid': gid}
    marker_path = Path(root) / '.space-shop-owner.json'
    if existing:
        if read_private(marker_path) != marker:
            raise ValueError('Directory ownership changed; all data was preserved')
    elif intent is not None:
        # A crash before this proof is durable remains blocked, never adopted.
        write_private(marker_path, marker)
    paths = [root + '/service', root + '/apps', root + '/service/metadata']
    # Reject every existing expected directory before adding missing ones.
    for path in paths:
        if not os.path.lexists(path): continue
        entry = directory_no_links(path)
        if entry.st_uid not in (os.getuid(), uid) or entry.st_gid not in (os.getgid(), gid) or stat.S_IMODE(entry.st_mode) != 0o700:
            raise ValueError('Directory ownership changed; all data was preserved')
    for path in paths:
        if not os.path.lexists(path): os.mkdir(path, 0o700)
    for path in list(reversed(paths)) + [root]:
        os.chown(path, uid, gid)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)


def write_private(path, value):
    # Publish complete receipts atomically without overwriting an existing file.
    # A failed write may leave only a private temporary file, never a partial
    # deployment/intent which permanently blocks a safe retry.
    path = Path(path)
    raw = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = '.' + path.name + '-' + os.urandom(16).hex() + '.tmp'
    created = False; published = False
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        created = True
        with os.fdopen(fd, 'wb') as target:
            target.write(raw); target.flush(); os.fsync(target.fileno())
        # Linux renameat2 (and the macOS equivalent for local tests) publishes
        # without replacement and without a transient second hard link.
        libc = ctypes.CDLL(None, use_errno=True)
        operation = getattr(libc, 'renameat2', None) if sys.platform == 'linux' else getattr(libc, 'renameatx_np', None)
        if operation is None: raise ValueError('Atomic private checkpoint publication is unavailable')
        operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        operation.restype = ctypes.c_int
        if operation(parent, os.fsencode(temporary), parent, os.fsencode(path.name), 1 if sys.platform == 'linux' else 4):
            raise OSError(ctypes.get_errno(), 'Atomic private checkpoint publication failed')
        published = True
        os.fsync(parent)
    finally:
        if created and not published: os.unlink(temporary, dir_fd=parent)
        os.close(parent)


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1 or metadata.st_size > 65536:
            raise ValueError('Invalid deployment receipt; all resources were preserved')
        value = json.loads(source.read(65537))
    return value


def commit_private(path, value):
    if os.path.lexists(path):
        if read_private(path) != value:
            raise ValueError('Deployment checkpoint changed; all resources were preserved')
    else: write_private(path, value)


def replace_private(path, expected, value):
    """Switch only an attested private receipt; retain complete old receipts elsewhere."""
    path = Path(path)
    actual = read_private(path)
    if actual == value: return
    if actual != expected:
        raise ValueError('Receipt switch source changed; all resources were preserved')
    before = path.lstat()
    temporary = path.with_name('.' + path.name + '-switch-' + os.urandom(16).hex())
    published = False
    try:
        write_private(temporary, value)
        current = path.lstat()
        if (current.st_dev, current.st_ino, current.st_ctime_ns) != (before.st_dev, before.st_ino, before.st_ctime_ns) or read_private(path) != expected:
            raise ValueError('Receipt switch source changed; all resources were preserved')
        os.replace(temporary, path); published = True
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if not published and os.path.lexists(temporary): os.unlink(temporary)


class Cancelled(Exception):
    pass


def checkpoint(cancelled):
    if cancelled(): raise Cancelled()


class DockerAPI:
    def command(self, *args, timeout=30):
        completed = subprocess.run(['docker', '--host', 'unix://' + SOCKET, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        if completed.returncode or len(completed.stdout) > 2 << 20:
            raise ValueError('A required Docker operation failed; all resources were preserved')
        return completed.stdout.decode('utf-8', 'strict').strip()

    def inspect(self, identity):
        rows = json.loads(self.command('inspect', identity))
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError('Docker identity was not verified')
        return rows[0]

    def find(self, name):
        return self.command('container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}')


def validate_runtime(actual, receipt):
    p = receipt['plan']; cfg = actual.get('Config', {}); host = actual.get('HostConfig', {})
    if any(actual.get(k) != v for k, v in {'Id': receipt['containerId'], 'Image': receipt['imageId'], 'Name': '/' + p['name']}.items()):
        raise ValueError('Runtime identity changed; all resources were preserved')
    if cfg.get('User') != p['user'] or cfg.get('Entrypoint') != ['/opt/space-store/space-store'] or cfg.get('Cmd') != p['command']:
        raise ValueError('Runtime configuration changed; all resources were preserved')
    if any(cfg.get('Labels', {}).get(k) != v for k, v in p['labels'].items()):
        raise ValueError('Runtime ownership changed; all resources were preserved')
    if receipt.get('intentId') is not None and cfg.get('Labels', {}).get('io.space-store.bootstrap-intent') != receipt['intentId']:
        raise ValueError('Runtime ownership intent changed; all resources were preserved')
    expected = {'Privileged': False, 'ReadonlyRootfs': True, 'NetworkMode': 'bridge', 'CapDrop': ['ALL'], 'GroupAdd': [str(receipt['socketGid'])], 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=32m'}, 'PortBindings': {'18435/tcp': [{'HostIp': p['ip'], 'HostPort': str(p['port'])}]}, 'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}}
    if any(host.get(k) != v for k, v in expected.items()) or host.get('SecurityOpt') not in (['no-new-privileges'], ['no-new-privileges:true']):
        raise ValueError('Runtime restrictions changed; all resources were preserved')
    if any(host.get(k) for k in ('CapAdd', 'Devices', 'DeviceRequests', 'Binds', 'VolumesFrom')):
        raise ValueError('Runtime privileges changed; all resources were preserved')
    if any(host.get(k, '') not in ('', 'private') for k in ('PidMode', 'UTSMode', 'CgroupnsMode', 'IpcMode')):
        raise ValueError('Runtime namespaces changed; all resources were preserved')
    def mount_key(m):
        return (m.get('Type'), m.get('Source'), m.get('Destination'), m.get('RW'), m.get('Propagation', 'rprivate'))
    expected_mounts = [('bind', m['Source'], m['Destination'], m['RW'], 'rslave' if m['Source'] == p['dockerRoot'] else 'rprivate') for m in p['mounts']]
    actual_mounts = [mount_key(m) for m in actual.get('Mounts', [])]
    if len(actual_mounts) != len(expected_mounts) or set(actual_mounts) != set(expected_mounts):
        raise ValueError('Runtime storage mappings changed; all resources were preserved')
    env = cfg.get('Env', [])
    if any(item.startswith(('DOCKER_HOST=', 'SPACE_CLOUD_DATABASE_URL=')) for item in env):
        raise ValueError('Runtime engine configuration changed; all resources were preserved')


def stop_owned(api, receipt):
    actual = api.inspect(receipt['containerId'])
    validate_runtime(actual, receipt)
    if actual.get('State', {}).get('Running'):
        api.command('container', 'stop', '--time', '15', receipt['containerId'])


def host_module():
    path = Path('/opt/space-store/host.py')
    if not path.exists(): path = Path(__file__).resolve().parents[2] / 'scripts/store-container-host.py'
    spec = importlib.util.spec_from_file_location('managed_shop_host', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def validate_helper(actual, cid, image, name, mount, arguments, user, labels, root):
    cfg = actual.get('Config', {}); host = actual.get('HostConfig', {})
    expected = {'Id': cid, 'Image': image, 'Name': '/' + name}
    if not re.fullmatch('[a-f0-9]{64}', cid) or any(actual.get(k) != v for k, v in expected.items()):
        raise ValueError('Initializer identity changed; all resources were preserved')
    if cfg.get('User') != user or cfg.get('Entrypoint') != ['python3'] or cfg.get('Cmd') != ['/opt/space-store/bootstrap.py', *arguments] or cfg.get('Labels') != labels:
        raise ValueError('Initializer ownership changed; all resources were preserved')
    expected_host = {'Privileged': False, 'ReadonlyRootfs': True, 'NetworkMode': 'none', 'CapDrop': ['ALL'], 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=32m'}, 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}}
    if any(host.get(k) != v for k, v in expected_host.items()) or host.get('SecurityOpt') not in (['no-new-privileges'], ['no-new-privileges:true']):
        raise ValueError('Initializer restrictions changed; all resources were preserved')
    if set(host.get('CapAdd') or []) != ({'CHOWN', 'DAC_OVERRIDE'} if root else set()) or any(host.get(k) for k in ('Devices', 'DeviceRequests', 'Binds', 'VolumesFrom', 'GroupAdd', 'PortBindings')):
        raise ValueError('Initializer privileges changed; all resources were preserved')
    if any(host.get(k, '') not in ('', 'private') for k in ('PidMode', 'UTSMode', 'CgroupnsMode', 'IpcMode')):
        raise ValueError('Initializer namespaces changed; all resources were preserved')
    fields = dict(piece.split('=', 1) for piece in mount.split(',') if '=' in piece)
    propagation = fields.get('bind-propagation')
    if propagation not in ('rprivate', 'rslave') or (propagation == 'rslave' and (not root or labels.get('io.space-store.bootstrap-phase') != 'initialize')):
        raise ValueError('Initializer propagation plan was not verified')
    mounts = [(m.get('Type'), m.get('Source'), m.get('Destination'), m.get('RW'), m.get('Propagation')) for m in actual.get('Mounts', [])]
    if mounts != [('bind', fields['src'], fields['dst'], True, propagation)]:
        raise ValueError('Initializer mappings changed; all resources were preserved')


def helper(api, image, name, mount, arguments, intent, phase, root=False, owner='10001:10001', cancelled=lambda: False, journal_prefix='', rerun=False, stop_only=False):
    path = CONTROL / (journal_prefix + 'helper-' + phase + '.json')
    labels = {**host_module().BASE_LABELS, 'io.space-store.service': 'space-store', 'io.space.role': 'shop-initializer', 'io.space-store.bootstrap-intent': intent, 'io.space-store.bootstrap-phase': phase}
    user = '0:0' if root else owner
    saved = read_private(path) if os.path.lexists(path) else None
    if saved is not None and (saved.get('schema') != 1 or saved.get('intentId') != intent):
        raise ValueError('Initializer checkpoint changed; all resources were preserved')
    identity = saved['containerId'] if saved is not None else api.find(name)
    if not identity and stop_only: return
    def create():
        checkpoint(cancelled)
        args = ['container', 'create', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--network', 'none', '--cgroupns', 'private', '--ipc', 'private', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--mount', mount, '--user', user]
        for key, value in sorted(labels.items()): args += ['--label', key + '=' + value]
        # Root can traverse its attested 0700 directories after CHOWN when
        # resuming. These capabilities never reach the non-root runtime.
        if root: args += ['--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE']
        args += ['--entrypoint', 'python3', image, '/opt/space-store/bootstrap.py', *arguments]
        return api.command(*args)
    if not identity: identity = create()
    actual = api.inspect(identity)
    cid = saved['containerId'] if saved is not None else actual.get('Id', '')
    # Older cgroup-v1 daemons defaulted to host cgroups. The old initializer
    # was rejected before its first start or checkpoint. Only that exact,
    # never-started, unjournaled helper may be replaced with private namespaces.
    host = actual.get('HostConfig', {})
    state = actual.get('State', {})
    if saved is None and not stop_only and state.get('Status') == 'created' and state.get('Running') is False and (host.get('CgroupnsMode') == 'host' or host.get('IpcMode') == 'shareable'):
        legacy = {**actual, 'HostConfig': {**host}}
        if host.get('CgroupnsMode') == 'host': legacy['HostConfig']['CgroupnsMode'] = 'private'
        if host.get('IpcMode') == 'shareable': legacy['HostConfig']['IpcMode'] = 'private'
        validate_helper(legacy, cid, image, name, mount, arguments, user, labels, root)
        checkpoint(cancelled)
        # No force flag: Docker independently refuses removal if it started.
        api.command('container', 'rm', cid)
        identity = create(); actual = api.inspect(identity); cid = actual.get('Id', '')
    validate_helper(actual, cid, image, name, mount, arguments, user, labels, root)
    if stop_only:
        if actual.get('State', {}).get('Running'):
            api.command('container', 'stop', '--time', '15', cid)
        actual = api.inspect(cid)
        validate_helper(actual, cid, image, name, mount, arguments, user, labels, root)
        if actual.get('State', {}).get('Running') is not False:
            raise ValueError('Receipt helper stop was not verified; all resources were preserved')
        return
    checkpoint(cancelled)
    commit_private(path, {'schema': 1, 'containerId': cid, 'intentId': intent})
    state = actual.get('State', {})
    if state.get('Status') == 'exited' and state.get('ExitCode') == 0 and not rerun: return
    if not state.get('Running'):
        checkpoint(cancelled)
        api.command('container', 'start', cid)
    for _ in range(60):
        checkpoint(cancelled)
        actual = api.inspect(cid)
        validate_helper(actual, cid, image, name, mount, arguments, user, labels, root)
        state = actual.get('State', {})
        if state.get('Status') == 'exited':
            if state.get('ExitCode') == 0: return
            raise ValueError('Initializer failed; all resources were preserved')
        time.sleep(1)
    raise ValueError('Initializer did not finish; all resources were preserved')


def runtime_plan(config, socket_gid, release=None):
    host = host_module()
    p = host.plan(config['root'] + '/service', config['root'] + '/apps', config['ip'], config['port'], release or RELEASE, config['uid'], config['gid'], 'local', config['cache'], socket_gid)
    p['command'] += ['--setup-mode', 'lan']
    if config.get('uiOrigin'):
        p['command'] += ['--public-origin', config['uiOrigin']]
    p['labels']['io.space.role'] = 'standalone-shop-runtime'
    return p


def validate_settings(receipt, p, image, socket_gid):
    if receipt.get('schema') != 1 or receipt.get('plan') != p or receipt.get('imageId') != image or receipt.get('socketGid') != socket_gid:
        raise ValueError('Deployment settings changed; keep the original configuration and data')
    if receipt.get('intentId') is not None and not re.fullmatch('[a-f0-9]{64}', receipt['intentId']):
        raise ValueError('Deployment ownership intent changed; all resources were preserved')


def pending_intent(config, socket_gid):
    path = CONTROL / 'intent.json'
    if not os.path.lexists(path): return None
    intent = read_private(path)
    release = intent.get('plan', {}).get('release', '')
    image = intent.get('imageId', '')
    if not isinstance(image, str) or not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('Pending image identity was not verified')
    # A newer bootstrap must be able to finish its own interrupted initial
    # install. Validate the entire historical plan before using its old image.
    validate_settings(intent, runtime_plan(config, socket_gid, release), image, socket_gid)
    if not re.fullmatch('[a-f0-9]{64}', intent.get('intentId', '')):
        raise ValueError('Deployment ownership intent changed; all resources were preserved')
    return intent


def resolve_pending_runtime(api, intent):
    path = CONTROL / 'runtime.json'
    receipt = read_private(path) if os.path.lexists(path) else None
    if receipt is not None:
        validate_settings(receipt, intent['plan'], intent['imageId'], intent['socketGid'])
        if receipt.get('intentId') != intent['intentId']:
            raise ValueError('Runtime checkpoint changed; all resources were preserved')
        actual = api.inspect(receipt['containerId'])
    else:
        identity = api.find(intent['plan']['name'])
        if not identity: return None
        actual = api.inspect(identity)
        receipt = {**intent, 'containerId': actual.get('Id', '')}
    validate_runtime(actual, receipt)
    return receipt


def owned_runtime(api, own, config, socket_gid):
    """Read-only recovery for cleanup, including a lost create/start response."""
    p = runtime_plan(config, socket_gid); image = own['Image']
    path = CONTROL / 'deployment.json'
    if os.path.lexists(path):
        receipt = read_private(path)
        validate_deployment(api, receipt, config, socket_gid, allow_origin_migration=receipt.get('imageId') != image)
        validate_runtime(api.inspect(receipt['containerId']), receipt)
        return receipt
    intent = pending_intent(config, socket_gid)
    return resolve_pending_runtime(api, intent) if intent is not None else None


def validate_deployment(api, receipt, config, socket_gid, allow_origin_migration=False):
    # Historical release/image identities are validated independently of the
    # newly pulled bootstrap image, never treated as permission to adopt a name.
    p = runtime_plan(config, socket_gid, receipt['plan']['release'])
    if allow_origin_migration and config.get('uiOrigin'):
        # Only a new image may add the explicitly configured UI origin. The
        # complete historical plan must still match before controlling it;
        # changing/removing an existing origin or any host setting stays blocked.
        original = runtime_plan({key: value for key, value in config.items() if key != 'uiOrigin'}, socket_gid, receipt['plan']['release'])
        if receipt['plan'] == original:
            p = original
    image = receipt['imageId']
    if not isinstance(image, str) or not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('Deployment image identity was not verified')
    validate_settings(receipt, p, image, socket_gid)
    validate_runtime(api.inspect(receipt['containerId']), receipt)


def self_receipt(receipt):
    p = receipt['plan']
    return {'schema': 1, 'service': 'space-store', 'deployment': p['labels']['io.space-store.deployment'], 'release': p['release'], 'containerId': receipt['containerId'], 'imageId': receipt['imageId']}


def start_owned(api, receipt, cancelled=lambda: False):
    actual = api.inspect(receipt['containerId']); validate_runtime(actual, receipt)
    checkpoint(cancelled)
    if not actual.get('State', {}).get('Running'):
        api.command('container', 'start', receipt['containerId'])
    checkpoint(cancelled)


def wait_bootstrap(config, cancelled=lambda: False):
    for _ in range(30):
        checkpoint(cancelled)
        try: return bootstrap_state(config)
        except (OSError, ValueError):
            checkpoint(cancelled); time.sleep(1)
    raise ValueError('Shop did not become ready; all resources were preserved')


def upgrade_candidate(api, target, prefix):
    path = CONTROL / (prefix + 'candidate.json')
    if os.path.lexists(path):
        receipt = read_private(path)
        if {key: value for key, value in receipt.items() if key != 'containerId'} != target:
            raise ValueError('Upgrade candidate checkpoint changed; all resources were preserved')
        actual = api.inspect(receipt['containerId'])
    else:
        identity = api.find(target['plan']['name'])
        if not identity: return None
        actual = api.inspect(identity); receipt = {**target, 'containerId': actual.get('Id', '')}
    validate_runtime(actual, receipt)
    return receipt


def upgrade_runtime(api, own, config, socket_gid, source, cancelled):
    image = own['Image']
    if not re.fullmatch('sha256:[a-f0-9]{64}', image): raise ValueError('Upgrade image identity was not verified')
    prefix = 'upgrade-' + image[7:] + '-'
    intent_path = CONTROL / (prefix + 'intent.json')
    plan = runtime_plan(config, socket_gid, RELEASE + '-' + image[7:19])
    try:
        if os.path.lexists(intent_path):
            intent = read_private(intent_path); target = intent['target']
            expected_target = {'schema': 1, 'imageId': image, 'plan': plan, 'socketGid': socket_gid, 'intentId': target.get('intentId')}
            if intent != {'schema': 1, 'source': source, 'target': expected_target} or not isinstance(target.get('intentId'), str) or not re.fullmatch('[a-f0-9]{64}', target['intentId']):
                raise ValueError('Upgrade intent changed; all resources were preserved')
        else:
            if api.find(plan['name']): raise ValueError('The upgrade name is already in use; no service was adopted')
            target = {'schema': 1, 'imageId': image, 'plan': plan, 'socketGid': socket_gid, 'intentId': os.urandom(32).hex()}
            intent = {'schema': 1, 'source': source, 'target': target}
            checkpoint(cancelled); write_private(intent_path, intent)
        candidate = upgrade_candidate(api, target, prefix)
    except Exception:
        # A rejected name/configuration is not a request to shut down the old
        # service. Restore it only before any receipt writer was authorized.
        # A running unknown candidate may already be a recovery-stage writer.
        if any(os.path.lexists(CONTROL / (prefix + 'helper-' + phase + '.json')) for phase in ('switch', 'rollback')):
            raise
        actual = api.inspect(source['containerId']); validate_runtime(actual, source)
        identity = api.find(plan['name'])
        if not actual.get('State', {}).get('Running') and identity and api.inspect(identity).get('State', {}).get('Running') is not False:
            raise
        start_owned(api, source, cancelled)
        print(json.dumps({'event': 'upgrade_rejected', 'runtimeContainerId': source['containerId'], 'targetImageId': image}), flush=True)
        return source
    failed = CONTROL / (prefix + 'failed.json')
    nonce = target['intentId'][:16]
    mount = 'type=bind,src=' + config['root'] + '/service/metadata,dst=/write,bind-propagation=rprivate,bind-recursive=disabled'
    def switch(old, new, phase):
        opposite = 'rollback' if phase == 'switch' else 'switch'
        # A timed-out/interrupted helper can still finish a CAS later. Attest
        # and stop the opposite writer before authorizing another direction.
        helper(api, image, 'shop-' + opposite + '-' + nonce, mount, ['--replace-receipt', json.dumps(self_receipt(new)), json.dumps(self_receipt(old))], target['intentId'], opposite, owner=plan['user'], journal_prefix=prefix, stop_only=True)
        helper(api, image, 'shop-' + phase + '-' + nonce, mount, ['--replace-receipt', json.dumps(self_receipt(old)), json.dumps(self_receipt(new))], target['intentId'], phase, owner=plan['user'], journal_prefix=prefix, rerun=True)
    if os.path.lexists(failed):
        if read_private(failed) != {'schema': 1, 'sourceId': source['containerId'], 'targetImageId': image}:
            raise ValueError('Upgrade failure checkpoint changed; all resources were preserved')
        checkpoint(cancelled)
        switch(candidate or source, source, 'rollback')
        start_owned(api, source, cancelled)
        print(json.dumps({'event': 'upgrade_failed', 'runtimeContainerId': source['containerId'], 'targetImageId': image}), flush=True)
        return source
    try:
        if candidate is None:
            args = host_module().create_arguments(plan, image)
            args[2:2] = ['--no-healthcheck', '--label', 'io.space-store.bootstrap-intent=' + target['intentId']]
            checkpoint(cancelled)
            cid = api.command(*args[1:]); candidate = {**target, 'containerId': cid}
            validate_runtime(api.inspect(cid), candidate)
        checkpoint(cancelled)
        commit_private(CONTROL / (prefix + 'candidate.json'), candidate)
        state_path = CONTROL / (prefix + 'source-state.json')
        if os.path.lexists(state_path):
            state = read_private(state_path)
            if not isinstance(state, dict) or set(state) != {'storeId', 'configured'} or not isinstance(state.get('storeId'), str) or not re.fullmatch('[a-f0-9]{48}', state['storeId']) or not isinstance(state.get('configured'), bool):
                raise ValueError('Source shop identity checkpoint changed')
        else:
            # Compose has already stopped the old bootstrap. Restart only this
            # attested old worker long enough to bind the public store identity.
            if api.inspect(candidate['containerId']).get('State', {}).get('Running') is not False:
                raise ValueError('Running candidate has no source identity checkpoint')
            start_owned(api, source, cancelled)
            state = wait_bootstrap(config, cancelled)
            if not re.fullmatch('[a-f0-9]{48}', state.get('nasAuth', {}).get('storeId', '')) or not isinstance(state.get('configured'), bool):
                raise ValueError('Source shop identity was not verified')
            state = {'storeId': state['nasAuth']['storeId'], 'configured': state['configured']}
            checkpoint(cancelled); write_private(state_path, state)
        checkpoint(cancelled)
        stop_owned(api, source)
        if api.inspect(source['containerId']).get('State', {}).get('Running') is not False:
            raise ValueError('Old shop stop was not verified')
        checkpoint(cancelled)
        switch(source, candidate, 'switch')
        checkpoint(cancelled)
        start_owned(api, candidate, cancelled)
        observed = wait_bootstrap(config, cancelled)
        if observed.get('nasAuth', {}).get('storeId') != state['storeId'] or observed.get('configured') != state['configured']:
            raise ValueError('Upgraded shop identity changed; original deployment was retained')
        checkpoint(cancelled)
        commit_private(CONTROL / (prefix + 'previous.json'), source)
        replace_private(CONTROL / 'deployment.json', source, candidate)
        return candidate
    except Exception as error:
        # Atomic deployment publication is the commit boundary, including a
        # lost directory-fsync response after the complete replacement landed.
        if candidate is not None and read_private(CONTROL / 'deployment.json') == candidate:
            if isinstance(error, Cancelled): raise
            return candidate
        candidate = candidate or upgrade_candidate(api, target, prefix)
        if candidate is not None:
            stop_owned(api, candidate)
            switch(candidate, source, 'rollback')
        if isinstance(error, Cancelled) or cancelled():
            stop_owned(api, source)
            raise Cancelled() from None
        start_owned(api, source)
        wait_bootstrap(config)
        commit_private(failed, {'schema': 1, 'sourceId': source['containerId'], 'targetImageId': image})
        print(json.dumps({'event': 'upgrade_failed', 'runtimeContainerId': source['containerId'], 'targetImageId': image}), flush=True)
        return source


def ensure_runtime(api, own, config, socket_gid, cancelled=lambda: False):
    p = runtime_plan(config, socket_gid)
    image = own['Image']; path = CONTROL / 'deployment.json'
    checkpoint(cancelled)
    if os.path.lexists(path):
        receipt = read_private(path)
        validate_deployment(api, receipt, config, socket_gid, allow_origin_migration=receipt.get('imageId') != image)
        if receipt['imageId'] != image:
            return upgrade_runtime(api, own, config, socket_gid, receipt, cancelled)
    else:
        intent = pending_intent(config, socket_gid)
        if intent is None:
            if api.find(p['name']): raise ValueError('The runtime name is already in use; no service was adopted')
            intent = {'schema': 1, 'intentId': os.urandom(32).hex(), 'imageId': image, 'plan': p, 'socketGid': socket_gid}
            checkpoint(cancelled)
            write_private(CONTROL / 'intent.json', intent)
        p = intent['plan']; image = intent['imageId']
        nonce = intent['intentId'][:16]
        parent = str(Path(config['root']).parent)
        # Docker requires slave propagation when this existing parent contains
        # its verified cache root. Other helper mounts remain private.
        propagation = 'rslave' if config['cache'] == parent or config['cache'].startswith(parent + '/') else 'rprivate'
        helper(api, image, 'shop-initialize-' + nonce, 'type=bind,src=' + parent + ',dst=' + parent + ',bind-propagation=' + propagation + ',bind-recursive=disabled', ['--init-directories', config['root'], str(config['uid']), str(config['gid']), intent['intentId']], intent['intentId'], 'initialize', root=True, cancelled=cancelled)
        checkpoint(cancelled)
        receipt = resolve_pending_runtime(api, intent)
        if receipt is None:
            args = host_module().create_arguments(p, image)
            # Keep the managed plan intact; bind only new runtimes to the intent.
            args[2:2] = ['--no-healthcheck', '--label', 'io.space-store.bootstrap-intent=' + intent['intentId']]
            checkpoint(cancelled)
            cid = api.command(*args[1:])
            receipt = {**intent, 'containerId': cid}
            validate_runtime(api.inspect(cid), receipt)
        checkpoint(cancelled)
        commit_private(CONTROL / 'runtime.json', receipt)
        cid = receipt['containerId']
        self_receipt = {'schema': 1, 'service': 'space-store', 'deployment': p['labels']['io.space-store.deployment'], 'release': p['release'], 'containerId': cid, 'imageId': image}
        helper(api, image, 'shop-receipt-' + nonce, 'type=bind,src=' + config['root'] + '/service/metadata,dst=/write,bind-propagation=rprivate,bind-recursive=disabled', ['--write-receipt', json.dumps(self_receipt)], intent['intentId'], 'receipt', owner=p['user'], cancelled=cancelled)
        checkpoint(cancelled)
        write_private(path, receipt)
    checkpoint(cancelled)
    actual = api.inspect(receipt['containerId']); validate_runtime(actual, receipt)
    if not actual.get('State', {}).get('Running'):
        checkpoint(cancelled)
        api.command('container', 'start', receipt['containerId'])
    checkpoint(cancelled)
    if receipt['imageId'] != own['Image']:
        return ensure_runtime(api, own, config, socket_gid, cancelled)
    return receipt


def bootstrap_state(config):
    # Use the fixed local runtime without an environment proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    target = 'http://' + config['ip'] + ':' + str(config['port'])
    with opener.open(target + '/api/store/bootstrap', timeout=3) as response:
        body = json.loads(response.read(65537))
    if body.get('data', {}).get('authMode') != 'independent' or body['data'].get('setupRequiresLoopback') is not False:
        raise ValueError('Independent shop startup was not verified')
    return body['data']


def ready(config):
    bootstrap_state(config)
    return 'http://' + config['ip'] + ':' + str(config['port'])


def supervise():
    stopping = False
    def terminate(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, terminate); signal.signal(signal.SIGINT, terminate)
    fd = None; locked = False; api = None; own = None; config = None; socket_gid = None
    try:
        checkpoint(lambda: stopping)
        os.umask(0o077)
        entry = directory_no_links(str(CONTROL))
        if entry.st_uid != os.getuid() or stat.S_IMODE(entry.st_mode) != 0o700:
            raise ValueError('The control volume must be private; existing permissions were not changed')
        checkpoint(lambda: stopping)
        fd = os.open(CONTROL / 'supervisor.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); locked = True
        api = DockerAPI()
        hostname = socket.gethostname()
        if not re.fullmatch('[a-f0-9]{12}', hostname) or os.environ.get('HOSTNAME') != hostname:
            raise ValueError('Supervisor identity was not verified')
        own = api.inspect(hostname)
        if not own.get('Id', '').startswith(hostname) or own.get('Config', {}).get('Hostname') != hostname or own.get('Config', {}).get('Labels', {}).get('io.space.role') != 'standalone-shop-bootstrap':
            raise ValueError('Supervisor ownership was not verified')
        mounts = [m for m in own.get('Mounts', []) if m.get('Destination') == '/control' and m.get('Type') == 'volume' and m.get('RW') is True]
        if len(mounts) != 1: raise ValueError('A dedicated named control volume is required')
        info = json.loads(api.command('info', '--format', '{{json .}}'))
        config = configuration(os.environ, info, mounts[0]['Source'])
        socket_gid = os.stat(SOCKET).st_gid
        receipt = ensure_runtime(api, own, config, socket_gid, cancelled=lambda: stopping)
        for _ in range(30):
            checkpoint(lambda: stopping)
            try:
                address = ready(config); break
            except (OSError, ValueError):
                checkpoint(lambda: stopping)
                time.sleep(1)
        else: raise ValueError('Shop did not become ready; data and containers were preserved')
        checkpoint(lambda: stopping)
        print(json.dumps({'event': 'ready', 'address': address, 'runtimeContainerId': receipt['containerId']}), flush=True)
        while not stopping:
            actual = api.inspect(receipt['containerId']); validate_runtime(actual, receipt)
            if not actual.get('State', {}).get('Running'):
                raise ValueError('Shop runtime stopped; all resources were preserved')
            checkpoint(lambda: stopping)
            time.sleep(2)
    except Cancelled:
        return
    finally:
        try:
            if locked and api is not None and own is not None and config is not None and socket_gid is not None:
                receipt = owned_runtime(api, own, config, socket_gid)
                if receipt is not None: stop_owned(api, receipt)
        finally:
            if fd is not None: os.close(fd)


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--replace-receipt':
        replace_private('/write/.space-store-container-self.json', json.loads(sys.argv[2]), json.loads(sys.argv[3])); return
    if len(sys.argv) == 6 and sys.argv[1] == '--init-directories':
        initialize(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]); return
    if len(sys.argv) == 5 and sys.argv[1] == '--init-directories':
        initialize(sys.argv[2], int(sys.argv[3]), int(sys.argv[4])); return
    if len(sys.argv) == 3 and sys.argv[1] == '--write-receipt':
        commit_private('/write/.space-store-container-self.json', json.loads(sys.argv[2])); return
    if len(sys.argv) == 2 and sys.argv[1] == '--health':
        receipt = read_private(CONTROL / 'deployment.json')
        ready({'ip': receipt['plan']['ip'], 'port': receipt['plan']['port']}); return
    if len(sys.argv) != 1: raise ValueError('Invalid bootstrap operation')
    supervise()


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # Never forward subprocess output, request bodies, credentials or paths.
        safe = str(error) if isinstance(error, ValueError) else 'Standalone shop startup failed; all resources were preserved'
        print(safe, file=sys.stderr); sys.exit(1)
