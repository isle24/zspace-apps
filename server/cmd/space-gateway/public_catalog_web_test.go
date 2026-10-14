package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"spacedesktop/server/internal/store"
)

func TestAPIOnlyBuiltPublicCatalogHasIndependentRootAndAdmin(t *testing.T) {
	dir := t.TempDir()
	for file, content := range map[string]string{"index.html": "<html>administrator</html>", "public.html": "<html>public application catalog</html>", "assets/public.js": "public catalog script"} {
		path := filepath.Join(dir, file)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	h := apiOnlyWebHandler(dir)
	for path, content := range map[string]string{"/": "public application catalog", "/admin/": "administrator", "/admin/apps": "administrator", "/admin/assets/public.js": "public catalog script"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), content) {
			t.Fatalf("%s returned %d %s", path, w.Code, w.Body.String())
		}
		if path == "/" && !strings.Contains(w.Header().Get("Content-Security-Policy"), "connect-src 'self';") {
			t.Fatal("public document must only connect to its own origin")
		}
	}
	for _, path := range []string{"/api/private", "/store.html", "/.env", "/unknown"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 || strings.Contains(w.Body.String(), "<html>") {
			t.Fatalf("private/unknown path fell back to catalog: %s %d", path, w.Code)
		}
	}
}

func TestAPIOnlyStatusRemainsAvailableWithPublicBuild(t *testing.T) {
	w := httptest.NewRecorder()
	apiOnlyWebHandler(t.TempDir()).ServeHTTP(w, httptest.NewRequest("GET", "/about", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"mode":"api-only"`) || w.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("status endpoint unavailable: %d %s", w.Code, w.Body.String())
	}
}

func TestPublicPageDoesNotBypassAPIAuthenticationOrHealth(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "public.html"), []byte("<html>public catalog</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	state, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := store.New(store.Options{DataDir: filepath.Join(state, "state"), EngineMode: "disabled", CatalogOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	mux := http.NewServeMux()
	s.Register(mux)
	if err := s.RegisterCloudHandlers(mux); err != nil {
		t.Fatal(err)
	}
	mux.HandleFunc("GET /api/health", healthHandler("public-host"))
	mux.Handle("/", apiOnlyWebHandler(dir))
	for path, code := range map[string]int{"/": 200, "/api/health": 200, "/api/cloud/public-catalog": 200, "/api/cloud/catalog": 401, "/api/store/admin/apps": 401, "/api/store/status": 401, "/api/missing": 404} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != code {
			t.Fatalf("%s expected %d, got %d", path, code, w.Code)
		}
		if strings.HasPrefix(path, "/api/") && strings.Contains(w.Body.String(), "<html>") {
			t.Fatal("API route was replaced by public HTML", path)
		}
	}
}
