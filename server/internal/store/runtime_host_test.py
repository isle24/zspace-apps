import copy, importlib.util, io, json, os, pathlib, tarfile, tempfile, unittest, sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('runtime_host', pathlib.Path(__file__).with_name('runtime_host.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=os.path.realpath(self.tmp.name)
        self.old={name:getattr(h,name) for name in ['storage','execute','command','marker','inspect','port_scope']}
        h.port_scope=lambda g:{'host_policy':None}
        h.storage=lambda mode,path:{'identity':'storage' if mode=='inspect' else 'docker','volumeType':'ssd','systemDisk':False,'installAllowed':True,'freeBytes':2**40}
        def execute(code,args):
            root,path,mode,payload=args
            if mode=='pin':
                pathlib.Path(path,'.space-store-owner').write_text(payload)
                return {'result':{'rootIdentity':'root','directoryIdentity':'data','marker':payload}}
            if pathlib.Path(path,'.space-store-owner').read_text()!=json.loads(payload)['marker']:h.reject()
            return {}
        h.execute=execute;h.provenance_code='fixture';h.storage_code='fixture'
        self.g={'storeId':'store','id':'generation','instanceId':'instance','appId':'app','version':'1','recipeRevision':'rev','rootPath':self.root,'dataPath':self.root+'/new','storageIdentity':'storage','dockerStorageIdentity':'docker','mediaPath':'','hostPort':32123,'publishHost':'127.0.0.1','networkId':'e'*64,'containers':[],'recipe':{'services':[{'id':'app','entry':True,'containerPort':80,'userMode':'image-default','environment':{},'volumes':[{'name':'data','target':'/data','role':'data'}]}]},'images':[{'serviceId':'app','reference':'repo@sha256:'+'a'*64,'digest':'sha256:'+'a'*64,'platform':'linux/amd64'}]}
        self.p={'rootPath':self.root,'storageIdentity':'storage','dockerStorageIdentity':'docker','mediaPath':'','recipe':self.g['recipe']}
        h.prepare(self.p,self.g)
    def tearDown(self):
        for name,old in self.old.items():setattr(h,name,old)
        self.tmp.cleanup()
    def test_marker_rejects_child_replacement_and_changed_layout(self):
        h.marker(self.g)
        pathlib.Path(self.root+'/new/data').rename(self.root+'/new/retained')
        pathlib.Path(self.root+'/new/data').mkdir()
        with self.assertRaises(ValueError):h.marker(self.g)
    def test_symlink_walk_rejected(self):
        pathlib.Path(self.root+'/link').symlink_to(self.root+'/new',target_is_directory=True)
        with self.assertRaises(OSError):h.opened(self.root+'/link/data')
    def test_archive_rejects_symlink_and_hardlink(self):
        path=pathlib.Path(self.root+'/new/data');(path/'file').write_text('sentinel');(path/'link').symlink_to(path/'file')
        fd=h.opened(str(path))
        try:
            with tarfile.open(fileobj=io.BytesIO(),mode='w') as tar:
                with self.assertRaises(ValueError):h.archive_directory(tar,fd,'data')
        finally:os.close(fd)
    def test_archive_members_reject_traversal_links_devices(self):
        for name in ['/data/a','data/../a','data//a','data/./a','other/file']:
            with self.assertRaises(ValueError):h.safe_member(tarfile.TarInfo(name),{'data'})
        for kind in [tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.CHRTYPE,tarfile.FIFOTYPE]:
            member=tarfile.TarInfo('data/file');member.type=kind
            with self.assertRaises(ValueError):h.safe_member(member,{'data'})
    def fixture(self):
        service=self.g['recipe']['services'][0];im={'Id':'sha256:'+'b'*64,'Os':'linux','Architecture':'amd64','RepoDigests':[self.g['images'][0]['reference']],'Config':{'Env':['PATH=/bin'],'Labels':{},'Entrypoint':['entry'],'Cmd':[],'User':''}}
        record={'id':'c'*64,'name':h.name(self.g,service),'image':self.g['images'][0]['reference'],'serviceId':service['id']}
        c={'Id':record['id'],'Name':'/'+record['name'],'Image':im['Id'],'Config':{'Image':record['image'],'Labels':h.labels(self.g,service),'Env':['PATH=/bin'],'Entrypoint':['entry'],'Cmd':[],'User':''},'HostConfig':{'NetworkMode':self.g['networkId'],'PortBindings':h.ports(self.g,service),'RestartPolicy':{'Name':'unless-stopped'}},'Mounts':h.mounts(self.g,service),'NetworkSettings':{'Networks':{h.name(self.g):{'NetworkID':self.g['networkId']}}},'State':{'Running':False,'Status':'exited'}}
        self.g['containers']=[record]
        net={'Id':self.g['networkId'],'Name':h.name(self.g),'Driver':'bridge','Scope':'local','Labels':h.labels(self.g),'Containers':{}}
        def command(args,**kw):
            if args[:2]==['image','inspect']:return json.dumps([im])
            if args[:2]==['container','inspect']:return json.dumps([c])
            if args[:2]==['network','inspect']:return json.dumps([net])
            self.fail('mutation attempted: '+repr(args))
        h.command=command
        return c,net,im,service,record
    def test_created_container_has_configured_network_before_endpoint_materialization(self):
        c,n,im,s,r=self.fixture()
        c['State']={'Running':False,'Status':'created'}
        endpoint={'NetworkID':'','EndpointID':'','IPAddress':'','GlobalIPv6Address':'','MacAddress':''}
        c['NetworkSettings']['Networks'][h.name(self.g)]=endpoint
        self.assertEqual('created',h.check_container(self.g,s,r)['State']['Status'])
        c['State']={'Running':False,'Status':'exited'}
        self.assertEqual('exited',h.check_container(self.g,s,r)['State']['Status'])
        c['State']={'Running':True,'Status':'running'}
        with self.assertRaises(ValueError):h.check_container(self.g,s,r)
        c['State']={'Running':False,'Status':'created'}
        endpoint['NetworkID']='f'*64
        with self.assertRaises(ValueError):h.check_container(self.g,s,r)
        endpoint['NetworkID']='';endpoint['EndpointID']='unexpected'
        with self.assertRaises(ValueError):h.check_container(self.g,s,r)
    def test_cached_container_remains_owned_when_original_digest_appears(self):
        self.g['images'][0]['reference']='docker.io/library/nginx@sha256:'+'a'*64
        container,_,im,service,record=self.fixture()
        descriptor=self.g['images'][0];cached=h.cache_reference(descriptor)
        container['Config']['Image']=cached;im['RepoDigests']=[cached]
        existing=h.command
        def command(args,**kwargs):
            if args==['image','inspect',descriptor['reference']] and descriptor['reference'] not in im['RepoDigests']:
                raise ValueError('origin reference absent')
            return existing(args,**kwargs)
        h.command=command
        self.assertEqual('exited',h.check_container(self.g,service,record)['State']['Status'])
        im['RepoDigests'].append(descriptor['reference'])
        self.assertEqual('exited',h.check_container(self.g,service,record)['State']['Status'])
        container['Config']['Image']='zstore.2iwm.com/cache/'+'f'*64+'@'+descriptor['digest']
        with self.assertRaises(ValueError):h.check_container(self.g,service,record)
    def test_cache_pull_failure_falls_back_to_locked_original(self):
        descriptor={'reference':'docker.io/library/nginx@sha256:'+'a'*64,'digest':'sha256:'+'a'*64,'platform':'linux/amd64'}
        cached=h.cache_reference(descriptor);calls=[]
        def command(args,**kwargs):
            calls.append(args)
            if args==['image','pull','--platform','linux/amd64',cached]:raise ValueError('cache unavailable')
            if args==['image','pull','--platform','linux/amd64',descriptor['reference']]:return ''
            self.fail('unexpected Docker request')
        h.command=command;h.pull_runtime_image(descriptor)
        self.assertEqual([['image','pull','--platform','linux/amd64',cached],['image','pull','--platform','linux/amd64',descriptor['reference']]],calls)
    def test_cache_platform_or_digest_mismatch_falls_back_to_locked_original(self):
        descriptor={'reference':'docker.io/library/nginx@sha256:'+'a'*64,'digest':'sha256:'+'a'*64,'platform':'linux/amd64'}
        cached=h.cache_reference(descriptor)
        for cached_image in [{'Os':'linux','Architecture':'arm64','RepoDigests':[cached]},{'Os':'linux','Architecture':'amd64','RepoDigests':[]}]:
            calls=[]
            def command(args,**kwargs):
                calls.append(args)
                if args[:2]==['image','pull']:return ''
                if args==['image','inspect',cached]:return json.dumps([cached_image])
                self.fail('unexpected Docker request')
            h.command=command;h.pull_runtime_image(descriptor)
            self.assertEqual(['image','pull','--platform','linux/amd64',descriptor['reference']],calls[-1])
    def test_complete_generation_owned(self):
        self.fixture();self.assertEqual('stopped',h.inspect(self.g)['state'])
    def test_foreign_inspect_rejected_before_mutation(self):
        for mutate in [lambda c,n,i:c['Config']['Labels'].update({'io.spacedesktop.generation':'foreign'}),lambda c,n,i:n['Containers'].update({'foreign':{}}),lambda c,n,i:c['Mounts'][0].update({'Source':'/foreign'}),lambda c,n,i:c['HostConfig']['PortBindings'].update({'22/tcp':[]}),lambda c,n,i:i.update({'Architecture':'arm64'}),lambda c,n,i:c['Config'].update({'Image':'foreign'}),lambda c,n,i:c['HostConfig'].update({'Privileged':True}),lambda c,n,i:c['NetworkSettings']['Networks'].update({'foreign':{}}),lambda c,n,i:c['Config']['Env'].append('SECRET=foreign')]:
            c,n,i,s,r=self.fixture();mutate(c,n,i)
            with self.assertRaises(ValueError):h.inspect(self.g)
    def test_snapshot_restore_preserves_original_and_fresh_provenance(self):
        self.fixture();pathlib.Path(self.g['dataPath']+'/data/file').write_text('sentinel')
        snap=h.snapshot(self.g,self.root,'snapshot')
        new=copy.deepcopy(self.g);new.update({'id':'restored','dataPath':self.root+'/restored','networkId':'','containers':[]})
        h.prepare(self.p,new);h.restore(snap,new)
        self.assertEqual('sentinel',pathlib.Path(new['dataPath']+'/data/file').read_text())
        self.assertEqual('sentinel',pathlib.Path(self.g['dataPath']+'/data/file').read_text())
        self.assertNotEqual(new['provenance']['marker'],self.g['provenance']['marker'])
        self.assertTrue(pathlib.Path(snap['path']).exists())
    def test_runtime_facts_without_unshipped_compose_plugin(self):
        original_argv=list(sys.argv);old_execute=h.execute;old_command=h.command
        info={'Architecture':'x86_64','DockerRootDir':'/data/cache','ServerVersion':'27.3.1','NCPU':4,'MemTotal':8*2**30}
        def command(args,**kwargs):
            if args==['info','--format','{{json .}}']:return json.dumps(info)
            if args==['compose','version','--short']:h.reject()
            self.fail('unshipped tool command invoked')
        h.command=command;h.execute=lambda *args:{}
        sys.argv=['helper','facts','{}','fixture','fixture','fixture']
        try:
            facts=h.main();self.assertEqual('',facts['composeVersion']);self.assertEqual('linux/amd64',facts['platform'])
            info['ServerVersion']=''
            with self.assertRaises(ValueError):h.main()
            info['ServerVersion']='27.3.1';info['Architecture']='arm64'
            with self.assertRaises(ValueError):h.main()
        finally:sys.argv=original_argv;h.execute=old_execute;h.command=old_command
    def test_attested_host_port_policy_does_not_bind_bridge_nas_ip(self):
        g=copy.deepcopy(self.g);g['publishHost']='192.168.1.55';calls=[]
        h.port_scope=lambda g:{'host_policy':{'network':'/run/space-store-host/net'},'host_port_available':lambda port,protocol,publishHost:calls.append((port,protocol,publishHost)) or True}
        old_socket=h.socket.socket
        h.socket.socket=lambda *args,**kwargs:self.fail('NAS IP bound in bridge namespace')
        try:h.ensure_ports(g)
        finally:h.socket.socket=old_socket
        self.assertEqual([(32123,'tcp','192.168.1.55')],calls)
    def test_host_tcp_udp_conflicts_wrong_mount_and_unattested_refuse(self):
        g=copy.deepcopy(self.g);g['appId']='syncthing';g['peerPort']=32200;g['discoveryPort']=32201
        for blocked in [(32123,'tcp'),(32200,'tcp'),(32200,'udp'),(32201,'udp')]:
            h.port_scope=lambda g,blocked=blocked:{'host_policy':{'network':'/run/space-store-host/net'},'host_port_available':lambda port,protocol,publishHost:(port,protocol)!=blocked}
            with self.assertRaises(ValueError):h.ensure_ports(g)
        for scope in [{},{'host_policy':{'network':'/proc/net'},'host_port_available':lambda *args,**kwargs:True},{'host_policy':{'network':'/run/space-store-host/net'}}]:
            h.port_scope=lambda g,scope=scope:scope
            with self.assertRaises(ValueError):h.ensure_ports(g)
        def unattested(g):raise ValueError('unattested container')
        h.port_scope=unattested
        with self.assertRaises(ValueError):h.ensure_ports(g)
    def test_daemon_publish_race_preserves_created_resources(self):
        c,n,im,s,r=self.fixture();self.g['containers']=[];self.g['networkId']=''
        h.port_scope=lambda g:{'host_policy':{'network':'/run/space-store-host/net'},'host_port_available':lambda *args,**kwargs:True}
        existing=h.command;commands=[]
        def command(args,**kwargs):
            commands.append(args)
            if args[:2]==['image','pull']:return ''
            if args[:2]==['network','create']:return 'e'*64
            if args[:2]==['container','create']:return r['id']
            if args[:2]==['container','start']:raise ValueError('authoritative host publication conflict')
            return existing(args,**kwargs)
        h.command=command
        with self.assertRaises(ValueError):h.launch(self.p,self.g)
        self.assertEqual(r['id'],self.g['containers'][0]['id']);self.assertEqual('e'*64,self.g['networkId'])
        self.assertTrue(pathlib.Path(self.g['dataPath']+'/.runtime-service-app-receipt.json').exists())
        self.assertFalse(any(any(v in ('rm','prune','down') for v in args) for args in commands))
    def test_image_pull_has_separate_bounded_command_timeout(self):
        self.assertEqual(900,h.command_timeout(['image','pull','--platform','linux/amd64','approved@sha256:'+'a'*64]))
        for command in [['image','inspect','approved'],['container','start','id'],['container','stop','id'],['exec','id','psql'],['logs','id'],['network','create','name']]:
            self.assertEqual(300,h.command_timeout(command))
    def quiesce_fixture(self):
        c,n,im,s,r=self.fixture();c['State']={'Running':True,'Status':'running'}
        existing=h.command;mutations=[]
        def command(args,**kwargs):
            if args[:2]==['container','ls']:
                return json.dumps({'Names':r['name'],'ID':r['id'][:12]})+'\n'
            if args[:2]==['network','ls']:
                return json.dumps({'Name':n['Name'],'ID':n['Id'][:12]})+'\n'
            if args[:2]==['container','stop']:
                mutations.append(args);c['State']={'Running':False,'Status':'exited'};return r['id']
            return existing(args,**kwargs)
        h.command=command
        return c,n,im,s,r,mutations
    def test_quiesce_recovers_receipts_without_adopting_by_labels(self):
        c,n,im,s,r,mutations=self.quiesce_fixture()
        h.resource_intent(self.g,'network')
        h.resource_receipt(self.g,'network',n['Id'])
        h.resource_intent(self.g,'service',s)
        h.resource_receipt(self.g,'service',r['id'],s)
        durable=copy.deepcopy(self.g);durable['networkId']='';durable['containers']=[]
        result=h.quiesce(durable)
        self.assertEqual('stopped',result['state']);self.assertEqual(r['id'],result['containers'][0]['id'])
        self.assertEqual([['container','stop',r['id']]],mutations)
        self.assertTrue(pathlib.Path(self.g['dataPath']+'/.runtime-network-receipt.json').exists())
    def test_quiesce_rejects_uncertain_create_and_foreign_before_any_stop(self):
        c,n,im,s,r,mutations=self.quiesce_fixture()
        h.resource_intent(self.g,'network')
        h.resource_receipt(self.g,'network',n['Id'])
        h.resource_intent(self.g,'service',s)
        uncertain=copy.deepcopy(self.g);uncertain['containers']=[]
        with self.assertRaises(ValueError):h.quiesce(uncertain)
        self.assertEqual([],mutations)
        h.resource_receipt(self.g,'service',r['id'],s)
        c['Config']['Labels']['io.spacedesktop.instance']='foreign'
        with self.assertRaises(ValueError):h.quiesce(copy.deepcopy(self.g))
        self.assertEqual([],mutations)
    def test_quiesce_unknown_name_is_uncertain_without_adoption(self):
        c,n,im,s,r,mutations=self.quiesce_fixture()
        lost=copy.deepcopy(self.g);lost['networkId']='';lost['containers']=[]
        with self.assertRaises(ValueError):h.quiesce(lost)
        self.assertEqual([],mutations);self.assertEqual([],lost['containers']);self.assertEqual('',lost['networkId'])
    def test_quiesce_receipt_profile_tamper_and_unknown_receipt_fail(self):
        c,n,im,s,r,mutations=self.quiesce_fixture()
        h.resource_intent(self.g,'network');h.resource_receipt(self.g,'network',n['Id'])
        path=pathlib.Path(self.g['dataPath']+'/.runtime-network-receipt.json')
        receipt=json.loads(path.read_text());receipt['resourceId']='f'*64;path.write_text(json.dumps(receipt))
        with self.assertRaises(ValueError):h.quiesce(copy.deepcopy(self.g))
        self.assertEqual([],mutations)
        pathlib.Path(self.g['dataPath']+'/.runtime-service-foreign-receipt.json').write_text('{}')
        with self.assertRaises(ValueError):h.quiesce(copy.deepcopy(self.g))
        self.assertEqual([],mutations)
    def test_quiesce_prepared_without_resources(self):
        g=copy.deepcopy(self.g);g['networkId']='';g['containers']=[]
        h.command=lambda args,**kwargs:'' if args[:2] in (['container','ls'],['network','ls']) else self.fail('prepared quiesce mutated')
        self.assertEqual('prepared',h.quiesce(g)['state'])
    def test_retry_readonly_proof_rejects_live_foreign_uncertain_and_unknown_inventory(self):
        c,n,im,s,r,mutations=self.quiesce_fixture()
        h.resource_intent(self.g,'network');h.resource_receipt(self.g,'network',n['Id'])
        h.resource_intent(self.g,'service',s);h.resource_receipt(self.g,'service',r['id'],s)
        previous=h.command
        def command(args,**kwargs):
            if '--filter' in args and args[:2]==['container','ls']:return json.dumps({'Names':r['name'],'ID':r['id']})+'\n'
            if '--filter' in args and args[:2]==['network','ls']:return json.dumps({'Name':n['Name'],'ID':n['Id']})+'\n'
            return previous(args,**kwargs)
        h.command=command
        with self.assertRaises(ValueError):h.verify_failed_install(self.p,copy.deepcopy(self.g))
        self.assertEqual([],mutations)
        c['State']={'Running':False,'Status':'exited'}
        before=copy.deepcopy(self.g);contents={p.name:p.read_bytes() for p in pathlib.Path(self.g['dataPath']).iterdir() if p.is_file()}
        h.verify_failed_install(self.p,self.g)
        self.assertEqual(before,self.g);self.assertEqual(contents,{p.name:p.read_bytes() for p in pathlib.Path(self.g['dataPath']).iterdir() if p.is_file()});self.assertEqual([],mutations)
        for phase in ('intent','receipt'):
            pathlib.Path(self.g['dataPath']+'/.runtime-network-'+phase+'.json').rename(self.root+'/network-'+phase)
        with self.assertRaises(ValueError):h.verify_failed_install(self.p,copy.deepcopy(self.g))
        for phase in ('intent','receipt'):
            pathlib.Path(self.root+'/network-'+phase).rename(self.g['dataPath']+'/.runtime-network-'+phase+'.json')
        c['Config']['Labels']['io.spacedesktop.instance']='foreign'
        with self.assertRaises(ValueError):h.verify_failed_install(self.p,copy.deepcopy(self.g))
        c['Config']['Labels']['io.spacedesktop.instance']=self.g['instanceId']
        receipt=pathlib.Path(self.g['dataPath']+'/.runtime-service-app-receipt.json');retained=self.root+'/retained-receipt';receipt.rename(retained)
        with self.assertRaises(ValueError):h.verify_failed_install(self.p,copy.deepcopy(self.g))
        pathlib.Path(retained).rename(receipt)
        h.command=lambda args,**kwargs:json.dumps({'Names':'foreign-renamed','ID':'f'*64}) if '--filter' in args and args[:2]==['container','ls'] else command(args,**kwargs)
        with self.assertRaises(ValueError):h.verify_failed_install(self.p,copy.deepcopy(self.g))
        self.assertEqual([],mutations)
    def test_retry_launch_rechecks_original_after_image_resolution_before_new_resources(self):
        c,n,im,s,r=self.fixture();self.g['containers']=[];self.g['networkId']=''
        previous=h.command;mutations=[];checks=[];old_verify=h.verify_failed_install
        def verify(p,g):
            checks.append(True)
            if mutations:h.reject()
        def command(args,**kwargs):
            if args[:2]==['image','pull']:mutations.append('pulled');return ''
            if args[:2] in (['network','create'],['container','create'],['container','start']):self.fail('resources created after original changed')
            return previous(args,**kwargs)
        h.verify_failed_install=verify;h.command=command
        try:
            with self.assertRaises(ValueError):h.launch(self.p,self.g,[{'plan':{},'generation':None}])
        finally:h.verify_failed_install=old_verify
        self.assertGreaterEqual(len(checks),2);self.assertEqual(['pulled'],mutations)
    def test_retry_launch_rechecks_all_ancestors_after_images(self):
        c,n,im,s,r=self.fixture();self.g['containers']=[];self.g['networkId']=''
        previous=h.command;checks=[];pulled=[];old_verify=h.verify_failed_install
        ancestors=[{'plan':{'id':'parent'},'generation':None},{'plan':{'id':'grandparent'},'generation':None}]
        def verify(p,g):
            checks.append(p['id'])
            if p['id']=='grandparent' and pulled:h.reject()
        def command(args,**kwargs):
            if args[:2]==['image','pull']:pulled.append(True);return ''
            if args[:2] in (['network','create'],['container','create'],['container','start']):self.fail('launched after grandparent changed')
            return previous(args,**kwargs)
        h.verify_failed_install=verify;h.command=command
        try:
            with self.assertRaises(ValueError):h.launch(self.p,self.g,ancestors)
        finally:h.verify_failed_install=old_verify
        self.assertEqual(['parent','grandparent','parent','grandparent'],checks)
        self.assertEqual([True],pulled)
    def test_retry_all_ancestors_rechecked_before_each_creation_and_start(self):
        old_verify=h.verify_failed_install
        try:
            for blocked_check in (2,3,4):
                with self.subTest(boundary=blocked_check):
                    # Fresh generation material for each network/container/start boundary.
                    self.g['networkId']='e'*64
                    c,n,im,s,r=self.fixture();self.g['containers']=[];self.g['networkId']=''
                    previous=h.command;calls=[];mutations=[]
                    def verify(p,g):
                        calls.append(p['id'])
                        if p['id']=='grandparent' and len(calls)==2*blocked_check:h.reject()
                    def command(args,**kwargs):
                        if args[:2]==['image','pull']:return ''
                        if args[:2]==['network','create']:mutations.append('network');return n['Id']
                        if args[:2]==['container','create']:mutations.append('container');return r['id']
                        if args[:2]==['container','start']:self.fail('start crossed changed ancestor fence')
                        return previous(args,**kwargs)
                    h.verify_failed_install=verify;h.command=command
                    with self.assertRaises(ValueError):h.launch(self.p,self.g,[{'plan':{'id':'parent'},'generation':None},{'plan':{'id':'grandparent'},'generation':None}])
                    self.assertEqual(['parent','grandparent']*blocked_check,calls)
                    self.assertEqual(['network','container'][:blocked_check-2],mutations)
                    # Receipt paths created by this fixture belong to a private temp dir.
                    for file in pathlib.Path(self.g['dataPath']).glob('.runtime-*.json'):file.rename(pathlib.Path(self.root)/('retained-'+str(blocked_check)+'-'+file.name))
        finally:h.verify_failed_install=old_verify
    def test_snapshot_readonly_verifier_preserves_files_and_rejects_tamper(self):
        self.fixture();pathlib.Path(self.g['dataPath']+'/data/file').write_text('sentinel')
        snap=h.snapshot(self.g,self.root,'snapshot')
        before={str(p):p.read_bytes() for p in pathlib.Path(self.root).rglob('*') if p.is_file()}
        h.verify_snapshot(snap)
        self.assertEqual(before,{str(p):p.read_bytes() for p in pathlib.Path(self.root).rglob('*') if p.is_file()})
        pathlib.Path(snap['path']).write_bytes(b'changed')
        with self.assertRaises(ValueError):h.verify_snapshot(snap)
    def test_restore_after_source_restarted_preserves_snapshot_evidence(self):
        c,n,im,s,r=self.fixture();pathlib.Path(self.g['dataPath']+'/data/file').write_text('sentinel')
        snapshot=h.snapshot(self.g,self.root,'snapshot');immutable=copy.deepcopy(snapshot)
        c['State']={'Running':True,'Status':'running'}
        new=copy.deepcopy(self.g);new.update({'id':'restored','dataPath':self.root+'/restored','networkId':'','containers':[]})
        h.prepare(self.p,new);h.restore(snapshot,new)
        self.assertEqual(immutable,snapshot)
        self.assertEqual('sentinel',pathlib.Path(new['dataPath']+'/data/file').read_text())
    def test_subprocess_log_capture_keeps_both_streams(self):
        original=h.subprocess.Popen
        def synthetic(args,**kwargs):
            return original([sys.executable,'-c','import sys;print("stdout=synthetic");sys.stderr.write("stderr=synthetic\\n")'],**kwargs)
        h.subprocess.Popen=synthetic
        try:
            result=self.old['command'](['logs','fixture'],capture_stderr=True)
            self.assertIn('stdout=synthetic',result);self.assertIn('stderr=synthetic',result)
        finally:h.subprocess.Popen=original
    def test_initialization_uses_authoritative_public_boolean(self):
        self.fixture();h.inspect=lambda g:g;original=h.public_json
        try:
            self.g['appId']='immich';h.public_json=lambda g,path:{'isInitialized':False}
            self.assertEqual('pending',h.initialization(self.g)['initialization'])
            h.public_json=lambda g,path:{'isInitialized':True}
            self.assertEqual('complete',h.initialization(self.g)['initialization'])
            h.public_json=lambda g,path:{'isInitialized':'true'}
            self.assertEqual('unknown',h.initialization(self.g)['initialization'])
        finally:h.public_json=original
    def test_initialization_sqlite_readonly_admin_and_unknown_schema(self):
        import sqlite3
        self.fixture();h.inspect=lambda g:g;self.g['appId']='uptime-kuma'
        path=self.g['dataPath']+'/data/kuma.db';db=sqlite3.connect(path)
        db.execute('CREATE TABLE user(id INTEGER,active INTEGER)');db.commit()
        self.assertEqual('pending',h.initialization(self.g)['initialization'])
        db.execute('INSERT INTO user VALUES(1,1)');db.commit();db.close()
        self.assertEqual('complete',h.initialization(self.g)['initialization'])
        before=pathlib.Path(path).read_bytes();h.initialization(self.g)
        self.assertEqual(before,pathlib.Path(path).read_bytes())
    def syncthing_config_fixture(self,text):
        self.g['appId']='syncthing';h.inspect=lambda g:g
        self.g['recipe']['services'][0]['volumes'].append({'name':'config','target':'/var/syncthing/config','role':'config'})
        directory=pathlib.Path(self.g['dataPath'])/'config';directory.mkdir(mode=0o700)
        path=directory/'config.xml';path.write_text(text);path.chmod(0o600)
        return path
    def test_syncthing_initialization_proves_admin_configuration_without_writing_or_exposing_secrets(self):
        path=self.syncthing_config_fixture('<configuration><gui enabled="true"><user>synthetic-admin</user><password>$2a$10$'+('A'*53)+'</password><apikey>synthetic-private-key</apikey><authMode>static</authMode></gui></configuration>')
        before=(path.read_bytes(),path.stat().st_mtime_ns,path.stat().st_mode)
        result=h.initialization(self.g)
        self.assertEqual({'initialization':'complete'},result)
        self.assertNotIn('synthetic',json.dumps(result))
        self.assertEqual(before,(path.read_bytes(),path.stat().st_mtime_ns,path.stat().st_mode))
    def test_syncthing_unconfigured_admin_is_pending_and_unverifiable_modes_are_unknown(self):
        path=self.syncthing_config_fixture('<configuration><gui enabled="true"/></configuration>')
        self.assertEqual('pending',h.initialization(self.g)['initialization'])
        for body in ['<configuration/>','<configuration><gui enabled="false"/></configuration>',
                     '<configuration><gui><authMode>ldap</authMode></gui></configuration>',
                     '<configuration><gui><user>synthetic</user><password>invalid</password></gui></configuration>',
                     '<configuration><gui/><gui/></configuration>',
                     '<!DOCTYPE configuration [<!ENTITY secret "synthetic">]><configuration><gui><user>&secret;</user></gui></configuration>']:
            with self.subTest(body=body):
                path.write_text(body)
                self.assertEqual('unknown',h.initialization(self.g)['initialization'])
    def test_syncthing_duplicate_authentication_fields_are_unverifiable(self):
        password='$2a$10$'+('A'*53)
        body='<configuration><gui><user>synthetic</user><password>'+password+'</password><authMode>static</authMode>{extra}</gui></configuration>'
        path=self.syncthing_config_fixture(body.format(extra=''))
        for extra in ['<user/>','<password/>','<authMode>ldap</authMode>']:
            with self.subTest(extra=extra):
                path.write_text(body.format(extra=extra))
                self.assertEqual('unknown',h.initialization(self.g)['initialization'])
    def test_syncthing_xml_declaration_matches_native_utf8_version_support(self):
        body='<configuration><gui><user>synthetic</user><password>$2a$10$'+('A'*53)+'</password></gui></configuration>'
        path=self.syncthing_config_fixture(body)
        for declaration in ['<?xml version="1.0" encoding="ISO-8859-1"?>',
                            '<?xml version="1.0" encoding="UTF8"?>',
                            '<?xml version="1.1" encoding="UTF-8"?>']:
            with self.subTest(declaration=declaration):
                path.write_text(declaration+body)
                self.assertEqual('unknown',h.initialization(self.g)['initialization'])
        for declaration in ['<?xml version="1.0" encoding="UTF-8"?>',
                            '<?xml version="1.0" encoding="utf-8"?>',
                            '\ufeff<?xml version="1.0" encoding="UTF-8"?>']:
            with self.subTest(declaration=declaration):
                path.write_text(declaration+body)
                self.assertEqual('complete',h.initialization(self.g)['initialization'])
    def test_syncthing_native_bcrypt_2y_password_is_configured(self):
        # Generated from random process-only bytes and verified with native Go
        # bcrypt. The credential was discarded; only its synthetic hash remains.
        password='$2y$04$euBJ4i4DQA7NCPmmlbTbEON5dPx802i65mgOY2vcGPRTfjI8/NRkG'
        self.syncthing_config_fixture('<configuration><gui><user>synthetic</user><password>'+password+'</password></gui></configuration>')
        self.assertEqual('complete',h.initialization(self.g)['initialization'])
    def test_syncthing_ambiguous_namespaces_and_nested_authentication_fields_are_unknown(self):
        gui='<gui><user>synthetic</user><password>$2a$10$'+('A'*53)+'</password>{extra}</gui>'
        path=self.syncthing_config_fixture('<configuration>'+gui.format(extra='')+'</configuration>')
        for body in [
                '<configuration>'+gui.format(extra='<authMode xmlns="urn:synthetic">ldap</authMode>')+'</configuration>',
                '<configuration>'+gui.format(extra='<password xmlns="urn:synthetic"/>')+'</configuration>',
                '<configuration>'+gui.format(extra='')+'<gui xmlns="urn:synthetic" enabled="false"/></configuration>',
                '<configuration>'+gui.format(extra='').replace('<gui>','<gui xmlns:s="urn:synthetic" s:enabled="false">')+'</configuration>',
                '<configuration>'+gui.format(extra='').replace('</password>','<unexpected/>suffix</password>')+'</configuration>']:
            with self.subTest(body=body):
                path.write_text(body)
                self.assertEqual('unknown',h.initialization(self.g)['initialization'])
    def test_syncthing_config_refuses_symlink_oversize_fifo_and_changed_file(self):
        path=self.syncthing_config_fixture('<configuration><gui/></configuration>')
        retained=path.with_name('retained.xml');path.rename(retained);path.symlink_to(retained)
        self.assertEqual('unknown',h.initialization(self.g)['initialization'])
        path.unlink();path.write_bytes(b'x'*(256*1024+1))
        self.assertEqual('unknown',h.initialization(self.g)['initialization'])
        path.unlink();os.mkfifo(path)
        self.assertEqual('unknown',h.initialization(self.g)['initialization'])
        path.unlink();path.write_text('<configuration><gui/></configuration>')
        previous=h.os.read
        def changed(fd,limit):
            result=previous(fd,limit)
            path.write_text('<configuration><gui enabled="false"/></configuration>')
            return result
        h.os.read=changed
        try:self.assertEqual('unknown',h.initialization(self.g)['initialization'])
        finally:h.os.read=previous
    def test_logs_redact_credentials_and_userinfo(self):
        c,n,im,s,r=self.fixture();secret='a'*64
        s['environment']={'DB_PASSWORD':'$managed:database-password'}
        c['Config']['Env'].append('DB_PASSWORD='+secret)
        old=h.command
        def command(args,**kwargs):
            if args[0]=='logs':
                original=h.subprocess.Popen
                def synthetic(argv,**options):
                    script='import sys;print("DB_PASSWORD='+secret+'");sys.stderr.write("url=http://user:pass@localhost token=private-value\\n")'
                    return original([sys.executable,'-c',script],**options)
                h.subprocess.Popen=synthetic
                try:return self.old['command'](args,**kwargs)
                finally:h.subprocess.Popen=original
            return old(args,**kwargs)
        h.command=command
        result=h.logs(self.g,'app',20)['logs']
        self.assertNotIn(secret,result);self.assertNotIn('user:pass',result);self.assertNotIn('private-value',result)
    def test_managed_password_is_inherited_only(self):
        c,n,im,service,record=self.fixture()
        service['environment']={'POSTGRES_PASSWORD':'$managed:database-password','DB_PASSWORD':'$managed:database-password'}
        service['entry']=False;c['HostConfig']['PortBindings']={}
        self.g['containers']=[];self.g['networkId']=''
        existing=h.command;seen=[]
        def command(args,**kwargs):
            seen.append(list(args))
            if args[:2]==['image','pull']:return ''
            if args[:2]==['network','create']:return 'e'*64
            if args[:2]==['container','create']:
                env=kwargs['env'];password=env['POSTGRES_PASSWORD']
                self.assertEqual(password,env['DB_PASSWORD']);self.assertRegex(password,r'^[a-f0-9]{64}$')
                self.assertNotIn(password,' '.join(args))
                c['Config']['Env']=['PATH=/bin','POSTGRES_PASSWORD='+password,'DB_PASSWORD='+password]
                return record['id']
            if args[:2]==['container','start']:
                c['State']={'Running':True,'Status':'running'};return ''
            return existing(args,**kwargs)
        h.command=command
        h.launch(self.p,self.g)
        self.assertEqual('running',self.g['state'])
        self.assertFalse(any('rm' in a or 'prune' in a for a in seen))
    def test_utility_retained_labelled_networkless_and_source_readonly(self):
        c,n,im,service,record=self.fixture()
        im['Config']['Volumes']={'/var/lib/postgresql/data':{}}
        service['id']='database';self.g['images'][0]['serviceId']='database'
        self.g['containers'][0]['serviceId']='database'
        # Utility has its own full inspect contract, independent of app record.
        utility_container={};seen=[];existing=h.command
        h.inspect=lambda g:g
        self.g['state']='stopped'
        snapshot_dir=self.root+'/private';os.mkdir(snapshot_dir,0o700)
        def command(args,**kwargs):
            seen.append(list(args))
            if args[:2]==['container','create']:
                get=lambda flag:args[args.index(flag)+1]
                pairs=[args[i+1] for i,v in enumerate(args) if v=='--label']
                mount_strings=[args[i+1] for i,v in enumerate(args) if v=='--mount']
                ms=[]
                for value in mount_strings:
                    vals=dict(part.split('=',1) for part in value.split(',') if '=' in part)
                    ms.append({'Type':'bind','Source':vals['src'],'Destination':vals['dst'],'RW':'readonly' not in value.split(',')})
                for declared in (im['Config'].get('Volumes') or {}):
                    if declared not in [m['Destination'] for m in ms]:
                        ms.append({'Type':'volume','Source':'/var/lib/docker/volumes/anonymous','Destination':declared,'RW':True})
                utility_container.update({'Id':'d'*64,'Name':'/'+get('--name'),'Image':im['Id'],'Config':{'Image':self.g['images'][0]['reference'],'Labels':dict(v.split('=',1) for v in pairs),'User':get('--user'),'Entrypoint':[get('--entrypoint')],'Cmd':args[-2:]},'HostConfig':{'NetworkMode':get('--network'),'ReadonlyRootfs':'--read-only' in args},'Mounts':ms,'State':{'Running':False,'ExitCode':0}})
                return 'd'*64
            if args[:2]==['container','inspect'] and args[2]=='d'*64:return json.dumps([utility_container])
            if args[:2]==['container','start']:return ''
            return existing(args,**kwargs)
        h.command=command
        h.utility(self.g,snapshot_dir,'archive','data')
        self.assertEqual('none',utility_container['HostConfig']['NetworkMode'])
        self.assertFalse(utility_container['Mounts'][0]['RW'])
        self.assertNotIn(self.g['dataPath'],[m['Source'] for m in utility_container['Mounts']])
        self.assertTrue(list(pathlib.Path(snapshot_dir).glob('utility-*.json')))
        self.assertFalse(any(any(v in ('rm','prune','down','--privileged') for v in args) for args in seen))
        original=self.g['dataPath']
        new=copy.deepcopy(self.g);new.update({'id':'restored','dataPath':self.root+'/restored','networkId':'','containers':[]});h.prepare(self.p,new)
        h.utility(new,snapshot_dir,'restore','data')
        self.assertEqual(new['dataPath']+'/data',utility_container['Mounts'][0]['Source'])
        self.assertTrue(utility_container['Mounts'][0]['RW'])
        self.assertFalse(utility_container['Mounts'][1]['RW'])
        self.assertNotEqual(original+'/data',utility_container['Mounts'][0]['Source'])
    def test_snapshot_hash_tamper_rejected(self):
        self.fixture();snap=h.snapshot(self.g,self.root,'snapshot');pathlib.Path(snap['path']).write_bytes(b'changed')
        new=copy.deepcopy(self.g);new.update({'id':'restored','dataPath':self.root+'/restored','networkId':'','containers':[]});h.prepare(self.p,new)
        with self.assertRaises(ValueError):h.restore(snap,new)

if __name__=='__main__':unittest.main()
