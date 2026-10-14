package store

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestStorageCreationScriptPreservesExistingAndRejectsChangedParent(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 unavailable")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fixture := fmt.Sprintf(`
os.path.exists=lambda path:False
socket.gethostname=lambda:"fixture-nas-host"
fixture_root=%q
def synthetic(args,**kwargs):
 if args[0]=='lsblk':return json.dumps({'blockdevices':[{'kname':'mmcblk0','path':'/dev/mmcblk0','type':'disk','rota':False,'children':[{'kname':'mmcblk0p2','path':'/dev/mmcblk0p2','type':'part','pkname':'mmcblk0'}]},{'kname':'nvme0n1','path':'/dev/nvme0n1','type':'disk','rota':False,'children':[{'kname':'nvme0n1p4','path':'/dev/nvme0n1p4','type':'part','pkname':'nvme0n1'}]}]})
 path=args[args.index('-T')+1] if '-T' in args else '/'
 data=path==fixture_root or path.startswith(fixture_root+'/')
 return json.dumps({'filesystems':[{'target':fixture_root if data else '/','source':'/dev/nvme0n1p4' if data else '/dev/mmcblk0p2','fstype':'ext4','maj:min':'259:4' if data else '179:2','fsroot':'/'}]})
subprocess.check_output=synthetic
`, base)
	script := "import os,sys,json,subprocess,re\n" + storageHostMetadataScript + fixture + storageBodyScript
	run := func(mode, path, proof string) (StorageCandidate, error) {
		raw, runErr := exec.Command("python3", "-c", script, mode, path, proof).CombinedOutput()
		var candidate StorageCandidate
		if runErr != nil {
			return candidate, runErr
		}
		return candidate, json.Unmarshal(raw, &candidate)
	}
	parent, err := run("inspect", base, "")
	if err != nil || !parent.InstallAllowed {
		t.Fatal("fixture data directory", parent, err)
	}
	fresh := filepath.Join(base, "new-apps")
	candidate, err := run("create", fresh, parent.Identity)
	if err != nil || candidate.Path != fresh || !candidate.InstallAllowed {
		t.Fatal("fresh directory creation failed", candidate, err)
	}
	entry, err := os.Stat(fresh)
	if err != nil || entry.Mode().Perm() != 0700 {
		t.Fatal("private directory", err)
	}
	sentinel := filepath.Join(fresh, "keep")
	if err = os.WriteFile(sentinel, []byte("user-data"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = run("create", fresh, parent.Identity); err == nil {
		t.Fatal("existing directory reused")
	}
	raw, err := os.ReadFile(sentinel)
	if err != nil || string(raw) != "user-data" {
		t.Fatal("existing data changed", err)
	}
	rejected := filepath.Join(base, "wrong-proof")
	if _, err = run("create", rejected, "changed"); err == nil {
		t.Fatal("stale parent identity accepted")
	}
	if _, err = os.Stat(rejected); !os.IsNotExist(err) {
		t.Fatal("stale proof created a directory")
	}
	link := filepath.Join(base, "linked")
	if err = os.Symlink(base, link); err != nil {
		t.Fatal(err)
	}
	if _, err = run("create", filepath.Join(link, "escape"), parent.Identity); err == nil {
		t.Fatal("symlink ancestor accepted")
	}
	if _, err = os.Stat(filepath.Join(base, "escape")); !os.IsNotExist(err) {
		t.Fatal("symlink path wrote data")
	}
}
