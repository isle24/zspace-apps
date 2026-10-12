package store

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

func cloudRig(t *testing.T) (*testRig, *http.ServeMux) {
	t.Helper()
	r := newRig(t)
	mux := http.NewServeMux()
	if err := r.s.RegisterCloudHandlers(mux); err != nil {
		t.Fatal(err)
	}
	return r, mux
}

func cloudCall(t *testing.T, mux *http.ServeMux, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(string(b)))
	req.RemoteAddr = "192.0.2.8:4567"
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("status %d, invalid JSON response", w.Code)
	}
	return w.Code, out
}

func cloudRegister(t *testing.T, mux *http.ServeMux, username string) string {
	t.Helper()
	status, out := cloudCall(t, mux, "POST", "/api/cloud/register", "", map[string]string{"username": username, "password": "test-pass-6"})
	if status != 201 {
		t.Fatalf("registration status %d: %v", status, out)
	}
	data := out["data"].(map[string]any)
	if data["user"].(map[string]any)["role"] != "user" {
		t.Fatal("registration escalated privileges")
	}
	return data["sessionId"].(string)
}

func cloudAdmin(t *testing.T, r *testRig, mux *http.ServeMux) string {
	t.Helper()
	r.setup()
	status, out := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "synthetic-admin", "password": "synthetic-pass-123"})
	if status != 200 {
		t.Fatalf("existing admin login status %d: %v", status, out)
	}
	data := out["data"].(map[string]any)
	if data["user"].(map[string]any)["role"] != "admin" {
		t.Fatal("existing administrator lost privilege")
	}
	return data["sessionId"].(string)
}

func TestCloudRegistrationSessionOwnershipAndLogout(t *testing.T) {
	r, mux := cloudRig(t)
	token := cloudRegister(t, mux, "alice")
	if !regexp.MustCompile(`^[a-f0-9]{48}$`).MatchString(token) {
		t.Fatal("session format")
	}
	var hash, password string
	if err := r.s.db.QueryRow(`SELECT token_hash FROM cloud_sessions`).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if hash != tokenHash(token) || hash == token {
		t.Fatal("session stored in cleartext")
	}
	if err := r.s.db.QueryRow(`SELECT password_hash FROM cloud_accounts WHERE username='alice'`).Scan(&password); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(password, "$2") || password == "test-pass-6" {
		t.Fatal("password not hashed")
	}
	if status, _ := cloudCall(t, mux, "GET", "/api/cloud/me", "", nil); status != 401 {
		t.Fatal("unauthenticated me", status)
	}
	if status, _ := cloudCall(t, mux, "GET", "/api/cloud/catalog", token, nil); status != 200 {
		t.Fatal("catalog", status)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps", token, map[string]string{"id": "attempt"}); status != 403 {
		t.Fatal("user accessed admin", status)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/logout", token, map[string]any{}); status != 200 {
		t.Fatal("logout", status)
	}
	if status, _ := cloudCall(t, mux, "GET", "/api/cloud/me", token, nil); status != 401 {
		t.Fatal("revoked session reused", status)
	}
}

func TestCloudCredentialsBoundariesReservedAdminAndNoRoleInput(t *testing.T) {
	r, mux := cloudRig(t)
	admin := cloudAdmin(t, r, mux)
	if status, _ := cloudCall(t, mux, "GET", "/api/store/admin/apps", admin, nil); status != 200 {
		t.Fatal("existing admin cannot manage", status)
	}
	for _, in := range []map[string]any{
		{"username": "abc", "password": "abcdef"},
		{"username": "abcd", "password": "abcde"},
		{"username": "evil", "password": "abcdef", "role": "admin"},
	} {
		if status, _ := cloudCall(t, mux, "POST", "/api/cloud/register", "", in); status != 400 {
			t.Fatalf("invalid signup status %d", status)
		}
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/register", "", map[string]string{"username": "SYNTHETIC-ADMIN", "password": "abcdef"}); status != 409 {
		t.Fatal("reserved admin username", status)
	}
	cloudRegister(t, mux, "abcd")
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/register", "", map[string]string{"username": "ABCD", "password": "abcdef"}); status != 409 {
		t.Fatal("case-insensitive uniqueness", status)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "abcd", "password": "wrong-password"}); status != 401 {
		t.Fatal("wrong password", status)
	}
}

func TestCloudExpiredAndMalformedSessionsFailClosed(t *testing.T) {
	r, mux := cloudRig(t)
	token := cloudRegister(t, mux, "alice")
	if _, err := r.s.db.Exec(`UPDATE cloud_sessions SET expires_at=?`, time.Now().Add(-time.Second).Unix()); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{token, strings.Repeat("A", 48), "bad"} {
		if status, _ := cloudCall(t, mux, "GET", "/api/cloud/catalog", token, nil); status != 401 {
			t.Fatal("invalid session", status)
		}
	}
}

func TestCloudAuthRateLimitAppliesToRegistrationAndLogin(t *testing.T) {
	_, mux := cloudRig(t)
	for i := 0; i < 30; i++ {
		cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "missing", "password": "wrong-password"})
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "missing", "password": "wrong-password"}); status != 429 {
		t.Fatal("login rate limit", status)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/register", "", map[string]string{"username": "alice", "password": "test-pass-6"}); status != 429 {
		t.Fatal("signup shares abuse limit", status)
	}
}

func TestCloudWishlistAndHistoryArePerAccount(t *testing.T) {
	_, mux := cloudRig(t)
	a := cloudRegister(t, mux, "alice")
	b := cloudRegister(t, mux, "bobby")
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/wishlist", a, map[string]string{"name": "Reader", "description": "Wanted application", "image": "ghcr.io/acme/reader:1"}); status != 201 {
		t.Fatal("wishlist create", status)
	}
	if status, out := cloudCall(t, mux, "GET", "/api/cloud/wishlist", b, nil); status != 200 || len(out["data"].(map[string]any)["items"].([]any)) != 0 {
		t.Fatal("wishlist crosses account")
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/history", a, map[string]string{"appId": "uptime-kuma", "version": "2.5.6", "status": "installed", "deviceName": "My NAS"}); status != 201 {
		t.Fatal("history record", status)
	}
	if status, out := cloudCall(t, mux, "GET", "/api/cloud/history", b, nil); status != 200 || len(out["data"].(map[string]any)["items"].([]any)) != 0 {
		t.Fatal("history crosses account")
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/history", a, map[string]string{"appId": "uptime-kuma", "version": "2.5.6", "status": "removed", "deviceName": "My NAS"}); status != 201 {
		t.Fatal("history update", status)
	}
	status, out := cloudCall(t, mux, "GET", "/api/cloud/history", a, nil)
	items := out["data"].(map[string]any)["items"].([]any)
	if status != 200 || len(items) != 1 || items[0].(map[string]any)["status"] != "removed" {
		t.Fatal("history current record for reinstall")
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/history", a, map[string]string{"appId": "uptime-kuma", "version": "2.5.6", "status": "installed", "deviceName": "http://192.168.0.1:1234"}); status != 400 {
		t.Fatal("history stored address", status)
	}
}
