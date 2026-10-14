package store

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestIndependentLANSetupAndPasswordLogin(t *testing.T) {
	r := newRig(t)
	r.s.opts.SetupMode = "lan"
	password := randomID()
	body, _ := json.Marshal(credentials{Username: "shop-owner", Password: password})
	call := func(path string) int {
		q := httptest.NewRequest("POST", "http://192.168.3.56:18443/api/store/"+path, strings.NewReader(string(body)))
		q.RemoteAddr = "192.168.3.12:40231"
		q.Header.Set("Origin", "http://192.168.3.56:18443")
		q.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.mux.ServeHTTP(w, q)
		return w.Code
	}
	if code := call("setup"); code != 201 {
		t.Fatalf("LAN setup HTTP %d", code)
	}
	if code := call("setup"); code != 409 {
		t.Fatalf("repeat setup HTTP %d", code)
	}
	if code := call("login"); code != 200 {
		t.Fatalf("password login HTTP %d", code)
	}
	code, out := r.call("GET", "/api/store/bootstrap", "", "192.168.3.12:1")
	if code != 200 {
		t.Fatal(code)
	}
	data := out["data"].(map[string]any)
	if data["authMode"] != "independent" || data["configured"] != true || data["setupRequiresLoopback"] != false {
		t.Fatal("incorrect independent bootstrap")
	}
}

func TestIndependentLANSetupRejectsUntrustedRequests(t *testing.T) {
	cases := []struct{ name, mode, peer, origin, header string }{
		{"default remains loopback", "", "192.168.3.12:1", "http://192.168.3.56:18443", ""},
		{"public peer", "lan", "203.0.113.10:1", "http://192.168.3.56:18443", ""},
		{"missing origin", "lan", "192.168.3.12:1", "", ""},
		{"foreign origin", "lan", "192.168.3.12:1", "http://other.invalid", ""},
		{"forwarded", "lan", "192.168.3.12:1", "http://192.168.3.56:18443", "Forwarded"},
		{"x forwarded", "lan", "192.168.3.12:1", "http://192.168.3.56:18443", "X-Forwarded-For"},
		{"real ip", "lan", "192.168.3.12:1", "http://192.168.3.56:18443", "X-Real-IP"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			r.s.opts.SetupMode = c.mode
			body, _ := json.Marshal(credentials{Username: "owner", Password: randomID()})
			q := httptest.NewRequest("POST", "http://192.168.3.56:18443/api/store/setup", strings.NewReader(string(body)))
			q.RemoteAddr = c.peer
			if c.origin != "" {
				q.Header.Set("Origin", c.origin)
			}
			if c.header != "" {
				q.Header.Set(c.header, "127.0.0.1")
			}
			w := httptest.NewRecorder()
			r.mux.ServeHTTP(w, q)
			if w.Code != 403 || r.s.configured() {
				t.Fatalf("untrusted setup HTTP %d", w.Code)
			}
		})
	}
}

func TestSetupModeCannotEnableNASOrCatalogRegistration(t *testing.T) {
	for _, c := range []Options{{SetupMode: "unknown"}, {SetupMode: "lan", NASOrigin: "http://192.168.3.56:5055", NASAdminOnly: true}, {SetupMode: "lan", CatalogOnly: true}} {
		c.DataDir = filepath.Join(t.TempDir(), "private")
		c.EngineMode = "disabled"
		s, err := New(c)
		if err == nil {
			s.Close()
			t.Fatal("unsafe setup mode accepted")
		}
	}
}

func TestIndependentLANSetupRejectsReboundPublicHostname(t *testing.T) {
	r := newRig(t)
	r.s.opts.SetupMode = "lan"
	body, _ := json.Marshal(credentials{Username: "owner", Password: randomID()})
	q := httptest.NewRequest("POST", "http://shop.attacker.example/api/store/setup", strings.NewReader(string(body)))
	q.RemoteAddr = "192.168.3.12:40231"
	q.Header.Set("Origin", "http://shop.attacker.example")
	w := httptest.NewRecorder()
	r.mux.ServeHTTP(w, q)
	if w.Code != 403 || r.s.configured() {
		t.Fatalf("rebound hostname setup HTTP %d", w.Code)
	}
}
