package store

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegressionNativeSetupOrigins(t *testing.T) {
	for _, origin := range []string{"tauri://localhost", "http://tauri.localhost", "http://localhost:5173"} {
		t.Run(origin, func(t *testing.T) {
			r := newRig(t)
			req := httptest.NewRequest("POST", "http://127.0.0.1:18435/api/store/setup", strings.NewReader(`{"username":"synthetic-admin","password":"synthetic-pass-123"}`))
			req.RemoteAddr = "127.0.0.1:1234"
			req.Header.Set("Origin", origin)
			w := httptest.NewRecorder()
			r.mux.ServeHTTP(w, req)
			if w.Code != 201 {
				t.Fatalf("trusted native/dev origin blocked: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

type regressionSwapEngine struct {
	*fakeEngine
	target, existing string
}

func (e *regressionSwapEngine) Pull(context.Context, string) error {
	if err := os.Rename(e.target, e.target+"-created"); err != nil {
		return err
	}
	return os.Rename(e.existing, e.target)
}
func TestRegressionDataDirectoryReplacementDuringPull(t *testing.T) {
	r := newRig(t)
	r.setup()
	e := &regressionSwapEngine{fakeEngine: r.e, target: filepath.Join(r.root, "target"), existing: filepath.Join(r.root, "existing")}
	if err := os.Mkdir(e.existing, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.existing, "synthetic-existing-data"), []byte("protected"), 0600); err != nil {
		t.Fatal(err)
	}
	r.s.engine = e
	p := r.plan("uptime-kuma", "target", "")
	j := r.install(p, "synthetic-swap-review")
	final := r.waitJob(j["id"].(string))
	e.mu.Lock()
	calls := len(e.runs)
	e.mu.Unlock()
	if calls != 0 {
		t.Fatalf("replacement of new data directory with existing data was accepted; runs=%d final=%v", calls, final["status"])
	}
}

type regressionAmbiguousEngine struct{ *fakeEngine }

func (e *regressionAmbiguousEngine) Run(c context.Context, s RunSpec) error {
	if err := e.fakeEngine.Run(c, s); err != nil {
		return err
	}
	return errors.New("synthetic transport failure after Docker created container")
}
func TestRegressionAmbiguousRunNeedsAttention(t *testing.T) {
	r := newRig(t)
	r.setup()
	r.s.engine = &regressionAmbiguousEngine{r.e}
	p := r.plan("uptime-kuma", "ambiguous", "")
	j := r.install(p, "synthetic-ambiguous-review")
	final := r.waitJob(j["id"].(string))
	if final["status"] != "needs_attention" {
		t.Fatalf("created container's uncertain outcome classified as %v", final["status"])
	}
	_, out := r.call("GET", "/api/store/instances", "", "127.0.0.1:1")
	i := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if i["containerId"] == "" {
		t.Fatal("own created container lost identity")
	}
	status, out := r.call("POST", "/api/store/instances/"+i["id"].(string)+"/stop", "{}", "127.0.0.1:1")
	if status != 200 {
		t.Fatal("created container controls cannot recover", status, out)
	}
}

func TestReadOnlyReconcileRecoversOwnUnknownContainerID(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := r.plan("uptime-kuma", "reconcile", "")
	j := r.install(p, "synthetic-reconcile")
	r.waitJob(j["id"].(string))
	i, err := r.s.readInstance(p["instanceId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	i.ContainerID = ""
	i.State = "needs_attention"
	if err = r.s.saveInstance(i); err != nil {
		t.Fatal(err)
	}
	_, out := r.call("GET", "/api/store/instances", "", "127.0.0.1:1")
	row := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if row["containerId"] == "" || row["state"] != "running" {
		t.Fatal("read-only reconciliation did not restore own known labels", row)
	}
	if r.e.starts+r.e.stops != 0 {
		t.Fatal("reconcile mutated engine")
	}
}
