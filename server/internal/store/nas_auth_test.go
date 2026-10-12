package store

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNASAuthDisabledByDefault(t *testing.T) {
	r := newRig(t)
	status, out := r.call("GET", "/api/store/bootstrap", "", "127.0.0.1:1")
	auth, ok := out["data"].(map[string]any)["nasAuth"].(map[string]any)
	if status != 200 || !ok || auth["enabled"] != false || auth["origin"] != "" || auth["storeId"] != r.s.storeID {
		t.Fatalf("missing disabled provider status: %v", out)
	}
	status, _ = r.call("POST", "/api/store/nas-session", `{}`, "127.0.0.1:1")
	if status != 403 {
		t.Fatalf("unconfigured exchange: %d", status)
	}
}

func nasRig(t *testing.T, origin string) *testRig {
	t.Helper()
	r := newRig(t)
	r.setup()
	r.s.Close()
	r.opts.NASOrigin = origin
	s, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	r.s, r.mux = s, http.NewServeMux()
	s.Register(r.mux)
	t.Cleanup(func() { s.Close() })
	r.token = ""
	return r
}
func exchange(r *testRig, body map[string]any) (int, map[string]any) {
	if body == nil {
		body = map[string]any{"providerId": r.s.opts.NASOrigin, "storeId": r.s.storeID, "token": "synthetic-secret-token", "deviceId": "synthetic-device", "nasId": "synthetic-nas"}
	}
	b, _ := json.Marshal(body)
	return r.call("POST", "/api/store/nas-session", string(b), "127.0.0.1:1")
}
func TestNASAdminExchangeAndProtectedRecheck(t *testing.T) {
	var master atomic.Bool
	master.Store(true)
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls.Add(1)
		if req.Method != "POST" || req.URL.Path != "/auth/token" || req.URL.RawQuery != "" || req.Header.Get("Cookie") != "" {
			t.Errorf("bad verification boundary")
		}
		req.ParseForm()
		if req.Form.Get("token") != "synthetic-secret-token" || req.Form.Get("device_id") != "synthetic-device" || req.Form.Get("nasid") != "synthetic-nas" {
			t.Errorf("missing official session identity")
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"username": "nas-admin", "is_master": master.Load(), "token": "private-response-secret"}})
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	status, out := exchange(r, nil)
	if status != 200 {
		t.Fatalf("exchange %d %v", status, out)
	}
	data := out["data"].(map[string]any)
	if data["authSource"] != "nas" || data["username"] != "nas-admin" || strings.Contains(fmtJSON(out), "synthetic-secret") || strings.Contains(fmtJSON(out), "private-response") {
		t.Fatal(out)
	}
	r.token = data["sessionId"].(string)
	if len(r.token) != 48 {
		t.Fatal("invalid session")
	}
	exp, _ := time.Parse(time.RFC3339Nano, data["expiresAt"].(string))
	if ttl := time.Until(exp); ttl < 19*time.Minute || ttl > 20*time.Minute {
		t.Fatal(ttl)
	}
	for _, path := range []string{"roots", "storage", "instances", "jobs", "catalog", "status"} {
		if code, _ := r.call("GET", "/api/store/"+path, "", "127.0.0.1:1"); code != 200 {
			t.Fatal(path, code)
		}
	}
	if calls.Load() != 7 {
		t.Fatal("protected reads were not reverified", calls.Load())
	}
	var persisted int
	if err := r.s.db.QueryRow("SELECT count(*) FROM sessions").Scan(&persisted); err != nil || persisted != 1 {
		t.Fatal("NAS sessions persisted", persisted, err)
	}
	for _, name := range []string{"store.sqlite", "store.sqlite-wal"} {
		raw, _ := os.ReadFile(filepath.Join(r.opts.DataDir, name))
		if strings.Contains(string(raw), "synthetic-secret-token") || strings.Contains(string(raw), "nas-admin") {
			t.Fatal("NAS credential/identity persisted")
		}
	}
	master.Store(false)
	if code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); code != 401 {
		t.Fatal("ordinary account retained privileges", code)
	}
	master.Store(true)
	if code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); code != 401 {
		t.Fatal("revoked session restored", code)
	}
}
func fmtJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func TestNASExchangeDeniesUnsafeAuthorityAndEnvelope(t *testing.T) {
	for _, body := range []string{
		`{"code":200,"data":{"username":"u","is_master":0}}`, `{"code":200,"data":{"username":"u"}}`,
		`{"code":200,"data":{"username":"u","is_master":"1"}}`, `{"code":200,"data":{"username":"u","is_master":{}}}`,
		`{"code":200,"data":{"username":"","is_master":1}}`, `{"code":"N001208","data":{"username":"u","is_master":1},"message":"synthetic-secret-token"}`,
		`{"ok":true,"data":{"username":"u","is_master":1}}`, `{"code":200,"data":{"username":"u","is_master":2}}`,
		`{"code":200,"data":{"username":"u","is_master":1}} {}`, `not JSON synthetic-secret-token`,
	} {
		t.Run(body, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { w.Write([]byte(body)) }))
			defer up.Close()
			r := nasRig(t, up.URL)
			code, out := exchange(r, nil)
			if code != 401 || strings.Contains(fmtJSON(out), "synthetic-secret-token") {
				t.Fatal(code, out)
			}
		})
	}
	for _, master := range []string{"1", "true"} {
		up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Write([]byte(`{"code":"S000200","data":{"username":"u","is_master":` + master + `}}`))
		}))
		r := nasRig(t, up.URL)
		code, _ := exchange(r, nil)
		up.Close()
		if code != 200 {
			t.Fatal(master, code)
		}
	}
}
func TestNASExchangeRejectsMismatchedBindingAndInputBeforeSending(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer up.Close()
	r := nasRig(t, up.URL)
	for _, change := range []map[string]any{{"providerId": "http://other.invalid"}, {"storeId": "other"}, {"token": ""}, {"token": strings.Repeat("x", 8193)}, {"deviceId": ""}, {"nasId": ""}, {"targetUrl": up.URL}, {"is_master": true}} {
		body := map[string]any{"providerId": up.URL, "storeId": r.s.storeID, "token": "synthetic-secret-token", "deviceId": "synthetic-device", "nasId": "synthetic-nas"}
		for k, v := range change {
			body[k] = v
		}
		if code, _ := exchange(r, body); code != 400 {
			t.Fatal(change, code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid requests reached provider")
	}
}
func TestNASOriginValidation(t *testing.T) {
	for _, origin := range []string{"http://user:secret@host", "http://host/path", "http://host/", "http://host?token=secret", "http://host#x", "HTTP://host", "http://HOST", "http://host:80", "http://host:0", "http://host:65536", "http://0.0.0.0", "http://[::]", "http://host\\evil", "http://host?", "http://host#", "http://host:00123", "file:///tmp/a"} {
		r := newRig(t)
		r.s.Close()
		r.opts.NASOrigin = origin
		if s, err := New(r.opts); err == nil {
			s.Close()
			t.Fatal("unsafe/noncanonical origin accepted", origin)
		}
	}
	for _, origin := range []string{"http://127.0.0.1:5055", "https://nas.example", "http://[::1]:5055"} {
		r := newRig(t)
		r.s.Close()
		r.opts.NASOrigin = origin
		s, err := New(r.opts)
		if err != nil {
			t.Fatal(origin, err)
		}
		s.Close()
	}
}
func TestNASLogoutWithUnreachableProviderAndRestart(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200,"data":{"username":"u","is_master":1}}`))
	}))
	r := nasRig(t, up.URL)
	code, out := exchange(r, nil)
	if code != 200 {
		t.Fatal(code, out)
	}
	r.token = out["data"].(map[string]any)["sessionId"].(string)
	up.Close()
	if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
		t.Fatal("offline logout failed", code)
	}
	if code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); code != 401 {
		t.Fatal("logout did not revoke")
	}
	r.s.Close()
	s, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r.s = s
	r.mux = http.NewServeMux()
	s.Register(r.mux)
	if code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); code != 401 {
		t.Fatal("restart restored NAS session")
	}
	// Independent passwords remain usable while the provider is down.
	r.token = ""
	if code, _ := r.call("POST", "/api/store/login", `{"username":"synthetic-admin","password":"synthetic-pass-123"}`, "127.0.0.1:1"); code != 200 {
		t.Fatal("password login changed", code)
	}
}
func TestNASRedirectAndResponseBounds(t *testing.T) {
	var received atomic.Int32
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received.Add(1) }))
	defer sink.Close()
	for _, mode := range []string{"redirect", "oversize", "status"} {
		t.Run(mode, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "redirect":
					http.Redirect(w, r, sink.URL, 307)
				case "oversize":
					w.Write([]byte(`{"code":200,"data":{"username":"u","is_master":1},"extra":"` + strings.Repeat("x", 65536) + `"}`))
				default:
					w.WriteHeader(500)
					w.Write([]byte("synthetic-secret-token"))
				}
			}))
			defer up.Close()
			r := nasRig(t, up.URL)
			code, out := exchange(r, nil)
			if code != 401 || strings.Contains(fmtJSON(out), "synthetic-secret-token") {
				t.Fatal(code, out)
			}
		})
	}
	if received.Load() != 0 {
		t.Fatal("redirect forwarded token")
	}
}
func TestNASVerificationHonorsRequestCancellation(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	defer up.Close()
	r := nasRig(t, up.URL)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b, _ := json.Marshal(map[string]string{"providerId": up.URL, "storeId": r.s.storeID, "token": "synthetic-secret-token", "deviceId": "d", "nasId": "n"})
	req := httptest.NewRequest("POST", "/api/store/nas-session", strings.NewReader(string(b))).WithContext(ctx)
	rec := httptest.NewRecorder()
	r.mux.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatal(rec.Code)
	}
}

func TestNASPendingVerificationCannotSurviveLogoutOrRoleRevocation(t *testing.T) {
	for _, action := range []string{"logout", "role-revoke", "expire", "replace", "close"} {
		t.Run(action, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var checks atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := checks.Add(1)
				if n == 2 {
					close(entered)
					<-release
				}
				master := 1
				if n == 3 && action == "role-revoke" {
					master = 0
				}
				json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"username": "u", "is_master": master}})
			}))
			defer up.Close()
			r := nasRig(t, up.URL)
			code, out := exchange(r, nil)
			if code != 200 {
				t.Fatal(code, out)
			}
			r.token = out["data"].(map[string]any)["sessionId"].(string)
			done := make(chan int, 1)
			req := httptest.NewRequest("GET", "/api/store/roots", nil)
			req.Header.Set("X-Store-Session", r.token)
			go func() { w := httptest.NewRecorder(); r.mux.ServeHTTP(w, req); done <- w.Code }()
			<-entered
			hash := tokenHash(r.token)
			switch action {
			case "logout":
				if c, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); c != 200 {
					t.Fatal(c)
				}
			case "role-revoke":
				if c, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); c != 401 {
					t.Fatal(c)
				}
			case "expire":
				r.s.nasMu.Lock()
				r.s.nasSessions[hash].expiresAt = time.Now().Add(-time.Second)
				r.s.nasMu.Unlock()
			case "replace":
				r.s.nasMu.Lock()
				old := r.s.nasSessions[hash]
				ctx, cancel := context.WithCancel(r.s.ctx)
				r.s.nasSessions[hash] = &nasMemorySession{credentials: old.credentials, username: old.username, expiresAt: old.expiresAt, ctx: ctx, cancel: cancel}
				old.cancel()
				r.s.nasMu.Unlock()
			case "close":
				r.s.Close()
			}
			close(release)
			select {
			case c := <-done:
				if c != 401 {
					t.Fatal("late request authorized", c)
				}
			case <-time.After(time.Second):
				t.Fatal("request did not finish")
			}
		})
	}
}
func TestNASSessionLimitExpiryAndNoActiveEviction(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200,"data":{"username":"u","is_master":1}}`))
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	var first string
	for i := 0; i < nasSessionLimit; i++ {
		code, out := exchange(r, nil)
		if code != 200 {
			t.Fatal(i, code, out)
		}
		if i == 0 {
			first = out["data"].(map[string]any)["sessionId"].(string)
		}
	}
	if code, _ := exchange(r, nil); code != 429 {
		t.Fatal("saturation evicted session", code)
	}
	r.token = first
	if code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); code != 200 {
		t.Fatal("active session evicted", code)
	}
	r.s.nasMu.Lock()
	r.s.nasSessions[tokenHash(first)].expiresAt = time.Now().Add(-time.Second)
	r.s.nasMu.Unlock()
	if code, _ := exchange(r, nil); code != 200 {
		t.Fatal("expired entries not pruned", code)
	}
	if code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); code != 401 {
		t.Fatal("expired token accepted", code)
	}
	r.s.Close()
	r.s.nasMu.Lock()
	defer r.s.nasMu.Unlock()
	if len(r.s.nasSessions) != 0 {
		t.Fatal("Close retained credentials")
	}
}
func TestNASProviderTimeoutAndProxyEnvironmentIsolation(t *testing.T) {
	// ProxyFromEnvironment must never be used for this private credential path.
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	r := nasRig(t, up.URL)
	transport, ok := r.s.nasClient.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil || r.s.nasClient.Timeout != 5*time.Second {
		t.Fatal("unsafe credential transport")
	}
	start := time.Now()
	code, out := exchange(r, nil)
	elapsed := time.Since(start)
	up.Close()
	if code != 401 || elapsed < 4*time.Second || elapsed > 6*time.Second {
		t.Fatal("timeout boundary", code, out, elapsed)
	}
}
func TestNASConflictingFailureAndSecretUsernameAreDenied(t *testing.T) {
	for _, body := range []string{
		`{"code":200,"ok":false,"data":{"username":"u","is_master":1}}`,
		`{"code":200,"success":false,"data":{"username":"u","is_master":1}}`,
		`{"code":200,"error":"private-secret-message","data":{"username":"u","is_master":1}}`,
		`{"code":200,"data":{"username":"synthetic-secret-token","is_master":1}}`,
		`{"code":"N001208","code":200,"data":{"username":"u","is_master":1}}`,
		`{"code":200,"data":{"username":"u","is_master":0,"is_master":1}}`,
		`{"code":"N001208","Code":200,"data":{"username":"u","is_master":1}}`,
		`{"Code":200,"data":{"username":"u","is_master":1}}`,
		`{"code":200,"data":{"Username":"u","IS_MASTER":1}}`,
	} {
		t.Run(body, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
			defer up.Close()
			r := nasRig(t, up.URL)
			code, out := exchange(r, nil)
			if code != 401 || strings.Contains(fmtJSON(out), "secret") {
				t.Fatal("unsafe envelope accepted", code, out)
			}
		})
	}
}
func TestNASLogoutCancelsPreviouslyAdmittedHandler(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200,"data":{"username":"u","is_master":1}}`))
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	code, out := exchange(r, nil)
	if code != 200 {
		t.Fatal(code)
	}
	r.token = out["data"].(map[string]any)["sessionId"].(string)
	entered, finished := make(chan struct{}), make(chan struct{})
	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("X-Store-Session", r.token)
	go func() {
		defer close(finished)
		r.s.auth(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() })(httptest.NewRecorder(), req)
	}()
	<-entered
	if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
		t.Fatal(code)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("logout did not cancel protected operation")
	}
}

func TestNASDoesNotBypassInitialLoopbackAdministratorSetup(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer up.Close()
	r := newRig(t)
	r.s.Close()
	r.opts.NASOrigin = up.URL
	s, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r.s = s
	r.mux = http.NewServeMux()
	s.Register(r.mux)
	if code, _ := exchange(r, nil); code != 403 {
		t.Fatal("NAS bypassed independent setup", code)
	}
	if calls.Load() != 0 {
		t.Fatal("sent token before administrator setup")
	}
	if code, _ := r.call("POST", "/api/store/setup", `{"username":"synthetic-admin","password":"synthetic-pass-123"}`, "192.0.2.1:1"); code != 403 {
		t.Fatal("loopback setup weakened", code)
	}
}
func TestNASAuthorityMustBeFreshForEveryProtectedWrite(t *testing.T) {
	var master atomic.Bool
	master.Store(true)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"username": "u", "is_master": master.Load()}})
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	for _, route := range []string{"/api/store/roots", "/api/store/plans", "/api/store/install", "/api/store/instances/fake/start", "/api/store/instances/fake/stop", "/api/store/instances/fake/retry-plan"} {
		master.Store(true)
		code, out := exchange(r, nil)
		if code != 200 {
			t.Fatal(code)
		}
		r.token = out["data"].(map[string]any)["sessionId"].(string)
		master.Store(false)
		if code, _ := r.call("POST", route, `{}`, "127.0.0.1:1"); code != 401 {
			t.Fatal("protected write accepted ordinary account", route, code)
		}
	}
	if r.e.starts != 0 || r.e.stops != 0 || len(r.e.runs) != 0 {
		t.Fatal("denied request changed engine")
	}
}
func TestNASSessionsCarryExpiryCancellation(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200,"data":{"username":"u","is_master":1}}`))
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	code, out := exchange(r, nil)
	if code != 200 {
		t.Fatal(code)
	}
	hash := tokenHash(out["data"].(map[string]any)["sessionId"].(string))
	r.s.nasMu.Lock()
	entry := r.s.nasSessions[hash]
	deadline, ok := entry.ctx.Deadline()
	r.s.nasMu.Unlock()
	if !ok || !deadline.Equal(entry.expiresAt) {
		t.Fatal("admitted operations can outlive the session expiry")
	}
}

func TestNASVerifierDoesNotInheritGlobalTransport(t *testing.T) {
	original := http.DefaultTransport
	defer func() { http.DefaultTransport = original }()
	http.DefaultTransport = &http.Transport{Proxy: func(*http.Request) (*url.URL, error) { return url.Parse("http://private-proxy.invalid") }, TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	client := newNASClient()
	defer client.CloseIdleConnections()
	tr := client.Transport.(*http.Transport)
	if tr.TLSClientConfig != nil && tr.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("private identity verifier inherited unsafe global TLS settings")
	}
}

func TestNASMalformedUTF8IdentityIsDenied(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("{\"code\":200,\"data\":{\"username\":\"\xff\",\"is_master\":1}}"))
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	if code, _ := exchange(r, nil); code != 401 {
		t.Fatal("malformed identity accepted", code)
	}
}
func TestNASLogoutCancellationCannotWaitForNoncooperativeHandler(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200,"data":{"username":"u","is_master":1}}`))
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	code, out := exchange(r, nil)
	if code != 200 {
		t.Fatal(code)
	}
	r.token = out["data"].(map[string]any)["sessionId"].(string)
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("X-Store-Session", r.token)
	go func() {
		defer close(finished)
		r.s.auth(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release })(httptest.NewRecorder(), req)
	}()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	logout := httptest.NewRequest("POST", "/api/store/logout", nil).WithContext(ctx)
	logout.Header.Set("X-Store-Session", r.token)
	start := time.Now()
	rec := httptest.NewRecorder()
	r.mux.ServeHTTP(rec, logout)
	close(release)
	<-finished
	if rec.Code != 200 || time.Since(start) > time.Second {
		t.Fatal("canceled logout waited for handler", rec.Code)
	}
	if code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); code != 401 {
		t.Fatal("canceled logout did not revoke", code)
	}
}

func TestNASEncodedCredentialEchoCannotBecomePublicIdentity(t *testing.T) {
	secret := "synthetic+/token secret"
	component := strings.ReplaceAll(url.QueryEscape(secret), "+", "%20")
	for _, echo := range []string{secret, component, strings.ReplaceAll(url.QueryEscape(component), "+", "%20"), url.PathEscape(url.QueryEscape(secret)), url.QueryEscape(secret), url.QueryEscape(url.QueryEscape(secret)), url.PathEscape(secret), url.PathEscape(url.PathEscape(secret)), base64.StdEncoding.EncodeToString([]byte(secret)), base64.RawStdEncoding.EncodeToString([]byte(secret)), base64.URLEncoding.EncodeToString([]byte(secret)), base64.RawURLEncoding.EncodeToString([]byte(secret)), strings.ToLower(url.QueryEscape(secret))} {
		t.Run(echo, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"username": "admin-" + echo, "is_master": 1}})
			}))
			defer up.Close()
			r := nasRig(t, up.URL)
			code, out := exchange(r, map[string]any{"providerId": up.URL, "storeId": r.s.storeID, "token": secret, "deviceId": "d", "nasId": "n"})
			if code != 401 || strings.Contains(fmtJSON(out), echo) {
				t.Fatal("encoded NAS credential escaped through identity", code)
			}
		})
	}
}

// This body deliberately ignores cancellation, like a client that stalls a
// request after authentication. Real handlers must fence before writing.
type delayedNASBody struct {
	*strings.Reader
	entered, release chan struct{}
	once             sync.Once
}

func (b *delayedNASBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered); <-b.release })
	return b.Reader.Read(p)
}
func (b *delayedNASBody) Close() error { return nil }

func nasMutationRig(t *testing.T) (*testRig, *atomic.Bool) {
	t.Helper()
	master := &atomic.Bool{}
	master.Store(true)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"username": "u", "is_master": master.Load()}})
	}))
	t.Cleanup(up.Close)
	r := nasRig(t, up.URL)
	code, out := exchange(r, nil)
	if code != 200 {
		t.Fatal(code, out)
	}
	r.token = out["data"].(map[string]any)["sessionId"].(string)
	return r, master
}
func TestNASDelayedInstallCannotCommitAfterRevocation(t *testing.T) {
	for _, cause := range []string{"logout", "cancel", "expire", "role-revoke", "replacement"} {
		t.Run(cause, func(t *testing.T) {
			r, master := nasMutationRig(t)
			plan := r.plan("uptime-kuma", "delayed-install", "")
			body := &delayedNASBody{Reader: strings.NewReader(fmtJSON(map[string]any{"planId": plan["id"], "requestId": "delayed-install"})), entered: make(chan struct{}), release: make(chan struct{})}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := httptest.NewRequest("POST", "/api/store/install", body).WithContext(ctx)
			req.Header.Set("X-Store-Session", r.token)
			done := make(chan int, 1)
			go func() { w := httptest.NewRecorder(); r.mux.ServeHTTP(w, req); done <- w.Code }()
			<-body.entered
			switch cause {
			case "logout":
				if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
					t.Fatal(code)
				}
			case "cancel":
				cancel()
			case "expire":
				r.s.nasMu.Lock()
				r.s.nasSessions[tokenHash(r.token)].expiresAt = time.Now().Add(-time.Second)
				r.s.nasMu.Unlock()
			case "role-revoke":
				master.Store(false)
				if code, _ := r.call("GET", "/api/store/roots", "", "127.0.0.1:1"); code != 401 {
					t.Fatal(code)
				}
			case "replacement":
				r.s.nasMu.Lock()
				old := r.s.nasSessions[tokenHash(r.token)]
				newctx, newcancel := context.WithDeadline(r.s.ctx, old.expiresAt)
				r.s.nasSessions[tokenHash(r.token)] = &nasMemorySession{credentials: old.credentials, username: old.username, expiresAt: old.expiresAt, ctx: newctx, cancel: newcancel}
				old.cancel()
				r.s.nasMu.Unlock()
			}
			close(body.release)
			code := <-done
			var jobs, instances int
			r.s.db.QueryRow("SELECT count(*) FROM jobs").Scan(&jobs)
			r.s.db.QueryRow("SELECT count(*) FROM instances").Scan(&instances)
			if code != 401 || jobs != 0 || instances != 0 {
				t.Fatalf("revoked delayed install committed: status %d jobs %d instances %d", code, jobs, instances)
			}
		})
	}
}
func TestNASInstallMutexWaitCannotCommitAfterRevocation(t *testing.T) {
	r, _ := nasMutationRig(t)
	plan := r.plan("uptime-kuma", "mutex-install", "")
	body := &delayedNASBody{Reader: strings.NewReader(fmtJSON(map[string]any{"planId": plan["id"], "requestId": "mutex-install"})), entered: make(chan struct{}), release: make(chan struct{})}
	req := httptest.NewRequest("POST", "/api/store/install", body)
	req.Header.Set("X-Store-Session", r.token)
	r.s.mu.Lock()
	done := make(chan int, 1)
	go func() { w := httptest.NewRecorder(); r.mux.ServeHTTP(w, req); done <- w.Code }()
	<-body.entered
	close(body.release)
	if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
		r.s.mu.Unlock()
		t.Fatal(code)
	}
	r.s.mu.Unlock()
	code := <-done
	var jobs int
	r.s.db.QueryRow("SELECT count(*) FROM jobs").Scan(&jobs)
	if code != 401 || jobs != 0 {
		t.Fatal("mutex wait restored write authority", code, jobs)
	}
}
func TestNASDelayedPlanAndRootBodyCannotCommitAfterCancellation(t *testing.T) {
	for _, route := range []string{"plans", "roots"} {
		t.Run(route, func(t *testing.T) {
			r, _ := nasMutationRig(t)
			input := map[string]any{"appId": "uptime-kuma", "rootId": "storage", "directory": "delayed-plan", "hostPort": 32123}
			if route == "roots" {
				input = map[string]any{"path": r.root, "name": "changed-name"}
			}
			var before string
			r.s.db.QueryRow("SELECT body FROM storage_roots WHERE id='storage'").Scan(&before)
			body := &delayedNASBody{Reader: strings.NewReader(fmtJSON(input)), entered: make(chan struct{}), release: make(chan struct{})}
			ctx, cancel := context.WithCancel(context.Background())
			req := httptest.NewRequest("POST", "/api/store/"+route, body).WithContext(ctx)
			req.Header.Set("X-Store-Session", r.token)
			done := make(chan int, 1)
			go func() { w := httptest.NewRecorder(); r.mux.ServeHTTP(w, req); done <- w.Code }()
			<-body.entered
			cancel()
			close(body.release)
			code := <-done
			var count int
			var after string
			r.s.db.QueryRow("SELECT count(*) FROM plans").Scan(&count)
			r.s.db.QueryRow("SELECT body FROM storage_roots WHERE id='storage'").Scan(&after)
			if code != 401 || count != 0 || before != after {
				t.Fatal("canceled body changed metadata", route, code, count, before == after)
			}
		})
	}
}

type nasDelayedInspectEngine struct {
	*fakeEngine
	entered, release chan struct{}
	once             sync.Once
}

func (e *nasDelayedInspectEngine) Inspect(ctx context.Context, name string) (Container, error) {
	e.once.Do(func() { close(e.entered); <-e.release })
	return e.fakeEngine.Inspect(ctx, name)
}
func TestNASStateEngineWaitCannotActAfterRevocation(t *testing.T) {
	r, _ := nasMutationRig(t)
	p := r.plan("uptime-kuma", "state-wait", "")
	job := r.install(p, "state-wait")
	r.waitJob(job["id"].(string))
	engine := &nasDelayedInspectEngine{fakeEngine: r.e, entered: make(chan struct{}), release: make(chan struct{})}
	r.s.engine = engine
	req := httptest.NewRequest("POST", "/api/store/instances/"+job["instanceId"].(string)+"/stop", strings.NewReader(`{}`))
	req.Header.Set("X-Store-Session", r.token)
	done := make(chan int, 1)
	go func() { w := httptest.NewRecorder(); r.mux.ServeHTTP(w, req); done <- w.Code }()
	<-engine.entered
	if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
		t.Fatal(code)
	}
	close(engine.release)
	code := <-done
	if code != 401 || r.e.stops != 0 {
		t.Fatal("revoked engine-wait request stopped container", code, r.e.stops)
	}
}

func TestNASCommittedInstallContinuesAfterLogout(t *testing.T) {
	r, _ := nasMutationRig(t)
	p := r.plan("uptime-kuma", "accepted-before-logout", "")
	job := r.install(p, "accepted-before-logout")
	if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
		t.Fatal(code)
	}
	// A previously committed job retains its original service-owned lifetime.
	r.token = ""
	code, out := r.call("POST", "/api/store/login", `{"username":"synthetic-admin","password":"synthetic-pass-123"}`, "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code)
	}
	r.token = out["data"].(map[string]any)["sessionId"].(string)
	finished := r.waitJob(job["id"].(string))
	if finished["status"] != "completed" {
		t.Fatal("logout altered accepted job", finished)
	}
}

func TestNASReconciliationEngineWaitCannotWriteAfterLogout(t *testing.T) {
	r, _ := nasMutationRig(t)
	p := r.plan("uptime-kuma", "reconcile-wait", "")
	job := r.install(p, "reconcile-wait")
	r.waitJob(job["id"].(string))
	var before string
	r.s.db.QueryRow("SELECT body FROM instances WHERE id=?", job["instanceId"]).Scan(&before)
	r.e.mu.Lock()
	for name, c := range r.e.containers {
		c.State = "exited"
		r.e.containers[name] = c
	}
	r.e.mu.Unlock()
	engine := &nasDelayedInspectEngine{fakeEngine: r.e, entered: make(chan struct{}), release: make(chan struct{})}
	r.s.engine = engine
	req := httptest.NewRequest("GET", "/api/store/instances", nil)
	req.Header.Set("X-Store-Session", r.token)
	done := make(chan int, 1)
	go func() { w := httptest.NewRecorder(); r.mux.ServeHTTP(w, req); done <- w.Code }()
	<-engine.entered
	if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
		t.Fatal(code)
	}
	close(engine.release)
	code := <-done
	var after string
	r.s.db.QueryRow("SELECT body FROM instances WHERE id=?", job["instanceId"]).Scan(&after)
	if code != 401 || before != after {
		t.Fatal("revoked read reconciled metadata", code, before == after)
	}
}

func TestNASInstallDatabaseWaitCannotCommitAfterLogout(t *testing.T) {
	r, _ := nasMutationRig(t)
	p := r.plan("uptime-kuma", "database-wait", "")
	reservation, err := r.s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	body := &delayedNASBody{Reader: strings.NewReader(fmtJSON(map[string]any{"planId": p["id"], "requestId": "database-wait"})), entered: make(chan struct{}), release: make(chan struct{})}
	req := httptest.NewRequest("POST", "/api/store/install", body)
	req.Header.Set("X-Store-Session", r.token)
	done := make(chan int, 1)
	go func() { w := httptest.NewRecorder(); r.mux.ServeHTTP(w, req); done <- w.Code }()
	<-body.entered
	close(body.release)
	if code, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); code != 200 {
		reservation.Rollback()
		t.Fatal(code)
	}
	reservation.Rollback()
	code := <-done
	var jobs int
	r.s.db.QueryRow("SELECT count(*) FROM jobs").Scan(&jobs)
	if code != 401 || jobs != 0 {
		t.Fatal("database wait committed after logout", code, jobs)
	}
}

func TestNASMetadataDatabaseWaitDoesNotBlockLocalLogout(t *testing.T) {
	r, _ := nasMutationRig(t)
	r.plan("uptime-kuma", "seed-plan", "")
	engine := &nasDelayedInspectEngine{fakeEngine: r.e, entered: make(chan struct{}), release: make(chan struct{})}
	r.s.engine = engine
	req := httptest.NewRequest("POST", "/api/store/plans", strings.NewReader(fmtJSON(map[string]any{"appId": "uptime-kuma", "rootId": "storage", "directory": "waiting-plan", "hostPort": 32124})))
	req.Header.Set("X-Store-Session", r.token)
	done := make(chan int, 1)
	go func() { w := httptest.NewRecorder(); r.mux.ServeHTTP(w, req); done <- w.Code }()
	<-engine.entered
	reservation, err := r.s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	initialWait := r.s.db.Stats().WaitCount
	close(engine.release)
	limit := time.Now().Add(time.Second)
	for r.s.db.Stats().WaitCount == initialWait && time.Now().Before(limit) {
		time.Sleep(time.Millisecond)
	}
	if r.s.db.Stats().WaitCount == initialWait {
		reservation.Rollback()
		<-done
		t.Fatal("request did not reach database wait")
	}
	logoutDone := make(chan int, 1)
	go func() {
		w := httptest.NewRecorder()
		logout := httptest.NewRequest("POST", "/api/store/logout", nil)
		logout.Header.Set("X-Store-Session", r.token)
		r.mux.ServeHTTP(w, logout)
		logoutDone <- w.Code
	}()
	immediate := true
	var logoutCode int
	select {
	case logoutCode = <-logoutDone:
	case <-time.After(250 * time.Millisecond):
		immediate = false
	}
	reservation.Rollback()
	code := <-done
	if !immediate {
		logoutCode = <-logoutDone
	}
	if !immediate || logoutCode != 200 || code != 401 {
		t.Fatal("database wait blocked local revocation", immediate, logoutCode, code)
	}
	var count int
	r.s.db.QueryRow("SELECT count(*) FROM plans").Scan(&count)
	if count != 1 {
		t.Fatal("uncommitted plan survived logout", count)
	}
}

func TestExplicitNASAdminOnlyDoesNotRequireOrCreatePasswordAccount(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("token") != "synthetic-secret-token" {
			t.Error("invalid identity token")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"code":"200","data":{"username":"owner","is_master":1}}`)
	}))
	defer provider.Close()
	r := newRig(t)
	r.s.Close()
	r.opts.NASOrigin = provider.URL
	r.opts.NASAdminOnly = true
	service, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	r.s = service
	r.mux = http.NewServeMux()
	service.Register(r.mux)
	if !service.configured() {
		t.Fatal("explicit NAS administrator mode requires a password bootstrap")
	}
	status, out := exchange(r, nil)
	if status != 200 {
		t.Fatalf("NAS exchange failed: %d %v", status, out)
	}
	var count int
	if service.db.QueryRow(`SELECT count(*) FROM admin`).Scan(&count) != nil || count != 0 {
		t.Fatal("NAS login created a hidden password account")
	}
}
func TestNASAdminOnlyWithoutProviderFailsClosed(t *testing.T) {
	r := newRig(t)
	r.s.Close()
	r.opts.NASAdminOnly = true
	s, err := New(r.opts)
	if s != nil {
		s.Close()
	}
	if err == nil {
		t.Fatal("accepted NAS-only mode without an explicit identity origin")
	}
}
