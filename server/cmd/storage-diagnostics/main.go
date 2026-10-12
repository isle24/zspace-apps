// storage-diagnostics performs read-only remote storage inspection with a
// synthetic, isolated local store identity. It never installs a container.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"spacedesktop/server/internal/store"
)

func main() {
	alias := flag.String("alias", "", "Existing usable sshbind alias")
	root := flag.String("root", "", "Existing dedicated data directory")
	mediaRoot := flag.String("media-root", "", "Optional existing media directory (inspected read-only)")
	flag.Parse()
	if *alias == "" || *root == "" {
		fmt.Fprintln(os.Stderr, "alias and root are required")
		os.Exit(1)
	}
	dir, err := os.MkdirTemp("", "space-storage-diagnostic-")
	if err != nil {
		fatal()
	}
	// MkdirTemp on macOS can return /var/... while /var is a system symlink.
	// Canonicalize only our own freshly created private metadata directory.
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		fatal()
	}
	s, err := store.New(store.Options{DataDir: dir, StorageRoot: *root, EngineMode: "sshbind", SSHAlias: *alias})
	if err != nil {
		fatal()
	}
	defer s.Close()
	mux := http.NewServeMux()
	s.Register(mux)
	random := make([]byte, 24)
	if _, err = rand.Read(random); err != nil {
		fatal()
	}
	body, _ := json.Marshal(map[string]string{"username": "diagnostic", "password": hex.EncodeToString(random)})
	req := httptest.NewRequest("POST", "http://127.0.0.1/api/store/setup", bytes.NewReader(body))
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var session struct {
		OK   bool `json:"ok"`
		Data struct {
			ID string `json:"sessionId"`
		} `json:"data"`
	}
	if rec.Code != 200 && rec.Code != 201 {
		fatal()
	}
	if json.Unmarshal(rec.Body.Bytes(), &session) != nil || !session.OK || session.Data.ID == "" {
		fatal()
	}
	req = httptest.NewRequest("GET", "http://127.0.0.1/api/store/storage", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-Store-Session", session.Data.ID)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var result map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &result) != nil {
		fatal()
	}
	storageStatus := rec.Code
	// Registration only changes this disposable local database; the remote
	// implementation inspects stat/findmnt/lsblk and never creates the directory.
	body, _ = json.Marshal(map[string]string{"path": *root, "name": "只读诊断根"})
	req = httptest.NewRequest("POST", "http://127.0.0.1/api/store/roots", bytes.NewReader(body))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-Store-Session", session.Data.ID)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var inspected map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &inspected) != nil {
		fatal()
	}
	result["rootInspection"] = inspected
	rootStatus := rec.Code
	mediaStatus := 201
	if *mediaRoot != "" {
		body, _ = json.Marshal(map[string]string{"path": *mediaRoot, "name": "只读媒体诊断根"})
		req = httptest.NewRequest("POST", "http://127.0.0.1/api/store/roots", bytes.NewReader(body))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("X-Store-Session", session.Data.ID)
		rec = httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		var media map[string]any
		if json.Unmarshal(rec.Body.Bytes(), &media) != nil {
			fatal()
		}
		result["mediaRootInspection"] = media
		mediaStatus = rec.Code
	}
	json.NewEncoder(os.Stdout).Encode(result)
	if storageStatus != 200 || rootStatus != 201 || mediaStatus != 201 {
		os.Exit(1)
	}
}
func fatal() { fmt.Fprintln(os.Stderr, "storage diagnostics failed; no install performed"); os.Exit(1) }
