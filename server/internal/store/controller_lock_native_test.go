//go:build linux || darwin

package store

import (
	"bufio"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestMaintenanceExternalRestartLockBlocksResume(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := maintenancePause(t, r, "external-restart")
	dir := filepath.Join(r.root, ".space-store-control")
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	f, e := os.OpenFile(filepath.Join(dir, "update.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		t.Fatal(e)
	}
	out := maintenanceCall(t, r, "POST", maintenanceURL+"/"+p["id"].(string)+"/resume", `{}`, 409)
	if out["error"].(map[string]any)["code"] != "store_update_in_progress" {
		t.Fatal(out)
	}
	view := maintenanceCall(t, r, "GET", maintenanceURL, "", 200)["data"].(map[string]any)
	if view["state"] != "quiesced" {
		t.Fatal(view)
	}
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"external-restart"}`, 200)
	if e = unix.Flock(int(f.Fd()), unix.LOCK_UN); e != nil {
		t.Fatal(e)
	}
	maintenanceCall(t, r, "POST", maintenanceURL+"/"+p["id"].(string)+"/resume", `{}`, 200)
}

func TestControllerNativeChild(t *testing.T) {
	path := os.Getenv("STORE_NATIVE_CHILD_PATH")
	if path == "" {
		return
	}
	switch os.Getenv("STORE_NATIVE_CHILD_KIND") {
	case "service":
		s, e := New(Options{DataDir: path, EngineMode: "disabled"})
		if e != nil {
			t.Fatal(e)
		}
		_ = s
		os.Stdout.WriteString("locked\n")
		var b [1]byte
		os.Stdin.Read(b[:])
		os.Exit(0)
	case "probe":
		f, e := os.OpenFile(path, os.O_RDWR, 0)
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		want := os.Getenv("STORE_NATIVE_CHILD_WANT_BUSY") == "1"
		if want && (e != unix.EWOULDBLOCK && e != unix.EAGAIN) {
			t.Fatal("cross-process lease did not conflict", e)
		}
		if !want && e != nil {
			t.Fatal("released lease not reacquired", e)
		}
	}
}
func TestControllerNativeCrashReleasesLeases(t *testing.T) {
	opts := controllerOptions(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestControllerNativeChild$")
	cmd.Env = append(os.Environ(), "STORE_NATIVE_CHILD_PATH="+opts.DataDir, "STORE_NATIVE_CHILD_KIND=service")
	out, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	stdin, e := cmd.StdinPipe()
	if e != nil {
		t.Fatal(e)
	}
	defer stdin.Close()
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	scanner := bufio.NewScanner(out)
	if !scanner.Scan() || scanner.Text() != "locked" {
		t.Fatal("child did not acquire service leases")
	}
	second, e := New(opts)
	if second != nil {
		second.Close()
	}
	if e == nil {
		t.Fatal("second process admitted")
	}
	if e = cmd.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	cmd.Wait()
	recovered, e := New(opts)
	if e != nil {
		t.Fatal("crash retained live lock", e)
	}
	defer recovered.Close()
}
func TestControllerNativeSharedLockExcludesExternalWriter(t *testing.T) {
	r := newRig(t)
	release, e := r.s.controllerLocks.MaintenanceChange()
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(r.root, ".space-store-control/update.lock")
	probe := func(busy bool) {
		t.Helper()
		cmd := exec.Command(os.Args[0], "-test.run=^TestControllerNativeChild$")
		value := "0"
		if busy {
			value = "1"
		}
		cmd.Env = append(os.Environ(), "STORE_NATIVE_CHILD_PATH="+path, "STORE_NATIVE_CHILD_KIND=probe", "STORE_NATIVE_CHILD_WANT_BUSY="+value)
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("native subprocess probe failed: %s %v", out, e)
		}
	}
	probe(true)
	release()
	probe(false)
}
func TestMaintenanceRestartLockPreservesAuthorizationAndReads(t *testing.T) {
	for _, source := range []string{"ordinary", "nas"} {
		t.Run(source, func(t *testing.T) {
			var r *testRig
			if source == "ordinary" {
				r = newRig(t)
				r.setup()
			} else {
				r, _ = nasMutationRig(t)
			}
			p := maintenancePause(t, r, "authorization")
			f, e := os.OpenFile(filepath.Join(r.root, ".space-store-control/update.lock"), os.O_RDWR, 0)
			if e != nil {
				t.Fatal(e)
			}
			defer f.Close()
			if e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
				t.Fatal(e)
			}
			maintenanceCall(t, r, "GET", maintenanceURL, "", 200)
			maintenanceCall(t, r, "GET", "/api/store/instances", "", 200)
			maintenanceCall(t, r, "POST", "/api/store/logout", `{}`, 200)
			maintenanceCall(t, r, "POST", maintenanceURL+"/"+p["id"].(string)+"/resume", `{}`, 401)
			var status string
			if e = r.s.db.QueryRow(`SELECT status FROM store_maintenance`).Scan(&status); e != nil || status != "quiesced" {
				t.Fatal("unauthorized mutation", e, status)
			}
		})
	}
}
func TestControllerSnapshotReadRejectsSymlinkAndFIFO(t *testing.T) {
	dir, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	root, e := os.OpenRoot(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	if e = os.WriteFile(filepath.Join(dir, "regular"), []byte("retained"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink("regular", filepath.Join(dir, "link")); e != nil {
		t.Fatal(e)
	}
	if f, e := nativeControllerSnapshotRead(root, "link"); e == nil {
		f.Close()
		t.Fatal("snapshot symlink followed")
	}
	if e = unix.Mkfifo(filepath.Join(dir, "fifo"), 0600); e != nil {
		t.Fatal(e)
	}
	f, e := nativeControllerSnapshotRead(root, "fifo")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	fi, e := f.Stat()
	if e != nil || fi.Mode().IsRegular() {
		t.Fatal("FIFO not rejected by caller regular-file guard", e)
	}
}

func TestControllerForeignOwnerRootRejectsBeforeSQLite(t *testing.T) {
	opts := controllerOptions(t)
	if os.Getuid() == 0 {
		opts.StorageRoot = filepath.Join(filepath.Dir(opts.DataDir), "foreign")
		if e := os.Mkdir(opts.StorageRoot, 0700); e != nil {
			t.Fatal(e)
		}
		if e := os.Chown(opts.StorageRoot, 65534, 65534); e != nil {
			t.Fatal(e)
		}
	} else {
		opts.StorageRoot = "/usr"
	}
	s, e := New(opts)
	if s != nil {
		s.Close()
	}
	if e == nil {
		t.Fatal("foreign owner root admitted")
	}
	if _, e = os.Lstat(filepath.Join(opts.DataDir, "store.sqlite")); !os.IsNotExist(e) {
		t.Fatal("SQLite touched before lease ownership verified", e)
	}
}
