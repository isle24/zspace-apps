import base64, hashlib, importlib.util, json, pathlib, sys, unittest
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('registry_host',pathlib.Path(__file__).with_name('runtime_registry_host.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
def digest(data):return 'sha256:'+hashlib.sha256(data).hexdigest()
class RegistryHostTests(unittest.TestCase):
 def setUp(self):
  self.original=h.open_request
  self.cfg=b'{"architecture":"amd64","os":"linux"}'
  self.manifest=json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'digest':digest(self.cfg),'size':len(self.cfg),'mediaType':'application/vnd.oci.image.config.v1+json'},'layers':[]}).encode()
  self.index=json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.index.v1+json','manifests':[{'digest':digest(self.manifest),'size':len(self.manifest),'platform':{'os':'linux','architecture':'amd64'},'mediaType':'application/vnd.oci.image.manifest.v1+json'}]}).encode()
 def tearDown(self):h.open_request=self.original
 def test_official_ghcr_auth_cdn_corpus_excludes_credentials(self):
  calls=[]
  def request(url,headers,limit):
   calls.append((url,dict(headers)))
   if url.startswith('https://ghcr.io/token?'):return 200,{},b'{"token":"fixture-anonymous-private-token"}'
   if url.startswith('https://pkg-containers.githubusercontent.com/'):
    self.assertNotIn('Authorization',headers);return 200,{},self.cfg
   if 'Authorization' not in headers:return 401,{'WWW-Authenticate':'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:navidrome/navidrome:pull"'},b''
   if '/blobs/' in url:return 307,{'Location':'https://pkg-containers.githubusercontent.com/private?signature=memory-only'},b''
   body=self.manifest if url.endswith(digest(self.manifest)) else self.index
   return 200,{'Docker-Content-Digest':digest(body)},body
  h.open_request=request
  corpus=h.resolve(['ghcr.io/navidrome/navidrome:0.64.2'])
  self.assertEqual(3,len(corpus['documents']))
  serialized=json.dumps(corpus)
  self.assertNotIn('fixture-anonymous-private-token',serialized);self.assertNotIn('signature',serialized)
  self.assertEqual(self.cfg,base64.b64decode(corpus['documents'][-1]['body']))
  self.assertIn('/blobs/',corpus['documents'][-1]['path'])
 def test_unapproved_references_never_request(self):
  h.open_request=lambda *args:self.fail('unapproved reference requested network')
  for ref in ['ghcr.io/attacker/app:1','ghcr.io/navidrome/navidrome:latest','http://ghcr.io/navidrome/navidrome:0.64.2','ghcr.io/navidrome/navidrome:0.64.2@sha256:'+'a'*64]:
   with self.assertRaises(ValueError):h.resolve([ref])
 def test_hostile_auth_redirect_digest_and_platform_fail_closed(self):
  for mode in ['realm','scope','manifestredirect','cdn','digest','platform','tokenredirect','oversize']:
   def request(url,headers,limit):
    if url.startswith('https://ghcr.io/token?'):
     return (307,{'Location':'https://evil.invalid/token'},b'') if mode=='tokenredirect' else (200,{},b'{"token":"fixture-token"}')
    if 'Authorization' not in headers:
     realm='https://evil.invalid/token' if mode=='realm' else 'https://ghcr.io/token'
     scope='repository:attacker/app:pull' if mode=='scope' else 'repository:navidrome/navidrome:pull'
     return 401,{'WWW-Authenticate':'Bearer realm="'+realm+'",service="ghcr.io",scope="'+scope+'"'},b''
    if '/blobs/' in url:
     if mode=='cdn':return 307,{'Location':'https://evil.invalid/blob'},b''
     return 200,{},self.cfg
    body=self.manifest if url.endswith(digest(self.manifest)) else self.index
    if mode=='manifestredirect':return 307,{'Location':'https://pkg-containers.githubusercontent.com/manifest'},b''
    if mode=='digest':return 200,{'Docker-Content-Digest':'sha256:'+'0'*64},body
    if mode=='platform':body=body.replace(b'amd64',b'arm64')
    if mode=='oversize':body=b'x'*(limit+1)
    return 200,{},body
   h.open_request=request
   with self.subTest(mode=mode),self.assertRaises(ValueError):h.resolve(['ghcr.io/navidrome/navidrome:0.64.2'])
if __name__=='__main__':unittest.main()
