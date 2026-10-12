"""Fetch bounded anonymous official OCI proof bytes on the Docker host.
Tokens, authentication responses and signed CDN URLs never leave this process.
Go's approved RuntimeRegistryResolver validates the complete returned proof.
"""
import base64, hashlib, json, re, sys, time, urllib.error, urllib.parse, urllib.request

ALLOWED = {
 'ghcr.io/louislam/uptime-kuma': {'2.5.6':'','2.5.5':''},
 'ghcr.io/navidrome/navidrome': {'0.64.2':'','0.64.1':''},
 'ghcr.io/jellyfin/jellyfin': {'12.2':'','12.1':''},
 'ghcr.io/syncthing/syncthing': {'2.1.6':'','2.1.5':''},
 'ghcr.io/immich-app/immich-server': {'v3.3.1':'','v3.3.0':''},
 'ghcr.io/immich-app/immich-machine-learning': {'v3.3.1':'','v3.3.0':''},
 'ghcr.io/immich-app/postgres': {'14-vectorchord0.4.3-pgvectors0.2.0':'sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23'},
 'ghcr.io/valkey-io/valkey': {'9':'sha256:c123e3715db63d06d4ad6964884037aa0d5d4d703939b9929954112889708e1d'},
}
MANIFEST_LIMIT=4*1024*1024
CONFIG_LIMIT=1024*1024
CORPUS_LIMIT=768*1024
DIGEST=re.compile(r'^sha256:[a-f0-9]{64}$')
ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

def reject():raise ValueError('official_image_verification_failed')

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):return None

def open_request(url,headers,limit):
 # Never inherit proxy configuration or automatic redirect behavior.
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 request=urllib.request.Request(url,headers=headers,method='GET')
 try:response=opener.open(request,timeout=15)
 except urllib.error.HTTPError as error:response=error
 with response:
  if sum(len(k)+len(v) for k,v in response.headers.items())>16384:reject()
  body=response.read(limit+1)
  if len(body)>limit:reject()
  return response.code,dict(response.headers.items()),body

def header(headers,name):
 values=[v for k,v in headers.items() if k.lower()==name.lower()]
 if len(values)>1 or any('\r' in v or '\n' in v or len(v)>8192 for v in values):reject()
 return values[0] if values else ''

def checked_request(url,headers,limit,deadline):
 if time.monotonic()>=deadline:reject()
 status,received,body=open_request(url,headers,limit)
 if len(body)>limit or sum(len(k)+len(v) for k,v in received.items())>16384:reject()
 return status,received,body

class Session:
 def __init__(self,repo,deadline):self.repo,self.deadline,self.token=repo,deadline,''
 def fetch(self,path,manifest=True):
  limit=MANIFEST_LIMIT if manifest else CONFIG_LIMIT
  url='https://ghcr.io'+path
  def request():
   headers={'Accept':ACCEPT} if manifest else {}
   if self.token:headers['Authorization']='Bearer '+self.token
   return checked_request(url,headers,limit,self.deadline)
  status,headers,body=request()
  if status==401 and not self.token:
   challenge=header(headers,'WWW-Authenticate')
   fields=re.findall(r'([a-z]+)="([^"]*)"',challenge)
   values={}
   for key,value in fields:
    if key in values:reject()
    values[key]=value
   scope='repository:'+self.repo+':pull'
   if not challenge.startswith('Bearer ') or values.get('realm')!='https://ghcr.io/token' or values.get('service')!='ghcr.io' or values.get('scope','') not in ('',scope):reject()
   token_url='https://ghcr.io/token?'+urllib.parse.urlencode({'service':'ghcr.io','scope':scope})
   ts,th,tb=checked_request(token_url,{},65536,self.deadline)
   if ts!=200:reject()
   token_doc=json.loads(tb)
   self.token=token_doc.get('token') or token_doc.get('access_token') or ''
   if not isinstance(self.token,str) or not self.token or len(self.token)>32768 or '\r' in self.token or '\n' in self.token:reject()
   status,headers,body=request()
  # Only official GHCR configuration-blob delivery may cross origin. Headers
  # start empty so bearer tokens and cookies are never sent to the CDN.
  if status==307 and not manifest and path.startswith('/v2/'+self.repo+'/blobs/'):
   for _ in range(2):
    if status!=307:break
    location=header(headers,'Location');target=urllib.parse.urlsplit(location)
    if target.scheme!='https' or target.netloc!='pkg-containers.githubusercontent.com' or target.username is not None or target.password is not None or target.fragment or not target.path:reject()
    status,headers,body=checked_request(location,{},limit,self.deadline)
  if status!=200:reject()
  actual='sha256:'+hashlib.sha256(body).hexdigest()
  advertised=header(headers,'Docker-Content-Digest')
  if advertised and advertised!=actual:reject()
  if self.token and self.token.encode() in body:reject()
  return body,actual

def reference(ref):
 if not isinstance(ref,str) or len(ref)>256 or any(c in ref for c in '\r\n\x00'):reject()
 split=ref.split('@')
 if len(split)>2:reject()
 plain=split[0]
 if ':' not in plain:reject()
 repo,tag=plain.rsplit(':',1)
 if repo not in ALLOWED or tag not in ALLOWED[repo]:reject()
 expected=ALLOWED[repo][tag]
 if (split[1] if len(split)==2 else '')!=expected:reject()
 return repo.split('/',1)[1],tag,expected

def resolve(refs):
 if not isinstance(refs,list) or not refs or len(refs)>4 or len(set(refs))!=len(refs):reject()
 parsed=[reference(ref) for ref in refs]
 docs={};total=0;deadline=time.monotonic()+280
 def record(path,body):
  nonlocal total
  if path in docs:
   if base64.b64decode(docs[path]['body'])!=body:reject()
   return
  total+=len(body)
  if total>CORPUS_LIMIT or len(docs)>=12:reject()
  docs[path]={'host':'ghcr.io','path':path,'body':base64.b64encode(body).decode('ascii')}
 for repo,tag,pin in parsed:
  session=Session(repo,deadline)
  path='/v2/'+repo+'/manifests/'+(pin or tag)
  body,sha=session.fetch(path)
  if pin and sha!=pin:reject()
  record(path,body);doc=json.loads(body)
  if doc.get('mediaType') in ('application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json'):
   descriptors=doc.get('manifests')
   if not isinstance(descriptors,list) or not descriptors or len(descriptors)>1024:reject()
   selected=[m for m in descriptors if isinstance(m,dict) and (m.get('platform') or {}).get('os')=='linux' and (m.get('platform') or {}).get('architecture')=='amd64' and not (m.get('platform') or {}).get('variant')]
   if len(selected)!=1 or not DIGEST.fullmatch(selected[0].get('digest','')):reject()
   path='/v2/'+repo+'/manifests/'+selected[0]['digest']
   body,sha=session.fetch(path)
   if sha!=selected[0]['digest']:reject()
   record(path,body);doc=json.loads(body)
  config=(doc.get('config') or {}).get('digest','')
  if not DIGEST.fullmatch(config):reject()
  path='/v2/'+repo+'/blobs/'+config
  body,sha=session.fetch(path,False)
  if sha!=config:reject()
  record(path,body)
 return {'documents':list(docs.values())}

if __name__=='__main__':
 try:
  if len(sys.argv)!=2:reject()
  print(json.dumps(resolve(json.loads(sys.argv[1])),separators=(',',':')))
 except BaseException:
  sys.stderr.write('official_image_verification_failed\n');sys.exit(3)
