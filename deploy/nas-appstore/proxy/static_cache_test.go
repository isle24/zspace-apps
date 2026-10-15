package main

import (
	"compress/gzip"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHTMLAndRuntimeConfigCannotBeHeuristicallyCached(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"index.html", "complete-store.html", "runtime-config.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("current release"), 0600); err != nil {
			t.Fatal(err)
		}
		f, err := os.Create(filepath.Join(dir, name+".gz"))
		if err != nil {
			t.Fatal(err)
		}
		z := gzip.NewWriter(f)
		if _, err = z.Write([]byte("current release")); err != nil {
			t.Fatal(err)
		}
		z.Close()
		f.Close()
	}
	root := http.Dir(dir)
	handler := precompressedFiles{root: root, next: http.FileServer(root)}
	for _, path := range []string{"/", "/complete-store.html?embedded=1", "/runtime-config.json"} {
		for _, encoding := range []string{"", "gzip"} {
			request := httptest.NewRequest("GET", path, nil)
			request.Header.Set("Accept-Encoding", encoding)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatalf("%s status=%d", path, response.Code)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("%s (%s) must refresh release entry points; got %q", path, encoding, response.Header().Get("Cache-Control"))
			}
		}
	}
}

func TestPrecompressedResponseHonorsEncodingPreferences(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "app.js"), []byte("plain javascript"), 0600)
	os.WriteFile(filepath.Join(dir, "app.js.gz"), []byte("compressed representation"), 0600)
	root := http.Dir(dir)
	handler := precompressedFiles{root: root, next: http.FileServer(root)}
	for _, test := range []struct {
		accept     string
		compressed bool
	}{
		{"gzip", true}, {"gzip;q=0", false}, {"br, gzip;q=0.5", true},
		{"*;q=0.8", true}, {"*;q=1, gzip;q=0", false},
		{"gzip;q=invalid", false}, {"gzip;q=2", false}, {"", false},
	} {
		t.Run(test.accept, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/app.js", nil)
			r.Header.Set("Accept-Encoding", test.accept)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if got := w.Header().Get("Content-Encoding") == "gzip"; got != test.compressed {
				t.Errorf("compressed=%v, want %v", got, test.compressed)
			}
			if w.Header().Get("Vary") != "Accept-Encoding" {
				t.Error("all encoding variants must vary by Accept-Encoding")
			}
		})
	}
}
