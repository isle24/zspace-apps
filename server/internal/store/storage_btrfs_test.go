package store

import (
	"encoding/json"
	"os/exec"
	"testing"
)

const btrfsHostFixture = hostMetadataFixture + `
os.stat=lambda p:types.SimpleNamespace(st_dev=73,st_ino=77,st_gid=999)
namespace_source='/dev/nvme0n1p4'
namespace_major='0:72'
namespace_type='btrfs'
namespace_target=None
namespace_duplicate=False
namespace_fsroot=None
host_fsroot='/'
old_container_fixture=container_fixture
def btrfs_fixture(args,**kwargs):
 raw=old_container_fixture(args,**kwargs)
 if args[0]!='findmnt':return raw
 body=json.loads(raw)
 for item in body['filesystems']:
  if item['source'].startswith('/dev/nvme0n1p4'):
   item['fstype']='btrfs';item['maj:min']='0:72';item['fsroot']=host_fsroot
   if '--tab-file' not in args:
    path=args[args.index('-T')+1]
    item['target']=namespace_target or path
    item['fsroot']=namespace_fsroot if namespace_fsroot is not None else host_fsroot.rstrip('/')+path[len('/data_n008'):]
    item['source']=namespace_source+'[/selected]';item['maj:min']=namespace_major;item['fstype']=namespace_type
 if namespace_duplicate and '--tab-file' not in args:body['filesystems']+=body['filesystems']
 return json.dumps(body)
subprocess.check_output=btrfs_fixture
`

func TestOwnContainerBtrfsSubvolumeUsesBothKernelMountViews(t *testing.T) {
	for _, mode := range []string{"inspect", "docker"} {
		out, err := exec.Command("python3", "-c", btrfsHostFixture+storageScript, mode, "/data_n008/selected").CombinedOutput()
		if err != nil {
			t.Fatalf("%s did not accept verified btrfs backing: %v %s", mode, err, out)
		}
		var c StorageCandidate
		if err := json.Unmarshal(out, &c); err != nil {
			t.Fatal(err)
		}
		if !c.InstallAllowed || c.SystemDisk || c.Filesystem != "btrfs" {
			t.Fatal("incorrect btrfs classification")
		}
	}
}

func TestOwnContainerBtrfsDoesNotAcceptOtherBackingMounts(t *testing.T) {
	for name, mutation := range map[string]string{
		"same device different subvolume": "host_fsroot='/expected';namespace_fsroot='/wrong/selected'\n",
		"missing root":                    "namespace_fsroot=''\n",
		"other block device":              "namespace_source='/dev/sda9'\n",
		"other mount identity":            "namespace_major='0:99'\n",
		"other filesystem":                "namespace_type='xfs'\n",
		"wrong target":                    "namespace_target='/data_n008/foreign'\n",
		"ambiguous":                       "namespace_duplicate=True\n",
	} {
		t.Run(name, func(t *testing.T) {
			if out, err := exec.Command("python3", "-c", btrfsHostFixture+mutation+storageScript, "inspect", "/data_n008/selected").CombinedOutput(); err == nil {
				t.Fatalf("unverified btrfs source accepted: %s", out)
			}
		})
	}
}
