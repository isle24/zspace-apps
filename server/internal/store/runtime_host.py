"""Guarded host implementation. No cleanup commands exist; all partial resources remain."""
import contextlib, copy, datetime, hashlib, io, ipaddress, json, os, re, secrets, socket, stat, subprocess, sys, tarfile, time

# Embedded before this file by Go; source tests load the identical helper.
if 'owner_descriptor' not in globals():
    import importlib.util, pathlib
    _owner_spec=importlib.util.spec_from_file_location('runtime_owner_image',pathlib.Path(__file__).with_name('runtime_owner_image.py'))
    _owner=importlib.util.module_from_spec(_owner_spec);_owner_spec.loader.exec_module(_owner)
    owner_descriptor,check_owner_image=_owner.owner_descriptor,_owner.check_owner_image

def reject():
    raise ValueError('runtime_guard_failed')

runtime_secret_values = {}
runtime_secret_scope = None

def secret_scope(g):
    return (g.get('secretSetId'), g.get('storeId'), g.get('instanceId'), g.get('id'), g.get('recipeRevision'))

def load_secret_config(g, path):
    global runtime_secret_values, runtime_secret_scope
    runtime_secret_values, runtime_secret_scope = {}, None
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path:
        reject()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_uid != os.getuid() or metadata.st_nlink != 1 or metadata.st_size > 16384:
            reject()
        raw = os.read(fd, 16385)
    finally:
        os.close(fd)
    def unique(pairs):
        out = {}
        for key, value in pairs:
            if key in out:reject()
            out[key] = value
        return out
    config = json.loads(raw, object_pairs_hook=unique)
    if set(config) != {'secretSetId', 'storeId', 'instanceId', 'generationId', 'recipeRevision', 'environment'}:
        reject()
    expected = (config['secretSetId'], config['storeId'], config['instanceId'], config['generationId'], config['recipeRevision'])
    if not expected[0] or expected != secret_scope(g):reject()
    values = config['environment']
    names = {key for service in g['recipe']['services'] for key, value in (service.get('environment') or {}).items() if value.startswith('$secret:')}
    if not isinstance(values, dict) or set(values) != names or not names or len(names) > 32:
        reject()
    if any(not isinstance(value, str) or not value or len(value.encode('utf-8')) > 4096 or any(ord(character) < 32 for character in value) for value in values.values()):
        reject()
    runtime_secret_values, runtime_secret_scope = values, expected

def secret_environment(g, service):
    names = {key for key, value in (service.get('environment') or {}).items() if value.startswith('$secret:')}
    if not names:return {}
    if runtime_secret_scope != secret_scope(g) or not names.issubset(runtime_secret_values):reject()
    return {key: runtime_secret_values[key] for key in names}

def redact_secret_logs(g, text):
    if runtime_secret_scope == secret_scope(g):
        for value in runtime_secret_values.values():
            text = text.replace(value, '[redacted]')
    return text

def command_timeout(args):
    # Slow verified public-layer downloads get their own finite budget. The
    # outer runtime SSH/caller context deadline still fences the whole launch.
    return 900 if args[:2] == ['image', 'pull'] else 300

def command(args, env=None, stdin=None, limit=2**21, capture_stderr=False):
    # subprocess output is private and never included in exception categories.
    import selectors
    process = subprocess.Popen(['docker'] + args, env=env, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if stdin is not None:
        # Only bounded controlled SQL uses stdin; never archive/file input.
        if len(stdin)>4096:
            process.kill();process.wait();reject()
        process.stdin.write(stdin);process.stdin.close()
    selector=selectors.DefaultSelector()
    selector.register(process.stdout,selectors.EVENT_READ,'stdout')
    selector.register(process.stderr,selectors.EVENT_READ,'stderr')
    output=bytearray();stderr_size=0;deadline=time.monotonic()+command_timeout(args)
    try:
        while selector.get_map():
            if time.monotonic()>deadline:
                process.kill();process.wait();reject()
            for key,_ in selector.select(timeout=0.25):
                data=os.read(key.fileobj.fileno(),65536)
                if not data:
                    selector.unregister(key.fileobj);continue
                if key.data=='stdout' or capture_stderr:
                    if len(output)+len(data)>limit:
                        process.kill();process.wait();reject()
                    output.extend(data)
                else:
                    stderr_size += len(data)
                    if stderr_size>65536:
                        process.kill();process.wait();reject()
        if process.wait(timeout=1):
            reject()
        return output.decode('utf-8','replace')
    finally:
        selector.close();process.stdout.close();process.stderr.close()


def execute(code, args):
    old = sys.argv
    sys.argv = ['runtime-check'] + args
    scope = {}
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            exec(code, scope)
        return scope
    finally:
        sys.argv = old

def opened(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path or path == '/':
        reject()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/')[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        return fd
    except BaseException:
        os.close(fd)
        raise

def identity(fd):
    s = os.fstat(fd)
    return str(s.st_dev) + ':' + str(s.st_ino)

def safe(c, media=False):
    return c.get('identity') and not c.get('systemDisk', True) and (c.get('volumeType') in ('ssd', 'hdd') or (c.get('volumeType') == 'virtual' and c.get('verifiedDataPool'))) and c.get('mediaReadAllowed' if media else 'installAllowed')

def storage(mode, path):
    return execute(storage_code, [mode, path])['result']

def plan_storage(p):
    data, cache = storage('inspect', p['rootPath']), storage('docker', '')
    if not safe(data) or data['identity'] != p['storageIdentity'] or data.get('freeBytes', 0) < 2**30:
        reject()
    if not safe(cache) or cache.get('volumeType') not in ('ssd', 'hdd') or cache['identity'] != p['dockerStorageIdentity'] or cache.get('freeBytes', 0) < 2**31:
        reject()
    media_check(p)

def media_check(g):
    if g.get('mediaPath'):
        root, path = g['mediaRootPath'], g['mediaPath']
        c = storage('inspect', root)
        if not safe(c, True) or c['identity'] != g['mediaStorageIdentity'] or (path != root and not path.startswith(root + '/')):
            reject()
        fd = opened(path)
        os.close(fd)
    elif g['recipe'].get('requiresMedia'):
        reject()

def cache_reference(x):
    reference=x.get('reference','')
    if not re.fullmatch(r'(?:ghcr\.io|docker\.io)/[a-z0-9._/-]+@sha256:[a-f0-9]{64}',reference):
        return None
    return 'zstore.2iwm.com/cache/'+hashlib.sha256(reference.encode()).hexdigest()+'@'+x['digest']

def pull_runtime_image(x):
    cached=cache_reference(x)
    if cached:
        try:
            command(['image','pull','--platform',x['platform'],cached])
            raw=json.loads(command(['image','inspect',cached]))
            if len(raw)!=1 or raw[0].get('Os')!='linux' or raw[0].get('Architecture')!='amd64' or cached not in (raw[0].get('RepoDigests') or []):reject()
            return
        except Exception:
            pass
    command(['image','pull','--platform',x['platform'],x['reference']])

def image_reference(x, im):
    if x.get('deliverySource')=='owner-archive' and x==owner_descriptor():return x['reference']
    if x['reference'] in (im.get('RepoDigests') or []):return x['reference']
    cached=cache_reference(x)
    if cached and cached in (im.get('RepoDigests') or []):return cached
    reject()

def image(g, service):
    matches = [x for x in g['images'] if x['serviceId'] == service['id']]
    if len(matches) != 1:
        reject()
    x = matches[0]
    if x.get('deliverySource') == 'owner-archive' or g['appId'] == 'nasreader':
        owner_scope(g, service, x)
        try:
            raw = json.loads(command(['image', 'inspect', x['reference']]))
            if not isinstance(raw,list) or len(raw) != 1:reject()
            return x, check_owner_image(raw[0])
        except Exception:
            raise ValueError('owner_image_unavailable') from None
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', x['digest']) or not x['reference'].endswith('@' + x['digest']) or x['platform'] != 'linux/amd64':
        reject()
    try:
        raw = json.loads(command(['image', 'inspect', x['reference']]))
    except Exception:
        cached=cache_reference(x)
        if not cached:raise
        raw=json.loads(command(['image','inspect',cached]))
    if len(raw) != 1:
        reject()
    im = raw[0]
    if im.get('Os') != 'linux' or im.get('Architecture') != 'amd64' or image_reference(x, im) not in (im.get('RepoDigests') or []) or not re.fullmatch(r'sha256:[a-f0-9]{64}', im.get('Id', '')):
        reject()
    return x, im

def owner_scope(g, service, descriptor):
    recipe = g['recipe']
    expected_volumes = [{'name':'data','target':'/data','role':'data'},{'name':'inbox','target':'/inbox','role':'data'},{'name':'media','target':'/library','role':'media-readonly'}]
    if g['appId'] != 'nasreader' or recipe.get('appId') != 'nasreader' or recipe.get('version') != '0.1.0' or recipe.get('revision') != '2026-10-12.1' or recipe.get('requiresMedia') is not True or len(recipe.get('services',[])) != 1 or service != recipe['services'][0] or descriptor != owner_descriptor():reject()
    if service.get('id') != 'nasreader' or service.get('image') != descriptor['tagReference'] or service.get('userMode') != 'host' or service.get('entry') is not True or service.get('containerPort') != 8080 or service.get('environment') != {} or service.get('volumes') != expected_volumes or service.get('dependsOn') or service.get('healthCommand') or service.get('sharedMemoryBytes'):reject()

def resolve_owner(recipe, images):
    g={'appId':recipe['appId'],'recipe':recipe,'images':images}
    if len(images)!=1 or len(recipe.get('services',[]))!=1:reject()
    image(g,recipe['services'][0])
    return images

def volumes(g):
    result = {}
    for s in g['recipe']['services']:
        for v in s.get('volumes') or []:
            if v['role'] in ('media', 'media-readonly'):
                continue
            name = v['name']
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', name) or name.startswith('.'):
                reject()
            result[name] = os.path.join(g['dataPath'], name)
    return result

def labels(g, service=None):
    out = {'io.spacedesktop.runtime': 'v1', 'io.spacedesktop.store': g['storeId'], 'io.spacedesktop.instance': g['instanceId'], 'io.spacedesktop.generation': g['id'], 'io.spacedesktop.app': g['appId'], 'io.spacedesktop.recipe': g['recipeRevision'], 'io.spacedesktop.provenance': g['provenance']['marker']}
    if service:
        out['io.spacedesktop.service'] = service['id']
    return out

def name(g, s=None):
    return 'space-store-' + g['id'] + ('-' + s['id'] if s else '-network')

def marker(g):
    if g['provenance']['marker'] != g['storeId'] + ':' + g['instanceId'] + ':' + g['id']:
        reject()
    execute(provenance_code, [g['rootPath'], g['dataPath'], 'verify', json.dumps(g['provenance'])])
    df = opened(g['dataPath'])
    try:
        f = os.open('.runtime-layout', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=df)
        try:
            layout = json.loads(os.read(f, 65536))
        finally:
            os.close(f)
        if layout['storeId'] != g['storeId'] or layout['storageIdentity'] != g['storageIdentity'] or layout['dockerStorageIdentity'] != g['dockerStorageIdentity']:
            reject()
        data, cache = storage('inspect', g['rootPath']), storage('docker', '')
        if not safe(data) or not safe(cache) or cache.get('volumeType') not in ('ssd','hdd') or data['identity'] != g['storageIdentity'] or cache['identity'] != g['dockerStorageIdentity']:
            reject()
        if layout['generationId'] != g['id'] or layout['instanceId'] != g['instanceId'] or layout['appId'] != g['appId'] or layout['recipeRevision'] != g['recipeRevision']:
            reject()
        expected = volumes(g)
        if set(expected) != set(layout['volumes']):
            reject()
        for key, path in expected.items():
            child = os.stat(key, dir_fd=df, follow_symlinks=False)
            if not stat.S_ISDIR(child.st_mode) or str(child.st_dev) + ':' + str(child.st_ino) != layout['volumes'][key]:
                reject()
        return layout
    finally:
        os.close(df)

def write_exclusive(path, data):
    parent = opened(os.path.dirname(path))
    try:
        fd = os.open(os.path.basename(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(parent)
    finally:
        os.close(parent)

def mounts(g, s):
    out = []
    for v in s.get('volumes') or []:
        media = v['role'] in ('media', 'media-readonly')
        out.append({'Type': 'bind', 'Source': g['mediaPath'] if media else os.path.join(g['dataPath'], v['name']), 'Destination': v['target'], 'RW': not media})
    return out

def ports(g, s):
    out = {}
    if s.get('entry'):
        out[str(s['containerPort']) + '/tcp'] = [{'HostIp': g['publishHost'], 'HostPort': str(g['hostPort'])}]
    if g['appId'] == 'syncthing' and s.get('entry'):
        for port, protocol, host in [(22000, 'tcp', g['peerPort']), (22000, 'udp', g['peerPort']), (21027, 'udp', g['discoveryPort'])]:
            out[str(port) + '/' + protocol] = [{'HostIp': g['publishHost'], 'HostPort': str(host)}]
    return out

def network(g, complete=True):
    raw = json.loads(command(['network', 'inspect', g['networkId']]))
    if len(raw) != 1:
        reject()
    n = raw[0]
    if n.get('Id') != g['networkId'] or n.get('Name') != name(g) or n.get('Driver') != 'bridge' or n.get('Scope') != 'local' or n.get('Ingress') or n.get('Internal') or n.get('Labels') != labels(g):
        reject()
    ids = {c['id'] for c in g.get('containers') or []}
    connected = set((n.get('Containers') or {}).keys())
    # Stopped containers can be absent from the network inspect membership map.
    if not connected.issubset(ids):
        reject()
    return n

def check_container(g, s, record):
    x, im = image(g, s)
    raw = json.loads(command(['container', 'inspect', record['id']]))
    if len(raw) != 1:
        reject()
    c = raw[0]
    config, host = c.get('Config') or {}, c.get('HostConfig') or {}
    if c.get('Id') != record['id'] or c.get('Name') != '/' + name(g, s) or record['name'] != name(g, s) or record['serviceId'] != s['id'] or record['image'] != x['reference'] or config.get('Image') not in [ref for ref in (x['reference'],cache_reference(x)) if ref] or c.get('Image') != im['Id'] or config.get('Labels') != dict((im.get('Config') or {}).get('Labels') or {}, **labels(g, s)):
        reject()
    if host.get('Privileged') or host.get('NetworkMode') != g['networkId'] or host.get('PidMode') or host.get('IpcMode') == 'host' or host.get('Devices') or host.get('Binds') or host.get('VolumesFrom') or host.get('CapAdd') or host.get('DeviceRequests') or host.get('ExtraHosts') or host.get('Dns') or host.get('UTSMode') or host.get('UsernsMode') or host.get('CgroupnsMode')=='host':
        reject()
    if g['appId'] == 'nasreader' or g['appId'].startswith('cloud-'):
        if host.get('CapDrop') != ['ALL'] or host.get('SecurityOpt') not in (['no-new-privileges'],['no-new-privileges=true']):reject()
    elif host.get('SecurityOpt'):reject()
    expected_mounts = mounts(g, s)
    actual = c.get('Mounts') or []
    if len(actual) != len(expected_mounts) or any(not any(all(a.get(k) == v for k, v in m.items()) for a in actual) for m in expected_mounts):
        reject()
    if (host.get('PortBindings') or {}) != ports(g, s):
        reject()
    nets = (c.get('NetworkSettings') or {}).get('Networks') or {}
    if set(nets) != {name(g)} or nets[name(g)].get('NetworkID') != g['networkId']:
        reject()
    base = im.get('Config') or {}
    if config.get('Entrypoint') != base.get('Entrypoint') or config.get('Cmd') != base.get('Cmd'):
        reject()
    expected_env = dict(v.split('=', 1) for v in base.get('Env') or [])
    actual_env = dict(v.split('=', 1) for v in config.get('Env') or [])
    for k, v in (s.get('environment') or {}).items():
        if v.startswith('$secret:'):
            expected_env[k] = secret_environment(g, s)[k]
        elif v == '$managed:database-password':
            if not re.fullmatch(r'[a-f0-9]{64}', actual_env.get(k, '')):
                reject()
            expected_env[k] = actual_env[k]
        else:
            expected_env[k] = v
    if s.get('userMode') == 'host-env':
        expected_env['PUID'], expected_env['PGID'] = str(os.getuid()), str(os.getgid())
    if actual_env != expected_env:
        reject()
    if (host.get('RestartPolicy') or {}).get('Name') != 'unless-stopped' or (s.get('sharedMemoryBytes') and host.get('ShmSize') != s['sharedMemoryBytes']):
        reject()
    wanted_health = base.get('Healthcheck')
    if s.get('healthCommand'):
        wanted_health = {'Test': ['CMD-SHELL', health_shell(s['healthCommand'])], 'Interval': s['healthIntervalSeconds'] * 10**9, 'Timeout': s['healthTimeoutSeconds'] * 10**9, 'Retries': s['healthRetries']}
    if s.get('healthCommand'):
        for field,key in [('healthStartPeriodSeconds','StartPeriod'),('healthStartIntervalSeconds','StartInterval')]:
            if s.get(field):
                wanted_health[key]=s[field]*10**9
    actual_health = config.get('Healthcheck')
    if wanted_health is not None:
        if not actual_health or any(actual_health.get(k) != v for k,v in wanted_health.items()):
            reject()
    elif actual_health:
        reject()
    wanted_user = str(os.getuid()) + ':' + str(os.getgid()) if s.get('userMode') == 'host' else base.get('User', '')
    if config.get('User', '') != wanted_user:
        reject()
    record['state'] = (c.get('State') or {}).get('Status', 'unknown')
    return c

def inspect(g):
    marker(g)
    media_check(g)
    records = g.get('containers') or []
    services = g['recipe']['services']
    if len(records) != len(services) or len({c['serviceId'] for c in records}) != len(records):
        reject()
    network(g)
    states = []
    for s in services:
        found = [c for c in records if c['serviceId'] == s['id']]
        if len(found) != 1:
            reject()
        states.append(check_container(g, s, found[0]))
    marker(g)
    if all((c.get('State') or {}).get('Running') and ((c.get('State') or {}).get('Health') or {}).get('Status', 'healthy') == 'healthy' for c in states):
        g['state'] = 'running'
    elif all(not (c.get('State') or {}).get('Running') for c in states):
        g['state'] = 'stopped'
    else:
        g['state'] = 'needs_attention'
    return g

def prepare(p, g):
    plan_storage(p)
    if os.path.dirname(g['dataPath']) != g['rootPath']:
        reject()
    root = opened(g['rootPath'])
    try:
        os.mkdir(os.path.basename(g['dataPath']), 0o700, dir_fd=root)
    finally:
        os.close(root)
    pin = execute(provenance_code, [g['rootPath'], g['dataPath'], 'pin', g['storeId'] + ':' + g['instanceId'] + ':' + g['id']])['result']
    g['provenance'] = pin
    layout = {'storeId': g['storeId'], 'generationId': g['id'], 'instanceId': g['instanceId'], 'appId': g['appId'], 'recipeRevision': g['recipeRevision'], 'storageIdentity': p['storageIdentity'], 'dockerStorageIdentity': p['dockerStorageIdentity'], 'volumes': {}, 'restored': False}
    for key, path in volumes(g).items():
        os.mkdir(path, 0o700)
        fd = opened(path)
        layout['volumes'][key] = identity(fd)
        os.close(fd)
    write_exclusive(g['dataPath'] + '/.runtime-layout', json.dumps(layout, sort_keys=True).encode())
    return g

def port_scope(g):
    # Central storage prelude either proves our exact container and RO host
    # metadata mounts or fails closed. A normal host explicitly returns None.
    scope=execute(storage_code,['inspect',g['rootPath']])
    if 'host_policy' not in scope:
        reject()
    return scope

def ensure_ports(g):
    scope=port_scope(g)
    if 'host_policy' not in scope:
        reject()
    policy=scope['host_policy']
    if policy is not None:
        if not isinstance(policy,dict) or policy.get('network')!='/run/space-store-host/net' or not callable(scope.get('host_port_available')):
            reject()
        for service in g['recipe']['services']:
            for target,mappings in ports(g,service).items():
                protocol=target.rsplit('/',1)[1]
                for mapping in mappings:
                    if scope['host_port_available'](int(mapping['HostPort']),protocol=protocol,publishHost=mapping['HostIp']) is not True:
                        reject()
        return
    for s in g['recipe']['services']:
        for target, mappings in ports(g, s).items():
            for m in mappings:
                sock = socket.socket(socket.AF_INET6 if ':' in m['HostIp'] else socket.AF_INET, socket.SOCK_DGRAM if target.endswith('/udp') else socket.SOCK_STREAM)
                try:
                    sock.bind((m['HostIp'], int(m['HostPort'])))
                finally:
                    sock.close()

def health_shell(command):
    import shlex
    if command[0] == 'CMD-SHELL' and len(command) == 2:
        return command[1]
    return shlex.join(command[1:] if command[0] == 'CMD' else command)

def http_healthy(g, s):
    import urllib.request, urllib.error
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    host = ipaddress.ip_address(g['publishHost'])
    if host.is_unspecified:
        host = ipaddress.ip_address('127.0.0.1' if host.version == 4 else '::1')
    address = '[' + str(host) + ']' if host.version == 6 else str(host)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open('http://' + address + ':' + str(g['hostPort']) + s['healthPath'], timeout=4) as response:
            response.read(4096)
            return 200 <= response.status < 400
    except urllib.error.HTTPError as err:
        return 300 <= err.code < 400
    except Exception:
        return False

def wait_healthy(g, s, record):
    deadline = time.monotonic() + min(900, max(600, s.get('healthStartPeriodSeconds',0) + s.get('healthIntervalSeconds',30) * max(1,s.get('healthRetries',3))))
    while time.monotonic() < deadline:
        marker(g)
        network(g, False)
        c = check_container(g, s, record)
        state = c.get('State') or {}
        health = (state.get('Health') or {}).get('Status', 'healthy')
        if state.get('Running') and health == 'healthy':
            if not s.get('entry') or not s.get('healthPath') or http_healthy(g, s):
                return
        if state.get('Status') in ('dead', 'exited') or health == 'unhealthy':
            reject()
        time.sleep(1)
    reject()

def partial_owned(g):
    marker(g)
    media_check(g)
    records=g.get('containers') or []
    if len({r['serviceId'] for r in records})!=len(records):
        reject()
    if g.get('networkId'):
        network(g,False)
    elif records:
        reject()
    for record in records:
        matches=[s for s in g['recipe']['services'] if s['id']==record['serviceId']]
        if len(matches)!=1:
            reject()
        check_container(g,matches[0],record)
    marker(g)

def resource_spec(g,kind,service=None):
    if kind not in ('network','service') or (kind=='service' and service is None):
        reject()
    profile={key:g.get(key) for key in ('storeId','id','instanceId','appId','version','recipeRevision','rootPath','dataPath','storageIdentity','dockerStorageIdentity','mediaPath','mediaRootPath','mediaStorageIdentity','publishHost','accessUrl','hostPort','peerPort','discoveryPort','recipe','images','provenance')}
    expected={'kind':kind,'storeId':g['storeId'],'instanceId':g['instanceId'],'generationId':g['id'],'name':name(g,service),'profileSHA256':hashlib.sha256(json.dumps(profile,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
    if service:
        expected['serviceId']=service['id']
        expected['image']=next(x['reference'] for x in g['images'] if x['serviceId']==service['id'])
    return expected

def resource_file(kind,phase,service=None):
    return '.runtime-'+kind+('-'+service['id'] if service else '')+'-'+phase+'.json'

def resource_intent(g,kind,service=None):
    marker(g)
    write_exclusive(g['dataPath']+'/'+resource_file(kind,'intent',service),json.dumps(resource_spec(g,kind,service),sort_keys=True).encode())

def resource_receipt(g,kind,resource_id,service=None):
    if not re.fullmatch('[a-f0-9]{64}',resource_id):
        reject()
    result=resource_spec(g,kind,service)
    result['resourceId']=resource_id
    marker(g)
    write_exclusive(g['dataPath']+'/'+resource_file(kind,'receipt',service),json.dumps(result,sort_keys=True).encode())

def read_resource_metadata(df,leaf):
    try:fd=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=df)
    except FileNotFoundError:return None
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>8192 or stat.S_IMODE(st.st_mode)!=0o600:
            reject()
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:reject()
                result[key]=value
            return result
        return json.loads(os.read(fd,8193),object_pairs_hook=unique)
    finally:os.close(fd)

def reconcile_receipts(g):
    candidate=copy.deepcopy(g)
    marker(candidate)
    df=opened(candidate['dataPath'])
    try:
        scopes=[('network',None)]+[('service',s) for s in candidate['recipe']['services']]
        allowed={resource_file(kind,phase,service) for kind,service in scopes for phase in ('intent','receipt')}
        if any((leaf.startswith('.runtime-network-') or leaf.startswith('.runtime-service-')) and leaf not in allowed for leaf in os.listdir(df)):
            reject()
        records={r['serviceId']:r for r in candidate.get('containers') or []}
        if len(records)!=len(candidate.get('containers') or []):reject()
        for kind,service in scopes:
            intent=read_resource_metadata(df,resource_file(kind,'intent',service))
            receipt=read_resource_metadata(df,resource_file(kind,'receipt',service))
            if intent is None and receipt is None:continue
            expected=resource_spec(candidate,kind,service)
            if intent!=expected or not isinstance(receipt,dict):reject()
            resource_id=receipt.get('resourceId','')
            if not re.fullmatch('[a-f0-9]{64}',resource_id) or receipt!={**expected,'resourceId':resource_id}:reject()
            if kind=='network':
                if candidate.get('networkId') and candidate['networkId']!=resource_id:reject()
                candidate['networkId']=resource_id
            else:
                sid=service['id']
                record={'serviceId':sid,'id':resource_id,'name':expected['name'],'image':expected['image'],'state':'unknown'}
                if sid in records and any(records[sid].get(k)!=v for k,v in record.items() if k!='state'):reject()
                records[sid]=record
        candidate['containers']=[records[s['id']] for s in candidate['recipe']['services'] if s['id'] in records]
        if len(candidate['containers'])!=len(records):reject()
    finally:os.close(df)
    return candidate

def resource_inventory_guard(g):
    # Names are only an uncertainty fence. They never authorize adoption.
    containers=command(['container','ls','--all','--format','{{json .}}'])
    networks=command(['network','ls','--format','{{json .}}'])
    known={r['name'] for r in g.get('containers') or []}
    expected={name(g,s) for s in g['recipe']['services']}
    for line in containers.splitlines():
        row=json.loads(line)
        names=row.get('Names')
        if not isinstance(names,str):reject()
        for cname in names.split(','):
            if cname in expected and cname not in known:reject()
    for line in networks.splitlines():
        row=json.loads(line)
        if row.get('Name')==name(g) and not g.get('networkId'):reject()

def retry_inventory_guard(g):
    resource_inventory_guard(g)
    # Labels are an uncertainty fence only: a renamed extra resource cannot be
    # adopted or ignored merely because it carries our generation label.
    for kind,known in [('container',{r['id'] for r in g.get('containers') or []}),('network',{g['networkId']} if g.get('networkId') else set())]:
        args=[kind,'ls']+(['--all'] if kind=='container' else [])+['--no-trunc','--filter','label=io.spacedesktop.generation='+g['id'],'--format','{{json .}}']
        for line in command(args).splitlines():
            row=json.loads(line)
            if row.get('ID') not in known:reject()

def verify_failed_install(p,g):
    plan_storage(p)
    if g is None:
        g=copy.deepcopy(p);g.update({'id':p['generationId'],'networkId':'','containers':[]})
        root=opened(p['rootPath'])
        try:
            if os.path.dirname(p['dataPath'])!=p['rootPath']:reject()
            try:os.stat(os.path.basename(p['dataPath']),dir_fd=root,follow_symlinks=False)
            except FileNotFoundError:pass
            else:reject()
            retry_inventory_guard(g)
            try:os.stat(os.path.basename(p['dataPath']),dir_fd=root,follow_symlinks=False)
            except FileNotFoundError:pass
            else:reject()
        finally:os.close(root)
    else:
        candidate=reconcile_receipts(g)
        df=opened(candidate['dataPath'])
        try:
            scopes=([('network',None)] if candidate.get('networkId') else [])+[('service',service) for service in candidate['recipe']['services'] if any(r['serviceId']==service['id'] for r in candidate.get('containers') or [])]
            for kind,service in scopes:
                if any(read_resource_metadata(df,resource_file(kind,phase,service)) is None for phase in ('intent','receipt')):reject()
        finally:os.close(df)
        retry_inventory_guard(candidate)
        partial_owned(candidate)
        for service in candidate['recipe']['services']:
            for record in candidate.get('containers') or []:
                if record['serviceId']==service['id']:
                    state=check_container(candidate,service,record).get('State') or {}
                    if state.get('Running') or state.get('Paused') or state.get('Restarting') or state.get('Status') not in ('created','exited'):reject()
        retry_inventory_guard(candidate)
        marker(candidate)
    return {}

def quiesce(g):
    candidate=reconcile_receipts(g)
    resource_inventory_guard(candidate)
    partial_owned(candidate)
    # Only now are receipt IDs proved by complete inspect. Preserve this proven
    # nonsecret record even if a subsequent stop fails; never infer unknown IDs.
    g.clear();g.update(candidate)
    for s in reversed(g['recipe']['services']):
        matches=[r for r in g['containers'] if r['serviceId']==s['id']]
        if not matches:continue
        partial_owned(g)
        resource_inventory_guard(g)
        c=check_container(g,s,matches[0])
        if (c.get('State') or {}).get('Running'):
            marker(g)
            command(['container','stop',matches[0]['id']])
    partial_owned(g)
    resource_inventory_guard(g)
    for s in g['recipe']['services']:
        for record in g['containers']:
            if record['serviceId']==s['id'] and (check_container(g,s,record).get('State') or {}).get('Running'):
                reject()
    g['state']='stopped' if g.get('networkId') or g['containers'] else 'prepared'
    return g

def launch(p, g, retry=None):
    def retry_guard():
        if retry is not None:
            if not isinstance(retry,list) or not 1<=len(retry)<=64:reject()
            for ancestor in retry:
                if not isinstance(ancestor,dict) or set(ancestor)!={'plan','generation'}:reject()
                verify_failed_install(ancestor['plan'],ancestor['generation'])
    retry_guard()
    layout = marker(g)
    plan_storage(p)
    if g.get('containers') or g.get('networkId'):
        reject()
    ensure_ports(g)
    for s in g['recipe']['services']:
        x = next(x for x in g['images'] if x['serviceId'] == s['id'])
        marker(g)
        plan_storage(p)
        if g['appId'] != 'nasreader' and x.get('deliverySource') != 'owner-archive':
            pull_runtime_image(x)
        image(g, s)
    marker(g)
    args = ['network', 'create', '--driver', 'bridge']
    for k, v in labels(g).items():
        args += ['--label', k + '=' + v]
    args += [name(g)]
    retry_guard()
    resource_intent(g,'network')
    marker(g)
    g['networkId'] = command(args).strip()
    resource_receipt(g,'network',g['networkId'])
    g['containers'] = []
    network(g, False)
    password = secrets.token_hex(32)
    for s in g['recipe']['services']:
        partial_owned(g)
        plan_storage(p)
        x, im = image(g, s)
        args = ['container', 'create', '--pull=never', '--name', name(g, s), '--network', g['networkId'], '--network-alias', s['id'], '--restart', 'unless-stopped']
        if g['appId'] == 'nasreader' or g['appId'].startswith('cloud-'):
            args += ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']
        for k, v in labels(g, s).items():
            args += ['--label', k + '=' + v]
        for m in mounts(g, s):
            value = 'type=bind,src=' + m['Source'] + ',dst=' + m['Destination']
            args += ['--mount', value + (',readonly' if not m['RW'] else '')]
        for target, mappings in ports(g, s).items():
            for m in mappings:
                host = '[' + m['HostIp'] + ']' if ':' in m['HostIp'] else m['HostIp']
                args += ['--publish', host + ':' + m['HostPort'] + ':' + target]
        env = dict(os.environ)
        for k, v in (s.get('environment') or {}).items():
            if v.startswith('$secret:'):
                env[k] = secret_environment(g, s)[k]
                args += ['--env', k]
            elif v == '$managed:database-password':
                env[k] = password
                args += ['--env', k]
            else:
                args += ['--env', k + '=' + v]
        if s.get('userMode') == 'host-env':
            args += ['--env', 'PUID=' + str(os.getuid()), '--env', 'PGID=' + str(os.getgid())]
        if s.get('sharedMemoryBytes'):
            args += ['--shm-size', str(s['sharedMemoryBytes'])]
        if s.get('userMode') == 'host':
            args += ['--user', str(os.getuid()) + ':' + str(os.getgid())]
        if s.get('healthCommand'):
            import shlex
            args += ['--health-cmd', health_shell(s['healthCommand']), '--health-interval', str(s['healthIntervalSeconds']) + 's', '--health-timeout', str(s['healthTimeoutSeconds']) + 's', '--health-retries', str(s['healthRetries'])]
        if s.get('healthCommand'):
            if s.get('healthStartPeriodSeconds'):
                args += ['--health-start-period',str(s['healthStartPeriodSeconds'])+'s']
            if s.get('healthStartIntervalSeconds'):
                args += ['--health-start-interval',str(s['healthStartIntervalSeconds'])+'s']
        args += [image_reference(x, im)]
        partial_owned(g)
        retry_guard()
        resource_intent(g,'service',s)
        marker(g)
        cid = command(args, env=env).strip()
        if not re.fullmatch('[a-f0-9]{64}', cid):
            reject()
        record = {'serviceId': s['id'], 'id': cid, 'name': name(g, s), 'image': x['reference'], 'state': 'created'}
        resource_receipt(g,'service',cid,s)
        g['containers'].append(record)
        partial_owned(g)
        marker(g)
        retry_guard()
        command(['container', 'start', cid])
        wait_healthy(g, s, record)
        # Existing PostgreSQL data uses its prior internal password. Rotate only
        # in this restored generation via local Unix socket, controlled stdin.
        if layout.get('restored') and g['appId'] == 'immich' and any(k == 'POSTGRES_PASSWORD' and v == '$managed:database-password' for k, v in (s.get('environment') or {}).items()):
            marker(g)
            network(g, False)
            check_container(g, s, record)
            user = (s.get('environment') or {}).get('POSTGRES_USER', 'postgres')
            if not re.fullmatch('[a-zA-Z_][a-zA-Z0-9_]*', user):
                reject()
            sql = ('ALTER ROLE "' + user + '" WITH PASSWORD \'' + password + '\';\n').encode()
            command(['exec', '-i', '--user', 'postgres', cid, 'psql', '-h', '/var/run/postgresql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], stdin=sql)
    return inspect(g)

def utility(g, snapshot_dir, mode, key):
    # The reviewed PostgreSQL image supplies GNU tar. Utility containers are
    # retained, labelled, networkless and never mount the provenance wrapper.
    database = next(s for s in g['recipe']['services'] if s['id'] == 'database')
    x, im = image(g, database)
    if key not in volumes(g) or mode not in ('archive', 'restore'):
        reject()
    uid = secrets.token_hex(12)
    utility_labels = labels(g)
    utility_labels.update({'io.spacedesktop.utility': mode, 'io.spacedesktop.utility-id': uid})
    utility_name = 'space-store-' + g['id'] + '-utility-' + uid
    source = volumes(g)[key]
    pgdata='/var/lib/postgresql/data'
    if set((im.get('Config') or {}).get('Volumes') or {}) != {pgdata}:
        reject()
    if mode == 'archive':
        script = 'test -z "$(find /var/lib/postgresql/data \( -type l -o \( ! -type f -a ! -type d \) -o \( -type f -links +1 \) \) -print -quit)" && umask 022 && tar -cf /snapshot/' + key + '.tar -C /var/lib/postgresql/data .'
        expected = [{'Type': 'bind', 'Source': source, 'Destination': pgdata, 'RW': False}, {'Type': 'bind', 'Source': snapshot_dir, 'Destination': '/snapshot', 'RW': True}]
    else:
        script = 'tar -xf /snapshot/data.tar -C /var/lib/postgresql/data --strip-components=1 ' + key
        expected = [{'Type': 'bind', 'Source': source, 'Destination': pgdata, 'RW': True}, {'Type': 'bind', 'Source': snapshot_dir, 'Destination': '/snapshot', 'RW': False}]
    args = ['container', 'create', '--pull=never', '--name', utility_name, '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', '/bin/sh']
    for k,v in utility_labels.items():
        args += ['--label', k + '=' + v]
    for m in expected:
        args += ['--mount', 'type=bind,src=' + m['Source'] + ',dst=' + m['Destination'] + (',readonly' if not m['RW'] else '')]
    args += [x['reference'], '-c', script]
    write_exclusive((snapshot_dir if mode=='archive' else g['dataPath']) + '/utility-intent-' + uid + '.json', json.dumps({'name':utility_name,'mode':mode,'generationId':g['id'],'image':x['reference']}).encode())
    marker(g)
    if mode=='archive':
        inspect(g)
        if g['state']!='stopped':
            reject()
    cid = command(args).strip()
    if not re.fullmatch('[a-f0-9]{64}', cid):
        reject()
    write_exclusive((snapshot_dir if mode=='archive' else g['dataPath']) + '/utility-' + uid + '.json', json.dumps({'id':cid,'name':utility_name,'mode':mode,'generationId':g['id'],'image':x['reference']}).encode())
    def verify():
        marker(g)
        image(g, database)
        raw = json.loads(command(['container','inspect',cid]))
        if len(raw) != 1:
            reject()
        c=raw[0]; config=c.get('Config') or {}; host=c.get('HostConfig') or {}
        wanted_labels=dict((im.get('Config') or {}).get('Labels') or {}, **utility_labels)
        if c.get('Id')!=cid or c.get('Name')!='/'+utility_name or c.get('Image')!=im['Id'] or config.get('Image')!=x['reference'] or config.get('Labels')!=wanted_labels or config.get('User')!='0:0' or config.get('Entrypoint')!=['/bin/sh'] or config.get('Cmd')!=['-c',script] or host.get('NetworkMode')!='none' or not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('Devices') or host.get('Binds') or host.get('VolumesFrom') or host.get('CapAdd') or host.get('PortBindings'):
            reject()
        actual=c.get('Mounts') or []
        if len(actual)!=len(expected) or any(not any(all(a.get(k)==v for k,v in m.items()) for a in actual) for m in expected):
            reject()
        return c
    verify()
    if mode=='archive':
        inspect(g)
        if g['state']!='stopped':
            reject()
    marker(g)
    command(['container','start','--attach',cid])
    c=verify()
    if (c.get('State') or {}).get('Running') or (c.get('State') or {}).get('ExitCode')!=0:
        reject()
    return snapshot_dir + '/' + key + '.tar'

def safe_member(m, allowed):
    parts = m.name.split('/')
    if not m.name or m.name.startswith('/') or any(p in ('', '.', '..') for p in parts) or parts[0] not in allowed or m.type not in (tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE) or m.issym() or m.islnk() or m.size < 0 or m.uid<0 or m.gid<0 or m.uid>=2**32 or m.gid>=2**32:
        reject()

def file_digest(fd):
    h = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 2**20)
        if not chunk:
            break
        h.update(chunk)
    return h.hexdigest()

def snapshot(g, root, sid):
    inspect(g)
    if g['state'] != 'stopped':
        reject()
    c = storage('inspect', root)
    if not safe(c):
        reject()
    rf = opened(root)
    try:
        os.mkdir(sid, 0o700, dir_fd=rf)
    finally:
        os.close(rf)
    directory = os.path.join(root, sid)
    archive = directory + '/data.tar'
    df = opened(directory)
    try:
        fd = os.open('data.tar', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=df)
        try:
            # Inspect every member through descriptor-relative traversal. Symlinks,
            # hardlinks and devices are rejected; snapshots never dereference them.
            with os.fdopen(os.dup(fd), 'wb') as stream, tarfile.open(fileobj=stream, mode='w') as tar:
                for key, path in volumes(g).items():
                    if g['appId'] == 'immich':
                        part = utility(g, directory, 'archive', key)
                        part_parent=opened(directory)
                        part_fd=os.open(key+'.tar',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=part_parent)
                        os.close(part_parent)
                        with os.fdopen(part_fd,'rb') as part_stream, tarfile.open(fileobj=part_stream,mode='r:') as child_tar:
                            for member in child_tar:
                                member.name = key if member.name in ('.','./') else key + '/' + member.name.removeprefix('./')
                                safe_member(member,set(volumes(g)))
                                tar.addfile(member,child_tar.extractfile(member) if member.isfile() else None)
                    else:
                        vfd = opened(path)
                        try:
                            archive_directory(tar, vfd, key)
                        finally:
                            os.close(vfd)
            os.fsync(fd)
            digest, size = file_digest(fd), os.fstat(fd).st_size
        finally:
            os.close(fd)
    finally:
        os.close(df)
    inspect(g)
    if g['state'] != 'stopped':
        reject()
    manifest = {'id': sid, 'instanceId': g['instanceId'], 'generationId': g['id'], 'rootPath': root, 'path': archive, 'sha256': digest, 'sizeBytes': size, 'appId': g['appId'], 'version': g['version'], 'recipeRevision': g['recipeRevision'], 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'), 'source': g}
    write_exclusive(directory + '/manifest.json', json.dumps(manifest, sort_keys=True).encode())
    return manifest

def archive_directory(tar, fd, name):
    s = os.fstat(fd)
    info = tarfile.TarInfo(name)
    info.type, info.mode, info.uid, info.gid, info.mtime = tarfile.DIRTYPE, stat.S_IMODE(s.st_mode), s.st_uid, s.st_gid, s.st_mtime
    tar.addfile(info)
    for leaf in sorted(os.listdir(fd)):
        if leaf in ('.', '..') or '/' in leaf:
            reject()
        st = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(st.st_mode):
            child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                archive_directory(tar, child, name + '/' + leaf)
            finally:
                os.close(child)
        elif stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
            f = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                opened_stat = os.fstat(f)
                if (opened_stat.st_dev, opened_stat.st_ino, opened_stat.st_size) != (st.st_dev, st.st_ino, st.st_size):
                    reject()
                info = tarfile.TarInfo(name + '/' + leaf)
                info.size, info.mode, info.uid, info.gid, info.mtime = st.st_size, stat.S_IMODE(st.st_mode), st.st_uid, st.st_gid, st.st_mtime
                with os.fdopen(os.dup(f), 'rb') as stream:
                    tar.addfile(info, stream)
            finally:
                os.close(f)
        else:
            reject()

@contextlib.contextmanager
def snapshot_material(snapshot,g=None):
    source = copy.deepcopy(snapshot['source'])
    inspect(source)
    root, path = snapshot['rootPath'], snapshot['path']
    if path != os.path.join(root, snapshot['id'], 'data.tar'):
        reject()
    parent = opened(os.path.dirname(path))
    try:
        mf = os.open('manifest.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            ms=os.fstat(mf)
            if not stat.S_ISREG(ms.st_mode) or ms.st_nlink!=1 or ms.st_size>2**20 or stat.S_IMODE(ms.st_mode)!=0o600:reject()
            manifest = json.loads(os.read(mf, 2**20))
        finally:
            os.close(mf)
        if manifest != snapshot:
            reject()
        fd = os.open('data.tar', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or stat.S_IMODE(os.fstat(fd).st_mode)!=0o600 or os.fstat(fd).st_nlink != 1 or os.fstat(fd).st_size != snapshot['sizeBytes'] or file_digest(fd) != snapshot['sha256']:
            reject()
        allowed = set(volumes(source))
        if g is not None and allowed != set(volumes(g)):
            reject()
        os.lseek(fd, 0, os.SEEK_SET)
        with os.fdopen(os.dup(fd), 'rb') as stream, tarfile.open(fileobj=stream, mode='r:') as tar:
            members = tar.getmembers()
            if len(members) > 1000000:
                reject()
            seen = set()
            for m in members:
                safe_member(m, allowed)
                if m.name in seen:
                    reject()
                seen.add(m.name)
            if not all(any(m.name == key and m.isdir() for m in members) for key in allowed):
                reject()
            yield tar,members,path,allowed
        if file_digest(fd) != snapshot['sha256']:reject()
    finally:os.close(fd)

def verify_snapshot(snapshot):
    with snapshot_material(snapshot):pass
    return {}

def restore(snapshot, g):
    marker(g)
    for child in volumes(g).values():
        cf=opened(child)
        try:
            if os.listdir(cf):
                reject()
        finally:
            os.close(cf)
    with snapshot_material(snapshot,g) as (tar,members,path,allowed):
        # Fresh child directories only; never overwrite an existing file.
        if g['appId']=='immich':
            for key in allowed:
                utility(g,os.path.dirname(path),'restore',key)
        for m in ([] if g['appId']=='immich' else members):
            marker(g)
            parts = m.name.split('/')
            target = g['dataPath'] + '/' + m.name
            if len(parts) == 1 and m.isdir():
                continue
            pf = opened(os.path.dirname(target))
            try:
                if m.isdir():
                    os.mkdir(parts[-1], stat.S_IMODE(m.mode) & 0o777, dir_fd=pf)
                    d = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pf)
                    if os.getuid() == 0:
                        os.fchown(d, m.uid, m.gid)
                    os.close(d)
                else:
                    f = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(m.mode) & 0o777, dir_fd=pf)
                    try:
                        data = tar.extractfile(m)
                        while True:
                            block = data.read(2**20)
                            if not block:
                                break
                            os.write(f, block)
                        if os.getuid() == 0:
                            os.fchown(f, m.uid, m.gid)
                        os.fsync(f)
                    finally:
                        os.close(f)
            finally:
                os.close(pf)
        for m in ([] if g['appId']=='immich' else members):
            if m.name in allowed:
                cf = opened(g['dataPath'] + '/' + m.name)
                os.fchmod(cf, stat.S_IMODE(m.mode) & 0o777)
                if os.getuid() == 0:
                    os.fchown(cf, m.uid, m.gid)
                os.close(cf)
    layout = marker(g)
    # Record restored status in a separate exclusive file; original provenance
    # and source snapshot remain immutable.
    write_exclusive(g['dataPath'] + '/.runtime-restored', json.dumps({'snapshotId': snapshot['id'], 'sha256': snapshot['sha256']}).encode())
    return g

def logs(g, service, lines):
    inspect(g)
    c = next(c for c in g['containers'] if c['serviceId'] == service)
    s = next(s for s in g['recipe']['services'] if s['id'] == service)
    raw = check_container(g, s, c)
    secret_values = []
    for v in (raw.get('Config') or {}).get('Env') or []:
        key, val = v.split('=', 1)
        if re.search(r'password|token|secret|credential|key', key, re.I) and val:
            secret_values.append(val)
    text = command(['logs', '--tail', str(lines), c['id']], limit=2**20, capture_stderr=True)
    for value in secret_values:
        text = text.replace(value, '[redacted]')
    text = re.sub(r'(?i)(password|token|secret|authorization|credential)(\s*[=:]\s*|\s+)[^\s,;]+', r'\1=[redacted]', text)
    text = re.sub(r'://[^\s/@]+:[^\s/@]+@', '://[redacted]@', text)
    return {'logs': redact_secret_logs(g, text)}

def public_json(g, path):
    import urllib.request
    host=ipaddress.ip_address(g['publishHost'])
    if host.is_unspecified:
        host=ipaddress.ip_address('127.0.0.1' if host.version==4 else '::1')
    address='['+str(host)+']' if host.version==6 else str(host)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open('http://'+address+':'+str(g['hostPort'])+path,timeout=4) as response:
        if response.status!=200:
            reject()
        body=response.read(65537)
        if len(body)>65536:
            reject()
        return json.loads(body)

def sqlite_initialized(g,filename,column):
    import sqlite3,urllib.parse
    base=volumes(g).get('data')
    if not base:
        return 'unknown'
    parent=opened(base)
    fd=None
    try:
        try:fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
        except FileNotFoundError:return 'pending'
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1:
            return 'unknown'
        # Immutable read avoids creating/changing WAL or shared-memory files. A
        # nonempty WAL means main-file evidence can be stale: report unknown.
        try:
            wal=os.stat(filename+'-wal',dir_fd=parent,follow_symlinks=False)
            if not stat.S_ISREG(wal.st_mode) or wal.st_size:
                return 'unknown'
        except FileNotFoundError:pass
        path=base+'/'+filename
        connection=sqlite3.connect('file:'+urllib.parse.quote(path,safe='/')+'?mode=ro&immutable=1',uri=True,timeout=1)
        try:
            deadline=time.monotonic()+1
            connection.set_progress_handler(lambda:1 if time.monotonic()>deadline else 0,1000)
            columns={row[1] for row in connection.execute('PRAGMA table_info("user")')}
            if column not in columns:
                return 'unknown'
            row=connection.execute('SELECT 1 FROM "user" WHERE "'+column+'"=1 LIMIT 1').fetchone()
            after=os.stat(filename,dir_fd=parent,follow_symlinks=False)
            if (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):
                return 'unknown'
            return 'complete' if row else 'pending'
        finally:connection.close()
    except (OSError,sqlite3.Error):return 'unknown'
    finally:
        if fd is not None:os.close(fd)
        os.close(parent)

def syncthing_initialized(g):
    # Read only the completely inspected generation's declared config volume.
    # Never return GUI names, password hashes, API keys or other config content.
    import xml.etree.ElementTree as ET
    from xml.parsers import expat
    parent=fd=None
    try:
        base=volumes(g).get('config')
        if not base:return 'unknown'
        parent=opened(base)
        fd=os.open('config.xml',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        before=os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid()
                or before.st_nlink!=1 or not 0<before.st_size<=256*1024):
            return 'unknown'
        raw=os.read(fd,256*1024+1)
        after=os.fstat(fd)
        named=os.stat('config.xml',dir_fd=parent,follow_symlinks=False)
        def file_identity(value):
            return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,
                    value.st_mode,value.st_uid,value.st_gid,value.st_nlink)
        if (len(raw)!=before.st_size or file_identity(before)!=file_identity(after)
                or file_identity(before)!=file_identity(named)):
            return 'unknown'
        text=raw.decode('utf-8')
        if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():return 'unknown'
        # Go's native XML reader accepts XML 1.0 and UTF-8 declarations only.
        # Parsing Unicode with ElementTree alone silently ignores encoding.
        def declaration(version,encoding,standalone):
            if version!='1.0' or (encoding and encoding.lower()!='utf-8'):
                raise ValueError('unsupported XML declaration')
        parser=expat.ParserCreate()
        parser.XmlDeclHandler=declaration
        parser.Parse(raw,True)
        config=ET.fromstring(raw)
        local_name=lambda key:key.rsplit('}',1)[-1]
        guis=[node for node in config if local_name(node.tag)=='gui']
        if config.tag!='configuration' or len(guis)!=1 or guis[0].tag!='gui':
            return 'unknown'
        gui=guis[0]
        if any(local_name(key)=='enabled' and key!='enabled' for key in gui.attrib):
            return 'unknown'
        if gui.get('enabled','true').lower()!='true':return 'unknown'
        # Native Go XML scalar fields use the last repeated element, whereas
        # findtext uses the first and ignores namespaces. Refuse ambiguity and
        # nested scalar content instead of guessing what native auth will use.
        for key in ('user','password','authMode'):
            fields=[node for node in gui if local_name(node.tag)==key]
            if len(fields)>1 or any(node.tag!=key or len(node) for node in fields):
                return 'unknown'
        if (gui.findtext('authMode') or 'static')!='static':return 'unknown'
        user,password=gui.findtext('user'),gui.findtext('password')
        if not user or not password:return 'pending'
        if re.fullmatch(r'\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}',password) is None:
            return 'unknown'
        return 'complete'
    except (OSError,ValueError,UnicodeError,ET.ParseError,expat.ExpatError):return 'unknown'
    finally:
        if fd is not None:os.close(fd)
        if parent is not None:os.close(parent)

def initialization(g):
    inspect(copy.deepcopy(g))
    result='unknown'
    if g['appId'] in ('immich','jellyfin'):
        path,key=('/api/server/config','isInitialized') if g['appId']=='immich' else ('/System/Info/Public','StartupWizardCompleted')
        try:
            body=public_json(g,path)
            value=body.get(key) if isinstance(body,dict) else None
            if isinstance(value,bool):result='complete' if value else 'pending'
        except Exception:pass
    elif g['appId']=='nasreader':
        try:
            body=public_json(g,'/api/v1/setup')
            value=body.get('required') if isinstance(body,dict) else None
            if isinstance(value,bool):result='pending' if value else 'complete'
        except Exception:pass
    elif g['appId']=='uptime-kuma':result=sqlite_initialized(g,'kuma.db','active')
    elif g['appId']=='navidrome':result=sqlite_initialized(g,'navidrome.db','is_admin')
    elif g['appId']=='syncthing':result=syncthing_initialized(g)
    # GUI administrator configuration and actual synchronization are separate.
    inspect(copy.deepcopy(g))
    return {'initialization':result}

def main():
    global probe_code, provenance_code, storage_code
    action, body, probe_code, provenance_code, storage_code = sys.argv[1:]
    request = json.loads(body)
    if action == 'directories':
        root, path = request['root'], request['path']
        candidate = storage('inspect', root)
        if not (safe(candidate) or safe(candidate, True)):
            reject()
        if path != root and not path.startswith(root + '/'):
            reject()
        rf, pf = opened(root), opened(path)
        try:
            return sorted([leaf for leaf in os.listdir(pf) if not leaf.startswith('.') and stat.S_ISDIR(os.stat(leaf, dir_fd=pf, follow_symlinks=False).st_mode)])[:1000]
        finally:
            os.close(rf)
            os.close(pf)
    execute(probe_code, [])
    if action == 'facts':
        info = json.loads(command(['info', '--format', '{{json .}}']))
        arch = info.get('Architecture')
        if arch not in ('x86_64', 'amd64') or not isinstance(info.get('ServerVersion'),str) or not info['ServerVersion'] or not isinstance(info.get('DockerRootDir'),str) or not os.path.isabs(info['DockerRootDir']) or not isinstance(info.get('NCPU'),int) or info['NCPU']<1 or not isinstance(info.get('MemTotal'),int) or info['MemTotal']<1:
            reject()
        compose=''
        try:compose=command(['compose','version','--short']).strip()
        except Exception:pass
        return {'platform': 'linux/amd64', 'dockerRoot': info['DockerRootDir'], 'dockerVersion': info['ServerVersion'], 'composeVersion': compose, 'userId': os.getuid(), 'groupId': os.getgid(), 'cpus': info['NCPU'], 'memoryBytes': info['MemTotal']}
    if action == 'resolve-owner':
        return resolve_owner(request['recipe'],request['images'])
    global failure_generation
    if action == 'verify-failed-install':
        return verify_failed_install(request['plan'],request.get('generation'))
    if action == 'verify-snapshot':
        return verify_snapshot(request['snapshot'])
    g = request['generation']
    if request.get('secretFile'):
        load_secret_config(g, request['secretFile'])
    failure_generation = g
    if action == 'prepare':
        return prepare(request['plan'], g)
    if action == 'launch':
        # A restored marker is verified no-follow and belongs to the fresh wrapper.
        layout = marker(g)
        try:
            df = opened(g['dataPath'])
            f = os.open('.runtime-restored', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=df)
            os.close(f)
            os.close(df)
            original_marker = marker
            def restored_marker(generation):
                result = original_marker(generation)
                result['restored'] = True
                return result
            globals()['marker'] = restored_marker
        except FileNotFoundError:
            os.close(df)
        return launch(request['plan'], g, request.get('retry'))
    if action == 'inspect':
        return inspect(g)
    if action == 'initialization':
        return initialization(g)
    if action == 'quiesce':
        return quiesce(g)
    if action == 'control':
        action = request['action']
        if action not in ('start', 'stop', 'restart'):
            reject()
        inspect(g)
        ordered = list(g['recipe']['services'])
        if action == 'stop':
            ordered.reverse()
        for s in ordered:
            inspect(g)
            c = next(c for c in g['containers'] if c['serviceId'] == s['id'])
            marker(g)
            check_container(g, s, c)
            command(['container', action, c['id']])
            if action != 'stop':
                wait_healthy(g, s, c)
        return {}
    if action == 'snapshot':
        return snapshot(g, request['root'], request['id'])
    if action == 'restore':
        return restore(request['snapshot'], g)
    if action == 'logs':
        return logs(g, request['service'], request['lines'])
    reject()

if __name__ == '__main__':
    try:
        print(json.dumps(main(), separators=(',', ':')))
    except BaseException:
        # Fixed category only: never expose argv, environment, SQL or Docker output.
        if 'failure_generation' in globals():
            failure_generation['state'] = 'needs_attention'
            print(json.dumps({'generation': failure_generation}, separators=(',', ':')))
        sys.stderr.write('runtime_guard_failed\n')
        sys.exit(3)
