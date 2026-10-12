package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const storageFixture = `import os,sys,subprocess,json,types,stat,io,socket
os.path.exists=lambda p:False
socket.gethostname=lambda:"fixture-nas-host"
os.lstat=lambda p:types.SimpleNamespace(st_mode=stat.S_IFDIR)
os.stat=lambda p:types.SimpleNamespace(st_dev=5 if p.startswith('/tmp/zfsv3/') else 9,st_ino=77)
os.statvfs=lambda p:types.SimpleNamespace(f_bavail=10000000,f_frsize=4096,f_blocks=20000000)
os.access=lambda *args:True
def synthetic(args,**kwargs):
 if args[0]=='lsblk': return json.dumps({'blockdevices':[{'name':'mmcblk0','kname':'mmcblk0','path':'/dev/mmcblk0','type':'disk','rota':False,'children':[{'name':'mmcblk0p2','kname':'mmcblk0p2','path':'/dev/mmcblk0p2','type':'part','pkname':'mmcblk0'}]},{'name':'nvme0n1','kname':'nvme0n1','path':'/dev/nvme0n1','type':'disk','rota':False,'children':[{'name':'nvme0n1p4','kname':'nvme0n1p4','path':'/dev/nvme0n1p4','type':'part','pkname':'nvme0n1'}]}]})
 if args[0]=='docker': return json.dumps(sys.argv[2] if 'DockerRootDir' in args[-1] else {'DockerRootDir':sys.argv[2],'Driver':sys.argv[3] if len(sys.argv)>3 else 'overlay2','DriverStatus':[]})
 path=args[args.index('-T')+1] if '-T' in args else '/'
 m={'target':'/','source':'/dev/mmcblk0p2','fstype':'ext4','maj:min':'179:2'}
 if path.startswith('/data_n008/'):m={'target':'/data_n008','source':'/dev/nvme0n1p4','fstype':'xfs','maj:min':'259:4'}
 if path.startswith('/tmp/zfsv3/'):m={'target':'/tmp/zfsv3/nvme11','source':'kufs','fstype':'fuse.kufs','maj:min':'0:93'}
 return json.dumps({'filesystems':[m]})
subprocess.check_output=synthetic
`

func (f *fakeEngine) DiscoverStorage(context.Context) ([]StorageCandidate, error) {
	return []StorageCandidate{}, nil
}
func (f *fakeEngine) InspectStorage(_ context.Context, p string) (StorageCandidate, error) {
	fi, err := os.Stat(p)
	if err != nil {
		return StorageCandidate{}, err
	}
	id, err := fileIdentity(fi)
	return StorageCandidate{Path: p, MountPoint: p, Source: "/dev/synthetic-nvme", Filesystem: "synthetic", Identity: id, VolumeType: "ssd", FreeBytes: 1 << 40, TotalBytes: 2 << 40, InstallAllowed: true, MediaReadAllowed: true}, err
}
func (f *fakeEngine) DockerStorage(ctx context.Context) (StorageCandidate, error) {
	return StorageCandidate{Path: "/synthetic/docker", MountPoint: "/synthetic", Source: "/dev/synthetic-nvme", Identity: "synthetic-docker-device", VolumeType: "ssd", FreeBytes: 1 << 40, TotalBytes: 2 << 40, InstallAllowed: true}, nil
}

type unsafeCacheEngine struct{ *fakeEngine }
type readOnlyMediaEngine struct {
	*fakeEngine
	root string
}

func (e readOnlyMediaEngine) InspectStorage(ctx context.Context, p string) (StorageCandidate, error) {
	c, err := e.fakeEngine.InspectStorage(ctx, p)
	if p == e.root {
		c.InstallAllowed = false
		c.MediaReadAllowed = true
		c.VolumeType = "virtual"
		c.VerifiedDataPool = true
	}
	return c, err
}

func (e unsafeCacheEngine) DockerStorage(context.Context) (StorageCandidate, error) {
	return StorageCandidate{Path: "/var/lib/docker", Identity: "emmc", VolumeType: "unknown", SystemDisk: true}, nil
}
func TestDockerSystemCacheBlocksPlanBeforeAnyPull(t *testing.T) {
	r := newRig(t)
	r.setup()
	r.s.engine = unsafeCacheEngine{r.e}
	b, _ := json.Marshal(map[string]any{"appId": "uptime-kuma", "rootId": "storage", "directory": "blocked", "hostPort": 32123})
	status, out := r.call("POST", "/api/store/plans", string(b), "127.0.0.1:1")
	if status != 409 {
		t.Fatal(status, out)
	}
	if _, err := os.Stat(filepath.Join(r.root, "blocked")); !os.IsNotExist(err) {
		t.Fatal("unsafe cache plan wrote data")
	}
}
func TestStorageRegistrationSupportsMultipleRootsAndPinsSelectedRoot(t *testing.T) {
	r := newRig(t)
	r.setup()
	newRoot := filepath.Join(filepath.Dir(r.root), "second")
	os.Mkdir(newRoot, 0700)
	b, _ := json.Marshal(map[string]any{"path": newRoot, "name": "手选SSD"})
	status, out := r.call("POST", "/api/store/roots", string(b), "127.0.0.1:1")
	if status != 201 {
		t.Fatal(status, out)
	}
	id := out["data"].(map[string]any)["id"].(string)
	b, _ = json.Marshal(map[string]any{"appId": "uptime-kuma", "rootId": id, "directory": "selected", "hostPort": 32123})
	status, out = r.call("POST", "/api/store/plans", string(b), "127.0.0.1:1")
	if status != 201 {
		t.Fatal(status, out)
	}
	p := out["data"].(map[string]any)
	if p["rootPath"] != newRoot {
		t.Fatal(p)
	}
	job := r.install(p, "synthetic-selected-root")
	if final := r.waitJob(job["id"].(string)); final["status"] != "completed" {
		t.Fatal(final)
	}
	if _, err := os.Stat(filepath.Join(newRoot, "selected", ownershipMarker)); err != nil {
		t.Fatal("did not use selected root", err)
	}
	if _, err := os.Stat(filepath.Join(r.root, "selected")); !os.IsNotExist(err) {
		t.Fatal("used default root")
	}
}
func TestStorageEndpointsRequireAuth(t *testing.T) {
	r := newRig(t)
	for _, method := range []string{"GET", "POST"} {
		path := "/api/store/storage"
		if method == "POST" {
			path = "/api/store/roots"
		}
		status, _ := r.call(method, path, `{"path":"/tmp"}`, "127.0.0.1:1")
		if status != 401 {
			t.Fatal(status)
		}
	}
}

func TestReadOnlyMediaRootRegistersWithoutGrantingDataWrite(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := filepath.Join(filepath.Dir(r.root), "read-only-music")
	os.Mkdir(p, 0755)
	r.s.engine = readOnlyMediaEngine{r.e, p}
	b, _ := json.Marshal(map[string]any{"path": p, "name": "既有只读媒体"})
	status, out := r.call("POST", "/api/store/roots", string(b), "127.0.0.1:1")
	if status != 201 {
		t.Fatal(status, out)
	}
	root := out["data"].(map[string]any)
	roles := root["roles"].([]any)
	if len(roles) != 1 || roles[0] != "mediaReadOnly" {
		t.Fatal("read-only media granted data role", root)
	}
	b, _ = json.Marshal(map[string]any{"appId": "uptime-kuma", "rootId": root["id"], "directory": "forbidden-write", "hostPort": 32123})
	status, out = r.call("POST", "/api/store/plans", string(b), "127.0.0.1:1")
	if status != 409 {
		t.Fatal("read-only media root accepted as data", status, out)
	}
}

func TestActualKufsAncestorStackSelectsActiveMountAndKeepsReadOnlyMusic(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 unavailable")
	}
	overrides := `
original_synthetic=synthetic
def layered(args,**kwargs):
 if args[0]=='findmnt' and '-T' in args and args[args.index('-T')+1].startswith('/tmp/zfsv3'):
  return json.dumps({'filesystems':[{'target':'/tmp/zfsv3','source':'tmpfs','fstype':'tmpfs','maj:min':'0:121'},{'target':'/tmp/zfsv3','source':'zfsv3','fstype':'kufs','maj:min':'0:77'}]})
 return original_synthetic(args,**kwargs)
subprocess.check_output=layered
original_stat=os.stat
os.stat=lambda p:types.SimpleNamespace(st_dev=77 if p=='/tmp/zfsv3' else 124,st_ino=1 if p=='/tmp/zfsv3' else 13547736490065636406)
os.access=lambda p,mode:not (p.endswith('/music') and mode & os.W_OK)
`
	for _, path := range []string{"/tmp/zfsv3/nvme11/user/data/shop", "/tmp/zfsv3/sata14/public/music"} {
		out, err := exec.Command("python3", "-c", storageFixture+overrides+storageScript, "inspect", path).CombinedOutput()
		if err != nil {
			t.Fatal("real layered kufs pattern rejected", err, string(out))
		}
		var c StorageCandidate
		if err = json.Unmarshal(out, &c); err != nil {
			t.Fatal(err, string(out))
		}
		if !c.VerifiedDataPool || c.VolumeType != "virtual" || c.Source != "zfsv3" || !c.MediaReadAllowed || c.InstallAllowed == strings.HasSuffix(path, "/music") {
			t.Fatal(c)
		}
	}
}

func TestSystemApplicationDiskIsProtectedWhenRootIsOverlay(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 unavailable")
	}
	fixture := storageFixture + `
old_synthetic=synthetic
def system_overlay(args,**kwargs):
 if args[0]=='lsblk':
  data=json.loads(old_synthetic(args,**kwargs));data['blockdevices'].append({'name':'sda','kname':'sda','path':'/dev/sda','type':'disk','rota':True,'children':[{'name':'sda7','kname':'sda7','path':'/dev/sda7','type':'part','pkname':'sda'}]});return json.dumps(data)
 if args[0]=='findmnt':
  root={'target':'/','source':'overlay','fstype':'overlay','maj:min':'0:25'}
  logs={'target':'/zspace/applications/logs','source':'/dev/sda7','fstype':'ext4','maj:min':'8:7'}
  if '-T' not in args:return json.dumps({'filesystems':[root,logs]})
  p=args[args.index('-T')+1]
  return json.dumps({'filesystems':[logs if p.startswith('/zspace/') else root]})
 return old_synthetic(args,**kwargs)
subprocess.check_output=system_overlay
`
	out, err := exec.Command("python3", "-c", fixture+storageScript, "inspect", "/zspace/applications/logs").CombinedOutput()
	if err != nil {
		t.Fatal(err, string(out))
	}
	var c StorageCandidate
	if err = json.Unmarshal(out, &c); err != nil {
		t.Fatal(err)
	}
	if !c.SystemDisk || c.InstallAllowed || c.MediaReadAllowed {
		t.Fatal("NAS system/application partition exposed as data volume", c)
	}
}

func TestNativeAppDataBindMountDoesNotRelabelUserSSDAsSystemDisk(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 unavailable")
	}
	fixture := storageFixture + `
previous=synthetic
def app_data_bind(args,**kwargs):
 if args[0]=='findmnt' and '-T' not in args:
  return json.dumps({'filesystems':[{'target':'/','source':'/dev/mmcblk0p2','fstype':'ext4','maj:min':'179:2'},{'target':'/zspace/applications/user-app/data','source':'/dev/nvme0n1p4[/app-data]','fstype':'btrfs','maj:min':'259:4'},{'target':'/data_n008','source':'/dev/nvme0n1p4','fstype':'btrfs','maj:min':'259:4'}]})
 return previous(args,**kwargs)
subprocess.check_output=app_data_bind
`
	out, err := exec.Command("python3", "-c", fixture+storageScript, "inspect", "/data_n008/selected").CombinedOutput()
	if err != nil {
		t.Fatal(err, string(out))
	}
	var c StorageCandidate
	if err = json.Unmarshal(out, &c); err != nil {
		t.Fatal(err)
	}
	if c.SystemDisk || !c.InstallAllowed {
		t.Fatal("user SSD incorrectly treated as system because existing app uses bind mount", c)
	}
}

func TestMediaCanUseSeparateRegisteredRootAndRemainsReadOnly(t *testing.T) {
	r := newRig(t)
	r.setup()
	mediaRoot := filepath.Join(filepath.Dir(r.root), "media")
	os.Mkdir(mediaRoot, 0700)
	music := filepath.Join(mediaRoot, "library")
	os.Mkdir(music, 0700)
	os.WriteFile(filepath.Join(music, "keep.mp3"), []byte("unchanged"), 0600)
	b, _ := json.Marshal(map[string]any{"path": mediaRoot, "name": "媒体数据池"})
	status, out := r.call("POST", "/api/store/roots", string(b), "127.0.0.1:1")
	if status != 201 {
		t.Fatal(status, out)
	}
	mediaID := out["data"].(map[string]any)["id"]
	for index, selected := range []string{mediaRoot, music} {
		b, _ = json.Marshal(map[string]any{"appId": "navidrome", "rootId": "storage", "directory": fmt.Sprintf("separate-media-%d", index), "hostPort": 32123 + index, "mediaRootId": mediaID, "mediaPath": selected})
		status, out = r.call("POST", "/api/store/plans", string(b), "127.0.0.1:1")
		if status != 201 {
			t.Fatal("separate registered media root refused", status, out)
		}
		p := out["data"].(map[string]any)
		if p["mediaRootPath"] != mediaRoot {
			t.Fatal(p)
		}
		if selected == music {
			j := r.install(p, "synthetic-separate-media")
			if final := r.waitJob(j["id"].(string)); final["status"] != "completed" {
				t.Fatal(final)
			}
			for _, m := range r.e.runs[0].Mounts {
				if m.Target == "/music" && (!m.ReadOnly || m.Source != music) {
					t.Fatal(m)
				}
			}
		}
	}
	got, err := os.ReadFile(filepath.Join(music, "keep.mp3"))
	if err != nil || string(got) != "unchanged" {
		t.Fatal("changed existing music")
	}
}

func TestStorageScriptUsesBlockEvidenceAndProtectsSystemAndVirtualCache(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 unavailable for script fixture")
	}
	fixture := storageFixture
	cases := []struct {
		mode, path, volume    string
		allowed, system, pool bool
	}{{"inspect", "/data_n008/selected", "ssd", true, false, false}, {"inspect", "/tmp/system-data", "ssd", false, true, false}, {"inspect", "/tmp/zfsv3/nvme11/selected", "virtual", true, false, true}, {"docker", "/tmp/zfsv3/nvme11/zdocker", "virtual", true, false, true}, {"docker", "/data_n008/zdocker", "ssd", true, false, false}}
	for _, tc := range cases {
		t.Run(tc.mode+tc.path, func(t *testing.T) {
			cmd := exec.Command("python3", "-c", fixture+storageScript, tc.mode, tc.path)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatal(err, string(out))
			}
			var c StorageCandidate
			if err = json.Unmarshal(out, &c); err != nil {
				t.Fatal(err, string(out))
			}
			if c.VolumeType != tc.volume || c.InstallAllowed != tc.allowed || c.SystemDisk != tc.system || c.VerifiedDataPool != tc.pool {
				t.Fatal(c)
			}
			if tc.mode == "docker" && tc.volume == "virtual" && safeDockerStorage(c) {
				t.Fatal("virtual unknown medium adopted as Docker cache")
			}
		})
	}
	out, err := exec.Command("python3", "-c", fixture+storageScript, "docker", "/data_n008/zdocker", "overlayfs").CombinedOutput()
	if err != nil {
		t.Fatal(err, string(out))
	}
	var unknown StorageCandidate
	if err = json.Unmarshal(out, &unknown); err != nil {
		t.Fatal(err, string(out))
	}
	if unknown.InstallAllowed {
		t.Fatal("unverified independent containerd cache was allowed", unknown)
	}
	for _, script := range []string{remoteProbeScript, remotePathScript, remotePortScript, remoteHealthScript, remoteProvenanceScript, storageScript} {
		cmd := exec.Command("python3", "-c", "import ast,sys;ast.parse(sys.stdin.read())")
		cmd.Stdin = strings.NewReader(script)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatal("invalid Python script", err, string(out))
		}
	}
}
