package store

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"testing"
)

// Separate host/container views; no Docker or NAS is contacted.
const hostMetadataFixture = storageFixture + `
import socket,hashlib,copy
metadata='/data_n008/store-release/metadata'
data='/data_n008/selected'
cache='/data_n008/zdocker'
deployment=hashlib.sha256('/data_n008/store-release'.encode()).hexdigest()[:24]
release='QA-20261011'
self_id='abcdef123456'+'0'*52
image_id='sha256:'+'a'*64
os.environ['HOSTNAME']=self_id[:12]
socket.gethostname=lambda:self_id[:12]
os.major=lambda dev:dev>>8
os.minor=lambda dev:dev&255
os.getuid=lambda:1000
os.getgid=lambda:1000
os.getgroups=lambda:[1000,999]
os.path.exists=lambda p:p=='/.dockerenv'
os.lstat=lambda p:types.SimpleNamespace(st_mode=stat.S_IFSOCK if p=='/var/run/docker.sock' else stat.S_IFREG if p=='/run/space-store-host/mountinfo' else stat.S_IFDIR)
os.stat=lambda p:types.SimpleNamespace(st_dev=259<<8|4,st_ino=77,st_gid=999)
labels={'io.space-store.service':'space-store','io.space-store.deployment':deployment,'io.space-store.release':release,'io.space-store.host-metadata':'v1'}
def bind(source,destination=None,rw=False):return {'Type':'bind','Source':source,'Destination':destination or source,'RW':rw,'Propagation':'rprivate'}
actual={'Id':self_id,'Image':image_id,'Name':'/space-store-'+deployment+'-'+release.lower(),'Config':{'Hostname':self_id[:12],'User':'1000:1000','Labels':labels,'Entrypoint':['/opt/space-store/space-store'],'Cmd':['--data-dir',metadata,'--engine','local','--storage-root',data],'Env':['SECRET=inspect-secret-sentinel']},'HostConfig':{'Privileged':False,'ReadonlyRootfs':True,'NetworkMode':'bridge','CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],'Tmpfs':{'/tmp':'rw,noexec,nosuid,size=32m'},'GroupAdd':['999']},'Mounts':[bind(metadata,rw=True),bind(data,rw=True),bind('/proc/1/mountinfo','/run/space-store-host/mountinfo'),bind('/var/run/docker.sock',rw=True),dict(bind(cache),Propagation='rslave'),bind('/sys'),bind('/proc/1/net','/run/space-store-host/net')]}
receipt={'schema':1,'service':'space-store','deployment':deployment,'release':release,'containerId':self_id,'imageId':image_id}
receipt_stat=types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=1000,st_size=1024)
original_open=os.open
def receipt_open(p,flags,*args,**kwargs):
 if p==metadata+'/.space-store-container-self.json':
  assert flags&os.O_NOFOLLOW
  return 99
 return original_open(p,flags,*args,**kwargs)
os.open=receipt_open
os.fstat=lambda fd:receipt_stat
class ReceiptStream(io.StringIO):
 def fileno(self):return 99
os.fdopen=lambda fd,*args,**kwargs:ReceiptStream(json.dumps(receipt))
old_synthetic=synthetic
host_findmnt_calls=[]
def container_fixture(args,**kwargs):
 if args[0]=='docker':
  if 'inspect' in args:return json.dumps([actual])
  return json.dumps({'DockerRootDir':cache,'Driver':'overlay2','DriverStatus':[]})
 if args[0]=='findmnt':
  host='--tab-file' in args
  if host:
   assert args[args.index('--tab-file')+1]=='/run/space-store-host/mountinfo' and '--kernel' in args
   host_findmnt_calls.append(args)
  path=args[args.index('-T')+1] if '-T' in args else '/'
  root={'target':'/','source':'/dev/mmcblk0p2' if host else 'overlay','fstype':'ext4' if host else 'overlay','maj:min':'179:2' if host else '0:25'}
  disk={'target':'/data_n008' if host else data,'source':'/dev/nvme0n1p4' if host else '/dev/nvme0n1p4[/selected]','fstype':'xfs','maj:min':'259:4'}
  if '-T' not in args:return json.dumps({'filesystems':[root,disk]})
  return json.dumps({'filesystems':[disk if path.startswith('/data_n008') else root]})
 return old_synthetic(args,**kwargs)
subprocess.check_output=container_fixture
`

func runHostStorageFixture(t *testing.T, mutation, mode, path string) ([]byte, error) {
	t.Helper()
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 unavailable")
	}
	return exec.Command("python3", "-c", hostMetadataFixture+mutation+storageScript, mode, path).CombinedOutput()
}

func TestOwnContainerStorageUsesAttestedHostMountIdentity(t *testing.T) {
	for _, mode := range []string{"inspect", "docker"} {
		out, err := runHostStorageFixture(t, "", mode, "/data_n008/selected")
		if err != nil {
			t.Fatal(err, string(out))
		}
		var c StorageCandidate
		if err = json.Unmarshal(out, &c); err != nil {
			t.Fatal(err, string(out))
		}
		expected := fmt.Sprintf("%d:77|259:4|/dev/nvme0n1p4|/data_n008", 259<<8|4)
		if !c.InstallAllowed || c.SystemDisk || c.Identity != expected {
			t.Fatalf("host identity not retained: %+v expected %s", c, expected)
		}
		if strings.Contains(string(out), "inspect-secret-sentinel") {
			t.Fatal("self inspect leaked environment")
		}
	}
}

func TestOwnContainerStorageRejectsUnattestedEvidence(t *testing.T) {
	cases := map[string]string{
		"forged hostname":       "os.environ['HOSTNAME']='fedcba654321'\n",
		"foreign self":          "actual['Id']='f'*64\n",
		"configured hostname":   "actual['Config']['Hostname']='foreign'\n",
		"service label":         "labels['io.space-store.service']='foreign'\n",
		"deployment label":      "labels['io.space-store.deployment']='f'*24\n",
		"release label":         "labels['io.space-store.release']='foreign'\n",
		"version label":         "labels['io.space-store.host-metadata']='v2'\n",
		"metadata writable":     "actual['Mounts'][2]['RW']=True\n",
		"metadata source":       "actual['Mounts'][2]['Source']='/tmp/forged-mountinfo'\n",
		"metadata destination":  "actual['Mounts'][2]['Destination']='/tmp/forged-mountinfo'\n",
		"privileged":            "actual['HostConfig']['Privileged']=True\n",
		"writable root":         "actual['HostConfig']['ReadonlyRootfs']=False\n",
		"host network":          "actual['HostConfig']['NetworkMode']='host'\n",
		"host pid":              "actual['HostConfig']['PidMode']='host'\n",
		"shared uts":            "actual['HostConfig']['UTSMode']='container:foreign'\n",
		"capabilities":          "actual['HostConfig']['CapAdd']=['SYS_ADMIN']\n",
		"root user":             "actual['Config']['User']='0:0'\n",
		"extra rw":              "actual['Mounts'].append(bind('/data_n008/unrelated',rw=True))\n",
		"translated data":       "actual['Mounts'][1]['Destination']='/data'\n",
		"writable cache":        "actual['Mounts'][4]['RW']=True\n",
		"device mismatch":       "os.stat=lambda p:types.SimpleNamespace(st_dev=8<<8|7,st_ino=77,st_gid=999)\n",
		"receipt foreign self":  "receipt['containerId']='f'*64\n",
		"receipt foreign image": "receipt['imageId']='sha256:'+'b'*64\n",
		"receipt public":        "receipt_stat.st_mode=stat.S_IFREG|0o644\n",
		"receipt wrong owner":   "receipt_stat.st_uid=0\n",
		"receipt not regular":   "receipt_stat.st_mode=stat.S_IFDIR|0o600\n",
	}
	for name, mutation := range cases {
		t.Run(name, func(t *testing.T) {
			out, err := runHostStorageFixture(t, mutation, "inspect", "/data_n008/selected")
			if err == nil {
				t.Fatal("unattested storage accepted", string(out))
			}
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 3 || len(out) != 0 {
				t.Fatal("attestation failure exposed output or wrong category", err, string(out))
			}
			if strings.Contains(string(out), "inspect-secret-sentinel") {
				t.Fatal("self inspect leaked secret", string(out))
			}
		})
	}
}

func TestOwnContainerStoragePreservesHostSystemDiskProtection(t *testing.T) {
	mutation := `previous_container=container_fixture
def system_backing(args,**kwargs):
 value=previous_container(args,**kwargs)
 if args[0]=='findmnt' and '--tab-file' in args:
  value=json.loads(value)
  for m in value['filesystems']:
   if m['target']=='/':m.update({'source':'/dev/nvme0n1p4','maj:min':'259:4'})
  return json.dumps(value)
 return value
subprocess.check_output=system_backing
`
	out, err := runHostStorageFixture(t, mutation, "docker", "")
	if err != nil {
		t.Fatal(err, string(out))
	}
	var c StorageCandidate
	if err = json.Unmarshal(out, &c); err != nil {
		t.Fatal(err, string(out))
	}
	if !c.SystemDisk || c.InstallAllowed {
		t.Fatal("real host system disk exposed as cache", c)
	}
}

func TestOwnContainerStorageDiscoveryOnlyReturnsSelectedHostDirectory(t *testing.T) {
	out, err := runHostStorageFixture(t, "", "discover", "")
	if err != nil {
		t.Fatal(err, string(out))
	}
	var rows []StorageCandidate
	if err = json.Unmarshal(out, &rows); err != nil {
		t.Fatal(err, string(out))
	}
	if len(rows) != 1 || rows[0].Path != "/data_n008/selected" || rows[0].MountPoint != "/data_n008" || !rows[0].InstallAllowed {
		t.Fatal("selected bind missing from host discovery", string(out))
	}
}

func TestOwnContainerStorageRejectsMissingPhysicalHostSystemEvidence(t *testing.T) {
	mutation := `previous_container=container_fixture
def no_system_device(args,**kwargs):
 value=previous_container(args,**kwargs)
 if args[0]=='lsblk':
  value=json.loads(value);value['blockdevices']=[b for b in value['blockdevices'] if b['name']!='mmcblk0'];return json.dumps(value)
 return value
subprocess.check_output=no_system_device
`
	out, err := runHostStorageFixture(t, mutation, "docker", "")
	if err == nil {
		t.Fatal("cache accepted without host system disk evidence", string(out))
	}
}
