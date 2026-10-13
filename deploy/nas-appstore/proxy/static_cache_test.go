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
