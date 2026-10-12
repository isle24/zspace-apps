# Embedded into every storage probe, including legacy and runtime subprocesses.
# Inspection results stay in process memory. Failures expose no Docker output.
import hashlib,socket,stat,ipaddress,selectors,time

HOST_MOUNTINFO='/run/space-store-host/mountinfo'
HOST_NETWORK='/run/space-store-host/net'
DOCKER_SOCKET='/var/run/docker.sock'

def metadata_command(args):
 return subprocess.check_output(['docker','--host','unix://'+DOCKER_SOCKET]+args,text=True,stderr=subprocess.DEVNULL,timeout=10)

def canonical_dedicated(path):
 if not isinstance(path,str) or not path.startswith('/') or path=='/' or os.path.normpath(path)!=path or re.search(r'[\x00-\x20\x7f,]',path): raise ValueError('host_storage_unverified')
 if re.match(r'^/(root|home|boot|zspace|usr|etc|bin|sbin|var|opt|run|proc|sys|dev)(/|$)',path): raise ValueError('host_storage_unverified')
 return path

def own_storage_policy():
 hostname=socket.gethostname()
 container=os.path.exists('/.dockerenv') or os.path.exists('/run/.containerenv') or bool(re.fullmatch(r'[0-9a-f]{12}',hostname))
 if not container: return None
 if not re.fullmatch(r'[0-9a-f]{12}',hostname) or os.environ.get('HOSTNAME')!=hostname: raise ValueError('host_storage_unverified')
 if not stat.S_ISSOCK(os.lstat(DOCKER_SOCKET).st_mode): raise ValueError('host_storage_unverified')
 rows=json.loads(metadata_command(['inspect','--type','container',hostname]))
 if not isinstance(rows,list) or len(rows)!=1: raise ValueError('host_storage_unverified')
 actual=rows[0];config=actual.get('Config',{});host=actual.get('HostConfig',{});labels=config.get('Labels',{})
 cid=actual.get('Id','');image=actual.get('Image','')
 if not re.fullmatch(r'[0-9a-f]{64}',cid) or not cid.startswith(hostname) or not re.fullmatch(r'sha256:[0-9a-f]{64}',image) or config.get('Hostname')!=hostname: raise ValueError('host_storage_unverified')
 if config.get('Entrypoint')!=['/opt/space-store/space-store']: raise ValueError('host_storage_unverified')
 args=config.get('Cmd',[]);options={};i=0
 # Parse canonical helper-generated flag/value pairs, rejecting duplicates.
 while i<len(args):
  if args[i]=='--nas-admin-only' and args[i] not in options: options[args[i]]='1';i+=1;continue
  if not isinstance(args[i],str) or not args[i].startswith('--') or i+1>=len(args) or args[i] in options or not isinstance(args[i+1],str): raise ValueError('host_storage_unverified')
  options[args[i]]=args[i+1];i+=2
 metadata=canonical_dedicated(options.get('--data-dir',''));data=canonical_dedicated(options.get('--storage-root',''))
 deployroot=os.path.dirname(metadata)
 if os.path.basename(metadata)!='metadata' or options.get('--engine')!='local' or metadata==data or metadata.startswith(data+'/') or data.startswith(metadata+'/'): raise ValueError('host_storage_unverified')
 deployment=hashlib.sha256(deployroot.encode()).hexdigest()[:24];release=labels.get('io.space-store.release','')
 if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}',release): raise ValueError('host_storage_unverified')
 required={'io.space-store.service':'space-store','io.space-store.deployment':deployment,'io.space-store.release':release,'io.space-store.host-metadata':'v1'}
 if any(labels.get(k)!=v for k,v in required.items()) or actual.get('Name')!='/space-store-'+deployment+'-'+release.lower(): raise ValueError('host_storage_unverified')
 if os.getuid()<=0 or os.getgid()<=0 or config.get('User')!=str(os.getuid())+':'+str(os.getgid()): raise ValueError('host_storage_unverified')
 if host.get('Privileged') is not False or host.get('ReadonlyRootfs') is not True or host.get('NetworkMode')!='bridge' or host.get('CapDrop')!=['ALL'] or host.get('SecurityOpt') not in (['no-new-privileges'],['no-new-privileges:true']): raise ValueError('host_storage_unverified')
 for key in ('CapAdd','Devices','DeviceRequests','Binds','VolumesFrom'):
  if host.get(key): raise ValueError('host_storage_unverified')
 for key in ('PidMode','UTSMode','CgroupnsMode'):
  if host.get(key,'') not in ('','private'): raise ValueError('host_storage_unverified')
 if host.get('IpcMode','') not in ('','private'): raise ValueError('host_storage_unverified')
 if host.get('Tmpfs')!={'/tmp':'rw,noexec,nosuid,size=32m'}: raise ValueError('host_storage_unverified')
 socket_gid=os.stat(DOCKER_SOCKET).st_gid
 if socket_gid not in [os.getgid()]+os.getgroups() or host.get('GroupAdd',[]) not in ([],[str(socket_gid)]): raise ValueError('host_storage_unverified')
 info=json.loads(metadata_command(['info','--format','{{json .}}']))
 cache=canonical_dedicated(info.get('DockerRootDir',''))
 expected={(metadata,metadata,True),(data,data,True),('/proc/1/mountinfo',HOST_MOUNTINFO,False),(DOCKER_SOCKET,DOCKER_SOCKET,True),(cache,cache,False),('/sys','/sys',False),('/proc/1/net',HOST_NETWORK,False)}
 mounts=actual.get('Mounts',[]);found=set()
 for mount in mounts:
  key=(mount.get('Source'),mount.get('Destination'),mount.get('RW'))
  if mount.get('Type')!='bind' or mount.get('Propagation','rprivate')!=('rslave' if mount.get('Source')==cache and mount.get('RW') is False else 'rprivate') or key in found: raise ValueError('host_storage_unverified')
  if key not in expected and key!=('/run/udev','/run/udev',False): raise ValueError('host_storage_unverified')
  found.add(key)
 if not expected.issubset(found) or len(expected)!=7: raise ValueError('host_storage_unverified')
 if not stat.S_ISDIR(os.lstat(HOST_NETWORK).st_mode): raise ValueError('host_storage_unverified')
 if not stat.S_ISREG(os.lstat(HOST_MOUNTINFO).st_mode): raise ValueError('host_storage_unverified')
 # Deployment writes the immutable self receipt after create, before start.
 fd=os.open(metadata+'/.space-store-container-self.json',os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'r') as source:
  entry=os.fstat(source.fileno())
  if not stat.S_ISREG(entry.st_mode) or stat.S_IMODE(entry.st_mode)!=0o600 or entry.st_uid!=os.getuid() or entry.st_size>4096: raise ValueError('host_storage_unverified')
  body=source.read(4097)
  if len(body)>4096: raise ValueError('host_storage_unverified')
  receipt=json.loads(body)
 expected_receipt={'schema':1,'service':'space-store','deployment':deployment,'release':release,'containerId':cid,'imageId':image}
 if receipt!=expected_receipt: raise ValueError('host_storage_unverified')
 return {'network':HOST_NETWORK,'findmnt':['--kernel','--tab-file',HOST_MOUNTINFO],'docker':['--host','unix://'+DOCKER_SOCKET],'data':data,'cache':cache,'metadata':metadata}


def host_network_table(name):
 # Open each fixed ancestor and leaf without following symlinks. Proc files
 # report size zero, so enforce a read limit instead of trusting st_size.
 if name not in ('tcp','tcp6','udp','udp6'): raise ValueError('host_network_unverified')
 directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in ('run','space-store-host','net'):
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
   os.close(directory);directory=child
  fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
  try:
   if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('host_network_unverified')
   source=os.fdopen(fd,'r',encoding='ascii',errors='strict');fd=None
   with source: body=source.read(1048577)
  finally:
   if fd is not None: os.close(fd)
 finally: os.close(directory)
 if len(body)>1048576: raise ValueError('host_network_unverified')
 lines=body.splitlines()
 if not lines or len(lines)>16384: raise ValueError('host_network_unverified')
 columns=lines[0].split()
 if len(columns)<12 or columns[0:2]!=['sl','local_address'] or columns[2] not in ('rem_address','remote_address') or columns[3:12]!=['st','tx_queue','rx_queue','tr','tm->when','retrnsmt','uid','timeout','inode']: raise ValueError('host_network_unverified')
 ports=set();width=32 if name.endswith('6') else 8
 for line in lines[1:]:
  fields=line.split()
  if len(fields)<10 or not re.fullmatch(r'[0-9]+:',fields[0]): raise ValueError('host_network_unverified')
  for address in fields[1:3]:
   if not re.fullmatch(r'[0-9A-Fa-f]{'+str(width)+r'}:[0-9A-Fa-f]{4}',address): raise ValueError('host_network_unverified')
  if not re.fullmatch(r'[0-9A-Fa-f]{2}',fields[3]) or not re.fullmatch(r'[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}',fields[4]) or not re.fullmatch(r'[0-9A-Fa-f]{2}:[0-9A-Fa-f]{8}',fields[5]) or not re.fullmatch(r'[0-9A-Fa-f]{8}',fields[6]): raise ValueError('host_network_unverified')
  if any(not re.fullmatch(r'[0-9]+',v) for v in fields[7:10]) or any(not re.fullmatch(r'-?[0-9A-Fa-f]+',v) for v in fields[10:]): raise ValueError('host_network_unverified')
  port=int(fields[1].rsplit(':',1)[1],16)
  if port: ports.add(port)
 return ports

def host_port_available(port,protocol='tcp',publishHost='127.0.0.1'):
 if not isinstance(globals().get('host_policy'),dict) or host_policy.get('network')!=HOST_NETWORK: raise ValueError('host_network_unverified')
 if isinstance(port,bool) or not isinstance(port,int) or not 1024<=port<=65535 or port==5055 or protocol not in ('tcp','udp'): raise ValueError('host_network_unverified')
 if not isinstance(publishHost,str) or str(ipaddress.ip_address(publishHost))!=publishHost: raise ValueError('host_network_unverified')
 # Validate every family even if a conflict is already known. All bound local
 # ports in the requested protocol are conservative conflicts, across addresses.
 tables={name:host_network_table(name) for name in ('tcp','tcp6','udp','udp6')}
 occupied=port in tables[protocol] or port in tables[protocol+'6']
 out=bounded_metadata_command(['docker','--host','unix://'+DOCKER_SOCKET,'container','ls','--format','{{json .Ports}}'])
 if len(out)>1048576 or len(out.splitlines())>16384: raise ValueError('host_network_unverified')
 def interval(value):
  if not re.fullmatch(r'[0-9]{1,5}(?:-[0-9]{1,5})?',value): raise ValueError('host_network_unverified')
  limits=[int(x) for x in value.split('-')]
  if len(limits)==1: limits.append(limits[0])
  if not 1<=limits[0]<=limits[1]<=65535: raise ValueError('host_network_unverified')
  return limits
 for line in out.splitlines():
  published=json.loads(line)
  if not isinstance(published,str): raise ValueError('host_network_unverified')
  for mapping in published.split(',') if published else []:
   mapping=mapping.strip();parts=mapping.rsplit('/',1)
   if len(parts)!=2 or parts[1] not in ('tcp','udp','sctp'): raise ValueError('host_network_unverified')
   route,kind=parts
   if '->' not in route: interval(route);continue
   bindings=route.split('->')
   if len(bindings)!=2: raise ValueError('host_network_unverified')
   interval(bindings[1]);address,separator,number=bindings[0].rpartition(':')
   if not separator: raise ValueError('host_network_unverified')
   ipaddress.ip_address(address.strip('[]'))
   low,high=interval(number)
   if kind==protocol and low<=port<=high: occupied=True
 return not occupied


def bounded_metadata_command(args):
 # Docker ps also has a hard output budget: do not collect an unlimited daemon
 # response before deciding that it exceeds the evidence limit.
 process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 deadline=time.monotonic()+10;parts=[];size=0
 try:
  with selectors.DefaultSelector() as ready:
   ready.register(process.stdout,selectors.EVENT_READ)
   while True:
    remaining=deadline-time.monotonic()
    if remaining<=0 or not ready.select(remaining): raise ValueError('host_network_unverified')
    chunk=os.read(process.stdout.fileno(),min(65536,1048577-size))
    if not chunk: break
    size+=len(chunk)
    if size>1048576: raise ValueError('host_network_unverified')
    parts.append(chunk)
  if process.wait(timeout=max(0.001,deadline-time.monotonic()))!=0: raise ValueError('host_network_unverified')
  return b''.join(parts).decode('utf-8','strict')
 finally:
  if process.poll() is None:
   process.kill();process.wait(timeout=2)
  process.stdout.close()
