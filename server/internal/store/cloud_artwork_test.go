package store

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCloudArtworkHashRouteUsesKnownCatalogSource(t *testing.T) {
	r, mux := cloudRig(t)
	var source string
	if err := r.s.db.QueryRow(`SELECT json_extract(draft_json,'$.icon') FROM cloud_apps WHERE id='navidrome'`).Scan(&source); err != nil {
		t.Fatal(err)
	}
	hash := tokenHash(source)
	_, err := r.s.db.Exec(`INSERT INTO cloud_artwork(hash,body,mime) VALUES(?,?,?)`, hash, []byte("cached-public-artwork"), "image/png")
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/cloud/artwork/"+hash, nil))
	if w.Code != 200 || w.Body.String() != "cached-public-artwork" || w.Header().Get("Content-Type") != "image/png" {
		t.Fatal("hash route failed", w.Code)
	}
	if w.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("artwork sandbox absent")
	}
	req := httptest.NewRequest("GET", "/api/cloud/artwork/"+hash, nil)
	req.Header.Set("If-None-Match", w.Header().Get("ETag"))
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusNotModified {
		t.Fatal("cache revalidation failed", w.Code)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/cloud/artwork/"+tokenHash("unregistered"), nil))
	if w.Code != 404 {
		t.Fatal("unknown artwork source accepted")
	}
}
