package store

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func controllerOptions(t *testing.T) Options {
	t.Helper()
	root, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	return Options{DataDir: filepath.Join(root, "state"), EngineMode: "disabled"}
}
func TestControllerSameDataDirectoryRejectsSecondLiveService(t *testing.T) {
	opts := controllerOptions(t)
	first, e := New(opts)
	if e != nil {
		t.Fatal(e)
	}
	defer first.Close()
	second, e := New(opts)
	if second != nil {
		second.Close()
	}
	if e == nil {
		t.Fatal("second controller admitted on the same metadata")
	}
}
func TestControllerSharedStorageRootRejectsSecondLiveService(t *testing.T) {
	opts := controllerOptions(t)
	opts.StorageRoot = filepath.Join(filepath.Dir(opts.DataDir), "apps")
	if e := os.Mkdir(opts.StorageRoot, 0700); e != nil {
		t.Fatal(e)
	}
	first, e := New(opts)
	if e != nil {
		t.Fatal(e)
	}
	defer first.Close()
	other := controllerOptions(t)
	other.StorageRoot = opts.StorageRoot
	second, e := New(other)
	if second != nil {
		second.Close()
	}
	if e == nil {
		t.Fatal("second controller admitted on the same storage root")
	}
}

func TestControllerCloseReleasesLeasesAndRetainsAddresses(t *testing.T) {
	opts := controllerOptions(t)
	first, e := New(opts)
	if e != nil {
		t.Fatal(e)
	}
	paths := []string{filepath.Join(opts.DataDir, ".space-store-controller.lock"), filepath.Join(opts.DataDir, "instances/.space-store-control/controller.lock"), filepath.Join(opts.DataDir, "instances/.space-store-control/update.lock")}
	identities := []os.FileInfo{}
	for _, p := range paths {
		fi, e := os.Lstat(p)
		if e != nil {
			t.Fatal(e)
		}
		identities = append(identities, fi)
	}
	if e = first.Close(); e != nil {
		t.Fatal(e)
	}
	second, e := New(opts)
	if e != nil {
		t.Fatal(e)
	}
	defer second.Close()
	for i, p := range paths {
		fi, e := os.Lstat(p)
		if e != nil || !os.SameFile(fi, identities[i]) {
			t.Fatal("lock address replaced", p, e)
		}
	}
	other, e := New(controllerOptions(t))
	if e != nil {
		t.Fatal("independent roots conflicted", e)
	}
	defer other.Close()
}
func TestControllerInitializationFailureReleasesLeases(t *testing.T) {
	for _, failure := range []string{"sqlite", "engine"} {
		t.Run(failure, func(t *testing.T) {
			opts := controllerOptions(t)
			if failure == "sqlite" {
				if e := os.Mkdir(opts.DataDir, 0700); e != nil {
					t.Fatal(e)
				}
				if e := os.WriteFile(filepath.Join(opts.DataDir, "store.sqlite"), []byte("corrupt retained database"), 0600); e != nil {
					t.Fatal(e)
				}
			} else {
				opts.EngineMode = "invalid"
			}
			failed, e := New(opts)
			if failed != nil {
				failed.Close()
			}
			if e == nil {
				t.Fatal("invalid initialization admitted")
			}
			if failure == "sqlite" {
				if e := os.Rename(filepath.Join(opts.DataDir, "store.sqlite"), filepath.Join(opts.DataDir, "retained-corrupt.sqlite")); e != nil {
					t.Fatal(e)
				}
			}
			opts.EngineMode = "disabled"
			s, e := New(opts)
			if e != nil {
				t.Fatal("failed startup retained live lease", e)
			}
			defer s.Close()
		})
	}
}
func TestControllerUnsafeAddressesRejected(t *testing.T) {
	for _, unsafe := range []string{"file-symlink", "hardlink", "mode", "directory-symlink", "directory-mode", "root-writable"} {
		t.Run(unsafe, func(t *testing.T) {
			opts := controllerOptions(t)
			s, e := New(opts)
			if e != nil {
				t.Fatal(e)
			}
			s.Close()
			file := filepath.Join(opts.DataDir, ".space-store-controller.lock")
			dir := filepath.Join(opts.DataDir, "instances/.space-store-control")
			switch unsafe {
			case "file-symlink":
				if e = os.Rename(file, file+".retained"); e == nil {
					e = os.Symlink(file+".retained", file)
				}
			case "hardlink":
				e = os.Link(file, file+".hardlink")
			case "mode":
				e = os.Chmod(file, 0644)
			case "directory-symlink":
				if e = os.Rename(dir, dir+".retained"); e == nil {
					e = os.Symlink(dir+".retained", dir)
				}
			case "directory-mode":
				e = os.Chmod(dir, 0755)
			case "root-writable":
				e = os.Chmod(filepath.Join(opts.DataDir, "instances"), 0777)
			}
			if e != nil {
				t.Fatal(e)
			}
			second, e := New(opts)
			if second != nil {
				second.Close()
			}
			if e == nil {
				t.Fatal("unsafe address admitted", unsafe)
			}
		})
	}
}
func TestMaintenanceChangedLockEvidenceRejectsMutation(t *testing.T) {
	for _, changed := range []string{"file", "directory", "root"} {
		t.Run(changed, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			p := maintenancePause(t, r, "tamper")
			path := filepath.Join(r.root, ".space-store-control/update.lock")
			if changed == "directory" {
				path = filepath.Dir(path)
			}
			if changed == "root" {
				path = r.root
			}
			if e := os.Rename(path, path+".retained"); e != nil {
				t.Fatal(e)
			}
			if changed == "file" {
				if e := os.WriteFile(path, nil, 0600); e != nil {
					t.Fatal(e)
				}
			} else {
				if e := os.Mkdir(path, 0700); e != nil {
					t.Fatal(e)
				}
			}
			out := maintenanceCall(t, r, "POST", maintenanceURL+"/"+p["id"].(string)+"/resume", `{}`, 503)
			if out["error"].(map[string]any)["code"] != "maintenance_unverified" {
				t.Fatal(out)
			}
			maintenanceCall(t, r, "GET", maintenanceURL, "", 200)
		})
	}
}

// External integration tests request a retained real Go SQLite/WAL fixture.
// Ordinary Go suites have no environment request and perform no export.
func TestControllerExportPausedEvidenceFixture(t *testing.T) {
	data := os.Getenv("STORE_EVIDENCE_FIXTURE_DATA")
	if data == "" {
		return
	}
	s, e := New(Options{DataDir: data, StorageRoot: os.Getenv("STORE_EVIDENCE_FIXTURE_STORAGE"), EngineMode: "disabled"})
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	r := &testRig{t: t, s: s, mux: http.NewServeMux()}
	s.Register(r.mux)
	r.setup()
	maintenancePause(t, r, "go-api-pause")
}
