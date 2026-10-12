#!/usr/bin/env python3
"""Update client web + proxy only; retain store gateway, data and old assets."""
import gzip, io, http.server, json, pathlib, shlex, socket, subprocess, tarfile, threading, time, uuid
root=pathlib.Path(__file__).resolve().parents[2]
release='client-review-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]
out=root/'.runtime'/release;out.mkdir(parents=True)
def run(args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def remote(command):
 result=run(['sshbind','exec','--json','--timeout','120','zspace',command],capture_output=True,text=True)
 data=json.loads(result.stdout)
 if data['exit_code']!=0:raise RuntimeError('Remote operation failed: '+str(data['exit_code']))
 return data['stdout'].strip()
q=shlex.quote
servers=json.loads(run(['sshbind','list','--json'],capture_output=True,text=True).stdout)['servers']
server=next(s for s in servers if s['name']=='zspace' and s['usable'])
web=root/'apps/client/dist';assert (web/'index.html').is_file(),'Build client first'
run(['go','build','-trimpath','-ldflags','-s -w','-o',str(out/'space-proxy'),'.'],cwd=root/'deploy/nas-appstore/proxy',env={**__import__('os').environ,'GOOS':'linux','GOARCH':'amd64','CGO_ENABLED':'0'})
archive=out/(release+'.tgz')
with tarfile.open(archive,'w:gz') as tar:
 tar.add(out/'space-proxy',arcname='space-proxy')
 tar.add(root/'deploy/nas-appstore/entrypoint.sh',arcname='entrypoint.sh')
 for path in web.rglob('*'):
  if path.is_symlink():raise RuntimeError('Symlink in build')
  if not path.is_file():continue
  name=path.relative_to(web).as_posix()
  if name=='store.html':name='shop.html'
  tar.add(path,arcname='web/'+name)
  if path.suffix in {'.html','.js','.css','.svg','.json','.webmanifest'}:
   packed=gzip.compress(path.read_bytes(),9,mtime=0);gz=tarfile.TarInfo('web/'+name+'.gz');gz.size=len(packed);tar.addfile(gz,io.BytesIO(packed))
 for path in (root/'apps/store/dist').rglob('*'):
  if not path.is_file():continue
  name=path.relative_to(root/'apps/store/dist').as_posix()
  if name=='index.html':continue
  if name=='store.html':name='complete-store.html'
  tar.add(path,arcname='web/'+name)
  if path.suffix in {'.html','.js','.css','.svg','.json'}:
   packed=gzip.compress(path.read_bytes(),9,mtime=0);gz=tarfile.TarInfo('web/'+name+'.gz');gz.size=len(packed);tar.addfile(gz,io.BytesIO(packed))
 # Same-origin config is explicit, and contains no credentials.
 import io
 payload=b'{"nasOrigin":""}\n';entry=tarfile.TarInfo('web/runtime-config.json');entry.size=len(payload);tar.addfile(entry,io.BytesIO(payload));packed=gzip.compress(payload,9,mtime=0);entry=tarfile.TarInfo('web/runtime-config.json.gz');entry.size=len(packed);tar.addfile(entry,io.BytesIO(packed))
if __import__('os').environ.get('SPACE_CLIENT_PREPARE_ONLY') == '1':
 import re,sys
 print(json.dumps({'release':release,'artifact':str(archive),'entry':re.search(r'assets/client-[A-Za-z0-9._-]+\.js',(web/'index.html').read_text()).group()}))
 sys.exit(0)
class ArtifactHandler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path!='/'+archive.name:self.send_error(404);return
  self.send_response(200);self.send_header('Content-Length',str(archive.stat().st_size));self.end_headers()
  with archive.open('rb') as stream:__import__('shutil').copyfileobj(stream,self.wfile)
 def log_message(self,*args):pass
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as route:
 route.connect((server['host'],22));local_ip=route.getsockname()[0]
http=http.server.ThreadingHTTPServer((local_ip,0),ArtifactHandler)
thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
try:
 remote_archive='/home/'+server['user']+'/'+archive.name
 remote('set -e; wget -q '+q('http://'+local_ip+':'+str(http.server_port)+'/'+archive.name)+' -O '+q(remote_archive))
 # Persist new build sources for future compose rebuilds. Existing gateway and
 # config are outside this allowlist. The one-shot helper is retained stopped.
 host='/tmp/zfsv3/nvme16/18181998187/data/docker/appstore'
 image=remote("docker inspect space-desktop --format '{{.Config.Image}}'")
 assert image and '\n' not in image and not image.startswith('-')
 source_update='set -e; mkdir -p /host/client-releases/'+release+'; tar xzf /in/'+archive.name+' -C /host/client-releases/'+release+'; mkdir -p /host/client-backups/'+release+'; cp /host/space-proxy /host/client-backups/'+release+'/space-proxy; cp -R /host/web /host/client-backups/'+release+'/web; cp /host/entrypoint.sh /host/client-backups/'+release+'/entrypoint.sh; cp /host/client-releases/'+release+'/entrypoint.sh /host/entrypoint.sh; cp /host/client-releases/'+release+'/space-proxy /host/space-proxy; cp -R /host/client-releases/'+release+'/web/. /host/web/; echo SOURCES_UPDATED'
 remote('docker run --name '+q(release+'-sources')+' --privileged --user 0:0 --entrypoint sh -v '+q(host+':/host')+' -v '+q('/home/'+server['user']+':/in:ro')+' '+q(image)+' -c '+q(source_update))
 remote('docker cp '+q(remote_archive)+' space-desktop:/tmp/'+archive.name)
 update='set -e; mkdir -p /data/client-review-backups/'+release+'; cp /usr/local/bin/space-proxy /data/client-review-backups/'+release+'/space-proxy; cp -R /web /data/client-review-backups/'+release+'/web; mkdir -p /tmp/'+release+'; tar xzf /tmp/'+archive.name+' -C /tmp/'+release+'; cp -R /tmp/'+release+'/web/. /web/; cp /usr/local/bin/entrypoint.sh /data/client-review-backups/'+release+'/entrypoint.sh; cp /tmp/'+release+'/entrypoint.sh /usr/local/bin/entrypoint.sh; chmod 755 /usr/local/bin/entrypoint.sh; cp /tmp/'+release+'/space-proxy /usr/local/bin/space-proxy.new; chmod 755 /usr/local/bin/space-proxy.new; mv /usr/local/bin/space-proxy.new /usr/local/bin/space-proxy; echo CLIENT_UPDATED'
 remote('docker exec space-desktop sh -c '+q(update))
 endpoint=__import__('os').environ.get('SPACE_STORE_ENDPOINT','')
 if endpoint:
  from urllib.parse import urlparse
  parsed=urlparse(endpoint)
  assert parsed.scheme in ('http','https') and parsed.hostname and not parsed.username and not parsed.password and parsed.path in ('','/') and not parsed.query and not parsed.fragment
  config='set -e; if [ -f /data/client-store-endpoint ]; then cp /data/client-store-endpoint /data/client-review-backups/'+release+'/client-store-endpoint; fi; printf %s '+q(endpoint)+' > /data/client-store-endpoint; chmod 600 /data/client-store-endpoint'
  remote('docker exec space-desktop sh -c '+q(config))
 remote('docker restart space-desktop')
 import urllib.request, re
 expected=re.search(r'assets/client-[A-Za-z0-9._-]+\.js',(web/'index.html').read_text()).group()
 base='http://'+server['host']+':18436'
 for attempt in range(20):
  try:
   with urllib.request.urlopen(base+'/healthz',timeout=3) as response:assert response.read().strip()==b'ok'
   with urllib.request.urlopen(urllib.request.Request(base+'/',headers={'Accept-Encoding':'gzip'}),timeout=3) as response:
    content=response.read();content=gzip.decompress(content) if response.headers.get('Content-Encoding')=='gzip' else content;actual=re.search(r'assets/client-[A-Za-z0-9._-]+\.js',content.decode()).group()
   if actual==expected:break
  except Exception:pass
  time.sleep(1)
 else:raise RuntimeError('Health/build identity failed; backups retained')
 print(json.dumps({'release':release,'url':base,'entry':expected,'backup':'/data/client-review-backups/'+release,'sourceBackup':host+'/client-backups/'+release,'storeGateway':'preserved'},ensure_ascii=False))
finally:http.shutdown();http.server_close()
