import copy, gzip, hashlib, importlib.util, io, json, os, pathlib, sys, tarfile, tempfile, unittest
from unittest.mock import patch
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('host_tests',pathlib.Path(__file__).with_name('runtime_host_test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base);h=base.h
CONFIG='sha256:0f1ea3da17ac3c2a37a7525323dbaeb5ea1c3c0ae7a5508329ca8f6a008f9ccb'
TAG='nasreader:free-platforms-reader-licensed-amd64-20261010'
DIFFS=['sha256:'+x for x in ['e63b02c2b5c761df2cb95e657d744f27d95da4e051235a13c80b88cd68eab188','15a1fd6977575dfbd3ce1a551140eeb3210e944b7d50bf69e69f5815b8506c7a','f8b32a7528ea40fb89aa834497fa3562c9099801ee2abbdc7e87714f48839408','54f59a3b6c5d3204c4d96327b21b1484fcb57919cbe1b72d6aa99adb311592b4','e36189ddb1f2188fd22b562f2a5551aec748aade5ba6a1c9204991e3c90ff2a7','287a4a9a15206855817ba3624df195400b576c9a78326bc156625555c2cfe25a']]
def descriptor():
 return dict(serviceId='nasreader',tagReference=TAG,reference=CONFIG,digest='',platform='linux/amd64',publisher='nasreader',deliverySource='owner-archive',configId=CONFIG,archiveSha256='90e7de4c1d97c548a838d086190b80ab52f7feb4be3abef013f3fcf4562fd491',archiveSizeBytes=44854784,diffIds=DIFFS.copy())
def service():
 return dict(id='nasreader',image=TAG,healthPath='/health',entry=True,containerPort=8080,userMode='host',environment={},volumes=[dict(name='data',target='/data',role='data'),dict(name='inbox',target='/inbox',role='data'),dict(name='media',target='/library',role='media-readonly')])
class OwnerRuntimeTests(unittest.TestCase):
 setUp=base.GuardTests.setUp
 tearDown=base.GuardTests.tearDown
 fixture=base.GuardTests.fixture
 def owned(self):
  self.g.update(appId='nasreader',version='0.1.0',recipeRevision='2026-10-12.1',dataPath=self.root+'/reader',images=[descriptor()],mediaPath=self.root+'/books',mediaRootPath=self.root,mediaStorageIdentity='storage')
  pathlib.Path(self.g['mediaPath']).mkdir(exist_ok=True)
  self.g['recipe']=dict(appId='nasreader',version='0.1.0',revision='2026-10-12.1',requiresMedia=True,services=[service()])
  h.storage=lambda mode,path:dict(identity='storage' if mode=='inspect' else 'docker',volumeType='ssd',systemDisk=False,installAllowed=True,mediaReadAllowed=True,freeBytes=2**40)
  self.p.update(recipe=self.g['recipe'],mediaPath=self.g['mediaPath'],mediaRootPath=self.root,mediaStorageIdentity='storage')
  if not pathlib.Path(self.g['dataPath']).exists():h.prepare(self.p,self.g)
  c,n,im,s,r=self.fixture()
  im.update(Id=CONFIG,RootFS={'Type':'layers','Layers':DIFFS.copy()},RepoDigests=[])
  c['Image']=CONFIG;c['Config']['User']=str(os.getuid())+':'+str(os.getgid())
  c['HostConfig'].update(CapDrop=['ALL'],SecurityOpt=['no-new-privileges'])
  return c,n,im,s,r
 def test_owner_loaded_image_and_complete_inspect(self):
  c,n,im,s,r=self.owned()
  self.assertEqual('stopped',h.inspect(self.g)['state'])
  self.assertTrue(callable(getattr(h,'resolve_owner',None)),'loaded author image resolver missing')
  self.assertEqual([descriptor()],h.resolve_owner(self.g['recipe'],[descriptor()]))
 def test_owner_forged_layers_config_profile_and_mounts_refused(self):
  mutations=[lambda c,i:i['RootFS']['Layers'].reverse(),lambda c,i:i.update(Id='sha256:'+'a'*64),lambda c,i:i.update(Architecture='arm64'),lambda c,i:c['HostConfig'].update(CapDrop=[]),lambda c,i:c['HostConfig'].update(SecurityOpt=[]),lambda c,i:c['HostConfig'].update(Privileged=True),lambda c,i:c['HostConfig'].update(PidMode='host'),lambda c,i:c['Mounts'][-1].update(RW=True),lambda c,i:c['Config']['Env'].append('LICENSE_ENABLED=false')]
  for mutate in mutations:
   c,n,im,s,r=self.owned();mutate(c,im)
   with self.assertRaises(ValueError):h.inspect(self.g)
 def test_owner_launch_never_pulls_and_applies_profile(self):
  c,n,im,s,r=self.owned();self.g['containers']=[];self.g['networkId']='';commands=[];original=h.command
  def command(args,**kw):
   commands.append(args)
   if args[:2]==['network','create']:return 'e'*64
   if args[:2]==['container','create']:return r['id']
   if args[:2]==['container','start']:c['State']={'Running':True,'Status':'running'};return ''
   return original(args,**kw)
  h.command=command
  with patch.object(h,'http_healthy',lambda g,s:s['healthPath']=='/health'):
   out=h.launch(self.p,self.g)
  self.assertEqual('running',out['state']);self.assertFalse(any(a[:2]==['image','pull'] for a in commands))
  create=next(a for a in commands if a[:2]==['container','create'])
  self.assertEqual('ALL',create[create.index('--cap-drop')+1]);self.assertEqual('no-new-privileges',create[create.index('--security-opt')+1]);self.assertEqual(CONFIG,create[-1])
 def test_owner_missing_image_fails_before_network_or_pull(self):
  self.owned();self.g.update(containers=[],networkId='');commands=[]
  def command(args,**kw):commands.append(args);raise ValueError('absent')
  h.command=command
  with self.assertRaisesRegex(ValueError,'owner_image_unavailable'):h.launch(self.p,self.g)
  self.assertEqual([['image','inspect',CONFIG]],commands)
 def test_owner_public_setup_boolean_is_not_license(self):
  self.owned();calls=[]
  for response,want in [({'required':True},'pending'),({'required':False},'complete'),({'required':'false'},'unknown'),({'data':{'required':False}},'unknown'),({'status':'ok','license':'active'},'unknown')]:
   with patch.object(h,'public_json',lambda g,path:calls.append(path) or response):
    self.assertEqual({'initialization':want},h.initialization(self.g))
  self.assertEqual(['/api/v1/setup']*5,calls)
 def test_owner_receipt_recovery_requires_unchanged_image_and_profile(self):
  c,n,im,s,r=self.owned();original=h.command;mutations=[]
  def command(args,**kwargs):
   if args[:2]==['container','ls']:return json.dumps({'Names':r['name'],'ID':r['id']})
   if args[:2]==['network','ls']:return json.dumps({'Name':n['Name'],'ID':n['Id']})
   if args[:2]==['container','stop']:mutations.append(args);c['State']={'Running':False,'Status':'exited'};return ''
   return original(args,**kwargs)
  h.command=command
  h.resource_intent(self.g,'network');h.resource_receipt(self.g,'network',n['Id'])
  h.resource_intent(self.g,'service',s);h.resource_receipt(self.g,'service',r['id'],s)
  durable=copy.deepcopy(self.g);durable.update(networkId='',containers=[])
  c['State']={'Running':True,'Status':'running'}
  im['RootFS']['Layers'].reverse()
  with self.assertRaises(ValueError):h.quiesce(copy.deepcopy(durable))
  self.assertEqual([],mutations)
  im['RootFS']['Layers'].reverse();c['HostConfig']['CapDrop']=[]
  with self.assertRaises(ValueError):h.quiesce(copy.deepcopy(durable))
  self.assertEqual([],mutations)
  c['HostConfig']['CapDrop']=['ALL'];out=h.quiesce(durable)
  self.assertEqual('stopped',out['state']);self.assertEqual([['container','stop',r['id']]],mutations)
  before={p.name:p.read_bytes() for p in pathlib.Path(self.g['dataPath']).iterdir() if p.is_file()}
  h.verify_failed_install(self.p,out)
  self.assertEqual(before,{p.name:p.read_bytes() for p in pathlib.Path(self.g['dataPath']).iterdir() if p.is_file()})
 def test_owner_snapshot_restore_preserves_library_and_inbox(self):
  self.owned();pathlib.Path(self.g['dataPath']+'/data/file').write_text('db');pathlib.Path(self.g['dataPath']+'/inbox/file').write_text('synthetic import');book=pathlib.Path(self.g['mediaPath']+'/book');book.write_text('synthetic book')
  snap=h.snapshot(self.g,self.root,'reader-backup');new=copy.deepcopy(self.g);new.update(id='restored',dataPath=self.root+'/restored',networkId='',containers=[])
  h.prepare(self.p,new);h.restore(snap,new)
  self.assertEqual('db',pathlib.Path(new['dataPath']+'/data/file').read_text());self.assertEqual('synthetic import',pathlib.Path(new['dataPath']+'/inbox/file').read_text());self.assertEqual('synthetic book',book.read_text())
  with tarfile.open(snap['path']) as tar:self.assertFalse(any('library' in x for x in tar.getnames()))
class OwnerLoadArchiveTests(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('owner_load_test',pathlib.Path(__file__).with_name('runtime_owner_image.py'))
  self.owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.owner)
  # Small synthetic software, with the identical fixed six-layer schema. Only
  # module constants are scoped to this fixture; no production identity changes.
  bodies=[('synthetic-layer-'+str(n)).encode() for n in range(6)]
  layers=[gzip.compress(b,mtime=0) for b in bodies]
  self.owner.OWNER_DIFF_IDS=['sha256:'+hashlib.sha256(b).hexdigest() for b in bodies]
  self.owner.OWNER_LAYERS=[hashlib.sha256(b).hexdigest() for b in layers]
  config=json.dumps({'os':'linux','architecture':'amd64','rootfs':{'type':'layers','diff_ids':self.owner.OWNER_DIFF_IDS}}).encode()
  self.owner.OWNER_CONFIG='sha256:'+hashlib.sha256(config).hexdigest()
  self.config_name='blobs/sha256/'+self.owner.OWNER_CONFIG[7:]
  self.names=['blobs/sha256/'+x for x in self.owner.OWNER_LAYERS]
  self.entries={self.config_name:config,**dict(zip(self.names,layers))}
  self.manifest=[{'Config':self.config_name,'Layers':self.names}]
  self.entries['manifest.json']=json.dumps(self.manifest).encode()
 def packed(self,entries):
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as archive:
   for name,body in entries:
    member=tarfile.TarInfo(name);member.size=len(body);archive.addfile(member,io.BytesIO(body))
  return out.getvalue()
 def test_derived_validator_rejects_tags_metadata_duplicates_and_software_changes(self):
  owner=self.owner
  self.assertTrue(callable(getattr(owner,'validate_owner_load_archive',None)),'independent load archive validator missing')
  self.assertEqual(owner.owner_descriptor(),owner.validate_owner_load_archive(self.packed(self.entries.items())))
  variants=[]
  for key,value in [('RepoTags',[TAG]),('RepoTags',[]),('Parent',CONFIG),('LayerSources',{})]:
   changed=dict(self.entries);changed['manifest.json']=json.dumps([dict(self.manifest[0],**{key:value})]).encode();variants.append(list(changed.items()))
  for extra in ('index.json','repositories','oci-layout','../escape'):
   variants.append(list(self.entries.items())+[(extra,b'{}')])
  variants.append(list(self.entries.items())+[('manifest.json',self.entries['manifest.json'])])
  for name in (self.config_name,self.names[0]):
   changed=dict(self.entries);changed[name]+=b'altered';variants.append(list(changed.items()))
  changed=dict(self.entries);changed['manifest.json']=json.dumps([dict(self.manifest[0],Layers=list(reversed(self.names)))]).encode();variants.append(list(changed.items()))
  variants.append(list(self.entries.items())[1:])
  for entries in variants:
   with self.subTest(names=[x[0] for x in entries]):
    with self.assertRaises(ValueError):owner.validate_owner_load_archive(self.packed(entries))
  with patch.object(owner,'OWNER_DIFF_IDS',list(reversed(owner.OWNER_DIFF_IDS))):
   with self.assertRaises(ValueError):owner.validate_owner_load_archive(self.packed(self.entries.items()))
 def test_derived_validator_rejects_links_oversize_and_uncompressed_identity_mismatch(self):
  owner=self.owner
  self.assertTrue(callable(getattr(owner,'validate_owner_load_archive',None)),'independent load archive validator missing')
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w') as archive:
   member=tarfile.TarInfo(self.config_name);member.type=tarfile.SYMTYPE;member.linkname='/private';archive.addfile(member)
  with self.assertRaises(ValueError):owner.validate_owner_load_archive(out.getvalue())
  with patch.object(owner,'OWNER_SIZE',1):
   with self.assertRaises(ValueError):owner.validate_owner_load_archive(self.packed(self.entries.items()))
  # Rehash the compressed stream and descriptor but keep the original diffID;
  # independent validation must also decompress and check software identity.
  changed=dict(self.entries);payload=gzip.compress(b'different software',mtime=0);new_digest=hashlib.sha256(payload).hexdigest();new_name='blobs/sha256/'+new_digest
  del changed[self.names[0]];changed[new_name]=payload
  changed['manifest.json']=json.dumps([dict(self.manifest[0],Layers=[new_name]+self.names[1:])]).encode()
  with patch.object(owner,'OWNER_LAYERS',[new_digest]+owner.OWNER_LAYERS[1:]):
   with self.assertRaises(ValueError):owner.validate_owner_load_archive(self.packed(changed.items()))
 def test_derived_validator_rejects_hidden_tar_metadata_and_trailing_content(self):
  owner=self.owner
  self.assertTrue(callable(getattr(owner,'validate_owner_load_archive',None)))
  good=self.packed(self.entries.items())
  with self.assertRaises(ValueError):owner.validate_owner_load_archive(good+b'not-zero-trailing-metadata')
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w',format=tarfile.GNU_FORMAT) as archive:
   extension=tarfile.TarInfo('././@LongLink');extension.type=tarfile.GNUTYPE_LONGNAME;body=self.config_name.encode()+b'\0';extension.size=len(body);archive.addfile(extension,io.BytesIO(body))
   for name,body in self.entries.items():
    entry=tarfile.TarInfo(name);entry.size=len(body);archive.addfile(entry,io.BytesIO(body))
  with self.assertRaises(ValueError):owner.validate_owner_load_archive(out.getvalue())
if __name__=='__main__':unittest.main()
