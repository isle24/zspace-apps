package nas

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDecodeBusinessFailure(t *testing.T) {
	for _, body := range []string{`{"success":false,"code":"N001208","msg":"expired"}`, `{"code":500,"msg":"token=secret"}`, `{"error":7}`, `{}`, `null`} {
		if _, err := DecodeResponse([]byte(body)); err == nil {
			t.Fatalf("accepted failure: %s", body)
		}
	}
	for _, body := range []string{`{"code":200,"data":{"list":[]}}`, `{"code":"S000200","data":[]}`, `{"error":0,"list":[]}`} {
		if _, err := DecodeResponse([]byte(body)); err != nil {
			t.Fatalf("rejected supported envelope: %s: %v", body, err)
		}
	}
}
func gateway(t *testing.T) *httptest.Server {
	t.Helper()
	s, e := New(Options{DataDir: t.TempDir()})
	if e != nil {
		t.Fatal(e)
	}
	m := http.NewServeMux()
	s.Register(m)
	g := httptest.NewServer(m)
	t.Cleanup(g.Close)
	return g
}
func request(t *testing.T, g, method, path, sid string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	r, _ := http.NewRequest(method, g+path, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-NAS-Session", sid)
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	var v map[string]any
	if e = json.NewDecoder(resp.Body).Decode(&v); e != nil {
		t.Fatal(e)
	}
	return resp.StatusCode, v
}
func sid(t *testing.T, g, up string) string {
	t.Helper()
	code, v := request(t, g, "POST", "/api/nas/login", "", map[string]string{"baseUrl": up, "username": "synthetic-user", "password": "synthetic-password"})
	if code != 200 || v["ok"] != true {
		t.Fatalf("login failed: %v %v", code, v)
	}
	out, _ := json.Marshal(v)
	if strings.Contains(string(out), "upstream-secret") {
		t.Fatal("login leaked upstream token")
	}
	return v["data"].(map[string]any)["sessionId"].(string)
}
func fake(t *testing.T, read http.HandlerFunc) *httptest.Server {
	t.Helper()
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	pub, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	var calls atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		r.ParseForm()
		switch r.URL.Path {
		case "/key/pub":
			calls.Add(1)
			if r.Form.Get("signme") != "1" {
				t.Error("missing fresh challenge")
			}
			json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"key": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pub})), "sign": "synthetic-challenge", "nasid": "synthetic-nas"}})
		case "/auth/login":
			if calls.Load() == 0 {
				t.Error("login without public key")
			}
			for k, want := range map[string]string{"username": "synthetic-user", "password": "synthetic-password"} {
				cipher, _ := base64.StdEncoding.DecodeString(r.Form.Get(k))
				plain, err := rsa.DecryptPKCS1v15(rand.Reader, key, cipher)
				if err != nil || string(plain) != want {
					t.Errorf("invalid RSA field %s", k)
				}
			}
			for _, k := range []string{"plat", "version", "device_id", "device", "_l"} {
				if r.Form.Get(k) == "" {
					t.Errorf("missing common parameter %s", k)
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"token": "upstream-secret", "username": "synthetic-user", "nasid": "synthetic-nas"}})
		default:
			if r.Form.Get("token") != "upstream-secret" && r.Header.Get("token") != "upstream-secret" {
				t.Error("missing NAS authentication")
			}
			read(w, r)
		}
	}))
	t.Cleanup(s.Close)
	return s
}
func TestRejectCredentialURLAndUnknownSession(t *testing.T) {
	g := gateway(t)
	code, v := request(t, g.URL, "POST", "/api/nas/login", "", map[string]string{"baseUrl": "http://user:pass@example.com", "username": "x", "password": "y"})
	if code < 400 || v["ok"] != false {
		t.Fatal("credential URL accepted")
	}
	code, _ = request(t, g.URL, "GET", "/api/nas/session", "wrong", nil)
	if code != 401 {
		t.Fatal("wrong session accepted")
	}
}
func TestNormalLoginReadPaginationSecretsAndLogout(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/file/list" {
			t.Errorf("unexpected route %s", r.URL.Path)
		}
		if r.Form.Get("start") != "12" || r.Form.Get("num") != "12" {
			t.Error("pagination lost")
		}
		io.WriteString(w, `{"code":200,"data":{"list":[{"id":"f1","name":"photo.jpg","path":"/my/photo.jpg","is_dir":"0","size":15,"token":"upstream-secret","password":"synthetic-password","thumbnail":"/thumb/photo.jpg?token=upstream-secret"}],"total":25,"private_key":"secret"}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	code, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.list", "params": map[string]any{"path": "/my", "page": 2, "pageSize": 12}})
	if code != 200 || v["ok"] != true {
		t.Fatalf("read failed: %v", v)
	}
	data := v["data"].(map[string]any)
	if data["total"] != float64(25) || len(data["items"].([]any)) != 1 {
		t.Fatal("normalization lost pagination")
	}
	b, _ := json.Marshal(v)
	for _, secret := range []string{"upstream-secret", "synthetic-password", "private_key"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("leaked %s", secret)
		}
	}
	request(t, g.URL, "POST", "/api/nas/logout", id, nil)
	code, _ = request(t, g.URL, "GET", "/api/nas/session", id, nil)
	if code != 401 {
		t.Fatal("logout failed")
	}
}
func TestExpiredBusinessSessionInvalidates(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"code":"N001208","msg":"secret=upstream-secret"}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	code, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.roots"})
	if code != 401 || v["ok"] != false {
		t.Fatal("business expiration ignored")
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "upstream-secret") {
		t.Fatal("error leaks secret")
	}
	code, _ = request(t, g.URL, "GET", "/api/nas/session", id, nil)
	if code != 401 {
		t.Fatal("expired session remains")
	}
}
func TestNoMutationOrParameterOverride(t *testing.T) {
	var n atomic.Int32
	up := fake(t, func(w http.ResponseWriter, r *http.Request) { n.Add(1); io.WriteString(w, `{"code":200,"data":{}}`) })
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	for _, body := range []map[string]any{{"operation": "files.delete"}, {"operation": "files.list", "params": map[string]any{"token": "attacker"}}, {"operation": "system.settings", "params": map[string]any{"action": "delete"}}} {
		code, _ := request(t, g.URL, "POST", "/api/nas/read", id, body)
		if code < 400 {
			t.Fatal("unsafe request accepted")
		}
	}
	if n.Load() != 0 {
		t.Fatal("unsafe params reached upstream")
	}
}
func TestMediaRangeAndCrossHostRedirect(t *testing.T) {
	var foreign atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { foreign.Add(1); io.WriteString(w, "bad") }))
	defer other.Close()
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/file/info":
			io.WriteString(w, `{"code":200,"data":{"id":"f1","name":"video","stream":"/play/ok?token=upstream-secret"}}`)
		case "/play/ok":
			if r.Header.Get("Range") == "bytes=0-511" {
				w.Header().Set("Content-Type", "video/mp4")
				w.Header().Set("Content-Range", "bytes 0-8/9")
				w.WriteHeader(206)
				w.Write([]byte("abc\x00\x00\x00\x00\x00\x00"))
				return
			}
			if r.Header.Get("Range") != "bytes=0-2" {
				t.Error("Range dropped")
			}
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Range", "bytes 0-2/9")
			w.WriteHeader(206)
			io.WriteString(w, "abc")
		case "/play/redirect":
			http.Redirect(w, r, other.URL, 302)
		}
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.info", "params": map[string]any{"path": "/my/a"}})
	item := v["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	media := item["stream"].(string)
	if !strings.HasPrefix(media, "/api/nas/media/") {
		t.Fatal("not opaque media reference")
	}
	r, _ := http.NewRequest("GET", g.URL+media, nil)
	r.Header.Set("Range", "bytes=0-2")
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 206 || string(b) != "abc" {
		t.Fatal("media failed")
	}
	request(t, g.URL, "POST", "/api/nas/logout", id, nil)
	resp, e = http.Get(g.URL + media)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("media survived logout")
	}
	if foreign.Load() != 0 {
		t.Fatal("cross host contacted")
	}
}

func TestMediaRedirectActuallyRejected(t *testing.T) {
	var contacts atomic.Int32
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { contacts.Add(1); io.WriteString(w, "secret") }))
	defer foreign.Close()
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/file/info" {
			io.WriteString(w, `{"code":200,"data":{"name":"file","stream":"/play/redirect"}}`)
		} else {
			http.Redirect(w, r, foreign.URL, 302)
		}
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.info", "params": map[string]any{"path": "/my/file"}})
	stream := v["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["stream"].(string)
	resp, e := http.Get(g.URL + stream)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 400 {
		t.Fatal("redirect allowed")
	}
	if contacts.Load() != 0 {
		t.Fatal("credentials could cross hosts")
	}
}
func TestForeignMediaURLNeverRegistered(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"code":200,"data":{"name":"file","stream":"http://example.net/play/a?token=upstream-secret","thumbnail":"http://user:pass@example.net/thumb/a"}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.info"})
	item := v["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if item["stream"] != "" || item["thumbnail"] != "" {
		t.Fatal("foreign/userinfo media admitted")
	}
}
func TestEveryVerifiedReadRouteIsAuthenticated(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v2/album/") && r.Form.Get("app") != "album" {
			t.Error("album app discriminator missing")
		}
		io.WriteString(w, `{"code":200,"data":{"list":[],"total":0}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	for op := range operations {
		code, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": op})
		if code != 200 || v["ok"] != true {
			t.Fatalf("%s failed: %v", op, v)
		}
	}
}

func TestMediaModulesAndPaginationMappings(t *testing.T) {
	expected := map[string]string{"video.libraries": "POST /zvideo/classification/list", "video.list": "POST /zvideo/video/v2/list", "video.info": "POST /zvideo/collection/v2/info", "video.play": "POST /zvideo/video/media", "music.songs": "POST /zmusic/api/v2/song/list", "music.albums": "GET /zmusic/api/v2/album/list", "music.playlists": "GET /zmusic/api/v2/playlist/list", "music.lyrics": "GET /zmusic/api/v2/song/info/lyrics", "music.play": "GET /transcode/audio/play", "downloads.list": "POST /downloader/list"}
	var want string
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method+" "+r.URL.Path != want {
			t.Errorf("wanted %s, got %s %s", want, r.Method, r.URL.Path)
		}
		if strings.HasPrefix(want, "POST /zvideo/video/v2/list") && (r.Form.Get("start") != "13" || r.Form.Get("limit") != "12") {
			t.Error("video page must map to start 13, limit 12")
		}
		if strings.HasPrefix(want, "POST /downloader/list") && (r.Form.Get("start") != "12" || r.Form.Get("size") != "12" || r.Form.Get("type") != "loading") {
			t.Error("downloads must use zero-based start 12, size 12")
		}
		io.WriteString(w, `{"code":200,"data":{"list":[],"count":0}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	for op, route := range expected {
		want = route
		params := map[string]any{}
		if op == "video.list" || op == "downloads.list" {
			params = map[string]any{"page": 2, "pageSize": 12}
		}
		code, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": op, "params": params})
		if code != 200 || v["ok"] != true {
			t.Fatalf("%s: %v", op, v)
		}
	}
}

func TestExtraVerificationAndMediaBusinessExpiry(t *testing.T) {
	_, e := DecodeResponse([]byte(`{"code":"N001414","msg":"check sms"}`))
	var a *APIError
	if !errors.As(e, &a) || a.Code != "CHALLENGE_REQUIRED" {
		t.Fatal("extra verification needs explicit status")
	}
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/file/info" {
			io.WriteString(w, `{"code":200,"data":{"name":"file","stream":"/play/expired"}}`)
		} else {
			io.WriteString(w, `{"code":"N001208","msg":"token=upstream-secret"}`)
		}
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.info"})
	stream := v["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["stream"].(string)
	resp, e := http.Get(g.URL + stream)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 401 || strings.Contains(string(b), "upstream-secret") {
		t.Fatal("media business expiration mishandled")
	}
	code, _ := request(t, g.URL, "GET", "/api/nas/session", id, nil)
	if code != 401 {
		t.Fatal("media expiry did not invalidate session")
	}
}

func TestAllUpstreamRedirectsRejected(t *testing.T) {
	var foreignCalls atomic.Int32
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		foreignCalls.Add(1)
		io.WriteString(w, `{"code":200,"data":{"token":"upstream-secret"}}`)
	}))
	defer foreign.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, foreign.URL, 307) }))
	defer redirect.Close()
	g := gateway(t)
	code, _ := request(t, g.URL, "POST", "/api/nas/login", "", map[string]any{"baseUrl": redirect.URL, "username": "synthetic-user", "password": "synthetic-password"})
	if code < 400 {
		t.Fatal("public-key redirect accepted")
	}
	up := fake(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, foreign.URL, 307) })
	id := sid(t, g.URL, up.URL)
	code, _ = request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.roots"})
	if code < 400 {
		t.Fatal("read redirect accepted")
	}
	if foreignCalls.Load() != 0 {
		t.Fatal("redirect followed with credentials")
	}
}
