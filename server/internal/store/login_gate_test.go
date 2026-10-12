package store

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type loginGateEngine struct {
	*fakeEngine
	probes           atomic.Int32
	entered, release chan struct{}
}

func (e *loginGateEngine) Probe(context.Context) error {
	e.probes.Add(1)
	if e.entered != nil {
		close(e.entered)
		<-e.release
	}
	return nil
}
func TestLoginGatePrivateReads(t *testing.T) {
	for _, state := range []string{"anonymous", "forged", "expired", "revoked", "valid"} {
		t.Run(state, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			e := &loginGateEngine{fakeEngine: r.e}
			r.s.engine = e
			switch state {
			case "anonymous":
				r.token = ""
			case "forged":
				r.token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			case "expired":
				if _, err := r.s.db.Exec("UPDATE sessions SET expires_at=?", time.Now().Add(-time.Minute).Unix()); err != nil {
					t.Fatal(err)
				}
			case "revoked":
				if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
					t.Fatal(code)
				}
			}
			for _, path := range []string{"catalog", "status"} {
				code, out := r.call("GET", "/api/store/"+path, "", "127.0.0.1:1")
				if state == "valid" {
					if code != 200 {
						t.Fatal(path, code, out)
					}
				} else if code != 401 {
					t.Fatal(path, "expected 401", code, out)
				} else if out["error"].(map[string]any)["code"] != "store_auth_required" {
					t.Fatal(out)
				}
			}
			if state != "valid" && e.probes.Load() != 0 {
				t.Fatal("unauthorized probe")
			}
		})
	}
}
func TestLoginGateBootstrapMinimal(t *testing.T) {
	r := newRig(t)
	e := &loginGateEngine{fakeEngine: r.e}
	r.s.engine = e
	code, out := r.call("GET", "/api/store/bootstrap", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code)
	}
	data := out["data"].(map[string]any)
	if len(data) != 4 || data["configured"] != false || data["setupRequiresLoopback"] != true {
		t.Fatal(data)
	}
	nas := data["nasAuth"].(map[string]any)
	if len(nas) != 3 || nas["enabled"] != false || nas["origin"] != "" || nas["storeId"] != r.s.storeID {
		t.Fatal(nas)
	}
	if e.probes.Load() != 0 {
		t.Fatal("bootstrap probed engine")
	}
	r.setup()
	code, out = r.call("GET", "/api/store/bootstrap", "", "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["configured"] != true {
		t.Fatal(out)
	}
}
func TestLoginGateStatusLogoutDuringProbe(t *testing.T) {
	r := newRig(t)
	r.setup()
	e := &loginGateEngine{fakeEngine: r.e, entered: make(chan struct{}), release: make(chan struct{})}
	r.s.engine = e
	req := httptest.NewRequest("GET", "/api/store/status", nil)
	req.Header.Set("X-Store-Session", r.token)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); r.mux.ServeHTTP(w, req) }()
	select {
	case <-e.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("probe never entered")
	}
	code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1")
	close(e.release)
	<-done
	if code != 200 || w.Code != 401 {
		t.Fatalf("logout %d status %d: %s", code, w.Code, w.Body.String())
	}
}

func TestLoginGateNASStatusLogoutDuringProbe(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"username": "nas-admin", "is_master": true}})
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	code, out := exchange(r, nil)
	if code != 200 {
		t.Fatal(code, out)
	}
	r.token = out["data"].(map[string]any)["sessionId"].(string)
	e := &loginGateEngine{fakeEngine: r.e, entered: make(chan struct{}), release: make(chan struct{})}
	r.s.engine = e
	req := httptest.NewRequest("GET", "/api/store/status", nil)
	req.Header.Set("X-Store-Session", r.token)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); r.mux.ServeHTTP(w, req) }()
	select {
	case <-e.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("probe never entered")
	}
	code, _ = r.call("POST", "/api/store/logout", "", "127.0.0.1:1")
	close(e.release)
	<-done
	if code != 200 || w.Code != 401 {
		t.Fatalf("logout %d status %d: %s", code, w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "engineReady") {
		t.Fatal("runtime leaked after NAS logout")
	}
}
