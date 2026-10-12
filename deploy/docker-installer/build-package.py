#!/usr/bin/env python3
"""Build public Linux amd64 Docker contexts. No runtime metadata is packaged."""
import gzip,hashlib,io,json,os,pathlib,shutil,subprocess,tarfile
repo=pathlib.Path(__file__).resolve().parents[2]
release='docker-2026.10.12-r1'
out=repo/'.runtime'/release
out.mkdir(parents=True,exist_ok=True)
env=dict(os.environ,GOOS='linux',GOARCH='amd64',CGO_ENABLED='0')
def run(argv,cwd):subprocess.run(argv,cwd=cwd,env=env,check=True)
run(['pnpm','--filter','@space/client','build'],repo)
run(['pnpm','--filter','@space/store','build'],repo)
store=out/'store';client=out/'client'
for directory in (store,client):directory.mkdir(exist_ok=True)
run(['go','build','-trimpath','-o',str(store/'space-store'),'./cmd/space-gateway'],repo/'server')
run(['go','build','-trimpath','-o',str(client/'space-proxy'),'.'],repo/'deploy/nas-appstore/proxy')
shutil.copyfile(store/'space-store',client/'space-gateway')
docker=pathlib.Path(os.environ.get('SPACE_DOCKER_CLI','/var/folders/7b/1wvm3hr10jl3hj9_ww_4k4v40000gn/T/space-store-container-release-6ruvpaoz/docker'))
if docker.read_bytes()[:4]!=b'\x7fELF':raise SystemExit('A verified Linux Docker CLI is required')
shutil.copyfile(docker,store/'docker')
compose=repo/'.runtime/docker-tools/docker-compose'
if hashlib.sha256(compose.read_bytes()).hexdigest()!='ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b':raise SystemExit('Compose checksum differs')
shutil.copyfile(compose,store/'docker-compose')
shutil.copyfile(repo/'docker/store/Dockerfile',store/'Dockerfile')
shutil.copyfile(repo/'deploy/nas-appstore/Dockerfile',client/'Dockerfile')
shutil.copyfile(repo/'deploy/nas-appstore/entrypoint.sh',client/'entrypoint.sh')
shutil.copytree(repo/'apps/store/dist',store/'web',dirs_exist_ok=True)
shutil.copytree(repo/'apps/client/dist',client/'web',dirs_exist_ok=True)
for path in (repo/'apps/store/dist').rglob('*'):
 if not path.is_file():continue
 rel=path.relative_to(repo/'apps/store/dist')
 if str(rel)=='index.html':continue
 if str(rel)=='store.html':rel=pathlib.Path('complete-store.html')
 target=client/'web'/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
(client/'web/runtime-config.json').write_text('{"nasOrigin":""}\n')
for root in (store/'web',client/'web'):
 for path in root.rglob('*'):
  if path.is_file() and path.suffix in ('.js','.css','.html','.svg','.json'):
   path.with_name(path.name+'.gz').write_bytes(gzip.compress(path.read_bytes(),9,mtime=0))
notices='''Space Store / Space Desktop deployment package
Docker CLI 27.3.1 and Docker Compose 2.32.4: Apache-2.0, official Docker publishers.
Python runtime image: Astral uv Python3.13-bookworm-slim pinned in store/Dockerfile.
Applications are installed separately; no NAS files, accounts, sessions or credentials are included.
Source project: https://github.com/isle24/nas-app-store-catalog
'''
(out/'THIRD-PARTY-NOTICES.txt').write_text(notices)
for name in ('LICENSE-compose','LICENSE-docker-cli'):
 shutil.copyfile(repo/'.runtime/docker-tools'/name,out/name)
images=out/'images';images.mkdir(exist_ok=True)
image_ids={}
for kind,name,directory in [('store','space-store',store),('client','space-desktop',client)]:
 tag=name+':'+release
 run(['docker','build','--platform','linux/amd64','-t',tag,str(directory)],repo)
 identity=json.loads(subprocess.check_output(['docker','image','inspect',tag],text=True))[0]
 if identity['Architecture']!='amd64' or identity['Os']!='linux':raise SystemExit('Image architecture differs')
 image_ids[kind]=identity['Id']
 raw=images/(kind+'.tar')
 with raw.open('wb') as handle:subprocess.run(['docker','image','save',tag],stdout=handle,check=True)
 with raw.open('rb') as source,(images/(kind+'.tar.gz')).open('wb') as target:
  with gzip.GzipFile(fileobj=target,mode='wb',mtime=0) as zipped:shutil.copyfileobj(source,zipped)
artifact=out/'space-store-linux-amd64.tgz'
with artifact.open('wb') as raw:
 with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as zipped:
  with tarfile.open(fileobj=zipped,mode='w') as tar:
   for root in (images,):
    for path in sorted(root.rglob('*')):
     if not path.is_file() or path.suffix!='.gz':continue
     if path.is_symlink():raise SystemExit('Package symlink rejected')
     info=tar.gettarinfo(str(path),arcname=str(path.relative_to(out)));info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0
     info.mode=0o555 if path.name in ('space-store','space-proxy','space-gateway','docker','docker-compose','entrypoint.sh') else 0o444
     with path.open('rb') as handle:tar.addfile(info,handle)
   for name in ('THIRD-PARTY-NOTICES.txt','LICENSE-compose','LICENSE-docker-cli'):
    path=out/name;info=tar.gettarinfo(str(path),arcname=path.name);info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0
    with path.open('rb') as handle:tar.addfile(info,handle)
checksum=hashlib.sha256(artifact.read_bytes()).hexdigest()
(out/'SHA256SUMS').write_text(checksum+'  '+artifact.name+'\n')
installer=(repo/'deploy/docker-installer/install-docker.sh').read_text().replace('BUILD_ARTIFACT_SHA256',checksum)
installer=installer.replace('BUILD_STORE_IMAGE_ID',image_ids['store']).replace('BUILD_CLIENT_IMAGE_ID',image_ids['client'])
(out/'install-docker.sh').write_text(installer)
print(json.dumps({'artifact':str(artifact),'sha256':checksum,'release':release,'images':image_ids}))
