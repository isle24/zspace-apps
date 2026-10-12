package nas

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReviewRangeManifestEncodingBypass(t *testing.T) {
	token := "upstream+secret"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Range", "bytes 8-52/53")
		w.WriteHeader(http.StatusPartialContent)
		io.WriteString(w, "/play/segment.ts?token="+url.QueryEscape(token)+"\n")
	}))
	defer up.Close()
	base, _ := url.Parse(up.URL)
	s, _ := New(Options{})
	ss := &session{id: "synthetic", base: base, token: token, expires: time.Now().Add(time.Hour)}
	s.sessions[ss.id] = ss
	ref := s.mediaURL(ss, "/play/manifest")
	mux := http.NewServeMux()
	s.Register(mux)
	g := httptest.NewServer(mux)
	defer g.Close()
	req, _ := http.NewRequest("GET", g.URL+ref, nil)
	req.Header.Set("Range", "bytes=8-")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	decoded, _ := url.QueryUnescape(string(b))
	if strings.Contains(decoded, token) {
		t.Fatalf("range bypass exposes URL-escaped NAS token: status=%d mime=%q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

func TestRangeProbeUsesSourceBeginningAndPreservesBinaryRange(t *testing.T) {
	var probes, reads int
	binary := []byte("\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42ASCII-RANGE")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		switch r.Header.Get("Range") {
		case "bytes=0-511":
			probes++
			w.Header().Set("Content-Range", "bytes 0-34/35")
			w.WriteHeader(206)
			w.Write(binary)
		case "bytes=24-":
			reads++
			w.Header().Set("Content-Range", "bytes 24-34/35")
			w.WriteHeader(206)
			w.Write(binary[24:])
		default:
			t.Errorf("unexpected range %s", r.Header.Get("Range"))
		}
	}))
	defer up.Close()
	base, _ := url.Parse(up.URL)
	s, _ := New(Options{})
	ss := &session{id: "synthetic", base: base, token: "upstream+secret", expires: time.Now().Add(time.Hour)}
	s.sessions[ss.id] = ss
	ref := s.mediaURL(ss, "/play/binary")
	mux := http.NewServeMux()
	s.Register(mux)
	g := httptest.NewServer(mux)
	defer g.Close()
	req, _ := http.NewRequest("GET", g.URL+ref, nil)
	req.Header.Set("Range", "bytes=24-")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 206 || string(b) != string(binary[24:]) || probes != 1 || reads != 1 {
		t.Fatalf("range preservation failed: status%d probes%d reads%d body%q", resp.StatusCode, probes, reads, b)
	}
}
func TestRangeProbeBlocksManifestBeforeOriginalOffset(t *testing.T) {
	var offsetContacted bool
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		if r.Header.Get("Range") == "bytes=0-511" {
			w.Header().Set("Content-Range", "bytes 0-34/35")
			w.WriteHeader(206)
			io.WriteString(w, "#EXTM3U\n/play/segment.ts?token=upstream%2Bsecret\n")
			return
		}
		offsetContacted = true
		w.Header().Set("Content-Range", "bytes 8-34/35")
		w.WriteHeader(206)
		io.WriteString(w, "/play/segment.ts?token=upstream%2Bsecret\n")
	}))
	defer up.Close()
	base, _ := url.Parse(up.URL)
	s, _ := New(Options{})
	ss := &session{id: "synthetic", base: base, token: "upstream+secret", expires: time.Now().Add(time.Hour)}
	s.sessions[ss.id] = ss
	ref := s.mediaURL(ss, "/play/manifest")
	mux := http.NewServeMux()
	s.Register(mux)
	g := httptest.NewServer(mux)
	defer g.Close()
	req, _ := http.NewRequest("GET", g.URL+ref, nil)
	req.Header.Set("Range", "bytes=8-")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	decoded, _ := url.QueryUnescape(string(b))
	if resp.StatusCode < 400 || offsetContacted || strings.Contains(decoded, ss.token) {
		t.Fatal("offset fetch bypassed source verification")
	}
}

func TestDeviceIdentityPersistsAcrossLoginsAndRestarts(t *testing.T) {
	var identities []string
	original := fake(t, func(w http.ResponseWriter, r *http.Request) {})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/key/pub" {
			identities = append(identities, r.URL.Query().Get("device_id"))
		}
		req, _ := http.NewRequest(r.Method, original.URL+r.URL.RequestURI(), r.Body)
		req.Header = r.Header.Clone()
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		io.Copy(w, resp.Body)
	}))
	defer up.Close()
	dir := t.TempDir()
	for restart := 0; restart < 2; restart++ {
		s, e := New(Options{DataDir: dir})
		if e != nil {
			t.Fatal(e)
		}
		m := http.NewServeMux()
		s.Register(m)
		g := httptest.NewServer(m)
		for login := 0; login < 2; login++ {
			sid(t, g.URL, up.URL)
		}
		g.Close()
	}
	if len(identities) != 4 {
		t.Fatal("missing logins")
	}
	for _, id := range identities {
		if id == "" || id != identities[0] {
			t.Fatal("device identity changes across login/restart")
		}
	}
	info, e := os.Stat(filepath.Join(dir, "nas", "device-id"))
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("identity must be private nonsecret file: %v %v", info, e)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "nas", "device-id"))
	if strings.Contains(string(body), "upstream-secret") || strings.Contains(string(body), "synthetic-password") {
		t.Fatal("credentials persisted")
	}
}
func TestDeviceIdentityRejectsSymlinkAndUnsafePath(t *testing.T) {
	for _, kind := range []string{"id-symlink", "directory-symlink", "insecure-directory", "data-symlink", "data-file", "relative"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			own := filepath.Join(dir, "nas")
			os.Mkdir(own, 0700)
			switch kind {
			case "id-symlink":
				target := filepath.Join(dir, "target")
				os.WriteFile(target, []byte("user-data"), 0600)
				os.Symlink(target, filepath.Join(own, "device-id"))
			case "directory-symlink":
				os.Remove(own)
				target := t.TempDir()
				os.Symlink(target, own)
			case "insecure-directory":
				os.Chmod(own, 0777)
			case "data-symlink":
				target := dir
				dir = filepath.Join(t.TempDir(), "data")
				os.Symlink(target, dir)
			case "data-file":
				dir = filepath.Join(dir, "file")
				os.WriteFile(dir, []byte("user-data"), 0600)
			case "relative":
				dir = "../outside-data"
			}
			if _, e := New(Options{DataDir: dir}); e == nil {
				t.Fatal("unsafe identity path accepted")
			}
		})
	}
}
