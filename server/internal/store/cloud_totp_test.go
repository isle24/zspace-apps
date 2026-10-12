package store

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func cloudTestOTP(t *testing.T, secret string, step int64) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		t.Fatal("invalid test secret")
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 15
	return fmt.Sprintf("%06d", (binary.BigEndian.Uint32(sum[offset:offset+4])&0x7fffffff)%1000000)
}
func cloudTwoFactorSetup(t *testing.T, mux *http.ServeMux, admin string) map[string]any {
	t.Helper()
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/2fa/setup", admin, map[string]string{"password": "synthetic-pass-123"})
	if status != 200 {
		t.Fatalf("setup status %d: %v", status, out)
	}
	setup := out["data"].(map[string]any)
	if !strings.HasPrefix(setup["qrDataUrl"].(string), "data:image/png;base64,") || !strings.HasPrefix(setup["otpauthUri"].(string), "otpauth://totp/") {
		t.Fatal("authenticator QR absent")
	}
	return setup
}
func cloudTwoFactorConfirm(t *testing.T, mux *http.ServeMux, admin string, setup map[string]any, step int64) {
	t.Helper()
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/2fa/confirm", admin, map[string]string{"password": "synthetic-pass-123", "otp": cloudTestOTP(t, setup["secret"].(string), step), "challengeId": setup["challengeId"].(string)})
	if status != 200 {
		t.Fatalf("confirm status %d: %v", status, out)
	}
}
func cloudTwoFactorOtherAdmin(t *testing.T, mux *http.ServeMux) string {
	t.Helper()
	status, out := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "synthetic-admin", "password": "synthetic-pass-123"})
	if status != 200 {
		t.Fatalf("second login %d", status)
	}
	return out["data"].(map[string]any)["sessionId"].(string)
}
func cloudTwoFactorRig(t *testing.T) (*testRig, *http.ServeMux, time.Time) {
	t.Helper()
	r := newRig(t)
	c, err := newCloudService(r.s)
	if err != nil {
		t.Fatal(err)
	}
	fixed := time.Now().UTC().Truncate(30 * time.Second).Add(10 * time.Second)
	c.twoFactorNow = func() time.Time { return fixed }
	mux := http.NewServeMux()
	c.register(mux)
	return r, mux, fixed
}
func TestCloudTwoFactorBindingRequiresCorrectPasswordAndOTP(t *testing.T) {
	t.Setenv("SPACE_ADMIN_2FA_REQUIRED", "")
	r, mux, now := cloudTwoFactorRig(t)
	admin := cloudAdmin(t, r, mux)
	other := cloudTwoFactorOtherAdmin(t, mux)
	setup := cloudTwoFactorSetup(t, mux, admin)
	for _, in := range []map[string]string{
		{"password": "wrong-pass", "otp": cloudTestOTP(t, setup["secret"].(string), now.Unix()/30), "challengeId": setup["challengeId"].(string)},
		{"password": "synthetic-pass-123", "otp": "abcdef", "challengeId": setup["challengeId"].(string)},
	} {
		if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/2fa/confirm", admin, in); status != 401 {
			t.Fatal("invalid bind accepted", status)
		}
	}
	if status, out := cloudCall(t, mux, "GET", "/api/store/admin/2fa", admin, nil); status != 200 || out["data"].(map[string]any)["bound"] != false {
		t.Fatal("activated before OTP proof", status, out)
	}
	cloudTwoFactorConfirm(t, mux, admin, setup, now.Unix()/30-1)
	if status, out := cloudCall(t, mux, "GET", "/api/store/admin/2fa", admin, nil); status != 200 || out["data"].(map[string]any)["enabled"] != true || out["data"].(map[string]any)["pending"] != false {
		t.Fatal("not bound", status, out)
	}
	if status, _ := cloudCall(t, mux, "GET", "/api/cloud/me", other, nil); status != 401 {
		t.Fatal("other admin session retained", status)
	}
	var active, pending []byte
	if err := r.s.db.QueryRow(`SELECT active_secret,pending_secret FROM cloud_admin_2fa WHERE id=1`).Scan(&active, &pending); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(active), setup["secret"].(string)) || len(active) < 32 || len(pending) != 0 {
		t.Fatal("secret not encrypted or pending retained")
	}
}
func TestCloudTwoFactorLoginMissingWrongAndReplayCreateNoSession(t *testing.T) {
	t.Setenv("SPACE_ADMIN_2FA_REQUIRED", "")
	r, mux, now := cloudTwoFactorRig(t)
	admin := cloudAdmin(t, r, mux)
	setup := cloudTwoFactorSetup(t, mux, admin)
	step := now.Unix() / 30
	cloudTwoFactorConfirm(t, mux, admin, setup, step-1)
	var before int
	r.s.db.QueryRow(`SELECT count(*) FROM cloud_sessions`).Scan(&before)
	for _, otp := range []string{"", "0000000", cloudTestOTP(t, setup["secret"].(string), step-1)} {
		if status, _ := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "synthetic-admin", "password": "synthetic-pass-123", "otp": otp}); status != 401 {
			t.Fatal("invalid OTP login", status)
		}
	}
	var after int
	r.s.db.QueryRow(`SELECT count(*) FROM cloud_sessions`).Scan(&after)
	if after != before {
		t.Fatal("invalid OTP created session")
	}
	otp := cloudTestOTP(t, setup["secret"].(string), step)
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "synthetic-admin", "password": "synthetic-pass-123", "otp": otp}); status != 200 {
		t.Fatal("valid OTP rejected", status)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "synthetic-admin", "password": "synthetic-pass-123", "otp": otp}); status != 401 {
		t.Fatal("OTP replay accepted", status)
	}
}
func TestCloudTwoFactorProductionGuideAndOrdinaryUserIsolation(t *testing.T) {
	t.Setenv("SPACE_ADMIN_2FA_REQUIRED", "1")
	r, mux, _ := cloudTwoFactorRig(t)
	admin := cloudAdmin(t, r, mux)
	user := cloudRegister(t, mux, "alice")
	if status, out := cloudCall(t, mux, "GET", "/api/store/admin/apps", admin, nil); status != 403 || out["error"].(map[string]any)["code"] != "cloud_2fa_setup_required" {
		t.Fatal("production gate absent", status, out)
	}
	if status, out := cloudCall(t, mux, "GET", "/api/store/admin/2fa", admin, nil); status != 200 || out["data"].(map[string]any)["required"] != true {
		t.Fatal("security guide blocked", status, out)
	}
	for _, path := range []string{"/api/store/admin/2fa", "/api/store/admin/2fa/setup", "/api/store/admin/2fa/confirm", "/api/store/admin/2fa/toggle"} {
		method := "POST"
		if path == "/api/store/admin/2fa" {
			method = "GET"
		}
		if status, _ := cloudCall(t, mux, method, path, user, map[string]string{"password": "test-pass-6", "otp": "123456"}); status != 403 {
			t.Fatal("user accessed admin security", path, status)
		}
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "alice", "password": "test-pass-6"}); status != 200 {
		t.Fatal("normal user login changed", status)
	}
	if status, out := cloudCall(t, mux, "GET", "/api/cloud/me", admin, nil); status != 200 || out["data"].(map[string]any)["user"].(map[string]any)["twoFactorRequired"] != true {
		t.Fatal("missing onboarding status", status, out)
	}
}
func TestCloudTwoFactorToggleRequiresPasswordOTPAndPersistsIntentionalDisable(t *testing.T) {
	t.Setenv("SPACE_ADMIN_2FA_REQUIRED", "1")
	r, mux, now := cloudTwoFactorRig(t)
	admin := cloudAdmin(t, r, mux)
	setup := cloudTwoFactorSetup(t, mux, admin)
	step := now.Unix() / 30
	cloudTwoFactorConfirm(t, mux, admin, setup, step-1)
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/2fa/toggle", admin, map[string]any{"password": "synthetic-pass-123", "otp": "abcdef", "enabled": false}); status != 401 {
		t.Fatal("disabled without proof", status)
	}
	otp := cloudTestOTP(t, setup["secret"].(string), step)
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/2fa/toggle", admin, map[string]any{"password": "wrong-pass", "otp": otp, "enabled": false}); status != 401 {
		t.Fatal("disabled without password", status)
	}
	if status, out := cloudCall(t, mux, "POST", "/api/store/admin/2fa/toggle", admin, map[string]any{"password": "synthetic-pass-123", "otp": otp, "enabled": false}); status != 200 || out["data"].(map[string]any)["enabled"] != false || out["data"].(map[string]any)["required"] != false {
		t.Fatal("disable failed", status, out)
	}
	if status, _ := cloudCall(t, mux, "GET", "/api/store/admin/apps", admin, nil); status != 200 {
		t.Fatal("intentional disable forced onboarding", status)
	}
	other := cloudTwoFactorOtherAdmin(t, mux)
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/2fa/toggle", admin, map[string]any{"password": "synthetic-pass-123", "otp": otp, "enabled": true}); status != 401 {
		t.Fatal("toggle replay accepted", status)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/2fa/toggle", admin, map[string]any{"password": "synthetic-pass-123", "otp": cloudTestOTP(t, setup["secret"].(string), step+1), "enabled": true}); status != 200 {
		t.Fatal("enable failed", status)
	}
	if status, _ := cloudCall(t, mux, "GET", "/api/cloud/me", other, nil); status != 401 {
		t.Fatal("reenable did not revoke sessions", status)
	}
}
func TestCloudTwoFactorExpiredSetupAndConcurrentReplay(t *testing.T) {
	t.Setenv("SPACE_ADMIN_2FA_REQUIRED", "")
	r, mux, now := cloudTwoFactorRig(t)
	admin := cloudAdmin(t, r, mux)
	setup := cloudTwoFactorSetup(t, mux, admin)
	r.s.db.Exec(`UPDATE cloud_admin_2fa SET pending_expires_at=? WHERE id=1`, now.Unix()-1)
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/2fa/confirm", admin, map[string]string{"password": "synthetic-pass-123", "otp": cloudTestOTP(t, setup["secret"].(string), now.Unix()/30), "challengeId": setup["challengeId"].(string)}); status != 409 {
		t.Fatal("expired bind accepted", status)
	}
	setup = cloudTwoFactorSetup(t, mux, admin)
	step := now.Unix() / 30
	cloudTwoFactorConfirm(t, mux, admin, setup, step-1)
	otp := cloudTestOTP(t, setup["secret"].(string), step)
	var wg sync.WaitGroup
	var lock sync.Mutex
	success := 0
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, _ := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "synthetic-admin", "password": "synthetic-pass-123", "otp": otp})
			if status == 200 {
				lock.Lock()
				success++
				lock.Unlock()
			}
		}()
	}
	wg.Wait()
	if success != 1 {
		t.Fatal("concurrent OTP was not consumed exactly once", success)
	}
}

func TestCloudTOTPReferenceVectorsAndValidationWindow(t *testing.T) {
	// RFC 6238 SHA-1 vectors, reduced to six digits for this application's policy.
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	for _, tc := range []struct {
		unix int64
		code string
	}{{59, "287082"}, {1111111109, "081804"}, {1111111111, "050471"}, {1234567890, "005924"}, {2000000000, "279037"}, {20000000000, "353130"}} {
		got, err := cloudTOTP(secret, tc.unix/30)
		if err != nil || got != tc.code {
			t.Fatalf("RFC TOTP vector failed at %d", tc.unix)
		}
	}
	now := time.Unix(1234567890, 0)
	step := now.Unix() / 30
	for _, candidate := range []int64{step - 1, step, step + 1} {
		otp := cloudTestOTP(t, secret, candidate)
		matched, err := cloudVerifyTOTP(secret, otp, -1, now)
		if err != nil || matched != candidate {
			t.Fatal("allowed clock skew failed")
		}
		if _, err = cloudVerifyTOTP(secret, otp, candidate, now); err == nil {
			t.Fatal("consumed vector replayed")
		}
	}
	otp := cloudTestOTP(t, secret, step-2)
	if _, err := cloudVerifyTOTP(secret, otp, -1, now); err == nil {
		t.Fatal("accepted outside validation window")
	}
}
