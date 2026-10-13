package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCloudCORSDoesNotOpenAdminRoutes(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	for _, path := range []string{"/api/cloud/register", "/api/cloud/catalog"} {
		req := httptest.NewRequest("OPTIONS", "http://127.0.0.1:18442"+path, nil)
		req.Header.Set("Origin", "http://192.168.3.56:18436")
		rec := httptest.NewRecorder()
		boundaryOrigin(next, true, "https://zstore.2iwm.com")(rec, req)
		if rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
			t.Fatalf("cloud preflight blocked: %d", rec.Code)
		}
		if rec.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Fatal("cloud API must use bearer tokens without browser credentials")
		}
	}
	req := httptest.NewRequest("POST", "http://127.0.0.1:18442/api/store/admin/apps", nil)
	req.Header.Set("Origin", "http://192.168.3.56:18436")
	rec := httptest.NewRecorder()
	boundaryOrigin(next, true, "https://zstore.2iwm.com")(rec, req)
	if rec.Code != 403 {
		t.Fatalf("cross-origin admin allowed: %d", rec.Code)
	}
}

func TestAPIOnlyServesOnlyAdminUI(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("管理后台"), 0600); err != nil {
		t.Fatal(err)
	}
	h := apiOnlyWebHandler(dir)
	for _, path := range []string{"/admin/", "/admin/apps"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "管理后台") {
			t.Fatalf("admin route %s: %d", path, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if !strings.Contains(rec.Body.String(), "api-only") {
		t.Fatal("root must remain API status")
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/space-store/", nil))
	if rec.Code != 404 {
		t.Fatal("public storefront exposed")
	}
}

func TestBoundaryRejectsUntrustedOrigin(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	for _, origin := range []string{"https://evil.example", "null", "http://127.0.0.1:1234"} {
		req := httptest.NewRequest("POST", "http://127.0.0.1:18435/api/store/setup", strings.NewReader(`{}`))
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		boundary(next, true)(rec, req)
		if rec.Code != 403 {
			t.Fatalf("origin %s: status %d", origin, rec.Code)
		}
	}
}
func TestBoundaryAcceptsOwnedUIAndSameOrigin(t *testing.T) {
	for _, origin := range []string{"tauri://localhost", "http://tauri.localhost", "http://localhost:5173", "http://127.0.0.1:18435"} {
		req := httptest.NewRequest("GET", "http://127.0.0.1:18435/api/health", nil)
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		boundary(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }), true)(rec, req)
		if rec.Code != 200 {
			t.Fatalf("origin %s: status %d", origin, rec.Code)
		}
	}
}
func TestBoundaryRejectsReboundHostInNative(t *testing.T) {
	req := httptest.NewRequest("POST", "http://attacker.example:1234/api/store/setup", nil)
	req.Header.Set("Origin", "http://attacker.example:1234")
	rec := httptest.NewRecorder()
	boundary(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }), true)(rec, req)
	if rec.Code != 403 {
		t.Fatalf("rebound host accepted: %d", rec.Code)
	}
}

func TestExplicitPublicOriginAllowsHTTPSProxyWithoutTrustingForwardedHeader(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	req := httptest.NewRequest("POST", "http://shop.example/api/store/login", nil)
	req.Header.Set("Origin", "https://shop.example")
	req.Header.Set("X-Forwarded-Proto", "https")
	noConfig := httptest.NewRecorder()
	boundary(next, false)(noConfig, req)
	if noConfig.Code != 403 {
		t.Fatal("unconfigured forwarded header must not grant origin")
	}
	configured := httptest.NewRecorder()
	boundaryOrigin(next, false, "https://shop.example")(configured, req)
	if configured.Code != 200 {
		t.Fatalf("configured HTTPS origin rejected: %d", configured.Code)
	}
	req.Header.Set("Origin", "https://evil.example")
	denied := httptest.NewRecorder()
	boundaryOrigin(next, false, "https://shop.example")(denied, req)
	if denied.Code != 403 {
		t.Fatal("foreign origin accepted")
	}
}

func TestPublicOriginMustBeBareHTTPOrigin(t *testing.T) {
	for _, value := range []string{"http://user:secret@host", "https://host/other", "https://host?x=y", "file:///tmp/a", "https://host#part"} {
		if validatePublicOrigin(value) == nil {
			t.Fatalf("unsafe origin accepted: %s", value)
		}
	}
	if validatePublicOrigin("https://shop.example") != nil {
		t.Fatal("valid origin rejected")
	}
}

func TestLoopbackProxyAllowsOnlyConfiguredPublicHost(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	req := httptest.NewRequest("POST", "http://shop.example/api/store/login", nil)
	req.Header.Set("Origin", "https://shop.example")
	rec := httptest.NewRecorder()
	boundaryOrigin(next, true, "https://shop.example")(rec, req)
	if rec.Code != 200 {
		t.Fatalf("loopback proxy public host rejected: %d", rec.Code)
	}
	req.Host = "evil.example"
	rec = httptest.NewRecorder()
	boundaryOrigin(next, true, "https://shop.example")(rec, req)
	if rec.Code != 403 {
		t.Fatal("unregistered proxy host accepted")
	}
}
func TestWebNeverExposesDotfilesOrFallsBackAPI(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<title>desktop</title>"), 0600)
	os.WriteFile(filepath.Join(dir, ".env"), []byte("secret"), 0600)
	for _, route := range []string{"/.env", "/api/unknown", "/nested/.git/config"} {
		rec := httptest.NewRecorder()
		webHandler(dir).ServeHTTP(rec, httptest.NewRequest("GET", route, nil))
		if rec.Code != 404 || strings.Contains(rec.Body.String(), "secret") {
			t.Fatalf("unsafe web route %s: %d %s", route, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	webHandler(dir).ServeHTTP(rec, httptest.NewRequest("GET", "/desktop", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "desktop") {
		t.Fatal("SPA route unavailable")
	}
}

func TestNASOriginCLIConfigurationRejectedBeforeStartup(t *testing.T) {
	err := run("127.0.0.1:0", t.TempDir(), "", "disabled", "", "", "", "", "", "http://user:private-secret@nas.example")
	if err == nil || strings.Contains(err.Error(), "private-secret") {
		t.Fatal("unsafe NAS origin accepted or echoed", err)
	}
}

func TestHealthDeclaresFixedControllerProtocol(t *testing.T) {
	w := httptest.NewRecorder()
	healthHandler("ready-instance")(w, httptest.NewRequest("GET", "/api/health", nil))
	var body struct {
		OK   bool `json:"ok"`
		Data struct{ Service, InstanceID, ControllerProtocol string }
	}
	if e := json.Unmarshal(w.Body.Bytes(), &body); e != nil {
		t.Fatal(e)
	}
	if w.Code != 200 || !body.OK || body.Data.Service != "space-store" || body.Data.InstanceID != "ready-instance" || body.Data.ControllerProtocol != "v1" {
		t.Fatal(w.Body.String())
	}
}
func TestAPIOnlyRootDoesNotServeTheStorefront(t *testing.T) {
	h := apiOnlyHandler()
	for _, path := range []string{"/", "/store.html", "/assets/store.js"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if strings.Contains(w.Body.String(), "<html") || w.Header().Get("Content-Type") != "application/json; charset=utf-8" {
			t.Fatal("API host exposed frontend", path, w.Body.String())
		}
		if path == "/" && w.Code != 200 || path != "/" && w.Code != 404 {
			t.Fatal(path, w.Code)
		}
	}
}

func TestDecodeCloudPublicationOperatorRequiresBoundedUniqueApps(t *testing.T) {
	for _, body := range []string{`{"apps":[]}`, `{"apps":[{"id":"first"},{"id":"first"}]}`, `{"apps":[{"id":"first","privateKey":"forbidden"}]}`, `{"apps":[{"id":"first"}]} {}`} {
		if _, err := decodeCloudPublication(strings.NewReader(body)); err == nil {
			t.Fatal("invalid operator input accepted")
		}
	}
	apps, err := decodeCloudPublication(strings.NewReader(`{"apps":[{"id":"first","name":"public info"}]}`))
	if err != nil || len(apps) != 1 {
		t.Fatal("valid input rejected", err)
	}
}
