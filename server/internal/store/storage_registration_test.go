package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRootsVerifyInitialDirectoryOnRead(t *testing.T) {
	r := newRig(t)
	r.setup()
	code, out := r.call("GET", "/api/store/roots", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	root := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	disk := root["storage"].(map[string]any)
	if disk["identity"] == "" || disk["installAllowed"] != true {
		t.Fatal("initial directory remains unusable after page refresh", root)
	}
}
func TestRootsReadDoesNotAdoptChangedIdentity(t *testing.T) {
	r := newRig(t)
	r.setup()
	body, _ := json.Marshal(map[string]any{"path": r.root})
	code, out := r.call("POST", "/api/store/roots", string(body), "127.0.0.1:1")
	if code != 201 {
		t.Fatal(code, out)
	}
	pinned := out["data"].(map[string]any)["storage"].(map[string]any)["identity"]
	if err := os.Rename(r.root, r.root+"-kept"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(r.root, 0700); err != nil {
		t.Fatal(err)
	}
	code, out = r.call("GET", "/api/store/roots", "", "127.0.0.1:1")
	root := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	disk := root["storage"].(map[string]any)
	if code != 200 || disk["installAllowed"] != false || disk["identity"] != pinned {
		t.Fatal("changed directory was offered for installation", code, root)
	}
}

type creatingStorageEngine struct {
	*fakeEngine
	creates int
	unsafe  bool
}

func (e *creatingStorageEngine) InspectStorage(ctx context.Context, path string) (StorageCandidate, error) {
	c, err := e.fakeEngine.InspectStorage(ctx, path)
	if e.unsafe {
		c.InstallAllowed = false
		c.SystemDisk = true
	}
	return c, err
}
func (e *creatingStorageEngine) CreateStorageDirectory(ctx context.Context, path, parentIdentity string) (StorageCandidate, error) {
	e.creates++
	p, err := e.fakeEngine.InspectStorage(ctx, filepath.Dir(path))
	if err != nil || p.Identity != parentIdentity {
		return StorageCandidate{}, errors.New("parent changed")
	}
	if err = os.Mkdir(path, 0700); err != nil {
		return StorageCandidate{}, err
	}
	return e.fakeEngine.InspectStorage(ctx, path)
}
func TestCreateStorageDirectoryRegistersFreshChild(t *testing.T) {
	r := newRig(t)
	r.setup()
	e := &creatingStorageEngine{fakeEngine: r.e}
	r.s.engine = e
	path := filepath.Join(r.root, "user-apps")
	body, _ := json.Marshal(map[string]any{"path": path, "name": "自建应用目录", "create": true})
	code, out := r.call("POST", "/api/store/roots", string(body), "127.0.0.1:1")
	if code != 201 || e.creates != 1 {
		t.Fatal("page cannot create and register directory", code, out, e.creates)
	}
	root := out["data"].(map[string]any)
	if root["path"] != path || root["storage"].(map[string]any)["installAllowed"] != true {
		t.Fatal(root)
	}
	entry, err := os.Stat(path)
	if err != nil || entry.Mode().Perm() != 0700 {
		t.Fatal("created directory is not private", err)
	}
}
func TestCreateStorageDirectoryNeverChangesExistingOrUnsafeParent(t *testing.T) {
	for _, unsafe := range []bool{false, true} {
		t.Run(map[bool]string{false: "existing", true: "unsafe-parent"}[unsafe], func(t *testing.T) {
			r := newRig(t)
			r.setup()
			e := &creatingStorageEngine{fakeEngine: r.e, unsafe: unsafe}
			r.s.engine = e
			path := filepath.Join(r.root, "untouched")
			if !unsafe {
				if err := os.Mkdir(path, 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(path, "keep"), []byte("user-data"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			body, _ := json.Marshal(map[string]any{"path": path, "create": true})
			code, _ := r.call("POST", "/api/store/roots", string(body), "127.0.0.1:1")
			if code < 400 {
				t.Fatal("unsafe creation accepted", code)
			}
			if unsafe && e.creates != 0 {
				t.Fatal("unsafe parent reached creation")
			}
			if !unsafe {
				raw, err := os.ReadFile(filepath.Join(path, "keep"))
				if err != nil || string(raw) != "user-data" {
					t.Fatal("existing data changed", err)
				}
			}
		})
	}
}
func TestRootsFirstVerificationPinsIdentityAcrossRefresh(t *testing.T) {
	r := newRig(t)
	r.setup()
	code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code)
	}
	old, err := r.s.root("storage")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(r.root, r.root+"-original"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(r.root, 0700); err != nil {
		t.Fatal(err)
	}
	code, out := r.call("GET", "/api/store/roots", "", "127.0.0.1:1")
	disk := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["storage"].(map[string]any)
	if code != 200 || old.Storage.Identity == "" || disk["identity"] != old.Storage.Identity || disk["installAllowed"] != false {
		t.Fatal("first verification did not bind directory", old.Storage, disk)
	}
}

type revokingCreationEngine struct {
	*creatingStorageEngine
	revoke func()
}

func (e *revokingCreationEngine) ValidatePath(ctx context.Context, root, path string, fresh bool) error {
	if err := e.fakeEngine.ValidatePath(ctx, root, path, fresh); err != nil {
		return err
	}
	e.revoke()
	return nil
}
func TestCreateStorageDirectoryChecksSessionAfterPathValidation(t *testing.T) {
	r := newRig(t)
	r.setup()
	e := &revokingCreationEngine{creatingStorageEngine: &creatingStorageEngine{fakeEngine: r.e}, revoke: func() {
		if _, err := r.s.db.Exec("DELETE FROM sessions"); err != nil {
			t.Fatal(err)
		}
	}}
	r.s.engine = e
	path := filepath.Join(r.root, "not-created-after-logout")
	body, _ := json.Marshal(map[string]any{"path": path, "create": true})
	code, _ := r.call("POST", "/api/store/roots", string(body), "127.0.0.1:1")
	if code != 401 || e.creates != 0 {
		t.Fatal("revoked session reached mkdir", code, e.creates)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("revoked request created directory")
	}
}
