#!/usr/bin/env python3
"""Additive standalone container deployment and explicit own-receipt restart.

No remove, adoption, automatic stop/replacement, or version update operation.

Both local orchestration and bounded remote phases live here so sshbind can
send reviewed public source, without installing a mutable remote helper.
"""
import argparse
import contextlib
import ctypes
import ctypes.util
import datetime
import fcntl
import hashlib
import io
import ipaddress
import json
import os
import pathlib
import platform
import re
import secrets
import shlex
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import urllib.parse

BASE = 'ghcr.io/astral-sh/uv@sha256:847b5e690018bc6b9d97a0848da65f721b785f1e78d9c7067b8947c7010b2718'
DOCKER_URL = 'https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz'
# Fixed publisher archive content; refreshed only by reviewed source changes.
DOCKER_SHA256 = '9b4f6fe406e50f9085ee474c451e2bb5adb119a03591f467922d3b4e2ddf31d3'
COMPOSE_URL = 'https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64'
COMPOSE_SHA256 = 'ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b'
BASE_LABELS = {
    'org.opencontainers.image.created': '2026-02-04T21:30:02.940Z',
    'org.opencontainers.image.description': 'An extremely fast Python package and project manager, written in Rust.',
    'org.opencontainers.image.licenses': 'Apache-2.0',
    'org.opencontainers.image.revision': 'ea4560831e503c6ce34d18739476a71ac6e9a9de',
    'org.opencontainers.image.source': 'https://github.com/astral-sh/uv',
    'org.opencontainers.image.title': 'uv', 'org.opencontainers.image.url': 'https://github.com/astral-sh/uv',
    'org.opencontainers.image.version': '0.9.30-python3.13-bookworm-slim'}
SAFE_REASONS={
    'host Docker facts changed','dedicated directory owner/mode differs',
    'noncanonical directory evidence','directory evidence is not directory',
    'metadata-only walk cannot authorize writable root',
    'Linux O_PATH required for readonly host metadata',
    'host mount metadata not regular','fixed Docker socket not socket',
    'deployment directory identity differs','first deployment requires empty dedicated directory',
    'NAS architecture/owner differs','live process uses chosen roots; preserved',
    'existing container uses selected roots; all resources preserved',
    'fixed local Docker Unix socket required','cached self identity differs',
    'active or uncertain jobs block controlled restart','receipt directory changed',
    'receipt metadata/host evidence changed','receipt plan/path differs',
    'remote preflight failed; no deployment performed',
    'selected sshbind alias absent/unusable','remote identity probe failed'}


def safe_error(error):
    if isinstance(error,OSError):
        return 'required path access failed (errno %d)' % (error.errno if isinstance(error.errno,int) else 0)
    if isinstance(error,sqlite3.Error):return 'task database unavailable or invalid'
    if isinstance(error,subprocess.SubprocessError):return 'required command failed; retained resources need inspection'
    value=str(error)
    if isinstance(error,ValueError) and value in SAFE_REASONS:return value
    if isinstance(error,ValueError) and re.fullmatch(r'required path access failed \(errno [0-9]+\)',value):return value
    return 'invalid deployment evidence; retained resources need inspection'


def remote_error(result):
    for line in str(result.get('stderr','')).splitlines():
        prefix='Container deployment stopped: '
        if line.startswith(prefix):
            return safe_error(ValueError(line[len(prefix):]))
    return 'remote preflight failed; no deployment performed'


def canonical(path, protected=False):
    if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path or path == '/' or re.search(r'[\x00-\x20\x7f,]', path):
        raise ValueError('noncanonical dedicated path')
    if not protected and re.match(r'^/(root|home|boot|zspace|usr|etc|bin|sbin|var|opt|run|proc|sys|dev)(/|$)', path):
        raise ValueError('protected path')
    return path


@contextlib.contextmanager
def directory_handle(path, private=True, metadata_only=False, secure_ancestors=False):
    if not isinstance(path,str) or not path.startswith('/') or os.path.normpath(path)!=path:
        raise ValueError('noncanonical directory evidence')
    if metadata_only and private:
        raise ValueError('metadata-only walk cannot authorize writable root')
    if metadata_only and not hasattr(os,'O_PATH'):
        raise ValueError('Linux O_PATH required for readonly host metadata')
    # O_PATH grants inode metadata access, not directory enumeration/read.
    # Combined DIRECTORY/NOFOLLOW still rejects links at every component.
    flags=(os.O_PATH if metadata_only else os.O_RDONLY)|os.O_DIRECTORY|os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        parts=path.split('/')[1:]
        for part in parts:
            if secure_ancestors:
                ancestor=os.fstat(fd)
                # Match the native controller policy: only root-owned sticky
                # shared ancestors (such as /tmp) may have foreign write bits.
                if ancestor.st_mode & 0o022 and not (ancestor.st_uid==0 and ancestor.st_mode & stat.S_ISVTX):
                    raise ValueError('unsafe controller directory ancestor')
            new = os.open(part, flags, dir_fd=fd)
            os.close(fd); fd = new
        entry = os.fstat(fd)
        if not stat.S_ISDIR(entry.st_mode):raise ValueError('directory evidence is not directory')
        if private and (entry.st_uid != os.getuid() or stat.S_IMODE(entry.st_mode) != 0o700):
            raise ValueError('dedicated directory owner/mode differs')
        yield fd
    finally:
        os.close(fd)


def directory(path, private=True, metadata_only=False, secure_ancestors=False):
    with directory_handle(path,private,metadata_only,secure_ancestors) as fd:
        entry=os.fstat(fd)
        return {'device': entry.st_dev, 'inode': entry.st_ino, 'uid': entry.st_uid}


def validate_nas_origin(origin):
    if not origin: return
    if len(origin) > 2048 or not re.fullmatch(r'https?://[^/?#\s\\]+', origin) or re.search(r'[\x00-\x20\x7f]', origin):
        raise ValueError('invalid canonical NAS origin')
    parsed = urllib.parse.urlsplit(origin)
    if parsed.username is not None or parsed.password is not None or not parsed.hostname:
        raise ValueError('invalid canonical NAS origin')
    host = parsed.hostname
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if re.fullmatch(r'[0-9.]+', host) or len(host) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*', host):
            raise ValueError('invalid canonical NAS origin')
    else:
        if address.is_unspecified: raise ValueError('invalid canonical NAS origin')
        host = str(address)
    authority = '[' + host + ']' if ':' in host else host
    port = parsed.port
    if port is not None:
        if not 1 <= port <= 65535 or (parsed.scheme, port) in (('http',80),('https',443)):
            raise ValueError('invalid canonical NAS origin')
        authority += ':' + str(port)
    if origin != parsed.scheme + '://' + authority:
        raise ValueError('invalid canonical NAS origin')


def plan(root, storage, ip, port, release, uid, gid, engine='disabled', docker_root='', socket_gid=None, nas_origin='', nas_only=False):
    validate_nas_origin(nas_origin)
    if not isinstance(nas_only,bool) or (nas_only and not nas_origin): raise ValueError("NAS-only mode needs an explicit NAS origin")
    canonical(root); canonical(storage)
    if root == storage or root.startswith(storage + '/') or storage.startswith(root + '/'):
        raise ValueError('dedicated roots must be disjoint')
    address = ipaddress.ip_address(ip)
    if address.version != 4 or address.is_unspecified or address.is_loopback or address.is_multicast or str(address) != ip:
        raise ValueError('explicit NAS IPv4 required')
    if not 1024 <= int(port) <= 65535 or int(port) == 5055:
        raise ValueError('invalid published port')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', release) or uid <= 0 or gid <= 0:
        raise ValueError('invalid release/owner')
    if engine not in ('disabled','local'): raise ValueError('unsupported engine')
    if engine == 'local':
        canonical(docker_root)
        if not isinstance(socket_gid,int) or socket_gid < 0:
            raise ValueError('missing socket group')
        if any(docker_root == p or docker_root.startswith(p+'/') or p.startswith(docker_root+'/') for p in (root,storage)):
            raise ValueError('cache cannot overlap owned writable roots')
    elif docker_root or socket_gid is not None:
        raise ValueError('disabled engine needs no host access')
    deployment = hashlib.sha256(root.encode()).hexdigest()[:24]
    metadata = root + '/metadata'
    result = {'schema': 1, 'root': root, 'storage': storage, 'ip': ip, 'port': int(port),
            'engine': engine, 'dockerRoot': docker_root, 'socketGid': socket_gid, 'nasOrigin': nas_origin,
            'release': release, 'uid': uid, 'gid': gid, 'user': '%d:%d' % (uid, gid),
            'name': 'space-store-' + deployment + '-' + release.lower(),
            'labels': {**BASE_LABELS, 'io.space-store.service': 'space-store', 'io.space-store.deployment': deployment,
                       'io.space-store.release': release, 'io.space-store.control-protocol': 'v1'},
            'mounts': [{'Type': 'bind', 'Source': p, 'Destination': p, 'RW': True} for p in (metadata, storage)],
            'env': ['PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
                    'GPG_KEY=7169605F62C751356D054A26A821E680E5FA6305', 'PYTHON_VERSION=3.13.11',
                    'PYTHON_SHA256=16ede7bb7cdbfa895d11b0642fa0e523f291e6487194d53cf6d3b338c3a17ea2',
                    'UV_TOOL_BIN_DIR=/usr/local/bin',
                    'PYTHONUNBUFFERED=1', 'PYTHONDONTWRITEBYTECODE=1', 'HOME=/tmp',
                    'DOCKER_CONFIG=/tmp/space-store-docker-config'],
            'command': ['--listen', '0.0.0.0:18435', '--web-root', '/opt/space-store/web',
                        '--data-dir', metadata, '--engine', engine, '--storage-root', storage,
                        '--publish-host', ip, '--access-host', ip]}
    if nas_origin: result['command'].extend(['--nas-origin',nas_origin])
    if nas_only:
        result['nasAdminOnly']=True
        result['command'].extend(['--nas-admin-only','--public-origin',nas_origin])
    if engine == 'local':
        result['labels']['io.space-store.host-metadata']='v1'
        result['mounts'].extend([
            {'Type':'bind','Source':docker_root,'Destination':docker_root,'RW':False},
            {'Type':'bind','Source':'/proc/1/mountinfo','Destination':'/run/space-store-host/mountinfo','RW':False},
            {'Type':'bind','Source':'/var/run/docker.sock','Destination':'/var/run/docker.sock','RW':True},
            {'Type':'bind','Source':'/sys','Destination':'/sys','RW':False},
            {'Type':'bind','Source':'/proc/1/net','Destination':'/run/space-store-host/net','RW':False}])
    return result


def create_arguments(p, image):
    args = ['docker', 'create', '--name', p['name'], '--user', p['user'], '--network', 'bridge',
            '--cgroupns','private',
            '--restart', 'unless-stopped', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
            '--publish', '%s:%d:18435/tcp' % (p['ip'], p['port'])]
    for key, value in sorted(p['labels'].items()):
        args.extend(['--label', key + '=' + value])
    for mount in p['mounts']:
        args.extend(['--mount', 'type=bind,src=' + mount['Source'] + ',dst=' + mount['Destination'] + ',bind-propagation=' + ('rslave' if p['engine']=='local' and mount['Source']==p['dockerRoot'] else 'rprivate') + ',bind-recursive=disabled' + ('' if mount['RW'] else ',readonly')])
    if p['engine']=='local': args.extend(['--group-add',str(p['socketGid'])])
    args.extend(['--entrypoint', '/opt/space-store/space-store', image])
    return args + p['command']


def verify_owned(actual, p, container_id, image_id):
    if not re.fullmatch('[0-9a-f]{64}', container_id) or not re.fullmatch('sha256:[0-9a-f]{64}', image_id):
        raise ValueError('invalid content identity')
    config, cfg = actual.get('Config', {}), actual.get('HostConfig', {})
    expected = {'Id': container_id, 'Image': image_id, 'Name': '/' + p['name']}
    if any(actual.get(k) != v for k, v in expected.items()):
        raise ValueError('container identity differs')
    for key, value in {'Labels': p['labels'], 'User': p['user'],
                       'Entrypoint': ['/opt/space-store/space-store'], 'Cmd': p['command'], 'Env': p['env']}.items():
        if config.get(key) != value:
            raise ValueError('container configuration differs')
    for key, value in {'Privileged': False, 'NetworkMode': 'bridge', 'ReadonlyRootfs': True,
                       'CgroupnsMode':'private',
                       'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
                       'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'],
                       'PortBindings': {'18435/tcp': [{'HostIp': p['ip'], 'HostPort': str(p['port'])}]},
                       'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=32m'}}.items():
        if cfg.get(key) != value:
            raise ValueError('container restrictions differ')
    if (cfg.get('GroupAdd') or []) != ([str(p['socketGid'])] if p['engine']=='local' else []):
        raise ValueError('socket groups differ')
    for key in ('CapAdd', 'Devices', 'Binds', 'VolumesFrom', 'DeviceRequests'):
        if cfg.get(key):
            raise ValueError('extra privileges/mounts')
    for key in ('PidMode', 'UTSMode', 'CgroupnsMode'):
        if cfg.get(key,'') not in ('','private'):
            raise ValueError('host namespace forbidden')
    if cfg.get('IpcMode','') not in ('','private'):
        raise ValueError('shared IPC namespace forbidden')
    if any(m.get('Propagation','rprivate') != ('rslave' if p['engine']=='local' and m.get('Source')==p['dockerRoot'] and m.get('RW') is False else 'rprivate') for m in actual.get('Mounts', [])):
        raise ValueError('shared mount propagation forbidden')
    mounts = [{k: m.get(k) for k in ('Type', 'Source', 'Destination', 'RW')} for m in actual.get('Mounts', [])]
    if sorted(mounts, key=lambda m: m['Source']) != sorted(p['mounts'], key=lambda m: m['Source']):
        raise ValueError('container mounts differ')


def command(args):
    if args and args[0]=='docker':
        args=args[:1]+['--host','unix:///var/run/docker.sock']+args[1:]
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=240).strip()
    except subprocess.CalledProcessError as error:
        # sshbind's nonzero result still carries its structured, bounded phase
        # failure. The caller extracts only the fixed safe failure reason.
        if args and args[0] == 'sshbind' and '--json' in args and error.output:
            result=json.loads(error.output)
            if isinstance(result,dict) and 'exit_code' in result: return error.output.strip()
        raise


def new_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out); out.write('\n'); out.flush(); os.fsync(out.fileno())


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        st = os.fstat(source.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > 65536:
            raise ValueError('unsafe record')
        return json.load(source)


def rebuild_plan(p):
    return plan(p['root'],p['storage'],p['ip'],p['port'],p['release'],p['uid'],p['gid'],
                p['engine'],p['dockerRoot'],p['socketGid'],p['nasOrigin'],p.get('nasAdminOnly',False))


def self_record(p,cid,image):
    if not re.fullmatch('[0-9a-f]{64}',cid) or not re.fullmatch('sha256:[0-9a-f]{64}',image):
        raise ValueError('invalid content identity')
    return {'schema':1,'service':'space-store','deployment':p['labels']['io.space-store.deployment'],
            'release':p['release'],'containerId':cid,'imageId':image}


def verify_self(path,p,cid,image):
    if read_json(path)!=self_record(p,cid,image):
        raise ValueError('cached self identity differs')


def strict_json(body):
    def unique(pairs):
        result={}
        for key,value in pairs:
            if key in result: raise ValueError('ambiguous retained JSON')
            result[key]=value
        return result
    def invalid(value): raise ValueError('invalid retained JSON')
    return json.loads(body,object_pairs_hook=unique,parse_constant=invalid)


def evidence_time(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})',value):
        raise ValueError('invalid maintenance time')
    fraction=re.search(r'\.([0-9]+)',value)
    nanos=int((fraction.group(1)[:9] if fraction else '').ljust(9,'0'))
    base=re.sub(r'\.[0-9]+','',value).replace('Z','+00:00')
    result=datetime.datetime.fromisoformat(base).astimezone(datetime.timezone.utc)
    if result==datetime.datetime(1,1,1,tzinfo=datetime.timezone.utc) and nanos==0: raise ValueError('invalid maintenance time')
    return (result.toordinal()*86400+result.hour*3600+result.minute*60+result.second)*1000000000+nanos


@contextlib.contextmanager
def readonly_evidence(db_path, stopped=False):
    parent=str(pathlib.Path(db_path).parent)
    with directory_handle(parent,secure_ancestors=True) as parentfd:
        with readonly_evidence_at(db_path,parentfd,stopped) as db:
            yield db


@contextlib.contextmanager
def readonly_evidence_at(db_path, parentfd, stopped):
    parent=str(pathlib.Path(db_path).parent);name=pathlib.Path(db_path).name
    node=os.fstat(parentfd);parent_identity={'device':node.st_dev,'inode':node.st_ino,'uid':node.st_uid}
    def sidecars():
        identities=[]
        for suffix in ('-wal','-shm'):
            try: sidefd=os.open(name+suffix,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parentfd)
            except FileNotFoundError: identities.append(None);continue
            try:
                node=os.fstat(sidefd)
                if (not stat.S_ISREG(node.st_mode) or node.st_nlink!=1 or node.st_uid!=os.getuid()
                        or stat.S_IMODE(node.st_mode)!=0o600 or (stopped and suffix=='-wal' and node.st_size!=0)):
                    raise ValueError('stopped database sidecar unverified')
                identities.append((node.st_dev,node.st_ino,node.st_size if stopped else None))
            finally:os.close(sidefd)
        return identities
    retained=sidecars()
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parentfd)
    try:
        entry=os.fstat(fd)
        if not stat.S_ISREG(entry.st_mode) or entry.st_nlink!=1 or entry.st_uid!=os.getuid() or stat.S_IMODE(entry.st_mode)!=0o600:
            raise ValueError('unsafe job database')
        db=sqlite3.connect('file:'+urllib.parse.quote(str(db_path),safe='/')+'?mode=ro'+('&immutable=1' if stopped else ''),uri=True,timeout=1)
        try:
            db.execute('PRAGMA query_only=ON')
            db.execute('BEGIN')  # Read snapshot only; never a SQL writer transaction.
            yield db
        finally: db.close()
        current=os.stat(name,dir_fd=parentfd,follow_symlinks=False)
        if (directory(parent,secure_ancestors=True)!=parent_identity or sidecars()!=retained
                or (current.st_dev,current.st_ino)!=(entry.st_dev,entry.st_ino)):
            raise ValueError('job database identity changed')
    finally: os.close(fd)


def evidence_schema(db,table,columns,unique_columns):
    expected=[(i,name,'TEXT',0 if i==0 else 1,None,1 if i==0 else 0) for i,name in enumerate(columns)]
    if db.execute('PRAGMA table_info('+table+')').fetchall()!=expected:
        raise ValueError('retained evidence schema differs')
    unique=set()
    for index in db.execute('PRAGMA index_list('+table+')'):
        if index[2]!=1 or index[4]!=0: continue
        # Bind the index name as data, never interpolate retained identifiers.
        names=db.execute('SELECT name FROM pragma_index_info(?) ORDER BY seqno',(index[1],)).fetchall()
        if len(names)==1: unique.add(names[0][0])
    if not set(unique_columns)<=unique: raise ValueError('retained evidence indexes differ')


def assert_idle(db_path, stopped=False):
    with readonly_evidence(db_path,stopped) as db:
        for table,terminals in (('jobs',('completed','failed')),('runtime_jobs',('succeeded','failed'))):
            evidence_schema(db,table,['id','plan_id','request_id','status','body'],['id','plan_id','request_id'])
            seen=[set(),set(),set()]
            for row in db.execute('SELECT id,plan_id,request_id,status,body FROM '+table):
                ident,plan_id,request,status,body=row
                job=strict_json(body)
                if (not isinstance(job,dict) or not isinstance(ident,str) or not re.fullmatch('[0-9a-fA-F]{48}',ident)
                        or not isinstance(plan_id,str) or not re.fullmatch('[0-9a-fA-F]{48}',plan_id)
                        or not isinstance(request,str) or not request or status not in terminals
                        or any(job.get(k)!=v for k,v in zip(('id','planId','requestId','status'),row[:4]))):
                    raise ValueError('active or uncertain jobs block controlled restart')
                for values,value in zip(seen,row[:3]):
                    if value in values: raise ValueError('ambiguous retained jobs')
                    values.add(value)


def assert_quiesced(db_path,expected=None,stopped=False):
    with readonly_evidence(db_path,stopped) as db:
        marker=db.execute("SELECT key,value,typeof(value) FROM metadata WHERE key='store_maintenance_schema'").fetchall()
        if marker!=[('store_maintenance_schema','v1','text')]: raise ValueError('maintenance protocol unsupported or unverified')
        evidence_schema(db,'store_maintenance',['id','request_id','status','body'],['id','request_id'])
        current=None;seen=[set(),set()]
        for ident,request,status,body in db.execute('SELECT id,request_id,status,body FROM store_maintenance ORDER BY rowid'):
            record=strict_json(body)
            if (not isinstance(record,dict) or set(record)-{'id','requestId','purpose','status','createdAt','resumedAt'}
                    or not isinstance(ident,str) or not re.fullmatch('[0-9a-fA-F]{48}',ident)
                    or not isinstance(request,str) or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',request)
                    or record.get('id')!=ident or record.get('requestId')!=request or record.get('status')!=status
                    or record.get('purpose')!='store-update'):
                raise ValueError('maintenance evidence differs')
            created=evidence_time(record.get('createdAt'))
            for values,value in zip(seen,(ident,request)):
                if value in values: raise ValueError('ambiguous maintenance evidence')
                values.add(value)
            if status=='quiesced':
                if record.get('resumedAt') is not None or current is not None: raise ValueError('ambiguous maintenance evidence')
                current=record
            elif status=='resumed':
                if evidence_time(record.get('resumedAt'))<created: raise ValueError('maintenance evidence differs')
            else: raise ValueError('maintenance evidence differs')
        if current is None or (expected is not None and current!=expected):
            raise ValueError('current quiesced maintenance required')
        return current


@contextlib.contextmanager
def exclusive_controller_file(record, name):
    # The caller must first verify the complete own receipt; never infer support
    # from a lock file's existence and never create missing protocol files here.
    p=record['plan']
    if p['engine'] not in ('disabled','local') or p['labels'].get('io.space-store.control-protocol')!='v1':
        raise ValueError('controller protocol unsupported')
    storage=p['storage'];control=storage+'/.space-store-control'
    root_identity=directory(storage,secure_ancestors=True);control_identity=directory(control,secure_ancestors=True)
    with directory_handle(storage,secure_ancestors=True) as rootfd:
        with exclusive_controller_file_at(storage,control,root_identity,control_identity,rootfd,name) as verify:
            _HELD_CLONE_LEASES[verify]=(name,storage)
            try: yield verify
            finally: _HELD_CLONE_LEASES.pop(verify,None)


@contextlib.contextmanager
def exclusive_controller_file_at(storage,control,root_identity,control_identity,rootfd,name):
    dirfd=None;fd=None
    try:
        dirfd=os.open('.space-store-control',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=rootfd)
        fd=os.open(name,os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dirfd)
        entry=os.fstat(fd)
        def verify():
            if directory(storage,secure_ancestors=True)!=root_identity or directory(control,secure_ancestors=True)!=control_identity:
                raise ValueError('controller directory changed')
            for handle,identity in ((rootfd,root_identity),(dirfd,control_identity)):
                node=os.fstat(handle)
                if (node.st_dev,node.st_ino,node.st_uid)!=(identity['device'],identity['inode'],identity['uid']) or stat.S_IMODE(node.st_mode)!=0o700:
                    raise ValueError('controller directory changed')
            node=os.fstat(fd);path=os.stat(name,dir_fd=dirfd,follow_symlinks=False)
            if (not stat.S_ISREG(node.st_mode) or node.st_nlink!=1 or node.st_uid!=os.getuid()
                    or stat.S_IMODE(node.st_mode)!=0o600 or (path.st_dev,path.st_ino)!=(entry.st_dev,entry.st_ino)
                    or (node.st_dev,node.st_ino)!=(entry.st_dev,entry.st_ino)):
                raise ValueError('controller lock evidence differs')
        verify();fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);verify()
        yield verify
    finally:
        for handle in (fd,dirfd):
            if handle is not None: os.close(handle)


def exclusive_update(record):
    return exclusive_controller_file(record,'update.lock')


def stopped_controller(record):
    # Source must first be proven stopped. This exclusive live-controller lease
    # excludes any cooperating source from starting while immutable proof runs.
    return exclusive_controller_file(record,'controller.lock')


# Only closures produced by active native lease contexts may enter the internal
# clone primitive. No CLI or boolean can assert ownership of these leases.
_HELD_CLONE_LEASES = {}


def _private_file_proof(path):
    with directory_handle(str(pathlib.Path(path).parent),secure_ancestors=True) as parent:
        fd=os.open(pathlib.Path(path).name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        try:
            node=os.fstat(fd)
            if not stat.S_ISREG(node.st_mode) or node.st_nlink!=1 or node.st_uid!=os.getuid() or stat.S_IMODE(node.st_mode)!=0o600:
                raise ValueError('unsafe clone file')
            digest=hashlib.sha256()
            while True:
                block=os.read(fd,1024*1024)
                if not block:break
                digest.update(block)
            after=os.fstat(fd);entry=os.stat(pathlib.Path(path).name,dir_fd=parent,follow_symlinks=False)
            fields=lambda n:(n.st_dev,n.st_ino,n.st_uid,n.st_mode,n.st_nlink,n.st_size,n.st_mtime_ns,n.st_ctime_ns)
            if fields(node)!=fields(after) or fields(after)!=fields(entry):raise ValueError('clone file changed')
            return {'device':node.st_dev,'inode':node.st_ino,'uid':node.st_uid,'size':node.st_size,
                    'mtimeNs':node.st_mtime_ns,'ctimeNs':node.st_ctime_ns,'sha256':digest.hexdigest()}
        finally:os.close(fd)


def _clone_source_proof(record):
    p=record['plan'];root=p['root'];db=root+'/metadata/store/store.sqlite'
    paths=[db,root+'/.space-store-container.json',root+'/metadata/.space-store-container-self.json',
           root+'/releases/'+p['release']+'/receipt.json']
    result={path:_private_file_proof(path) for path in paths}
    for suffix in ('-wal','-shm'):
        try:result[db+suffix]=_private_file_proof(db+suffix)
        except FileNotFoundError:result[db+suffix]=None
    if result[db+'-wal'] is not None and result[db+'-wal']['size']!=0:raise ValueError('stopped database sidecar unverified')
    return result


def _clone_identifier(name):
    return '"'+name.replace('"','""')+'"'


def _clone_digest(rows):
    # Typed length-delimited encoding preserves BLOB/NULL/numeric distinctions.
    # Only the aggregate digest and row count leave this function.
    digests=[]
    for row in rows:
        h=hashlib.sha256()
        for value in row:
            if value is None:tag,data=b'n',b''
            elif isinstance(value,bytes):tag,data=b'b',value
            elif isinstance(value,str):tag,data=b's',value.encode('utf-8')
            elif isinstance(value,int):tag,data=b'i',str(value).encode('ascii')
            elif isinstance(value,float):tag,data=b'f',value.hex().encode('ascii')
            else:raise ValueError('unsupported retained value')
            h.update(tag+str(len(data)).encode('ascii')+b':'+data)
        digests.append(h.digest())
    return {'rows':len(digests),'sha256':hashlib.sha256(b''.join(sorted(digests))).hexdigest()}


def _clone_database_proof(db,expire_at=None):
    required={
        'admin':'id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL',
        'sessions':'token_hash TEXT PRIMARY KEY,username TEXT NOT NULL,expires_at INTEGER NOT NULL',
        'metadata':'key TEXT PRIMARY KEY,value TEXT NOT NULL',
        'instances':'id TEXT PRIMARY KEY,data_path TEXT NOT NULL UNIQUE,port INTEGER NOT NULL UNIQUE,body TEXT NOT NULL',
        'storage_roots':'id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,body TEXT NOT NULL',
        'store_maintenance':'id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL'}
    for table in ('jobs','runtime_jobs'):
        required[table]='id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL'
    for table in ('plans','runtime_plans','runtime_instances','runtime_generations','runtime_snapshots','runtime_settings','runtime_catalog'):
        required[table]='id TEXT PRIMARY KEY,body TEXT NOT NULL'
    schema=db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
    tables={name:sql for kind,name,owner,sql in schema if kind=='table'}
    compact=lambda sql:re.sub(r'\s+','',sql).lower()
    if not required.keys()<=tables.keys():raise ValueError('required clone table missing')
    for kind,name,owner,sql in schema:
        if kind not in ('table','index') or (kind=='table' and (not sql or not re.match(r'^CREATE TABLE\s',sql,re.I))):
            raise ValueError('unsupported clone schema object')
    for table,columns in required.items():
        if compact(tables[table])!=compact('CREATE TABLE '+table+'('+columns+')'):
            raise ValueError('required clone schema differs')
    # Refuse hidden/generated columns; do not evaluate untrusted schema features.
    for table in tables:
        if any(row[6]!=0 for row in db.execute('SELECT * FROM pragma_table_xinfo(?)',(table,))):
            raise ValueError('unsupported clone columns')
    admin=db.execute('SELECT id,username,password_hash FROM admin').fetchall()
    if (len(admin)!=1 or admin[0][0]!=1 or not isinstance(admin[0][1],str)
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',admin[0][1]) or not isinstance(admin[0][2],str)
            or not re.fullmatch(r'\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./a-zA-Z0-9]{53}',admin[0][2])):
        raise ValueError('configured clone administrator required')
    metadata=db.execute("SELECT value FROM metadata WHERE key='store_id'").fetchall()
    if len(metadata)!=1 or not isinstance(metadata[0][0],str) or not re.fullmatch('[0-9a-f]{48}',metadata[0][0]):
        raise ValueError('unambiguous store identity required')
    # Retained JSON indexes are evidence, not executable SQL or trusted objects.
    for table in required.keys()-{'admin','sessions','metadata'}:
        columns=[x[1] for x in db.execute('SELECT * FROM pragma_table_info(?)',(table,))]
        for row in db.execute('SELECT * FROM '+_clone_identifier(table)):
            values=dict(zip(columns,row));body=strict_json(values['body'])
            if not isinstance(values['id'],str) or not values['id']:raise ValueError('invalid retained clone index')
            if not isinstance(body,dict):raise ValueError('invalid retained clone JSON')
            pairs={'id':'id','plan_id':'planId','request_id':'requestId','status':'status','data_path':'dataPath','port':'hostPort','path':'path'}
            for column,key in pairs.items():
                if column in values and not (table in ('runtime_settings','runtime_catalog') and column=='id') and (type(body.get(key)) is not type(values[column]) or body.get(key)!=values[column]):
                    raise ValueError('retained clone index differs')
    sessions=db.execute('SELECT token_hash,username,expires_at FROM sessions').fetchall()
    for token,user,expiry in sessions:
        if (not isinstance(token,str) or not re.fullmatch('[0-9a-f]{64}',token) or user!=admin[0][1]
                or not isinstance(expiry,int)):
            raise ValueError('invalid retained clone session')
    counts={table:_clone_digest(db.execute('SELECT * FROM '+_clone_identifier(table))) for table in tables}
    if expire_at is not None:
        counts['sessions']=_clone_digest((token,user,min(expiry,expire_at)) for token,user,expiry in sessions)
    return {'storeId':metadata[0][0],'schemaDigest':_clone_digest(schema),'tables':counts},sum(expiry>expire_at for _,_,expiry in sessions) if expire_at is not None else 0


def _clone_sqlite_api():
    # Python 3.9 has no Connection.serialize. Use documented SQLite C APIs,
    # never CPython object layouts or a mutable pathname for a SQL writer.
    if platform.system() not in ('Darwin','Linux'):
        raise ValueError('inode-bound clone writer unsupported')
    library=ctypes.util.find_library('sqlite3')
    if not library:raise ValueError('native SQLite clone library unavailable')
    try:
        api=ctypes.CDLL(library)
        pointer=ctypes.c_void_p;integer=ctypes.c_int;string=ctypes.c_char_p
        signatures={
            'sqlite3_libversion_number':(integer,[]),
            'sqlite3_open_v2':(integer,[string,ctypes.POINTER(pointer),integer,string]),
            'sqlite3_close':(integer,[pointer]),
            'sqlite3_backup_init':(pointer,[pointer,string,pointer,string]),
            'sqlite3_backup_step':(integer,[pointer,integer]),
            'sqlite3_backup_finish':(integer,[pointer]),
            'sqlite3_exec':(integer,[pointer,string,pointer,pointer,pointer]),
            'sqlite3_serialize':(pointer,[pointer,string,ctypes.POINTER(ctypes.c_longlong),ctypes.c_uint]),
            'sqlite3_free':(None,[pointer])}
        for name,(result,args) in signatures.items():
            function=getattr(api,name);function.restype=result;function.argtypes=args
        # immutable read-only source URIs require SQLite >= 3.22.0.
        if api.sqlite3_libversion_number()<3022000:raise ValueError('native SQLite clone version unsupported')
        return api
    except (OSError,AttributeError):
        raise ValueError('native SQLite clone API unavailable') from None


def _clone_memory_image(api,source,epoch):
    # Both backup and expiration write exclusively to SQLite's :memory: DB.
    # Only the retained O_EXCL FD below ever writes persistent clone bytes.
    source_db=ctypes.c_void_p();destination=ctypes.c_void_p();image=None
    def check(status):
        if status!=0:raise ValueError('native SQLite clone failed')
    try:
        uri=('file:'+urllib.parse.quote(source,safe='/')+'?mode=ro&immutable=1').encode()
        check(api.sqlite3_open_v2(uri,ctypes.byref(source_db),0x00000001|0x00000040,None))
        check(api.sqlite3_open_v2(b':memory:',ctypes.byref(destination),0x00000002|0x00000004,None))
        backup=api.sqlite3_backup_init(destination,b'main',source_db,b'main')
        if not backup:raise ValueError('native SQLite clone backup unavailable')
        try:
            if api.sqlite3_backup_step(backup,-1)!=101:raise ValueError('native SQLite clone backup failed')
        finally:check(api.sqlite3_backup_finish(backup))
        check(api.sqlite3_exec(destination,('UPDATE sessions SET expires_at=%d WHERE expires_at>%d'%(epoch,epoch)).encode(),None,None,None))
        size=ctypes.c_longlong()
        image=api.sqlite3_serialize(destination,b'main',ctypes.byref(size),0)
        if not image or size.value<=0:raise ValueError('native SQLite clone serialization unavailable')
        return ctypes.string_at(image,size.value)
    finally:
        if image:api.sqlite3_free(image)
        if destination:api.sqlite3_close(destination)
        if source_db:api.sqlite3_close(source_db)


def _clone_receipt_publisher():
    # A missing symbol fails before creating the target; unsupported filesystem
    # flags fail at publication without falling back to an overwriting rename.
    names={'Darwin':('renameatx_np',0x00000004),'Linux':('renameat2',0x00000001)}
    selected=names.get(platform.system())
    if selected is None:raise ValueError('atomic clone receipt publication unsupported')
    try:
        libc=ctypes.CDLL(None,use_errno=True);rename=getattr(libc,selected[0])
    except (OSError,AttributeError):
        raise ValueError('atomic clone receipt publication unavailable') from None
    rename.restype=ctypes.c_int
    rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    def publish(directory_fd):
        if rename(directory_fd,b'clone-receipt.pending.json',directory_fd,b'clone-receipt.json',selected[1])!=0:
            raise OSError(ctypes.get_errno(),'clone receipt publication failed')
    return publish


def _prepare_update_locked(record,current,release,artifact_sha256,verify_update):
    """Bind a readonly review to a running source and the caller's update lease.

    This is an input to the future version-switch coordinator, never permission
    to execute a switch or proof that target software has been delivered.
    """
    if not isinstance(release,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}',release):
        raise ValueError('invalid review release')
    if not isinstance(artifact_sha256,str) or not re.fullmatch('[0-9a-f]{64}',artifact_sha256):
        raise ValueError('invalid review artifact checksum')
    if not isinstance(current,dict):raise ValueError('current quiesced maintenance required')
    p=record['plan'];root=p['root'];source=root+'/metadata/store/store.sqlite'
    receipt=root+'/releases/'+p['release']+'/receipt.json'
    if release.lower()==p['release'].lower():raise ValueError('review release must differ')
    if not isinstance(record.get('artifactSHA256'),str) or not re.fullmatch('[0-9a-f]{64}',record['artifactSHA256']):
        raise ValueError('invalid source artifact checksum')
    directories={};files={};instance=None
    def lease():
        if not callable(verify_update) or _HELD_CLONE_LEASES.get(verify_update)!=('update.lock',p['storage']):
            raise ValueError('active native update lease required')
        verify_update()
    def verify_source():
        nonlocal instance
        lease()
        refreshed,actual=validate_receipt(receipt)
        if refreshed!=record or actual.get('State',{}).get('Running') is not True:
            raise ValueError('running own review source changed')
        if p['labels'].get('io.space-store.control-protocol')!='v1':raise ValueError('controller protocol unsupported')
        observed=controller_health(p,record['containerId'],record['imageId'])
        if instance is not None and observed!=instance:raise ValueError('review controller instance changed')
        instance=observed
        for path in (root,root+'/metadata',root+'/metadata/store',root+'/releases',str(pathlib.Path(receipt).parent)):
            identity=directory(path,secure_ancestors=True)
            if path in directories and directories[path]!=identity:raise ValueError('review source directory changed')
            directories[path]=identity
        for path in (root+'/.space-store-container.json',root+'/metadata/.space-store-container-self.json',receipt):
            proof=_private_file_proof(path)
            if path in files and files[path]!=proof:raise ValueError('review source file changed')
            files[path]=proof
        lease()
    def database_identity():
        # Each readonly SQL transaction closes before any Docker/health check.
        assert_quiesced(source,current);assert_idle(source)
        with readonly_evidence(source) as db:
            proof,_=_clone_database_proof(db)
            if db.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:raise ValueError('review source integrity differs')
        lease()
        return {key:proof[key] for key in ('storeId','schemaDigest')}
    def target_absent():
        # Missing updates is valid: review never creates a directory or file.
        with directory_handle(root,secure_ancestors=True) as rootfd:
            try:os.stat('updates',dir_fd=rootfd,follow_symlinks=False)
            except FileNotFoundError:return
        with directory_handle(root+'/updates',secure_ancestors=True) as updatesfd:
            try:os.stat(release,dir_fd=updatesfd,follow_symlinks=False)
            except FileNotFoundError:return
            raise FileExistsError('review target already exists')
    verify_source()
    target=plan(root+'/updates/'+release,p['storage'],p['ip'],p['port'],release,p['uid'],p['gid'],
                p['engine'],p['dockerRoot'],p['socketGid'],p['nasOrigin'],p.get('nasAdminOnly',False))
    target_absent();before=database_identity()
    after=database_identity()
    if after!=before:raise ValueError('review database identity changed')
    verify_source();target_absent();lease()
    identity=lambda value:{key:value[key] for key in ('device','inode','uid')}
    body={'schema':1,'state':'review','kind':'store-version-switch','maintenance':current,
          'source':{'containerId':record['containerId'],'imageId':record['imageId'],
                    'artifactSHA256':record['artifactSHA256'],'receiptPath':receipt,'receiptProof':files[receipt],
                    'plan':rebuild_plan(p),'directories':{key:identity(record['directories'][key]) for key in ('root','storage')},
                    'metadata':identity(record['metadata']),
                    'hostEvidence':{path:{key:value[key] for key in ('device','inode')} for path,value in record['hostEvidence'].items()},
                    'controllerInstanceId':instance,'administratorConfigured':True,**before},
          'target':{'plan':target,'artifactSHA256':artifact_sha256}}
    encoded=json.dumps(body,sort_keys=True,separators=(',',':')).encode('utf-8')
    # JSON roundtrip also detaches every mutable value from caller input.
    return {'plan':json.loads(encoded),'sha256':hashlib.sha256(encoded).hexdigest()}


def _clone_metadata_locked(record,current,release,verify_update,verify_controller):
    """Clone a stopped own store inside the caller's existing two native leases.

    The future Stop/clone/Start coordinator must keep the outer update lease.
    This internal component never stops/starts containers and is not a switch CLI.
    """
    if not isinstance(release,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}',release):
        raise ValueError('invalid clone release')
    api=_clone_sqlite_api();publish_receipt=_clone_receipt_publisher()
    p=record['plan'];root=p['root'];source=root+'/metadata/store/store.sqlite'
    receipt=root+'/releases/'+p['release']+'/receipt.json'
    source_directories={}
    def verify():
        for callback,name in ((verify_update,'update.lock'),(verify_controller,'controller.lock')):
            if _HELD_CLONE_LEASES.get(callback)!=(name,p['storage']):raise ValueError('active native clone leases required')
            callback()
        refreshed,actual=validate_receipt(receipt)
        if refreshed!=record or actual.get('State',{}).get('Running') is not False:
            raise ValueError('stopped own clone source changed')
        for path in (root,root+'/metadata',root+'/metadata/store',root+'/releases',str(pathlib.Path(receipt).parent)):
            identity=directory(path,secure_ancestors=True)
            if path in source_directories and source_directories[path]!=identity:raise ValueError('clone source directory changed')
            source_directories[path]=identity
        # These read transactions close before the next network/Docker verify.
        assert_quiesced(source,current,stopped=True);assert_idle(source,stopped=True)
        verify_update();verify_controller()
    verify();original=_clone_source_proof(record);epoch=int(time.time())
    with readonly_evidence(source,stopped=True) as db:
        before,expired=_clone_database_proof(db,epoch)
        if db.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:raise ValueError('source clone integrity differs')
    verify()
    if _clone_source_proof(record)!=original:raise ValueError('clone source changed')
    target_root=root+'/updates/'+release;target=target_root+'/metadata/store/store.sqlite'
    if target==source or any(target_root==x or target_root.startswith(x+'/') or x.startswith(target_root+'/') for x in (p['storage'],root+'/metadata')):
        raise ValueError('clone paths overlap')
    stack=contextlib.ExitStack();published=False
    try:
        rootfd=stack.enter_context(directory_handle(root,secure_ancestors=True))
        try:os.mkdir('updates',0o700,dir_fd=rootfd)
        except FileExistsError:pass
        updatesfd=stack.enter_context(directory_handle(root+'/updates',secure_ancestors=True))
        os.mkdir(release,0o700,dir_fd=updatesfd)  # Never replay or adopt a target.
        targetfd=stack.enter_context(directory_handle(target_root,secure_ancestors=True))
        retained={target_root:directory(target_root,secure_ancestors=True),root+'/updates':directory(root+'/updates',secure_ancestors=True)}
        def verify_target():
            for path,identity in retained.items():
                if directory(path,secure_ancestors=True)!=identity:raise ValueError('clone target directory changed')
        try:
            os.mkdir('metadata',0o700,dir_fd=targetfd)
            metadatafd=stack.enter_context(directory_handle(target_root+'/metadata',secure_ancestors=True))
            os.mkdir('store',0o700,dir_fd=metadatafd)
            storefd=stack.enter_context(directory_handle(target_root+'/metadata/store',secure_ancestors=True))
            for path in (target_root+'/metadata',target_root+'/metadata/store'):retained[path]=directory(path,secure_ancestors=True)
            fd=os.open('store.sqlite',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=storefd)
            stack.callback(os.close,fd);created=os.fstat(fd)
            def verify_db():
                verify_target()
                for suffix in ('-wal','-shm','-journal'):
                    try:os.stat('store.sqlite'+suffix,dir_fd=storefd,follow_symlinks=False)
                    except FileNotFoundError:continue
                    raise ValueError('unexpected clone target sidecar')
                node=os.stat('store.sqlite',dir_fd=storefd,follow_symlinks=False);held=os.fstat(fd)
                if (not stat.S_ISREG(node.st_mode) or node.st_nlink!=1 or node.st_uid!=os.getuid()
                        or stat.S_IMODE(node.st_mode)!=0o600 or (node.st_dev,node.st_ino)!=(created.st_dev,created.st_ino)
                        or held.st_nlink!=1):raise ValueError('clone target database changed')
            verify();verify_db()
            if _clone_source_proof(record)!=original:raise ValueError('clone source changed')
            image=_clone_memory_image(api,source,epoch)
            verify_db()
            # A path replacement after this check cannot redirect os.write:
            # fd is still the newly created inode, not the substituted entry.
            remaining=memoryview(image)
            while remaining:
                written=os.write(fd,remaining[:1024*1024])
                if written<=0:raise OSError('clone byte write failed')
                remaining=remaining[written:]
            del remaining,image
            os.fsync(fd);verify_db()
            with readonly_evidence(target,stopped=True) as destination:
                after,_=_clone_database_proof(destination)
                if after!=before or destination.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:
                    raise ValueError('clone preservation verification failed')
            verify_db();target_proof=_private_file_proof(target)
            verify()
            if _clone_source_proof(record)!=original:raise ValueError('clone source changed')
            verify_db()
            if _private_file_proof(target)!=target_proof:raise ValueError('clone target bytes changed')
            result={'schema':1,'state':'completed','publication':'atomic-noreplace-v1',
                    'durability':'file-synced-directory-entry-not-guaranteed',
                    'sourceContainerId':record['containerId'],'sourceImageId':record['imageId'],
                    'maintenanceId':current['id'],'release':release,'source':source,'target':target,
                    'sourceFiles':original,'sourceDirectories':source_directories,'targetDirectories':retained,
                    'targetDatabase':target_proof,'storeId':before['storeId'],'schemaDigest':before['schemaDigest'],
                    'tables':before['tables'],'expiredAt':epoch,'copiedSessions':before['tables']['sessions']['rows'],'expiredSessions':expired}
            verify_target()
            # Pending is never completion evidence, even if its JSON is whole.
            # Never delete it on failure or overwrite an existing final receipt.
            pending=target_root+'/clone-receipt.pending.json'
            outfd=os.open('clone-receipt.pending.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=targetfd)
            receipt_created=os.fstat(outfd)
            out=stack.enter_context(os.fdopen(outfd,'w',encoding='utf-8',newline='\n'))
            payload=json.dumps(result)+'\n';payload_bytes=payload.encode('utf-8')
            expected={'device':receipt_created.st_dev,'inode':receipt_created.st_ino,'uid':receipt_created.st_uid,
                      'size':len(payload_bytes),'sha256':hashlib.sha256(payload_bytes).hexdigest()}
            out.write(payload);out.flush();os.fsync(out.fileno())
            def verify_staged():
                proof=_private_file_proof(pending);held=os.fstat(outfd)
                # Even the first proof must match the created inode and intended
                # bytes, not whatever now occupies the pending pathname. Keep
                # the descriptor alive through every pre-publication check.
                if (any(proof[key]!=value for key,value in expected.items())
                        or not stat.S_ISREG(held.st_mode) or held.st_nlink!=1
                        or held.st_uid!=os.getuid() or stat.S_IMODE(held.st_mode)!=0o600
                        or (held.st_dev,held.st_ino,held.st_uid,held.st_size,held.st_mtime_ns,held.st_ctime_ns)
                        !=tuple(proof[key] for key in ('device','inode','uid','size','mtimeNs','ctimeNs'))):
                    raise ValueError('clone receipt changed before publication')
                return proof
            staged=verify_staged()
            for directory_fd in (storefd,metadatafd,targetfd,updatesfd,rootfd):os.fsync(directory_fd)
            verify();verify_db()
            if _clone_source_proof(record)!=original or _private_file_proof(target)!=target_proof:
                raise ValueError('clone changed before publication')
            if verify_staged()!=staged:raise ValueError('clone receipt changed before publication')
            # The no-replace rename is the final logical commit. All required
            # fsyncs precede it. Power loss can lose this final directory entry;
            # an absent final receipt always means uncompleted, retained work.
            publish_receipt(targetfd);published=True
            return result
        except Exception:
            # Retain the partial database; a fixed failure receipt contains no
            # exception text, rows, session IDs or credential hashes.
            try:
                verify_target()
                failed=os.open('clone-receipt.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=targetfd)
                with os.fdopen(failed,'w') as out:
                    json.dump({'schema':1,'state':'failed','reason':'clone_unverified','release':release},out);out.flush();os.fsync(out.fileno())
            except (OSError,ValueError):pass
            raise
    finally:
        try:stack.close()
        except OSError:
            # No writes remain. A descriptor cleanup error cannot turn the
            # already committed final receipt into a reported clone failure.
            if not published:raise


def host_identity(engine):
    result={'uid':os.getuid(),'gid':os.getgid(),'dockerRoot':'','socketGid':None}
    if engine=='local':
        node=os.stat('/var/run/docker.sock',follow_symlinks=False)
        if not stat.S_ISSOCK(node.st_mode): raise ValueError('fixed Docker socket not socket')
        cache=command(['docker','info','--format','{{json .DockerRootDir}}'])
        result.update(dockerRoot=json.loads(cache),socketGid=node.st_gid)
    return result


def host_evidence(p):
    if p['engine']!='local': return {}
    identity=host_identity('local')
    if identity['dockerRoot']!=p['dockerRoot'] or identity['socketGid']!=p['socketGid']:
        raise ValueError('host Docker facts changed')
    cache=directory(p['dockerRoot'],private=False,metadata_only=True)
    sysmeta=directory('/sys',private=False,metadata_only=True)
    net=directory('/proc/1/net',private=False,metadata_only=True)
    mount=os.stat('/proc/1/mountinfo',follow_symlinks=False)
    if not stat.S_ISREG(mount.st_mode): raise ValueError('host mount metadata not regular')
    paths=('/var/run/docker.sock','/proc/1/mountinfo')
    evidence={path:{'device':os.stat(path,follow_symlinks=False).st_dev,
                  'inode':os.stat(path,follow_symlinks=False).st_ino} for path in paths}
    for path,entry in ((p['dockerRoot'],cache),('/sys',sysmeta),('/proc/1/net',net)):
        evidence[path]={key:entry[key] for key in ('device','inode')}
    return evidence


def probe(p):
    if platform.machine() != 'x86_64' or os.getuid() != p['uid'] or os.getgid() != p['gid']:
        raise ValueError('NAS architecture/owner differs')
    dirs = {name: directory(p[name]) for name in ('root', 'storage')}
    host_evidence(p)
    marker = p['root'] + '/.space-store-container.json'
    expected = {'schema': 1, 'service': 'space-store', 'deployment': p['labels']['io.space-store.deployment'], 'directories': dirs}
    if os.path.lexists(marker):
        if read_json(marker) != expected:
            raise ValueError('deployment directory identity differs')
        directory(p['root'] + '/releases'); directory(p['root'] + '/metadata')
    elif os.listdir(p['root']):
        raise ValueError('first deployment requires empty dedicated directory')
    # Refuse manually started host services too; never adopt their data/process.
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            args = pathlib.Path('/proc/' + pid + '/cmdline').read_bytes().split(b'\0')
            for flag, path in ((b'--data-dir', (p['root'] + '/metadata').encode()),
                               (b'--storage-root', p['storage'].encode())):
                if (flag + b'=' + path in args or any(args[i] == flag and args[i + 1] == path for i in range(len(args) - 1))):
                    raise ValueError('live process uses chosen roots; preserved')
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    # Never share metadata/data with an existing container, even stopped/foreign.
    ids = command(['docker', 'ps', '-aq']).splitlines()
    if ids:
        items = json.loads(command(['docker', 'inspect'] + ids))
        for item in items:
            for mount in item.get('Mounts', []):
                source = mount.get('Source', '')
                if any(source == p[key] or source.startswith(p[key] + '/') or p[key].startswith(source + '/') for key in ('root', 'storage')):
                    raise ValueError('existing container uses selected roots; all resources preserved')
    with socket.socket() as sock:
        sock.bind((p['ip'], p['port']))
    endpoint = json.loads(command(['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']))
    if endpoint != 'unix:///var/run/docker.sock' or os.environ.get('DOCKER_HOST') or os.environ.get('DOCKER_CONTEXT'):
        raise ValueError('fixed local Docker Unix socket required')
    return expected


def unpack(data, release):
    # Fresh release only; reject duplicate, link, device and unreviewed paths.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        names = set()
        members = archive.getmembers()
        for member in members:
            name = member.name
            if (not member.isfile() or name in names or not re.fullmatch(r'(Dockerfile|space-store|docker|docker-compose|web/[a-zA-Z0-9_./-]+)', name)
                    or str(pathlib.PurePosixPath(name)) != name
                    or '..' in pathlib.PurePosixPath(name).parts or member.size > 256 * 1024 * 1024):
                raise ValueError('unsafe release member')
            names.add(name)
        if not {'Dockerfile', 'space-store', 'docker', 'docker-compose', 'web/store.html'} <= names:
            raise ValueError('incomplete release')
        if sum(m.size for m in members) > 512 * 1024 * 1024:
            raise ValueError('oversized expanded release')
        for member in members:
            target = release / member.name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as out:
                out.write(archive.extractfile(member).read())
            os.chmod(target, 0o555 if member.name in ('space-store', 'docker', 'docker-compose') else 0o444)


def install(p, checksum):
    expected = probe(p)
    data = sys.stdin.buffer.read(512 * 1024 * 1024 + 1)
    if len(data) > 512 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != checksum:
        raise ValueError('release checksum differs')
    root = pathlib.Path(p['root'])
    if not (root / '.space-store-container.json').exists():
        new_json(root / '.space-store-container.json', expected)
        (root / 'releases').mkdir(mode=0o700); (root / 'metadata').mkdir(mode=0o700)
    release = root / 'releases' / p['release']; release.mkdir(mode=0o700)
    new_json(release / 'plan.json', p)
    unpack(data, release)
    # Build retained immutable image in retained fresh context; never overwrite tags.
    tag = 'space-store-owned:' + p['release'].lower()
    if command(['docker', 'image', 'ls', '-q', tag]):
        raise ValueError('existing image tag preserved')
    command(['docker', 'build', '--pull', '--platform', 'linux/amd64', '--tag', tag,
             '--label', 'io.space-store.service=space-store', str(release)])
    image = json.loads(command(['docker', 'image', 'inspect', tag]))[0]
    if image.get('Architecture') != 'amd64' or image.get('Os') != 'linux':
        raise ValueError('built image architecture differs')
    container_id = command(create_arguments(p, image['Id']))
    receipt = {'containerId': container_id, 'imageId': image['Id'], 'artifactSHA256': checksum, 'plan': p,
               'directories':{key:directory(p[key]) for key in ('root','storage')},
               'metadata':directory(p['root']+'/metadata'),'hostEvidence':host_evidence(p)}
    new_json(release / 'receipt.json', receipt)
    actual = json.loads(command(['docker', 'inspect', container_id]))[0]
    verify_owned(actual, p, container_id, image['Id'])
    if actual.get('State', {}).get('Running') is not False:
        raise ValueError('fresh container state differs')
    self_path=root/'metadata'/'.space-store-container-self.json'
    new_json(self_path,self_record(p,container_id,image['Id']))
    verify_self(self_path,p,container_id,image['Id'])
    validate_receipt(release/'receipt.json')
    command(['docker', 'start', container_id])
    health_check(p,container_id,image['Id'],release/'receipt.json')


def controller_health(p,container_id,image_id):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://%s:%d/api/health' % (p['ip'],p['port']),timeout=2) as response:
        health=strict_json(response.read())
    actual=json.loads(command(['docker','inspect',container_id]))[0]
    verify_owned(actual,p,container_id,image_id)
    logs=command(['docker','logs','--tail','20',container_id])
    ready=[json.loads(line) for line in logs.splitlines() if line.startswith('{')]
    if not isinstance(health,dict): raise ValueError('controller health unconfirmed')
    data=health.get('data',{})
    if not isinstance(data,dict): raise ValueError('controller health unconfirmed')
    instance=data.get('instanceId')
    if (health.get('ok') is not True or data.get('service')!='space-store' or data.get('controllerProtocol')!='v1'
            or not isinstance(instance,str) or not re.fullmatch('[0-9a-f]{32}',instance)
            or not any(isinstance(x,dict) and x.get('event')=='ready' and x.get('instanceId')==instance for x in ready)
            or actual.get('State',{}).get('Running') is not True):
        raise ValueError('controller health unconfirmed')
    return instance


def health_check(p,container_id,image_id,receipt_path):
    for attempt in range(40):
        try:
            controller_health(p,container_id,image_id)
            print(json.dumps({'ok':True,'receipt':str(receipt_path),'containerId':container_id,'engine':p['engine']}));return
        except (OSError,ValueError): pass
        time.sleep(0.25)
    raise ValueError('health unconfirmed; container/files retained')


def validate_receipt(path):
    canonical(str(path))
    directory(str(pathlib.Path(path).parent),secure_ancestors=True)
    record=read_json(path); p=record['plan']
    if p!=rebuild_plan(p) or str(path)!=p['root']+'/releases/'+p['release']+'/receipt.json':
        raise ValueError('receipt plan/path differs')
    if os.getuid()!=p['uid'] or os.getgid()!=p['gid']:
        raise ValueError('receipt owner differs')
    for key in ('root','storage'):
        if directory(p[key],secure_ancestors=True)!=record['directories'][key]: raise ValueError('receipt directory changed')
    if directory(p['root']+'/metadata',secure_ancestors=True)!=record['metadata'] or host_evidence(p)!=record['hostEvidence']:
        raise ValueError('receipt metadata/host evidence changed')
    marker=read_json(p['root']+'/.space-store-container.json')
    expected={'schema':1,'service':'space-store','deployment':p['labels']['io.space-store.deployment'],
              'directories':record['directories']}
    if marker!=expected: raise ValueError('root ownership marker differs')
    verify_self(p['root']+'/metadata/.space-store-container-self.json',p,record['containerId'],record['imageId'])
    actual=json.loads(command(['docker','inspect',record['containerId']]))[0]
    verify_owned(actual,p,record['containerId'],record['imageId'])
    return record,actual


def controlled_restart(path):
    record,actual=validate_receipt(path);p=record['plan'];cid=record['containerId'];image=record['imageId']
    if actual.get('State',{}).get('Running') is not True:
        raise ValueError('controlled restart requires this own running store')
    if p['labels'].get('io.space-store.control-protocol')!='v1': raise ValueError('controller protocol unsupported')
    instance=controller_health(p,cid,image)
    db=pathlib.Path(p['root'])/'metadata/store/store.sqlite'
    current=assert_quiesced(db);assert_idle(db)
    with exclusive_update(record) as verify_lock:
        refreshed,actual=validate_receipt(path)
        if refreshed!=record or actual.get('State',{}).get('Running') is not True or controller_health(p,cid,image)!=instance:
            raise ValueError('source controller identity changed')
        assert_quiesced(db,current);assert_idle(db);verify_lock()
        command(['docker','stop','--time','15',cid])
        refreshed,actual=validate_receipt(path)
        if refreshed!=record or actual.get('State',{}).get('Running') is not False:
            raise ValueError('own store stop unconfirmed; preserved')
        with stopped_controller(record) as verify_controller:
            assert_quiesced(db,current,stopped=True);assert_idle(db,stopped=True)
            verify_controller();verify_lock()
        command(['docker','start',cid])
        health_check(p,cid,image,path)
        verify_lock()
        # The same API pause remains intact until an administrator resumes it.
        assert_quiesced(db,current)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--remote':
        if sys.argv[2]=='identity':
            print(json.dumps(host_identity(sys.argv[3]))); return
        if sys.argv[2]=='restart':
            controlled_restart(sys.argv[3]); return
        phase, raw = sys.argv[2:4]; p = json.loads(raw)
        rebuilt = rebuild_plan(p)
        if p != rebuilt:
            raise ValueError('remote plan differs')
        if phase == 'probe':
            print(json.dumps(probe(p)))
        elif phase == 'install':
            install(p, sys.argv[4])
        else:
            raise ValueError('unsupported remote phase')
        return
    local_main()


def local_main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--alias', required=True)
    parser.add_argument('--deploy-root')
    parser.add_argument('--storage-root')
    parser.add_argument('--publish-ip')
    parser.add_argument('--port', type=int, default=18441)
    parser.add_argument('--engine', choices=['disabled', 'local'], default='disabled')
    parser.add_argument('--nas-origin',default='')
    parser.add_argument('--nas-admin-only',action='store_true')
    parser.add_argument('--restart-receipt',help='Explicit controlled restart of exactly this retained own receipt; no deploy')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', args.alias):
        raise ValueError('invalid alias')
    source=pathlib.Path(__file__).read_text()
    if args.restart_receipt:
        canonical(args.restart_receipt)
        if args.deploy_root or args.storage_root or args.publish_ip or args.nas_origin or args.nas_admin_only or args.engine!='disabled':
            raise ValueError('restart cannot combine deployment options')
    elif not all((args.deploy_root,args.storage_root,args.publish_ip)):
        parser.error('deployment requires deploy-root, storage-root and publish-ip')
    # Validate local input before contacting any server.
    release = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4)
    if not args.restart_receipt:
        plan(args.deploy_root,args.storage_root,args.publish_ip,args.port,release,1,1,args.engine,
             '/placeholder-cache' if args.engine=='local' else '',1 if args.engine=='local' else None,args.nas_origin,args.nas_admin_only)
    servers = json.loads(command(['sshbind', 'list', '--json']))['servers']
    selected = [s for s in servers if s.get('name') == args.alias and s.get('usable') is True]
    if len(selected) != 1:
        raise ValueError('selected sshbind alias absent/unusable')
    if args.restart_receipt:
        remote='python3 -c '+' '.join(shlex.quote(x) for x in (source,'--remote','restart',args.restart_receipt))
        subprocess.run(['sshbind','exec','--timeout','300',args.alias,remote],check=True,timeout=315)
        return
    identity_command='python3 -c '+' '.join(shlex.quote(x) for x in (source,'--remote','identity',args.engine))
    identity = json.loads(command(['sshbind', 'exec', '--json', args.alias,
                                  identity_command]))
    if identity.get('exit_code') != 0:
        raise ValueError('remote identity probe failed')
    facts=json.loads(identity['stdout'])
    p=plan(args.deploy_root,args.storage_root,args.publish_ip,args.port,release,facts['uid'],facts['gid'],
           args.engine,facts['dockerRoot'],facts['socketGid'],args.nas_origin,args.nas_admin_only)
    def remote(phase, *extra):
        return 'python3 -c ' + ' '.join(shlex.quote(x) for x in (source, '--remote', phase, json.dumps(p), *extra))
    result = json.loads(command(['sshbind', 'exec', '--json', args.alias, remote('probe')]))
    if result.get('exit_code') != 0:
        raise ValueError(remote_error(result))
    repo = pathlib.Path(__file__).resolve().parent.parent
    build = pathlib.Path(tempfile.mkdtemp(prefix='space-store-container-release-')).resolve()
    print('Retained public release build context: ' + str(build), flush=True)
    artifact = build_bundle(repo, build)
    checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
    subprocess.run([sys.executable, str(repo / 'scripts/transfer-store-sshbind.py'), args.alias,
                    selected[0]['host'], str(artifact), remote('install', checksum)], check=True)


def build_bundle(repo, build):
    env = dict(os.environ, CGO_ENABLED='0', GOOS='linux', GOARCH='amd64')
    subprocess.run(['go', 'build', '-trimpath', '-o', str(build / 'space-store'), './cmd/space-gateway'], cwd=repo / 'server', env=env, check=True)
    subprocess.run(['pnpm', '--filter', '@space/store', 'typecheck'], cwd=repo, check=True)
    frontend = build / 'frontend'
    subprocess.run(['pnpm', '--filter', '@space/store', 'exec', 'vite', 'build', '--manifest', '--outDir', str(frontend)], cwd=repo, check=True)
    manifest = json.loads((frontend / '.vite/manifest.json').read_text())
    files = {'store.html'}; seen = set()
    def visit(key):
        if key in seen: return
        seen.add(key); entry = manifest[key]; files.add(entry['file'])
        files.update(entry.get('css', [])); files.update(entry.get('assets', []))
        for key in entry.get('imports', []) + entry.get('dynamicImports', []): visit(key)
    visit('store.html')
    public = repo / 'apps/store/public'
    if public.is_dir(): files.update(str(x.relative_to(public)) for x in public.rglob('*') if x.is_file())
    if 'index.html' in files or manifest.get('index.html', {}).get('file') in files:
        raise ValueError('client entry in store closure')
    with urllib.request.urlopen(DOCKER_URL, timeout=60) as response:
        cli_archive = response.read(128 * 1024 * 1024)
    if hashlib.sha256(cli_archive).hexdigest() != DOCKER_SHA256:
        raise ValueError('official fixed Docker CLI archive checksum differs')
    with tarfile.open(fileobj=io.BytesIO(cli_archive)) as archive:
        cli = archive.extractfile('docker/docker').read()
    if cli[:4] != b'\x7fELF' or cli[18:20] != b'\x3e\x00':
        raise ValueError('Docker CLI is not Linux amd64 ELF')
    (build / 'docker').write_bytes(cli)
    with urllib.request.urlopen(COMPOSE_URL,timeout=120) as response:
        compose=response.read(128*1024*1024)
    if hashlib.sha256(compose).hexdigest()!=COMPOSE_SHA256 or compose[:4]!=b'\x7fELF' or compose[18:20]!=b'\x3e\x00':
        raise ValueError('official fixed Compose plugin checksum or architecture differs')
    (build/'docker-compose').write_bytes(compose)
    dockerfile = (repo / 'docker/store/Dockerfile').read_bytes()
    (build / 'Dockerfile').write_bytes(dockerfile)
    artifact = build / 'release.tar.gz'
    with tarfile.open(artifact, 'w:gz') as archive:
        for name in ('Dockerfile', 'space-store', 'docker', 'docker-compose'):
            archive.add(build / name, arcname=name, recursive=False)
        for name in sorted(files):
            path = frontend / name
            if path.is_symlink() or not path.is_file() or '..' in pathlib.PurePosixPath(name).parts or name.startswith('/'):
                raise ValueError('unsafe asset')
            archive.add(path, arcname='web/' + name, recursive=False)
    return artifact


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, sqlite3.Error, KeyError) as error:
        # Never emit Docker/log/API/command bodies, which may contain secrets.
        sys.exit('Container deployment stopped: '+safe_error(error))
