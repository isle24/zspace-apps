import copy
import importlib.util
import pathlib
import tempfile
import io
import tarfile
import unittest
import sqlite3
import os
import json
import stat
import fcntl
import secrets
import subprocess
import contextlib
import http.server
import threading
import select
import urllib.error
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('container_host', ROOT / 'store-container-host.py')
host = importlib.util.module_from_spec(SPEC)
if SPEC.loader:
    try:
        SPEC.loader.exec_module(host)
    except FileNotFoundError:
        pass


class ContainerDeployment(unittest.TestCase):
    def plan(self):
        return host.plan('/data_n008/store-service', '/data_n008/store-data',
                         '192.168.3.56', 18439, 'qa-release', 1001, 1002)

    def test_explicit_nas_admin_only_keeps_proxy_origin_and_receipt_command_bound(self):
        p=host.plan('/data_n008/store-service','/data_n008/store-data','192.168.3.56',18441,'client',1001,1002,nas_origin='http://192.168.3.56:18436',nas_only=True)
        self.assertIn('--nas-admin-only',p['command'])
        self.assertEqual(p['command'][p['command'].index('--public-origin')+1],'http://192.168.3.56:18436')
        self.assertEqual(host.rebuild_plan(p),p)
        with self.assertRaises(ValueError): host.plan('/data_n008/store-service','/data_n008/store-data','192.168.3.56',18441,'client',1001,1002,nas_only=True)

    def test_all_bind_mounts_explicitly_disable_propagation_and_submounts(self):
        p=host.plan('/data_n008/service','/data_n008/appdata','192.168.3.56',18441,'candidate',1001,1002,'local','/data_n008/cache',989)
        args=host.create_arguments(p,'sha256:'+'a'*64)
        mounts=[args[i+1] for i,item in enumerate(args) if item=='--mount']
        self.assertTrue(mounts)
        self.assertTrue(all(('bind-propagation=rslave' if ',src=/data_n008/cache,' in item else 'bind-propagation=rprivate') in item for item in mounts))
        self.assertTrue(all('bind-recursive=disabled' in item for item in mounts))

    def test_paths_stay_actual_host_paths_and_only_selected_roots_are_writable(self):
        p = self.plan()
        self.assertEqual(p['mounts'], [
            {'Type': 'bind', 'Source': '/data_n008/store-service/metadata',
             'Destination': '/data_n008/store-service/metadata', 'RW': True},
            {'Type': 'bind', 'Source': '/data_n008/store-data',
             'Destination': '/data_n008/store-data', 'RW': True}])
        self.assertIn('--storage-root', p['command'])
        self.assertEqual(p['command'][p['command'].index('--storage-root') + 1], '/data_n008/store-data')

    def test_dedicated_roots_cannot_overlap_or_be_protected(self):
        for storage in ['/data_n008/store-service', '/data_n008/store-service/sub', '/etc/private', '/data_n008/../etc', '/data_n008/x,y']:
            with self.subTest(storage=storage), self.assertRaises(ValueError):
                host.plan('/data_n008/store-service', storage, '192.168.3.56', 18439, 'qa-release', 1001, 1002)

    def test_explicit_real_nas_ip_and_nonofficial_port_required(self):
        for ip, port in [('0.0.0.0', 18439), ('127.0.0.1', 18439), ('nas.example', 18439), ('192.168.3.56', 5055)]:
            with self.subTest(ip=ip, port=port), self.assertRaises(ValueError):
                host.plan('/data_n008/store-service', '/data_n008/store-data', ip, port, 'qa-release', 1001, 1002)

    def test_local_engine_needs_fixed_cache_and_socket_evidence(self):
        with self.assertRaises(ValueError):
            host.plan('/data_n008/store-service', '/data_n008/store-data', '192.168.3.56', 18439, 'qa-release', 1001, 1002, engine='local')

    def local_plan(self):
        return host.plan('/data_n008/store-service', '/data_n008/store-data', '192.168.3.56', 18441,
                         'qa-release', 1001, 1002, engine='local', docker_root='/data_n008/zdocker', socket_gid=994,
                         nas_origin='http://192.168.3.56:5055')

    def test_local_contract_has_exact_host_evidence_and_only_owned_data_rw(self):
        p = self.local_plan()
        self.assertEqual(p['labels']['io.space-store.host-metadata'], 'v1')
        self.assertEqual([m for m in p['mounts'] if m['RW']], [
            {'Type': 'bind', 'Source': '/data_n008/store-service/metadata', 'Destination': '/data_n008/store-service/metadata', 'RW': True},
            {'Type': 'bind', 'Source': '/data_n008/store-data', 'Destination': '/data_n008/store-data', 'RW': True},
            {'Type': 'bind', 'Source': '/var/run/docker.sock', 'Destination': '/var/run/docker.sock', 'RW': True}])
        self.assertIn({'Type': 'bind', 'Source': '/proc/1/mountinfo', 'Destination': '/run/space-store-host/mountinfo', 'RW': False}, p['mounts'])
        self.assertIn({'Type': 'bind', 'Source': '/data_n008/zdocker', 'Destination': '/data_n008/zdocker', 'RW': False}, p['mounts'])
        args = host.create_arguments(p, 'sha256:' + 'b' * 64)
        self.assertIn('readonly', ','.join(args))
        self.assertIn('--group-add', args); self.assertIn('994', args)
        self.assertIn('DOCKER_CONFIG=/tmp/space-store-docker-config', p['env'])
        self.assertEqual(p['command'][-2:], ['--nas-origin', 'http://192.168.3.56:5055'])

    def test_local_inspection_rejects_readwrite_host_evidence_extra_socket_group_and_proxy(self):
        p = self.local_plan(); f = self.fixture(p); f['HostConfig']['GroupAdd'] = ['994']
        host.verify_owned(f, p, f['Id'], f['Image'])
        for change in [lambda x: x['Mounts'][3].update({'RW': True}),
                       lambda x: x['HostConfig']['GroupAdd'].append('0'),
                       lambda x: x['Config']['Env'].append('HTTP_PROXY=http://foreign'),
                       lambda x: x['Config']['Labels'].update({'io.space-store.host-metadata': 'v0'})]:
            changed=copy.deepcopy(f); change(changed)
            with self.assertRaises(ValueError): host.verify_owned(changed, p, f['Id'], f['Image'])

    def test_nas_origin_rejects_credentials_paths_noncanonical_and_wildcard(self):
        for origin in ['http://user:pass@nas:5055', 'http://nas:5055/path', 'http://0.0.0.0:5055', 'http://nas:80', 'HTTP://nas:5055', 'http://nas:05055']:
            with self.subTest(origin=origin), self.assertRaises(ValueError): host.validate_nas_origin(origin)

    def test_self_record_is_exclusive_and_cannot_adopt_cached_different_container(self):
        p = self.local_plan(); cid='a'*64; image='sha256:'+'b'*64
        with tempfile.TemporaryDirectory() as root:
            target=pathlib.Path(root)/'self.json'
            record=host.self_record(p,cid,image)
            host.new_json(target,record)
            host.verify_self(target,p,cid,image)
            with self.assertRaises(FileExistsError): host.new_json(target,record)
            with self.assertRaises(ValueError): host.verify_self(target,p,'c'*64,image)
            target.unlink(); target.symlink_to(pathlib.Path(root)/'foreign')
            with self.assertRaises(OSError): host.verify_self(target,p,cid,image)

    def database_fixture(self, root, paused=True):
        db=pathlib.Path(root)/'store.sqlite'
        fd=os.open(db,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
        with sqlite3.connect(db) as c:
            c.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
            c.execute("INSERT INTO metadata VALUES('store_maintenance_schema','v1')")
            c.execute('CREATE TABLE store_maintenance(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL)')
            for table in ('jobs','runtime_jobs'):
                c.execute('CREATE TABLE '+table+'(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL)')
            if paused:
                record={'id':'d'*48,'requestId':'normal-api-pause','status':'quiesced','purpose':'store-update','createdAt':'2026-10-12T00:00:00.123456789Z'}
                c.execute('INSERT INTO store_maintenance VALUES(?,?,?,?)',(record['id'],record['requestId'],record['status'],json.dumps(record)))
        return db

    def insert_job(self, db, table, status):
        record={'id':secrets.token_hex(24),'planId':secrets.token_hex(24),'requestId':secrets.token_hex(8),'status':status}
        with sqlite3.connect(db) as c:
            # NULL status is deliberately injected via a damaged schema fixture.
            if status is None:
                c.execute('ALTER TABLE '+table+' RENAME TO retained_'+table)
                c.execute('CREATE TABLE '+table+'(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,status TEXT,body TEXT NOT NULL)')
            c.execute('INSERT INTO '+table+' VALUES(?,?,?,?,?)',(record['id'],record['planId'],record['requestId'],status,json.dumps(record)))
        return record

    def test_restart_checks_both_sqlite_job_tables_and_unknown_status_fail_closed(self):
        for table in ['jobs','runtime_jobs']:
            for status in ['queued','running','needs_attention','unknown',None]:
                with self.subTest(table=table,status=status),tempfile.TemporaryDirectory() as root:
                    os.chmod(root,0o700);db=self.database_fixture(pathlib.Path(root).resolve())
                    self.insert_job(db,table,status)
                    with self.assertRaises(ValueError):host.assert_idle(db)
        with tempfile.TemporaryDirectory() as root:
            os.chmod(root,0o700);db=self.database_fixture(pathlib.Path(root).resolve());host.assert_idle(db)

    def test_legacy_completed_and_runtime_succeeded_history_admit_restart(self):
        with tempfile.TemporaryDirectory() as root:
            os.chmod(root,0o700);db=self.database_fixture(pathlib.Path(root).resolve())
            for table,status in [('jobs','completed'),('runtime_jobs','succeeded'),('jobs','failed'),('runtime_jobs','failed')]:self.insert_job(db,table,status)
            host.assert_idle(db)
            for table,status in [('jobs','succeeded'),('runtime_jobs','completed')]:
                record=self.insert_job(db,table,status)
                with self.assertRaises(ValueError):host.assert_idle(db)
                with sqlite3.connect(db) as c:c.execute('DELETE FROM '+table+' WHERE id=?',(record['id'],))

    def test_local_network_metadata_is_required_ro_and_forgery_is_rejected(self):
        p=self.local_plan()
        net={'Type':'bind','Source':'/proc/1/net','Destination':'/run/space-store-host/net','RW':False}
        self.assertIn(net,p['mounts']); self.assertEqual(len(p['mounts']),7)
        f=self.fixture(p); f['HostConfig']['GroupAdd']=['994']
        host.verify_owned(f,p,f['Id'],f['Image'])
        for change in [lambda x: x['Mounts'].remove(next(m for m in x['Mounts'] if m['Source']==net['Source'])),
                       lambda x: next(m for m in x['Mounts'] if m['Destination']==net['Destination']).update({'RW':True}),
                       lambda x: next(m for m in x['Mounts'] if m['Destination']==net['Destination']).update({'Source':'/proc/self/net'})]:
            changed=copy.deepcopy(f); change(changed)
            with self.assertRaises(ValueError): host.verify_owned(changed,p,f['Id'],f['Image'])
        self.assertNotIn(net,self.plan()['mounts'])

    def test_private_cgroup_namespace_is_explicit_and_attested(self):
        p=self.local_plan();args=host.create_arguments(p,'sha256:'+'b'*64)
        self.assertIn('--cgroupns',args); self.assertEqual(args[args.index('--cgroupns')+1],'private')
        f=self.fixture(p); f['HostConfig']['GroupAdd']=['994'];f['HostConfig']['CgroupnsMode']=''
        with self.assertRaises(ValueError):host.verify_owned(f,p,f['Id'],f['Image'])


    def restart_fixture(self, base, paused=True):
        base=pathlib.Path(base).resolve();root=base/'service';storage=base/'apps'
        root.mkdir(mode=0o700);storage.mkdir(mode=0o700)
        for path in [root/'metadata',root/'metadata'/'store',root/'releases',root/'releases'/'qa-release',storage/'.space-store-control']:path.mkdir(mode=0o700)
        for name in ('controller.lock','update.lock'):
            fd=os.open(storage/'.space-store-control'/name,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
        db=self.database_fixture(root/'metadata'/'store',paused)
        p=host.plan(str(root),str(storage),'192.168.3.56',18439,'qa-release',os.getuid(),os.getgid())
        f=self.fixture(p);f['State']={'Running':True}
        cid=f['Id'];image=f['Image']
        record={'plan':p,'containerId':cid,'imageId':image,'artifactSHA256':'e'*64,
                'directories':{key:host.directory(p[key]) for key in ('root','storage')},
                'metadata':host.directory(str(root/'metadata')),'hostEvidence':{}}
        receipt=root/'releases'/'qa-release'/'receipt.json'
        host.new_json(receipt,record)
        host.new_json(root/'.space-store-container.json',{'schema':1,'service':'space-store','deployment':p['labels']['io.space-store.deployment'],'directories':record['directories']})
        host.new_json(root/'metadata'/'.space-store-container-self.json',host.self_record(p,cid,image))
        return p,record,f,receipt,db

    def clone_fixture(self, base):
        p,r,f,path,db=self.restart_fixture(base)
        f['State']['Running']=False
        with sqlite3.connect(db) as c:
            c.execute('CREATE TABLE admin(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL)')
            c.execute('CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,username TEXT NOT NULL,expires_at INTEGER NOT NULL)')
            c.execute('INSERT INTO admin VALUES(1,?,?)',('private_admin','$2a$10$'+'a'*53))
            c.execute("INSERT INTO metadata VALUES('store_id',?)",('c'*48,))
            c.executemany('INSERT INTO sessions VALUES(?,?,?)',[('1'*64,'private_admin',4102444800),('2'*64,'private_admin',1)])
            for table in ('plans','runtime_plans','runtime_instances','runtime_generations','runtime_snapshots','runtime_settings','runtime_catalog'):
                c.execute('CREATE TABLE '+table+'(id TEXT PRIMARY KEY,body TEXT NOT NULL)')
                c.execute('INSERT INTO '+table+' VALUES(?,?)',(table,json.dumps({'id':table,'retained':'private-value'})))
            c.execute('CREATE TABLE instances(id TEXT PRIMARY KEY,data_path TEXT NOT NULL UNIQUE,port INTEGER NOT NULL UNIQUE,body TEXT NOT NULL)')
            c.execute('CREATE TABLE storage_roots(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,body TEXT NOT NULL)')
            c.execute('CREATE TABLE "historic""; -- data"(id INTEGER PRIMARY KEY,payload BLOB,note TEXT)')
            c.execute('INSERT INTO "historic""; -- data" VALUES(1,?,?)',(bytes(range(256)),'private-history'))
        self.insert_job(db,'jobs','completed');self.insert_job(db,'runtime_jobs','succeeded')
        return p,r,f,path,db

    def test_prepare_update_deterministic_readonly_review(self):
        self.assertTrue(callable(getattr(host,'_prepare_update_locked',None)), 'missing held-lease readonly update review')
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.clone_fixture(base);f['State']['Running']=True
            # Unknown receipt fields are not review authority or output fields.
            r['unreviewed']={'private':'do-not-project'}
            r['directories']['unreviewed']={'private':'do-not-project'}
            path.write_text(json.dumps(r));os.chmod(path,0o600)
            marker=pathlib.Path(p['root'])/'.space-store-container.json'
            marker.write_text(json.dumps({'schema':1,'service':'space-store','deployment':p['labels']['io.space-store.deployment'],'directories':r['directories']}))
            current=host.assert_quiesced(db);before={str(x):x.read_bytes() for x in (db,path,marker,pathlib.Path(p['root'])/'metadata/.space-store-container-self.json')}
            input_record=copy.deepcopy(r);input_current=copy.deepcopy(current)
            with patch.object(host,'command',side_effect=self.docker_fixture(f,[])),self.http_fixture(p):
                with host.exclusive_update(r) as update:
                    result=host._prepare_update_locked(r,current,'next-release','f'*64,update)
                    self.assertEqual(result,host._prepare_update_locked(r,current,'next-release','f'*64,update))
                    update()
                    with self.assertRaises(BlockingIOError):
                        with host.exclusive_update(r):pass
            review=result['plan'];source=review['source'];target=review['target']['plan']
            self.assertEqual((review['schema'],review['state'],review['kind']),(1,'review','store-version-switch'))
            self.assertEqual(review['maintenance'],current)
            self.assertEqual(set(source),{'containerId','imageId','artifactSHA256','receiptPath','receiptProof','plan','directories','metadata','hostEvidence','controllerInstanceId','administratorConfigured','storeId','schemaDigest'})
            self.assertEqual(set(source['directories']),{'root','storage'})
            self.assertEqual(source['plan'],p);self.assertEqual(source['receiptProof'],host._private_file_proof(str(path)))
            self.assertEqual(source['controllerInstanceId'],'1'*32);self.assertIs(source['administratorConfigured'],True)
            self.assertEqual(source['storeId'],'c'*48)
            with host.readonly_evidence(db) as connection:proof,_=host._clone_database_proof(connection)
            self.assertEqual(source['schemaDigest'],proof['schemaDigest'])
            self.assertEqual(target,host.plan(p['root']+'/updates/next-release',p['storage'],p['ip'],p['port'],'next-release',p['uid'],p['gid'],p['engine'],p['dockerRoot'],p['socketGid'],p['nasOrigin']))
            self.assertNotEqual(target['mounts'][0]['Source'],p['mounts'][0]['Source'])
            self.assertEqual(review['target']['artifactSHA256'],'f'*64)
            self.assertEqual(result['sha256'],host.hashlib.sha256(json.dumps(review,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest())
            serialized=json.dumps(result)
            for private in ('do-not-project','private_admin','private-history','private-value','token_hash','tables'):
                self.assertNotIn(private,serialized)
            review['maintenance']['id']='changed';source['plan']['mounts'][0]['RW']=False;source['directories']['root']['inode']=-1
            self.assertEqual(r,input_record);self.assertEqual(current,input_current)
            self.assertTrue(all(pathlib.Path(name).read_bytes()==data for name,data in before.items()),'source files changed')
            self.assertFalse((pathlib.Path(p['root'])/'updates').exists())

    def test_prepare_update_requires_explicit_exact_current_maintenance(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.clone_fixture(base);f['State']['Running']=True
            with host.exclusive_update(r) as update,patch.object(host,'command',side_effect=self.docker_fixture(f,[])),patch.object(host,'controller_health',return_value='1'*32):
                for current in (None,True,[],{}, {'unreviewed':'not-current'}):
                    with self.subTest(current=current),self.assertRaises(ValueError):
                        host._prepare_update_locked(r,current,'next','f'*64,update)
                    update()
            self.assertFalse((pathlib.Path(p['root'])/'updates').exists())

    def test_prepare_update_rejects_invalid_inputs_and_unheld_native_leases(self):
        with tempfile.TemporaryDirectory() as base,tempfile.TemporaryDirectory() as other:
            p,r,f,path,db=self.clone_fixture(base);f['State']['Running']=True;current=host.assert_quiesced(db)
            _,wrong,_,_,_=self.clone_fixture(other)
            before=db.read_bytes()
            with host.exclusive_update(r) as update:
                for release,sha in [('qa-release','f'*64),('QA-RELEASE','f'*64),('../new','f'*64),('', 'f'*64),(None,'f'*64),('next','F'*64),('next','g'*64),('next','f'*63),('next',None)]:
                    with self.subTest(release=release,sha=sha),self.assertRaises(ValueError):
                        host._prepare_update_locked(r,current,release,sha,update)
                for fake in (True,lambda:None):
                    with self.assertRaises(ValueError):host._prepare_update_locked(r,current,'next','f'*64,fake)
                with host.stopped_controller(r) as controller,host.exclusive_update(wrong) as wrong_update:
                    for invalid in (controller,wrong_update):
                        with self.assertRaises(ValueError):host._prepare_update_locked(r,current,'next','f'*64,invalid)
                update()
            with self.assertRaises(ValueError):host._prepare_update_locked(r,current,'next','f'*64,update)
            self.assertTrue(before==db.read_bytes(),'lease refusal changed source')
            self.assertFalse((pathlib.Path(p['root'])/'updates').exists())

    def test_prepare_update_refuses_damaged_source_and_existing_targets(self):
        cases=('source-sha','stopped','v1','receipt','self','marker','root-mode','metadata-mode','store-mode','release-mode',
               'maintenance','current','jobs','runtime-jobs','schema','admin','store-id','body','index','session',
               'profile','port','mount','updates-link','updates-mode','updates-ancestor','target-directory','target-file','target-link')
        for case in cases:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);f=copy.deepcopy(f);f['State']['Running']=True;current=host.assert_quiesced(db)
                root=pathlib.Path(p['root']);updates=root/'updates'
                if case=='source-sha':r['artifactSHA256']='E'*64;path.write_text(json.dumps(r))
                elif case=='stopped':f['State']['Running']=False
                elif case=='v1':f['Config']['Labels']['io.space-store.control-protocol']='v2'
                elif case=='receipt':changed=copy.deepcopy(r);changed['artifactSHA256']='f'*64;path.write_text(json.dumps(changed))
                elif case in ('self','marker'):
                    changed=root/('metadata/.space-store-container-self.json' if case=='self' else '.space-store-container.json')
                    changed.write_text('{}')
                elif case in ('root-mode','metadata-mode','store-mode','release-mode'):
                    changed={'root-mode':root,'metadata-mode':root/'metadata','store-mode':db.parent,'release-mode':path.parent}[case];changed.chmod(0o755)
                elif case=='current':current['requestId']='not-current'
                elif case in ('maintenance','schema','admin','store-id','body','index','session'):
                    with sqlite3.connect(db) as c:
                        if case=='maintenance':c.execute("UPDATE store_maintenance SET status='resumed'")
                        elif case=='schema':c.execute('CREATE VIEW unreviewed AS SELECT * FROM metadata')
                        elif case=='admin':c.execute('DELETE FROM admin')
                        elif case=='store-id':c.execute("UPDATE metadata SET value='invalid' WHERE key='store_id'")
                        elif case=='body':c.execute("UPDATE plans SET body='{}'")
                        elif case=='index':c.execute('ALTER TABLE jobs RENAME TO damaged_jobs')
                        elif case=='session':c.execute("UPDATE sessions SET token_hash='invalid' WHERE token_hash=?",('1'*64,))
                elif case in ('jobs','runtime-jobs'):self.insert_job(db,'jobs' if case=='jobs' else 'runtime_jobs','running')
                elif case=='profile':f['HostConfig']['Privileged']=True
                elif case=='port':f['HostConfig']['PortBindings']['18435/tcp'][0]['HostPort']='18440'
                elif case=='mount':f['Mounts'][0]['RW']=False
                elif case=='updates-link':updates.symlink_to(pathlib.Path(p['storage']))
                elif case in ('updates-mode','updates-ancestor'):updates.mkdir(mode=0o755 if case=='updates-mode' else 0o700)
                elif case.startswith('target-'):
                    updates.mkdir(mode=0o700);target=updates/'next'
                    if case=='target-directory':target.mkdir(mode=0o700)
                    elif case=='target-file':target.write_bytes(b'retained-target')
                    else:target.symlink_to(root/'missing-target')
                before=db.read_bytes();file_names={str(x) for x in root.rglob('*')}
                with host.exclusive_update(r) as update:
                    if case=='updates-ancestor':root.chmod(0o722)
                    with patch.object(host,'command',side_effect=self.docker_fixture(f,[])),patch.object(host,'controller_health',return_value='1'*32),contextlib.redirect_stdout(io.StringIO()) as output:
                        with self.assertRaises((ValueError,OSError,sqlite3.Error)):
                            host._prepare_update_locked(r,current,'next','f'*64,update)
                    update()
                    self.assertEqual(output.getvalue(),'')
                self.assertTrue(before==db.read_bytes(),'review refusal changed source')
                self.assertEqual({str(x) for x in root.rglob('*')},file_names)

    def test_prepare_update_rechecks_instance_files_directories_and_target_absence(self):
        for case in ('instance','receipt','self','marker','store-directory','release-directory','target','updates-link'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);f['State']['Running']=True;current=host.assert_quiesced(db)
                root=pathlib.Path(p['root']);proof=host._clone_database_proof;injected=[]
                def proving(connection):
                    result=proof(connection)
                    if not injected:
                        injected.append(True)
                        if case in ('receipt','self','marker'):
                            node={'receipt':path,'self':root/'metadata/.space-store-container-self.json','marker':root/'.space-store-container.json'}[case]
                            node.write_bytes(node.read_bytes())  # Same body, changed private-file proof.
                        elif case in ('store-directory','release-directory'):
                            node=db.parent if case=='store-directory' else path.parent
                            node.rename(node.with_name(node.name+'-retained'));node.mkdir(mode=0o700)
                            for child in node.with_name(node.name+'-retained').iterdir():child.rename(node/child.name)
                        elif case=='target':(root/'updates').mkdir(mode=0o700);(root/'updates/next').mkdir(mode=0o700)
                        elif case=='updates-link':(root/'updates').symlink_to(pathlib.Path(p['storage']))
                    return result
                instances=['1'*32,'2'*32] if case=='instance' else ['1'*32,'1'*32]
                with host.exclusive_update(r) as update,patch.object(host,'command',side_effect=self.docker_fixture(f,[])),patch.object(host,'controller_health',side_effect=instances),patch.object(host,'_clone_database_proof',side_effect=proving):
                    with self.assertRaises((ValueError,OSError)):host._prepare_update_locked(r,current,'next','f'*64,update)
                    update()
                self.assertTrue(injected)

    def test_prepare_update_rechecks_database_identity_without_freezing_session_rows(self):
        for case in ('store-id','schema','maintenance','sessions'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);f['State']['Running']=True;current=host.assert_quiesced(db)
                readonly=host.readonly_evidence;count=[]
                @contextlib.contextmanager
                def reading(*args,**kwargs):
                    with readonly(*args,**kwargs) as connection:yield connection
                    count.append(True)
                    if len(count)==3:
                        with sqlite3.connect(db) as c:
                            if case=='store-id':c.execute("UPDATE metadata SET value=? WHERE key='store_id'",('a'*48,))
                            elif case=='schema':c.execute('CREATE TABLE allowed_history(id TEXT PRIMARY KEY,body TEXT)')
                            elif case=='maintenance':c.execute('UPDATE store_maintenance SET request_id=?',('changed',))
                            else:c.execute('DELETE FROM sessions WHERE token_hash=?',('2'*64,))
                with host.exclusive_update(r) as update,patch.object(host,'command',side_effect=self.docker_fixture(f,[])),patch.object(host,'controller_health',return_value='1'*32),patch.object(host,'readonly_evidence',side_effect=reading):
                    if case=='sessions':self.assertEqual(host._prepare_update_locked(r,current,'next','f'*64,update)['plan']['source']['storeId'],'c'*48)
                    else:
                        with self.assertRaises(ValueError):host._prepare_update_locked(r,current,'next','f'*64,update)
                    update()
                self.assertFalse((pathlib.Path(p['root'])/'updates').exists())

    def test_prepare_update_all_docker_and_health_checks_close_sql_transactions(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.clone_fixture(base);f['State']['Running']=True;current=host.assert_quiesced(db);connections=[];checks=[]
            class Tracked(sqlite3.Connection):
                closed=False
                def close(inner):inner.closed=True;super().close()
            connect=sqlite3.connect;original=self.docker_fixture(f,[])
            def tracking(*args,**kwargs):
                kwargs['factory']=Tracked;c=connect(*args,**kwargs);connections.append(c);return c
            def check():
                checks.append(True);self.assertFalse(any(not c.closed and c.in_transaction for c in connections),'network in SQL transaction')
            def docker(argv):check();return original(argv)
            with host.exclusive_update(r) as update,patch.object(host.sqlite3,'connect',side_effect=tracking),patch.object(host,'command',side_effect=docker),self.http_fixture(p,on_health=check):
                host._prepare_update_locked(r,current,'next','f'*64,update)
            self.assertEqual(len(connections),6);self.assertEqual(len(checks),8);self.assertTrue(all(c.closed for c in connections))

    def test_prepare_update_refuses_unconfirmed_v1_health_and_retains_update_lease(self):
        for health in ({'service':'space-store','controllerProtocol':'v2','instanceId':'1'*32},
                       {'service':'space-store','controllerProtocol':'v1','instanceId':'2'*32},
                       {'service':'space-store','controllerProtocol':'v1','instanceId':'invalid'}):
            with self.subTest(health=health),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);f['State']['Running']=True;current=host.assert_quiesced(db);before=db.read_bytes()
                with host.exclusive_update(r) as update,patch.object(host,'command',side_effect=self.docker_fixture(f,[])),self.http_fixture(p,health_data=health):
                    with self.assertRaises(ValueError):host._prepare_update_locked(r,current,'next','f'*64,update)
                    update()
                self.assertTrue(before==db.read_bytes(),'health refusal changed source')
                self.assertFalse((pathlib.Path(p['root'])/'updates').exists())

    def test_prepare_update_inherits_verified_simulated_local_profile(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.clone_fixture(base);root=pathlib.Path(p['root']);cache=pathlib.Path(base).resolve()/'cache'
            cache.mkdir(mode=0o700)
            p=host.plan(p['root'],p['storage'],p['ip'],p['port'],p['release'],p['uid'],p['gid'],'local',str(cache),994,'http://nas.example:8080')
            # This task-local profile and its host facts are simulated, not Docker evidence.
            facts={str(cache):{'device':1,'inode':2},'/var/run/docker.sock':{'device':3,'inode':4}}
            r.update(plan=p,hostEvidence=facts);path.write_text(json.dumps(r))
            (root/'metadata/.space-store-container-self.json').write_text(json.dumps(host.self_record(p,r['containerId'],r['imageId'])))
            f=self.fixture(p);f['HostConfig']['GroupAdd']=['994'];f['State']={'Running':True}
            (root/'.space-store-container.json').write_text(json.dumps({'schema':1,'service':'space-store','deployment':p['labels']['io.space-store.deployment'],'directories':r['directories']}))
            current=host.assert_quiesced(db)
            with host.exclusive_update(r) as update,patch.object(host,'host_evidence',return_value=facts),patch.object(host,'command',side_effect=self.docker_fixture(f,[])),self.http_fixture(p):
                review=host._prepare_update_locked(r,current,'next','f'*64,update)['plan']
                changed=host._prepare_update_locked(r,current,'next','a'*64,update)
            target=review['target']['plan']
            for key in ('storage','ip','port','uid','gid','engine','dockerRoot','socketGid','nasOrigin'):self.assertEqual(target[key],p[key])
            self.assertEqual(target['mounts'][1:],p['mounts'][1:]);self.assertNotEqual(target['labels'],p['labels'])
            self.assertNotEqual(changed['sha256'],host.hashlib.sha256(json.dumps(review,sort_keys=True,separators=(',',':')).encode()).hexdigest())
            self.assertFalse((root/'updates').exists())

    def clone_under_leases(self,r,current,release='next-release'):
        with host.exclusive_update(r) as update:
            with host.stopped_controller(r) as controller:
                result=host._clone_metadata_locked(r,current,release,update,controller)
                # Completion stays in the caller's same native lock scope.
                for lease in (host.exclusive_update,host.stopped_controller):
                    with self.assertRaises(BlockingIOError):
                        with lease(r):pass
                return result

    def test_clone_complete_database_preserves_source_and_expires_only_session_time(self):
        self.assertTrue(callable(getattr(host,'_clone_metadata_locked',None)), 'missing held-lease metadata clone')
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.clone_fixture(base);calls=[]
            source=db.read_bytes();identity=db.stat();current=host.assert_quiesced(db,stopped=True)
            with patch.object(host,'command',side_effect=self.docker_fixture(f,calls)):
                result=self.clone_under_leases(r,current)
                with self.assertRaises(FileExistsError):self.clone_under_leases(r,current)
            target=pathlib.Path(p['root'])/'updates/next-release/metadata/store/store.sqlite'
            self.assertTrue(source==db.read_bytes(),'original SQLite changed')
            self.assertEqual((identity.st_dev,identity.st_ino),(db.stat().st_dev,db.stat().st_ino))
            with sqlite3.connect(db) as a,sqlite3.connect(target) as b:
                tables=[x[0] for x in a.execute("SELECT name FROM sqlite_schema WHERE type='table'")]
                for name in tables:
                    quoted='"'+name.replace('"','""')+'"'
                    before=a.execute('SELECT * FROM '+quoted).fetchall();after=b.execute('SELECT * FROM '+quoted).fetchall()
                    if name=='sessions':
                        self.assertEqual(len(before),len(after))
                        self.assertTrue(all(x[:2]==y[:2] and y[2]==min(x[2],result['expiredAt']) for x,y in zip(before,after)),'session preservation failed')
                    else:self.assertTrue(before==after,'retained table differs')
                self.assertEqual(b.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
            self.assertEqual(result['state'],'completed');self.assertEqual(result['copiedSessions'],2);self.assertEqual(result['expiredSessions'],1)
            receipt=target.parents[2]/'clone-receipt.json'
            self.assertEqual(host.read_json(receipt),result)
            for item in target.parents[2].rglob('*'):
                self.assertEqual(stat.S_IMODE(item.stat().st_mode),0o700 if item.is_dir() else 0o600)
            self.assertEqual({str(x.relative_to(target.parents[2])) for x in target.parents[2].rglob('*') if x.is_file()},{'metadata/store/store.sqlite','clone-receipt.json'})
            for private in ('private_admin','private-value','private-history','$2a$10$', '1'*64):self.assertNotIn(private,receipt.read_text())
            self.assertTrue(all(x[:2]==['docker','inspect'] for x in calls))

    def test_clone_writer_open_swap_cannot_modify_existing_private_database(self):
        # Attack the old SQLite pathname-open boundary and the new inode-bound
        # byte-writer boundary. Neither may modify a preexisting private file.
        for boundary in ('sqlite-open','fd-write'):
            with self.subTest(boundary=boundary),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
                victim=pathlib.Path(base)/'existing-private.sqlite'
                victim.write_bytes(db.read_bytes());victim.chmod(0o600)
                before=victim.read_bytes();source=db.read_bytes()
                target=pathlib.Path(p['root'])/'updates/next-release/metadata/store/store.sqlite'
                injected=[];connect=sqlite3.connect;write=os.write
                def swap():
                    injected.append(True);target.rename(target.with_name('retained-new.sqlite'));target.symlink_to(victim)
                def connecting(database,*args,**kwargs):
                    if boundary=='sqlite-open' and isinstance(database,str) and database.endswith('?mode=rw') and not injected:swap()
                    return connect(database,*args,**kwargs)
                def writing(fd,data):
                    if boundary=='fd-write' and target.exists() and not injected:
                        held=os.fstat(fd);entry=target.stat()
                        if (held.st_dev,held.st_ino)==(entry.st_dev,entry.st_ino):swap()
                    return write(fd,data)
                with patch.object(host,'command',side_effect=self.docker_fixture(f,[])),patch.object(host.sqlite3,'connect',side_effect=connecting),patch.object(host.os,'write',side_effect=writing):
                    try:self.clone_under_leases(r,current)
                    except (ValueError,OSError,sqlite3.Error):pass
                self.assertTrue(before==victim.read_bytes(),'writer altered an existing private database')
                self.assertTrue(source==db.read_bytes(),'writer altered source')
                if boundary=='fd-write':self.assertTrue(injected,'inode-bound writer was not exercised')
                if injected:
                    self.assertEqual(host.read_json(target.parents[2]/'clone-receipt.json')['state'],'failed')
                    self.assertTrue(target.with_name('retained-new.sqlite').exists(),'fresh inode was deleted')

    def test_clone_receipt_faults_never_publish_completed_work(self):
        for fault in ('flush','receipt-fsync','directory-fsync'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
                targetroot=pathlib.Path(p['root'])/'updates/next-release'
                receipt=targetroot/'clone-receipt.json';pending=targetroot/'clone-receipt.pending.json'
                source=db.read_bytes();injected=[];fsync=os.fsync;fdopen=os.fdopen
                def is_receipt(fd):
                    node=os.fstat(fd)
                    return any(file.exists() and (file.stat().st_dev,file.stat().st_ino)==(node.st_dev,node.st_ino) for file in (pending,receipt))
                def syncing(fd):
                    if not injected and (pending.exists() or receipt.exists()):
                        if (fault=='receipt-fsync' and is_receipt(fd)) or (fault=='directory-fsync' and stat.S_ISDIR(os.fstat(fd).st_mode)):
                            injected.append(True);raise OSError('injected receipt persistence failure')
                    return fsync(fd)
                class FlushFailure:
                    def __init__(inner,stream):inner.stream=stream
                    def __enter__(inner):return inner
                    def __exit__(inner,*args):inner.stream.close()
                    def __getattr__(inner,name):return getattr(inner.stream,name)
                    def flush(inner):
                        inner.stream.flush()
                        if not injected:injected.append(True);raise OSError('injected receipt flush failure')
                def opening(fd,*args,**kwargs):
                    stream=fdopen(fd,*args,**kwargs)
                    return FlushFailure(stream) if fault=='flush' and not injected and is_receipt(fd) else stream
                with patch.object(host,'command',side_effect=self.docker_fixture(f,[])),patch.object(host.os,'fsync',side_effect=syncing),patch.object(host.os,'fdopen',side_effect=opening):
                    with self.assertRaises(OSError):self.clone_under_leases(r,current)
                self.assertTrue(injected,'receipt persistence boundary not exercised')
                self.assertTrue(source==db.read_bytes(),'receipt failure changed source')
                self.assertGreater((targetroot/'metadata/store/store.sqlite').stat().st_size,0)
                self.assertEqual(host.read_json(receipt)['state'],'failed','failed clone left a completed final receipt')
                self.assertTrue(pending.exists(),'failed staged evidence was deleted')

    def test_clone_rejects_staged_receipt_identity_or_content_change_before_first_proof(self):
        for change in ('identity','same-inode-content'):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
                root=pathlib.Path(p['root'])/'updates/next-release'
                pending=root/'clone-receipt.pending.json';receipt=root/'clone-receipt.json'
                retained=root/'retained-original-pending.json'
                source=host._clone_source_proof(r);fsync=os.fsync;injected=[];tampered=[]
                def syncing(fd):
                    result=fsync(fd)
                    if pending.exists() and not injected:
                        held=os.fstat(fd);entry=pending.stat()
                        if (held.st_dev,held.st_ino)==(entry.st_dev,entry.st_ino):
                            injected.append(True);payload=pending.read_bytes()
                            if change=='identity':
                                pending.rename(retained)
                                replacement=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                                try:os.write(replacement,payload)
                                finally:os.close(replacement)
                                self.assertNotEqual(pending.stat().st_ino,entry.st_ino)
                            else:
                                altered=payload.replace(b'"state": "completed"',b'"state": "failed"   ',1)
                                self.assertNotEqual(altered,payload);self.assertEqual(len(altered),len(payload))
                                with pending.open('r+b') as out:out.write(altered)
                                self.assertEqual(pending.stat().st_ino,entry.st_ino)
                            tampered.append(pending.read_bytes())
                    return result
                with patch.object(host,'command',side_effect=self.docker_fixture(f,[])),patch.object(host.os,'fsync',side_effect=syncing):
                    with self.assertRaises(ValueError,msg='changed staged receipt was accepted as initial proof'):
                        self.clone_under_leases(r,current)
                self.assertTrue(injected,'post-fsync/pre-proof receipt boundary not exercised')
                self.assertTrue(host._clone_source_proof(r)==source,'receipt rejection changed source proof')
                self.assertEqual(host.read_json(receipt)['state'],'failed')
                self.assertEqual(pending.read_bytes(),tampered[0],'tampered staged evidence was overwritten or removed')
                self.assertGreater((root/'metadata/store/store.sqlite').stat().st_size,0)
                if change=='identity':self.assertEqual(host.read_json(retained)['state'],'completed')
                for lease in (host.exclusive_update,host.stopped_controller):
                    with lease(r):pass

    def test_clone_publishes_receipt_only_after_all_fsyncs(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
            root=pathlib.Path(p['root'])/'updates/next-release';receipt=root/'clone-receipt.json'
            fsync=os.fsync;observed=[]
            def syncing(fd):
                observed.append(stat.S_ISDIR(os.fstat(fd).st_mode))
                self.assertFalse(receipt.exists(),'completed receipt published before persistence finished')
                return fsync(fd)
            with patch.object(host,'command',side_effect=self.docker_fixture(f,[])),patch.object(host.os,'fsync',side_effect=syncing):result=self.clone_under_leases(r,current)
            self.assertEqual(host.read_json(receipt),result)
            self.assertEqual(result['state'],'completed');self.assertIn(True,observed)
            self.assertFalse((root/'clone-receipt.pending.json').exists())

    def test_clone_atomic_receipt_publication_preserves_existing_final(self):
        publish=host._clone_receipt_publisher()
        with tempfile.TemporaryDirectory() as base:
            root=pathlib.Path(base);pending=root/'clone-receipt.pending.json';final=root/'clone-receipt.json'
            pending.write_bytes(b'pending-private-evidence');pending.chmod(0o600)
            final.write_bytes(b'existing-private-evidence');final.chmod(0o600)
            with host.directory_handle(str(root.resolve()),secure_ancestors=True) as fd:
                with self.assertRaises(OSError):publish(fd)
            self.assertEqual(final.read_bytes(),b'existing-private-evidence')
            self.assertEqual(pending.read_bytes(),b'pending-private-evidence')

    def test_clone_unavailable_capabilities_fail_before_creating_target(self):
        for capability in ('sqlite-library','sqlite-api','publication-api','platform'):
            with self.subTest(capability=capability),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True);source=db.read_bytes()
                if capability=='sqlite-library':block=patch.object(host.ctypes.util,'find_library',return_value=None)
                elif capability=='sqlite-api':block=patch.object(host.ctypes,'CDLL',return_value=object())
                elif capability=='publication-api':block=patch.object(host,'_clone_receipt_publisher',side_effect=ValueError('unavailable'))
                else:block=patch.object(host.platform,'system',return_value='unsupported')
                with block,patch.object(host,'command',side_effect=self.docker_fixture(f,[])):
                    with self.assertRaises(ValueError):self.clone_under_leases(r,current)
                self.assertFalse((pathlib.Path(p['root'])/'updates').exists())
                self.assertTrue(source==db.read_bytes(),'capability refusal changed source')

    def test_clone_publication_failure_preserves_staged_and_failed_receipts(self):
        for fault in ('rename','close-after-commit'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
                root=pathlib.Path(p['root'])/'updates/next-release';receipt=root/'clone-receipt.json';pending=root/'clone-receipt.pending.json'
                close=os.close;publish=host._clone_receipt_publisher();injected=[]
                def publishing(fd):
                    if fault=='rename':injected.append(True);raise OSError('injected publication failure')
                    return publish(fd)
                def closing(fd):
                    close(fd)
                    if fault=='close-after-commit' and receipt.exists() and not injected:
                        injected.append(True);raise OSError('injected postcommit close failure')
                with patch.object(host,'_clone_receipt_publisher',return_value=publishing),patch.object(host.os,'close',side_effect=closing),patch.object(host,'command',side_effect=self.docker_fixture(f,[])):
                    if fault=='rename':
                        with self.assertRaises(OSError):self.clone_under_leases(r,current)
                    else:self.assertEqual(self.clone_under_leases(r,current)['state'],'completed')
                self.assertTrue(injected)
                self.assertEqual(host.read_json(receipt)['state'],'failed' if fault=='rename' else 'completed')
                self.assertEqual(pending.exists(),fault=='rename')

    def test_clone_rejects_unheld_wrong_and_released_native_leases(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
            with patch.object(host,'command',side_effect=self.docker_fixture(f,[])):
                for fake in (True,lambda:None):
                    with self.assertRaises((ValueError,TypeError)):host._clone_metadata_locked(r,current,'next',fake,fake)
                with host.exclusive_update(r) as update:
                    with host.stopped_controller(r) as controller:
                        with self.assertRaises(ValueError):host._clone_metadata_locked(r,current,'next',controller,update)
                with self.assertRaises(ValueError):host._clone_metadata_locked(r,current,'next',update,controller)
            self.assertFalse((pathlib.Path(p['root'])/'updates').exists())

    def test_clone_rejects_unsafe_source_schema_jobs_and_ownership_before_target(self):
        cases=('running','receipt','schema','missing','trigger','view','virtual','marker','bad-id','admin',
               'session-schema','session-value','json','duplicate-json','indexed-json','null-index','bad-user','bad-cost','queued','unknown',
               'wal','db-mode','db-symlink','db-hardlink','ancestor','lock','source-parent-link')
        for case in cases:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
                if case=='running':f['State']['Running']=True
                elif case=='receipt':
                    changed=copy.deepcopy(r);changed['artifactSHA256']='f'*64;path.write_text(json.dumps(changed))
                elif case=='wal':
                    fd=os.open(str(db)+'-wal',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.write(fd,b'nonempty');os.close(fd)
                elif case=='db-mode':os.chmod(db,0o644)
                elif case=='db-symlink':db.rename(db.with_name('retained.sqlite'));db.symlink_to(db.with_name('retained.sqlite'))
                elif case=='db-hardlink':os.link(db,db.with_name('retained.link'))
                elif case=='ancestor':os.chmod(base,0o777)
                elif case=='lock':os.chmod(pathlib.Path(p['storage'])/'.space-store-control/update.lock',0o644)
                elif case=='source-parent-link':
                    db.parent.rename(db.parent.with_name('retained'));db.parent.symlink_to(db.parent.with_name('retained'))
                else:
                    with sqlite3.connect(db) as c:
                        sql={
                            'schema':'ALTER TABLE runtime_generations ADD COLUMN unknown TEXT',
                            'missing':'DROP TABLE runtime_snapshots',
                            'trigger':'CREATE TRIGGER unsafe AFTER UPDATE ON sessions BEGIN DELETE FROM admin; END',
                            'view':'CREATE VIEW unknown_view AS SELECT * FROM admin',
                            'virtual':'CREATE VIRTUAL TABLE unknown_virtual USING fts5(body)',
                            'marker':"UPDATE metadata SET value='v0' WHERE key='store_maintenance_schema'",
                            'bad-id':"UPDATE metadata SET value='bad' WHERE key='store_id'",
                            'admin':'DELETE FROM admin',
                            'session-schema':'ALTER TABLE sessions RENAME COLUMN expires_at TO other',
                            'session-value':"UPDATE sessions SET expires_at='uncertain'",
                            'json':"UPDATE runtime_generations SET body='null'",
                            'duplicate-json':"UPDATE runtime_snapshots SET body='{\"id\":\"a\",\"id\":\"b\"}'",
                            'indexed-json':"UPDATE runtime_generations SET body='{}'",
                            'null-index':"UPDATE runtime_generations SET id=NULL,body='{\"id\":null}'",
                            'bad-user':"UPDATE admin SET username='_invalid'",
                            'bad-cost':"UPDATE admin SET password_hash=replace(password_hash,'$10$','$99$')",
                            'queued':"UPDATE jobs SET status='queued'",
                            'unknown':"UPDATE runtime_jobs SET status='unknown'"}[case]
                        c.execute(sql)
                before=db.read_bytes()
                try:
                    with patch.object(host,'command',side_effect=self.docker_fixture(f,[])):
                        with self.assertRaises((ValueError,OSError,sqlite3.Error)):self.clone_under_leases(r,current)
                    self.assertTrue(before==db.read_bytes(),'clone wrote source on refusal')
                    self.assertFalse((pathlib.Path(p['root'])/'updates').exists())
                finally:os.chmod(base,0o700)

    def test_clone_preserves_partial_and_never_completes_after_evidence_drift(self):
        for case in ('running','receipt','maintenance','source-bytes','lock','ancestor','target-parent','target-symlink','target-hardlink','target-mode','target-wal-link'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
                targetroot=pathlib.Path(p['root'])/'updates/next-release';target=targetroot/'metadata/store/store.sqlite'
                calls=[];original=self.docker_fixture(f,calls);injected=[];before=db.read_bytes()
                def docker(argv):
                    # The third inspection is after the fresh target has been
                    # created and before any backup writes begin.
                    if len(calls)==2 and not injected:
                        injected.append(True)
                        if case=='running':f['State']['Running']=True
                        elif case=='receipt':
                            changed=copy.deepcopy(r);changed['artifactSHA256']='f'*64;path.write_text(json.dumps(changed))
                        elif case in ('maintenance','source-bytes'):
                            with sqlite3.connect(db) as c:
                                if case=='maintenance':
                                    body=dict(current);body['requestId']='drift';c.execute('UPDATE store_maintenance SET request_id=?,body=?',('drift',json.dumps(body)))
                                else:c.execute("INSERT INTO metadata VALUES('later','unapproved')")
                        elif case=='lock':
                            lock=pathlib.Path(p['storage'])/'.space-store-control/update.lock';lock.rename(lock.with_name('retained.lock'))
                            fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
                        elif case=='ancestor':os.chmod(base,0o777)
                        elif case=='target-parent':
                            target.parent.rename(target.parent.with_name('retained'));target.parent.mkdir(mode=0o700)
                        elif case=='target-symlink':target.rename(target.with_name('retained.sqlite'));target.symlink_to(db)
                        elif case=='target-hardlink':os.link(target,target.with_name('retained.link'))
                        elif case=='target-mode':os.chmod(target,0o644)
                        elif case=='target-wal-link':pathlib.Path(str(target)+'-wal').symlink_to(db)
                    return original(argv)
                try:
                    with patch.object(host,'command',side_effect=docker):
                        with self.assertRaises((ValueError,OSError)):self.clone_under_leases(r,current)
                    self.assertTrue(injected);self.assertTrue(targetroot.exists(),'partial directory removed')
                    receipt=targetroot/'clone-receipt.json'
                    if receipt.exists():self.assertEqual(host.read_json(receipt)['state'],'failed')
                    if case not in ('maintenance','source-bytes'):self.assertTrue(before==db.read_bytes(),'source changed')
                    if case=='source-bytes':self.assertEqual(target.stat().st_size,0,'changed source must be refused before backup')
                finally:os.chmod(base,0o700)

    def test_clone_retains_populated_partial_if_final_target_or_source_proof_changes(self):
        for case in ('target-bytes','source-bytes','running','lock','maintenance'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
                target=pathlib.Path(p['root'])/'updates/next-release/metadata/store/store.sqlite'
                before=db.read_bytes();calls=[];original=self.docker_fixture(f,calls);injected=[]
                def docker(argv):
                    if len(calls)==3 and not injected:
                        injected.append(True);self.assertGreater(target.stat().st_size,0)
                        if case in ('target-bytes','source-bytes'):
                            with sqlite3.connect(target if case=='target-bytes' else db) as c:c.execute('UPDATE sessions SET expires_at=4102444800')
                        elif case=='running':f['State']['Running']=True
                        elif case=='lock':
                            lock=pathlib.Path(p['storage'])/'.space-store-control/controller.lock';lock.rename(lock.with_name('retained.lock'))
                            fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
                        else:
                            with sqlite3.connect(db) as c:
                                body=dict(current);body['requestId']='drift';c.execute('UPDATE store_maintenance SET request_id=?,body=?',('drift',json.dumps(body)))
                    return original(argv)
                with patch.object(host,'command',side_effect=docker):
                    with self.assertRaises(ValueError):self.clone_under_leases(r,current)
                self.assertTrue(injected)
                self.assertGreater(target.stat().st_size,0)
                self.assertEqual(host.read_json(target.parents[2]/'clone-receipt.json')['state'],'failed')
                if case not in ('source-bytes','maintenance'):self.assertTrue(before==db.read_bytes(),'source changed')

    def test_clone_never_inspects_docker_inside_sql_transaction_and_refuses_updates_links(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True);connections=[]
            class Tracked(sqlite3.Connection):
                closed=False
                def close(inner):inner.closed=True;super().close()
            connect=sqlite3.connect
            def tracking(*args,**kwargs):
                kwargs['factory']=Tracked;c=connect(*args,**kwargs);connections.append(c);return c
            original=self.docker_fixture(f,[])
            def docker(argv):
                self.assertFalse(any(not c.closed and c.in_transaction for c in connections),'network in SQL transaction')
                return original(argv)
            with patch.object(host.sqlite3,'connect',side_effect=tracking),patch.object(host,'command',side_effect=docker):self.clone_under_leases(r,current)
        for case in ('updates-link','existing-target'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.clone_fixture(base);current=host.assert_quiesced(db,stopped=True)
                updates=pathlib.Path(p['root'])/'updates'
                if case=='updates-link':updates.symlink_to(pathlib.Path(p['storage']))
                else:updates.mkdir(mode=0o700);(updates/'next-release').mkdir(mode=0o700)
                with patch.object(host,'command',side_effect=self.docker_fixture(f,[])):
                    with self.assertRaises((ValueError,OSError)):self.clone_under_leases(r,current)

    def test_clone_actual_go_source_target_normal_authentication_and_pause(self):
        # Real native Go/HTTP/SQLite/flock; running/stopped own-container
        # facts are simulated. Credentials/API rows remain in process memory.
        with tempfile.TemporaryDirectory() as builddir,tempfile.TemporaryDirectory() as base:
            binary=pathlib.Path(builddir)/'space-gateway'
            build=subprocess.run(['go','build','-o',str(binary),'./cmd/space-gateway'],cwd=ROOT.parent/'server',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
            self.assertEqual(build.returncode,0,'native fixture build failed')
            p,r,f,path,db=self.restart_fixture(base,paused=False)
            opener=host.urllib.request.build_opener(host.urllib.request.ProxyHandler({}))
            @contextlib.contextmanager
            def running(data):
                process=subprocess.Popen([str(binary),'--listen','127.0.0.1:0','--engine','disabled','--data-dir',str(data),'--storage-root',p['storage']],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
                try:
                    self.assertTrue(select.select([process.stdout],[],[],15)[0],'native fixture readiness timeout')
                    line=process.stdout.readline();self.assertTrue(bool(line),'native fixture startup failed')
                    ready=json.loads(line);self.assertEqual(ready['event'],'ready')
                    self.assertTrue(ready['address'].startswith('http://127.0.0.1:'))
                    yield ready['address']
                finally:
                    if process.poll() is None:process.terminate()
                    try:process.wait(timeout=10)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5);self.fail('native fixture required forced termination')
                    finally:process.stdout.close()
                    self.assertEqual(process.returncode,0,'native fixture did not stop normally')
            def request(address,endpoint,body=None,session=None):
                headers={'Content-Type':'application/json'}
                if session:headers['X-Store-Session']=session
                req=host.urllib.request.Request(address+endpoint,data=None if body is None else json.dumps(body).encode(),headers=headers)
                try:
                    with opener.open(req,timeout=10) as response:return response.status,json.load(response).get('data')
                except urllib.error.HTTPError as error:
                    code=error.code;error.close();return code,None
            credentials={'username':'qa_'+secrets.token_hex(8),'password':secrets.token_urlsafe(32)}
            with running(pathlib.Path(p['root'])/'metadata') as address:
                code,setup=request(address,'/api/store/setup',credentials);self.assertEqual(code,201)
                code,login=request(address,'/api/store/login',credentials);self.assertEqual(code,200)
                tokens=[setup['sessionId'],login['sessionId']]
                code,status=request(address,'/api/store/status',session=tokens[-1]);self.assertEqual(code,200)
                store_id=status['nasAuth']['storeId']
                settings={'theme':'dark','updateCheckEnabled':False,'updateCheckHours':48}
                code,_=request(address,'/api/store/v2/settings',settings,tokens[-1]);self.assertEqual(code,200)
                code,_=request(address,'/api/store/v2/maintenance/quiesce',{'requestId':'native-clone-pause'},tokens[-1]);self.assertEqual(code,201)
                code,paused=request(address,'/api/store/v2/maintenance',session=tokens[-1]);self.assertEqual(code,200)
                self.assertEqual(paused['state'],'quiesced')
                with self.assertRaises(BlockingIOError):
                    with host.stopped_controller(r):pass
                # Live review uses real Go health and real readonly SQLite/flock.
                # CID/image/profile and matching readiness log are explicitly
                # simulated facts; no actual Docker container is inspected.
                code,health=request(address,'/api/health');self.assertEqual(code,200)
                native_instance=health['instanceId'];expected='http://%s:%d/api/health' % (p['ip'],p['port'])
                test=self
                class NativeHealthTransport:
                    def open(inner,url,timeout):
                        test.assertEqual(url,expected)
                        return opener.open(address+'/api/health',timeout=timeout)
                inspect=self.docker_fixture(f,[])
                def simulated_docker(argv):
                    if argv[:2]==['docker','logs']:
                        self.assertEqual(argv,['docker','logs','--tail','20',f['Id']])
                        return json.dumps({'event':'ready','instanceId':native_instance})
                    return inspect(argv)
                current=host.assert_quiesced(db)
                private_paths=(path, pathlib.Path(p['root'])/'.space-store-container.json',pathlib.Path(p['root'])/'metadata/.space-store-container-self.json')
                private_before={str(node):host._private_file_proof(str(node)) for node in private_paths}
                def session_count():
                    with host.readonly_evidence(db) as c:return c.execute('SELECT count(*) FROM sessions').fetchone()[0]
                self.assertEqual(session_count(),2)
                with host.exclusive_update(r) as update,patch.object(host,'command',side_effect=simulated_docker),patch.object(host.urllib.request,'build_opener',return_value=NativeHealthTransport()):
                    review=host._prepare_update_locked(r,current,'next-release','f'*64,update)
                    self.assertEqual(review['plan']['source']['controllerInstanceId'],native_instance)
                    self.assertEqual(review['plan']['source']['storeId'],store_id)
                    readonly=host.readonly_evidence;reads=[];new_login=[]
                    @contextlib.contextmanager
                    def changing_sessions(*args,**kwargs):
                        with readonly(*args,**kwargs) as c:yield c
                        reads.append(True)
                        if len(reads)==3:
                            code,new=request(address,'/api/store/login',credentials);self.assertEqual(code,200);new_login.append(new['sessionId'])
                    with patch.object(host,'readonly_evidence',side_effect=changing_sessions):
                        during_login=host._prepare_update_locked(r,current,'next-release','f'*64,update)
                    self.assertEqual(session_count(),3)
                    self.assertEqual(during_login,review,'normal source login changed review identity')
                    code,_=request(address,'/api/store/logout',{},new_login[0]);self.assertEqual(code,200)
                    self.assertEqual(session_count(),2)
                    self.assertEqual(host._prepare_update_locked(r,current,'next-release','f'*64,update),review,'normal source logout changed review identity')
                    update()
                    with self.assertRaises(BlockingIOError):
                        with host.exclusive_update(r):pass
                    with self.assertRaises(BlockingIOError):
                        with host.stopped_controller(r):pass
                self.assertEqual({str(node):host._private_file_proof(str(node)) for node in private_paths},private_before)
                self.assertFalse((pathlib.Path(p['root'])/'updates').exists())
            f['State']['Running']=False
            self.assertEqual(db.read_bytes()[18:20],bytes([2,2]))
            source_proof=host._clone_source_proof(r)
            current=host.assert_quiesced(db,stopped=True)
            with host.readonly_evidence(db,stopped=True) as connection:
                original,_=host._clone_database_proof(connection)
            with patch.object(host,'command',side_effect=self.docker_fixture(f,[])):
                result=self.clone_under_leases(r,current)
            target=pathlib.Path(result['target']);data=target.parent.parent
            with host.readonly_evidence(target,stopped=True) as connection:
                copied,_=host._clone_database_proof(connection)
                self.assertEqual(copied['tables']['sessions']['rows'],2)
                self.assertEqual(connection.execute('SELECT count(*) FROM sessions WHERE expires_at>?',(result['expiredAt'],)).fetchone()[0],0)
            self.assertFalse((data/'.space-store-container-self.json').exists())
            with running(data) as address:
                for token in tokens:
                    code,_=request(address,'/api/store/v2/maintenance',session=token);self.assertEqual(code,401)
                code,login=request(address,'/api/store/login',credentials);self.assertEqual(code,200)
                self.assertTrue(login['username']==credentials['username'],'copied administrator cannot log in')
                code,status=request(address,'/api/store/status',session=login['sessionId']);self.assertEqual(code,200)
                self.assertEqual(status['nasAuth']['storeId'],store_id)
                code,after_pause=request(address,'/api/store/v2/maintenance',session=login['sessionId']);self.assertEqual(code,200)
                self.assertTrue(after_pause==paused,'pause record changed')
                code,after_settings=request(address,'/api/store/v2/settings',session=login['sessionId']);self.assertEqual(code,200)
                self.assertTrue(all(after_settings[k]==v for k,v in settings.items()),'settings changed')
            # Ordinary Go login cleans expired authentication sessions; the clone
            # itself preserved every row before login. All other history persists.
            with host.readonly_evidence(target,stopped=True) as connection:
                after_login,_=host._clone_database_proof(connection)
            self.assertEqual(after_login['tables']['sessions']['rows'],1)
            self.assertTrue(all(proof==after_login['tables'][table] for table,proof in original['tables'].items() if table!='sessions'),'post-login retained application history changed')
            self.assertTrue(host._clone_source_proof(r)==source_proof,'native source changed after clone or target login')
            self.assertFalse((data/'.space-store-container-self.json').exists())
            for lease in (host.exclusive_update,host.stopped_controller):
                with lease(r):pass

    @contextlib.contextmanager
    def http_fixture(self, p, on_health=None, health_data=None):
        test=self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                test.assertEqual(self.path,'/api/health')
                if on_health:on_health()
                body=json.dumps({'ok':True,'data':health_data if health_data is not None else {'service':'space-store','controllerProtocol':'v1','instanceId':'1'*32}}).encode()
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
            def log_message(self,*args):pass
        server=http.server.HTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        opener=host.urllib.request.build_opener(host.urllib.request.ProxyHandler({}))
        expected='http://%s:%d/api/health' % (p['ip'],p['port'])
        class RoutedOpener:
            def open(self,url,timeout):
                test.assertEqual(url,expected)
                return opener.open('http://127.0.0.1:%d/api/health' % server.server_port,timeout=timeout)
        try:
            with patch.object(host.urllib.request,'build_opener',return_value=RoutedOpener()),contextlib.redirect_stdout(io.StringIO()):yield
        finally:server.shutdown();thread.join(timeout=5);server.server_close()

    def docker_fixture(self, fixture, calls, on_stop=None):
        def command(argv, **kwargs):
            calls.append(argv)
            if argv[:2]==['docker','inspect']:
                self.assertEqual(argv[2:], [fixture['Id']]);return json.dumps([fixture])
            if argv[:2]==['docker','logs']:
                self.assertEqual(argv,['docker','logs','--tail','20',fixture['Id']]);return json.dumps({'event':'ready','instanceId':'1'*32})
            if argv[:2]==['docker','stop']:
                self.assertEqual(argv,['docker','stop','--time','15',fixture['Id']]);fixture['State']['Running']=False
                if on_stop:on_stop()
                return fixture['Id']
            if argv[:2]==['docker','start']:
                self.assertEqual(argv,['docker','start',fixture['Id']]);fixture['State']['Running']=True;return fixture['Id']
            self.fail('unexpected Docker invocation '+str(argv))
        return command

    def test_restart_never_stops_when_job_or_receipt_revalidation_fails(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base);calls=[]
            self.insert_job(db,'runtime_jobs','running')
            with self.http_fixture(p),patch.object(host,'command',side_effect=self.docker_fixture(f,calls)):
                with self.assertRaises(ValueError):host.controlled_restart(path)
            self.assertFalse(any(x[1] in ('start','stop') for x in calls))
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base);calls=[]
            original=host.validate_receipt
            def verify(path):
                result=original(path)
                if len(calls)>1:raise ValueError('forged')
                return result
            with patch.object(host,'validate_receipt',side_effect=verify),self.http_fixture(p),patch.object(host,'command',side_effect=self.docker_fixture(f,calls)):
                with self.assertRaises(ValueError):host.controlled_restart(path)
            self.assertFalse(any(x[1] in ('start','stop') for x in calls))

    def test_restart_targets_only_exact_full_id_and_rechecks_after_stop(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base);calls=[]
            with patch.object(host,'validate_receipt',wraps=host.validate_receipt) as verify,patch.object(host,'assert_idle',wraps=host.assert_idle) as idle,self.http_fixture(p),patch.object(host,'command',side_effect=self.docker_fixture(f,calls)):
                host.controlled_restart(path)
                self.assertEqual([x for x in calls if x[1] in ('stop','start')],[['docker','stop','--time','15',r['containerId']],['docker','start',r['containerId']]])
                self.assertEqual(verify.call_count,3);self.assertEqual(idle.call_count,3)
                self.assertEqual(host.assert_quiesced(db)['id'],'d'*48)

    def test_restart_requires_quiesced_evidence_before_stop(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base,paused=False);calls=[]
            with self.http_fixture(p),patch.object(host,'command',side_effect=self.docker_fixture(f,calls)):
                with self.assertRaises(ValueError):host.controlled_restart(path)
            self.assertFalse(any(x[1] in ('start','stop') for x in calls))

    def test_restart_refuses_unsafe_shared_ancestor_before_stop(self):
        for mode in (0o777,0o770,0o1777):
            with self.subTest(mode=oct(mode)),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.restart_fixture(base);calls=[]
                os.chmod(base,mode)
                try:
                    with self.http_fixture(p),patch.object(host,'command',side_effect=self.docker_fixture(f,calls)):
                        with self.assertRaises(ValueError):host.controlled_restart(path)
                    self.assertFalse(any(x[1] in ('stop','start') for x in calls))
                    self.assertEqual(stat.S_IMODE(os.stat(base).st_mode),mode)
                finally:os.chmod(base,0o700)

    def test_restart_rechecks_unsafe_ancestors_before_stop_and_start(self):
        for phase in ('before-stop','after-stop'):
            with self.subTest(phase=phase),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.restart_fixture(base);calls=[];reads=[]
                def during_health():
                    reads.append(True)
                    if phase=='before-stop' and len(reads)==2:os.chmod(base,0o777)
                def during_stop():
                    if phase=='after-stop':os.chmod(base,0o777)
                try:
                    with self.http_fixture(p,during_health),patch.object(host,'command',side_effect=self.docker_fixture(f,calls,during_stop)):
                        with self.assertRaises(ValueError):host.controlled_restart(path)
                    self.assertEqual([x[1] for x in calls if x[1] in ('stop','start')],[] if phase=='before-stop' else ['stop'])
                finally:os.chmod(base,0o700)

    def test_metadata_evidence_rechecks_unsafe_ancestors(self):
        for stopped in (False,True):
            for phase in ('before-read','after-read'):
                with self.subTest(stopped=stopped,phase=phase),tempfile.TemporaryDirectory() as base:
                    parent=pathlib.Path(base).resolve()/'store';parent.mkdir(mode=0o700)
                    db=self.database_fixture(parent)
                    try:
                        if phase=='before-read':
                            os.chmod(base,0o777)
                            with self.assertRaises(ValueError):host.assert_quiesced(db,stopped=stopped)
                        else:
                            with self.assertRaises(ValueError):
                                with host.readonly_evidence(db,stopped=stopped) as evidence:
                                    self.assertEqual(evidence.execute('SELECT count(*) FROM store_maintenance').fetchone()[0],1)
                                    os.chmod(base,0o777)
                    finally:os.chmod(base,0o700)

    def test_controller_leases_recheck_unsafe_ancestors(self):
        for lease in (host.exclusive_update,host.stopped_controller):
            with self.subTest(lease=lease.__name__),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.restart_fixture(base)
                try:
                    with lease(r) as verify:
                        os.chmod(base,0o777)
                        with self.assertRaises(ValueError):verify()
                    with self.assertRaises(ValueError):
                        with lease(r):pass
                finally:os.chmod(base,0o700)

    def test_controller_leases_allow_only_root_owned_sticky_shared_ancestors(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base)
            ancestor=os.stat(base);original=os.fstat
            def root_sticky(fd):
                node=original(fd)
                if (node.st_dev,node.st_ino)==(ancestor.st_dev,ancestor.st_ino):
                    fields=list(node);fields[0]=stat.S_IFDIR|0o1777;fields[4]=0
                    return os.stat_result(fields)
                return node
            with patch.object(host.os,'fstat',side_effect=root_sticky):
                with host.exclusive_update(r) as verify:verify()
                host.assert_quiesced(db);host.assert_idle(db)

    def test_metadata_only_directory_probes_keep_existing_ancestor_policy(self):
        with tempfile.TemporaryDirectory() as base:
            cache=pathlib.Path(base).resolve()/'cache';cache.mkdir(mode=0o710)
            os.chmod(base,0o777)
            try:
                kwargs={'metadata_only':True} if hasattr(os,'O_PATH') else {}
                self.assertEqual(host.directory(str(cache),private=False,**kwargs)['inode'],cache.stat().st_ino)
            finally:os.chmod(base,0o700)

    def test_go_created_closed_wal_quiesced_proof_under_source_lease(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base)
            db.rename(db.with_name('retained-python-fixture.sqlite'))
            env=dict(os.environ,STORE_EVIDENCE_FIXTURE_DATA=str(db.parent),STORE_EVIDENCE_FIXTURE_STORAGE=p['storage'])
            result=subprocess.run(['go','test','./internal/store','-run','^TestControllerExportPausedEvidenceFixture$','-count=1'],cwd=ROOT.parent/'server',env=env,capture_output=True,text=True,timeout=45)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertEqual(db.read_bytes()[18:20],bytes([2,2]))
            self.assertFalse(pathlib.Path(str(db)+'-wal').exists())
            self.assertFalse(pathlib.Path(str(db)+'-shm').exists())
            with host.exclusive_update(r):
                with host.stopped_controller(r):
                    current=host.assert_quiesced(db,stopped=True)
                    host.assert_idle(db,stopped=True)
                    self.assertEqual(current['requestId'],'go-api-pause')
            # Never use immutable proof over retained nonempty WAL evidence.
            wal=pathlib.Path(str(db)+'-wal');fd=os.open(wal,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.write(fd,b'retained nonempty WAL');os.close(fd)
            with host.stopped_controller(r):
                with self.assertRaises(ValueError):host.assert_quiesced(db,stopped=True)

    def test_exclusive_update_uses_real_native_process_lock_and_retains_inode(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base)
            lock=pathlib.Path(p['storage'])/'.space-store-control/update.lock';before=lock.stat()
            code="import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_SH|fcntl.LOCK_NB);print('locked',flush=True);sys.stdin.read(1)"
            child=subprocess.Popen([os.sys.executable,'-c',code,str(lock)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(),'locked')
                with self.assertRaises(BlockingIOError):
                    with host.exclusive_update(r):pass
                child.stdin.write('x');child.stdin.flush();child.wait(timeout=5)
                with host.exclusive_update(r):
                    with self.assertRaises(BlockingIOError):
                        with host.exclusive_update(r):pass
                with host.exclusive_update(r):pass
                self.assertEqual((lock.stat().st_dev,lock.stat().st_ino),(before.st_dev,before.st_ino))
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=5)
                child.stdin.close();child.stdout.close()

    def test_restart_rejects_changed_quiesced_metadata_after_stop(self):
        for change in ('id','requestId','createdAt','purpose','status'):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.restart_fixture(base);calls=[]
                def corrupt():
                    with sqlite3.connect(db) as c:
                        record=json.loads(c.execute('SELECT body FROM store_maintenance').fetchone()[0])
                        record[change]={'id':'f'*48,'requestId':'other','createdAt':'2026-10-12T01:00:00Z','purpose':'other','status':'resumed'}[change]
                        c.execute('UPDATE store_maintenance SET body=?',(json.dumps(record),))
                with self.http_fixture(p),patch.object(host,'command',side_effect=self.docker_fixture(f,calls,corrupt)):
                    with self.assertRaises(ValueError):host.controlled_restart(path)
                self.assertEqual([x[1] for x in calls if x[1] in ('stop','start')],['stop'])

    def test_restart_rejects_maintenance_marker_schema_history_and_job_body_corruption(self):
        for corrupt in ('marker','schema','index','body','duplicate-body','multiple','resumed','time','job-body','job-schema'):
            with self.subTest(corrupt=corrupt),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.restart_fixture(base);calls=[]
                with sqlite3.connect(db) as c:
                    if corrupt=='marker':c.execute("UPDATE metadata SET value='v0'")
                    elif corrupt=='schema':c.execute('ALTER TABLE store_maintenance RENAME COLUMN status TO damaged')
                    elif corrupt=='index':
                        c.execute('ALTER TABLE store_maintenance RENAME TO retained')
                        c.execute('CREATE TABLE store_maintenance(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL)')
                        c.execute('INSERT INTO store_maintenance SELECT * FROM retained')
                    elif corrupt=='body':c.execute("UPDATE store_maintenance SET body='null'")
                    elif corrupt=='duplicate-body':c.execute('UPDATE store_maintenance SET body=?',('{"id":"'+ 'd'*48 +'","id":"other"}',))
                    elif corrupt=='multiple':
                        record={'id':'e'*48,'requestId':'other','purpose':'store-update','status':'quiesced','createdAt':'2026-10-12T00:00:00Z'}
                        c.execute('INSERT INTO store_maintenance VALUES(?,?,?,?)',(record['id'],record['requestId'],record['status'],json.dumps(record)))
                    elif corrupt in ('resumed','time'):
                        record=json.loads(c.execute('SELECT body FROM store_maintenance').fetchone()[0])
                        if corrupt=='resumed':record['resumedAt']='2026-10-12T01:00:00Z'
                        else:record['createdAt']='not-time'
                        c.execute('UPDATE store_maintenance SET body=?',(json.dumps(record),))
                    elif corrupt=='job-schema':c.execute('ALTER TABLE jobs RENAME COLUMN body TO damaged')
                if corrupt=='job-body':
                    self.insert_job(db,'jobs','completed')
                    with sqlite3.connect(db) as c:c.execute("UPDATE jobs SET body='{}'")
                with self.http_fixture(p),patch.object(host,'command',side_effect=self.docker_fixture(f,calls)):
                    with self.assertRaises((ValueError,sqlite3.Error)):host.controlled_restart(path)
                self.assertFalse(any(x[1] in ('stop','start') for x in calls))

    def test_exclusive_update_refuses_missing_link_mode_and_replaced_addresses(self):
        for corrupt in ('missing','symlink','hardlink','mode','control-mode','root-mode','replaced'):
            with self.subTest(corrupt=corrupt),tempfile.TemporaryDirectory() as base:
                p,r,f,path,db=self.restart_fixture(base)
                lock=pathlib.Path(p['storage'])/'.space-store-control/update.lock'
                if corrupt=='missing':lock.rename(lock.with_name('retained.lock'))
                elif corrupt=='symlink':lock.rename(lock.with_name('retained.lock'));lock.symlink_to(lock.with_name('retained.lock'))
                elif corrupt=='hardlink':os.link(lock,lock.with_name('retained.link'))
                elif corrupt=='mode':os.chmod(lock,0o644)
                elif corrupt=='control-mode':os.chmod(lock.parent,0o755)
                elif corrupt=='root-mode':os.chmod(lock.parent.parent,0o777)
                if corrupt=='replaced':
                    with host.exclusive_update(r) as verify:
                        lock.rename(lock.with_name('retained.lock'));fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
                        with self.assertRaises(ValueError):verify()
                else:
                    with self.assertRaises((ValueError,OSError)):
                        with host.exclusive_update(r):pass

    def test_legacy_receipt_and_source_health_do_not_imply_protocol_support(self):
        p=self.plan();self.assertEqual(p['labels']['io.space-store.control-protocol'],'v1')
        f=self.fixture(p);legacy=copy.deepcopy(p);legacy['labels'].pop('io.space-store.control-protocol')
        with self.assertRaises(ValueError):host.verify_owned(f,legacy,f['Id'],f['Image'])
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base);calls=[];r['plan']['labels'].pop('io.space-store.control-protocol')
            with patch.object(host,'validate_receipt',return_value=(r,f)),patch.object(host,'command') as cmd:
                with self.assertRaises(ValueError):host.controlled_restart(path)
                cmd.assert_not_called()
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return json.dumps({'ok':True,'data':{'service':'space-store','instanceId':'1'*32}}).encode()
        p=self.plan();f=self.fixture(p);f['State']={'Running':True}
        with patch.object(host.urllib.request,'build_opener') as opener,patch.object(host,'command',side_effect=[json.dumps([f]),json.dumps({'event':'ready','instanceId':'1'*32})]):
            opener.return_value.open.return_value=Response()
            with self.assertRaises(ValueError):host.controller_health(p,f['Id'],f['Image'])

    def test_first_deploy_still_refuses_existing_stopped_or_foreign_overlap(self):
        for running in (False,True):
            for overlap in ('metadata','storage-child','storage-parent'):
                with self.subTest(running=running,overlap=overlap),tempfile.TemporaryDirectory() as base:
                    base=pathlib.Path(base).resolve();root=base/'service';storage=base/'apps';root.mkdir(mode=0o700);storage.mkdir(mode=0o700)
                    p=host.plan(str(root),str(storage),'192.168.3.56',18439,'qa-release',os.getuid(),os.getgid())
                    source={'metadata':str(root/'metadata'),'storage-child':str(storage/'foreign'),'storage-parent':str(base)}[overlap]
                    item={'Id':'f'*64,'State':{'Running':running},'Config':{'Labels':{'foreign':'true'}},'Mounts':[{'Source':source}]}
                    def docker(argv):
                        if argv==['docker','ps','-aq']:return item['Id']
                        if argv==['docker','inspect',item['Id']]:return json.dumps([item])
                        self.fail('mutation or unexpected command '+str(argv))
                    original_listdir=os.listdir
                    with patch.object(host.platform,'machine',return_value='x86_64'),patch.object(host.os,'listdir',side_effect=lambda path: [] if path=='/proc' else original_listdir(path)),patch.object(host,'command',side_effect=docker):
                        with self.assertRaisesRegex(ValueError,'existing container uses selected roots'):host.probe(p)
                    self.assertEqual(list(root.iterdir()),[]);self.assertEqual(list(storage.iterdir()),[])

    def test_restart_holds_exclusive_update_through_stop_start_and_health(self):
        with tempfile.TemporaryDirectory() as base:
            p,r,f,path,db=self.restart_fixture(base);calls=[]
            lock=pathlib.Path(p['storage'])/'.space-store-control/update.lock'
            def assert_excluded():
                fd=os.open(lock,os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
                finally:os.close(fd)
            original=self.docker_fixture(f,calls)
            def docker(argv):
                if argv[1] in ('stop','start'):assert_excluded()
                return original(argv)
            reads=[]
            def during_health():
                reads.append(True)
                if len(reads)==3:assert_excluded()
            with self.http_fixture(p,during_health),patch.object(host,'command',side_effect=docker):host.controlled_restart(path)
            self.assertEqual(len(reads),3)
            with host.exclusive_update(r):pass

    def fixture(self, p):
        return {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64,
                'Name': '/' + p['name'], 'Config': {'Labels': p['labels'],
                'User': p['user'], 'Entrypoint': ['/opt/space-store/space-store'],
                'Cmd': p['command'], 'Env': p['env']},
                'HostConfig': {'Privileged': False, 'NetworkMode': 'bridge',
                'CgroupnsMode':'private',
                'ReadonlyRootfs': True, 'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
                'CapDrop': ['ALL'], 'CapAdd': [], 'SecurityOpt': ['no-new-privileges'],
                'PortBindings': {'18435/tcp': [{'HostIp': p['ip'], 'HostPort': str(p['port'])}]},
                'Devices': [], 'Binds': None, 'GroupAdd': [], 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=32m'}},
                'Mounts': [dict(m,Propagation=('rslave' if p.get('engine')=='local' and m['Source']==p.get('dockerRoot') else 'rprivate')) for m in p['mounts']]}

    def test_start_checks_exact_owned_labels_image_paths_ports_and_restrictions(self):
        p = self.plan()
        f = self.fixture(p)
        host.verify_owned(f, p, f['Id'], f['Image'])
        for mutate in [lambda x: x['Config']['Labels'].update({'io.space-store.release': 'foreign'}),
                       lambda x: x.update({'Image': 'sha256:' + 'c' * 64}),
                       lambda x: x['Mounts'].append({'Type': 'bind', 'Source': '/home', 'Destination': '/home', 'RW': True}),
                       lambda x: x['HostConfig'].update({'Privileged': True}),
                       lambda x: x['HostConfig'].update({'NetworkMode': 'host'}),
                       lambda x: x['Config'].update({'User': '0'}),
                       lambda x: x['HostConfig']['PortBindings']['18435/tcp'][0].update({'HostIp': '0.0.0.0'})]:
            changed = copy.deepcopy(f); mutate(changed)
            with self.assertRaises(ValueError):
                host.verify_owned(changed, p, f['Id'], f['Image'])

    def test_directory_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            base = pathlib.Path(root).resolve(); (base / 'real').mkdir()
            (base / 'link').symlink_to(base / 'real')
            with self.assertRaises((ValueError, OSError)):
                host.directory(str(base / 'link'), private=False)

    def test_metadata_only_walk_uses_path_fds_without_directory_read_permission(self):
        opened=[];fake_path=0x200000
        def open_node(path,flags,**kwargs):
            opened.append((path,flags,kwargs))
            if not flags & fake_path: raise PermissionError('directory read denied')
            if path=='link':raise NotADirectoryError('symlink')
            return len(opened)+10
        entry=type('CacheStat',(),{'st_dev':98,'st_ino':12345,'st_uid':0,'st_mode':stat.S_IFDIR|0o710})()
        with patch.object(host.os,'O_PATH',fake_path,create=True), patch.object(host.os,'open',side_effect=open_node), patch.object(host.os,'close'), patch.object(host.os,'fstat',return_value=entry):
            self.assertEqual(host.directory('/data_n008/cache',private=False,metadata_only=True),{'device':98,'inode':12345,'uid':0})
            self.assertTrue(all(flags&host.os.O_DIRECTORY and flags&host.os.O_NOFOLLOW for _,flags,_ in opened))
            with self.assertRaises(OSError):host.directory('/data_n008/link',private=False,metadata_only=True)
            with self.assertRaises(ValueError):host.directory('/data_n008/cache',private=True,metadata_only=True)
            with self.assertRaises(OSError):host.directory('/data_n008/cache',private=True)

    @unittest.skipUnless(hasattr(os,'O_PATH') and os.getuid()==0,'native Linux root required for real non-owner permission fixture')
    def test_native_nonowner_0700_0710_cache_metadata_and_foreign_private_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=pathlib.Path(tmp).resolve();os.chmod(base,0o711)
            cache=base/'cache';cache.mkdir();link=base/'link';link.symlink_to(cache)
            for mode in (0o700,0o710):
                os.chmod(cache,mode);expected=cache.stat();readfd,writefd=os.pipe();pid=os.fork()
                if pid==0:
                    os.close(readfd)
                    try:
                        os.setgroups([]);os.setgid(65534);os.setuid(65534)
                        result={'identity':host.directory(str(cache),private=False,metadata_only=True)}
                        for key,path,kwargs in [('readDenied',cache,{'private':False}),('foreignPrivateDenied',cache,{'private':True}),('linkDenied',link,{'private':False,'metadata_only':True})]:
                            try:host.directory(str(path),**kwargs);result[key]=False
                            except (ValueError,OSError):result[key]=True
                        os.write(writefd,json.dumps(result).encode());os._exit(0)
                    except BaseException:os._exit(1)
                os.close(writefd);payload=os.read(readfd,4096);os.close(readfd);_,status=os.waitpid(pid,0)
                self.assertEqual(status,0);result=json.loads(payload)
                self.assertEqual(result['identity'],{'device':expected.st_dev,'inode':expected.st_ino,'uid':0})
                self.assertTrue(all(result[key] for key in ('readDenied','foreignPrivateDenied','linkDenied')))

    def test_safe_deployment_error_never_returns_subprocess_or_untrusted_text(self):
        self.assertEqual(host.safe_error(ValueError('host Docker facts changed')),'host Docker facts changed')
        self.assertEqual(host.safe_error(PermissionError(13,'sensitive path')),'required path access failed (errno 13)')
        self.assertNotIn('SECRET',host.safe_error(ValueError('SECRET arbitrary output')))
        self.assertEqual(host.remote_error({'stderr':'noise\nContainer deployment stopped: required path access failed (errno 13)\n'}),'required path access failed (errno 13)')
        self.assertNotIn('SECRET',host.remote_error({'stderr':'Container deployment stopped: SECRET arbitrary command output'}))

    def test_foreign_docker_root_facts_are_rejected_before_metadata_walk(self):
        p=self.local_plan()
        with patch.object(host,'host_identity',return_value={'dockerRoot':'/foreign-cache','socketGid':994}), patch.object(host,'directory') as walk:
            with self.assertRaises(ValueError):host.host_evidence(p)
            walk.assert_not_called()

    def test_run_arguments_have_no_automatic_replace_or_delete(self):
        argv = host.create_arguments(self.plan(), 'sha256:' + 'b' * 64)
        self.assertEqual(argv[:2], ['docker', 'create'])
        self.assertIn('--restart', argv); self.assertIn('unless-stopped', argv)
        self.assertNotIn('--privileged', argv)
        self.assertNotIn('--network=host', argv)
        self.assertNotIn('--rm', argv)

    def test_inherited_publisher_labels_are_exact_and_known(self):
        p = self.plan()
        self.assertEqual(p['labels']['org.opencontainers.image.source'], 'https://github.com/astral-sh/uv')
        self.assertIn('PYTHON_VERSION=3.13.11', p['env'])

    def test_foreign_mount_propagation_and_host_pid_namespace_are_rejected(self):
        p = self.plan(); f = self.fixture(p)
        f['Mounts'] = copy.deepcopy(f['Mounts'])
        f['Mounts'][0]['Propagation'] = 'rshared'
        with self.assertRaises(ValueError): host.verify_owned(f, p, f['Id'], f['Image'])
        f = self.fixture(p); f['HostConfig']['PidMode'] = 'host'
        with self.assertRaises(ValueError): host.verify_owned(f, p, f['Id'], f['Image'])

    def test_archive_rejects_noncanonical_asset_names_before_writing(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            for name in ['Dockerfile', 'space-store', 'docker', 'web/store.html', 'web//foreign.html']:
                item = tarfile.TarInfo(name); item.size = 1
                archive.addfile(item, io.BytesIO(b'x'))
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError): host.unpack(buffer.getvalue(), pathlib.Path(root))
            self.assertEqual(list(pathlib.Path(root).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
