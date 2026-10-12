package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/skip2/go-qrcode"
	"golang.org/x/crypto/bcrypt"
)

const cloudTwoFactorPendingTTL = 10 * time.Minute

var errCloudOTP = errors.New("invalid or reused OTP")

type cloudTwoFactorState struct {
	active, pending          []byte
	enabled, override        int
	pendingExpires, lastStep int64
	challenge                string
}
type cloudTwoFactorStatus struct {
	Bound            bool   `json:"bound"`
	Enabled          bool   `json:"enabled"`
	Required         bool   `json:"required"`
	Pending          bool   `json:"pending"`
	PendingExpiresAt string `json:"pendingExpiresAt,omitempty"`
}

func (c *cloudService) initializeTwoFactor(ctx context.Context) error {
	stmt := `CREATE TABLE IF NOT EXISTS cloud_admin_2fa(id INTEGER PRIMARY KEY CHECK(id=1),active_secret BLOB NOT NULL,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),pending_secret BLOB NOT NULL,pending_expires_at BIGINT NOT NULL DEFAULT 0,challenge_id TEXT NOT NULL DEFAULT '',last_used_step BIGINT NOT NULL DEFAULT -1,disabled_override INTEGER NOT NULL DEFAULT 0 CHECK(disabled_override IN (0,1)))`
	if c.db.postgres {
		stmt = strings.ReplaceAll(stmt, " BLOB ", " BYTEA ")
	}
	if _, err := c.db.ExecContext(ctx, stmt); err != nil {
		return err
	}
	_, err := c.db.ExecContext(ctx, `INSERT INTO cloud_admin_2fa(id,active_secret,pending_secret) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING`, []byte{}, []byte{})
	return err
}
func (c *cloudService) registerTwoFactor(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/store/admin/2fa", c.auth(true, c.getTwoFactor))
	mux.HandleFunc("POST /api/store/admin/2fa/setup", c.auth(true, c.setupTwoFactor))
	mux.HandleFunc("POST /api/store/admin/2fa/confirm", c.auth(true, c.confirmTwoFactor))
	mux.HandleFunc("POST /api/store/admin/2fa/toggle", c.auth(true, c.toggleTwoFactor))
}
func cloudTwoFactorRoute(path string) bool {
	switch path {
	case "/api/store/admin/2fa", "/api/store/admin/2fa/setup", "/api/store/admin/2fa/confirm", "/api/store/admin/2fa/toggle":
		return true
	}
	return false
}
func (c *cloudService) twoFactorTime() time.Time {
	if c.twoFactorNow != nil {
		return c.twoFactorNow()
	}
	return time.Now()
}
func (s cloudTwoFactorState) status(now time.Time) cloudTwoFactorStatus {
	status := cloudTwoFactorStatus{Bound: len(s.active) > 0, Enabled: s.enabled == 1, Required: os.Getenv("SPACE_ADMIN_2FA_REQUIRED") == "1" && len(s.active) == 0 && s.override == 0, Pending: len(s.pending) > 0 && s.pendingExpires > now.Unix()}
	if status.Pending {
		status.PendingExpiresAt = time.Unix(s.pendingExpires, 0).UTC().Format(time.RFC3339)
	}
	return status
}
func scanCloudTwoFactor(row *sql.Row) (cloudTwoFactorState, error) {
	var s cloudTwoFactorState
	err := row.Scan(&s.active, &s.enabled, &s.pending, &s.pendingExpires, &s.challenge, &s.lastStep, &s.override)
	return s, err
}
func (c *cloudService) twoFactorState(ctx context.Context) (cloudTwoFactorState, error) {
	return scanCloudTwoFactor(c.db.QueryRowContext(ctx, `SELECT active_secret,enabled,pending_secret,pending_expires_at,challenge_id,last_used_step,disabled_override FROM cloud_admin_2fa WHERE id=1`))
}
func (c *cloudService) lockedTwoFactor(ctx context.Context, tx *cloudTx) (cloudTwoFactorState, error) {
	query := `SELECT active_secret,enabled,pending_secret,pending_expires_at,challenge_id,last_used_step,disabled_override FROM cloud_admin_2fa WHERE id=1`
	if c.db.postgres {
		query += " FOR UPDATE"
	}
	return scanCloudTwoFactor(tx.QueryRowContext(ctx, query))
}
func (c *cloudService) twoFactorAEAD() (cipher.AEAD, error) {
	key := sha256.Sum256(append([]byte("zstore admin TOTP\x00"), c.signingKey.Seed()...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (c *cloudService) encryptTwoFactor(secret string) ([]byte, error) {
	aead, err := c.twoFactorAEAD()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(secret), []byte("admin:1/totp")), nil
}
func (c *cloudService) decryptTwoFactor(raw []byte) (string, error) {
	aead, err := c.twoFactorAEAD()
	if err != nil || len(raw) < aead.NonceSize() {
		return "", errors.New("two factor secret unavailable")
	}
	plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte("admin:1/totp"))
	return string(plain), err
}

// RFC 6238: SHA-1, 30 seconds and six digits, compatible with authenticator apps.
func cloudTOTP(secret string, step int64) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil || len(key) < 20 || step < 0 {
		return "", errCloudOTP
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 15
	return fmt.Sprintf("%06d", (binary.BigEndian.Uint32(sum[offset:offset+4])&0x7fffffff)%1000000), nil
}
func cloudVerifyTOTP(secret, otp string, lastStep int64, now time.Time) (int64, error) {
	if len(otp) != 6 || strings.IndexFunc(otp, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return 0, errCloudOTP
	}
	step := now.Unix() / 30
	matched := int64(-1)
	for _, candidate := range []int64{step - 1, step, step + 1} {
		code, err := cloudTOTP(secret, candidate)
		if err != nil {
			return 0, err
		}
		if subtle.ConstantTimeCompare([]byte(code), []byte(otp)) == 1 && candidate > lastStep && candidate > matched {
			matched = candidate
		}
	}
	if matched < 0 {
		return 0, errCloudOTP
	}
	return matched, nil
}
func (c *cloudService) getTwoFactor(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	s, err := c.twoFactorState(r.Context())
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法读取双重验证状态。")
		return
	}
	respond(w, 200, s.status(c.twoFactorTime()))
}
func (c *cloudService) twoFactorPassword(w http.ResponseWriter, r *http.Request, password string) bool {
	if !c.allowAuth(w, r) {
		return false
	}
	var hash string
	err := c.db.QueryRowContext(r.Context(), `SELECT password_hash FROM cloud_admin WHERE id=1`).Scan(&hash)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法读取管理员信息。")
		return false
	}
	if len(password) > 72 || bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		fail(w, 401, "cloud_2fa_password_invalid", "管理员密码错误。")
		return false
	}
	return true
}
func (c *cloudService) twoFactorSession(ctx context.Context, tx *cloudTx, r *http.Request) error {
	var found int
	return tx.QueryRowContext(ctx, `SELECT 1 FROM cloud_sessions WHERE token_hash=? AND user_id='admin:1' AND expires_at>?`, tokenHash(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")), time.Now().Unix()).Scan(&found)
}
func (c *cloudService) revokeOtherAdminSessions(ctx context.Context, tx *cloudTx, r *http.Request) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM cloud_sessions WHERE user_id='admin:1' AND token_hash<>?`, tokenHash(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
	return err
}
func (c *cloudService) setupTwoFactor(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var in struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &in) || !c.twoFactorPassword(w, r, in.Password) {
		return
	}
	in.Password = ""
	c.twoFactorMu.Lock()
	defer c.twoFactorMu.Unlock()
	tx, err := c.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法生成双重验证二维码。")
		return
	}
	defer tx.Rollback()
	s, err := c.lockedTwoFactor(r.Context(), tx)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法读取双重验证状态。")
		return
	}
	if c.twoFactorSession(r.Context(), tx, r) != nil {
		fail(w, 401, "cloud_auth_required", "登录会话已失效，请重新登录。")
		return
	}
	if len(s.active) > 0 {
		fail(w, 409, "cloud_2fa_already_bound", "已绑定验证器，请通过启用或停用按钮修改状态。")
		return
	}
	raw := make([]byte, 20)
	if _, err = rand.Read(raw); err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法生成双重验证二维码。")
		return
	}
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	encrypted, err := c.encryptTwoFactor(secret)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法生成双重验证二维码。")
		return
	}
	challenge := randomID()
	expiry := c.twoFactorTime().Add(cloudTwoFactorPendingTTL).UTC().Truncate(time.Second)
	uri := url.URL{Scheme: "otpauth", Host: "totp", Path: "/Space Store:" + cloudActor(r).Username}
	uri.RawQuery = url.Values{"secret": {secret}, "issuer": {"Space Store"}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"}}.Encode()
	qr, err := qrcode.Encode(uri.String(), qrcode.Medium, 256)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法生成双重验证二维码。")
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE cloud_admin_2fa SET pending_secret=?,pending_expires_at=?,challenge_id=? WHERE id=1`, encrypted, expiry.Unix(), challenge)
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "cloud_2fa_failed", "无法保存待确认验证信息。")
		return
	}
	respond(w, 200, map[string]any{"challengeId": challenge, "secret": secret, "otpauthUri": uri.String(), "qrDataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(qr), "expiresAt": expiry.Format(time.RFC3339)})
}
func (c *cloudService) confirmTwoFactor(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var in struct {
		Password  string `json:"password"`
		OTP       string `json:"otp"`
		Challenge string `json:"challengeId"`
	}
	if !decode(w, r, &in) || !c.twoFactorPassword(w, r, in.Password) {
		return
	}
	in.Password = ""
	c.twoFactorMu.Lock()
	defer c.twoFactorMu.Unlock()
	tx, err := c.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法绑定双重验证。")
		return
	}
	defer tx.Rollback()
	s, err := c.lockedTwoFactor(r.Context(), tx)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法读取双重验证状态。")
		return
	}
	if c.twoFactorSession(r.Context(), tx, r) != nil {
		fail(w, 401, "cloud_auth_required", "登录会话已失效，请重新登录。")
		return
	}
	if len(s.active) > 0 || len(s.pending) == 0 || s.pendingExpires <= c.twoFactorTime().Unix() || in.Challenge == "" || in.Challenge != s.challenge {
		fail(w, 409, "cloud_2fa_setup_expired", "绑定二维码已失效，请重新生成。")
		return
	}
	secret, err := c.decryptTwoFactor(s.pending)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "待绑定验证信息不可用，请重新生成。")
		return
	}
	step, err := cloudVerifyTOTP(secret, in.OTP, -1, c.twoFactorTime())
	if err != nil {
		fail(w, 401, "cloud_2fa_otp_invalid", "动态码错误或已使用，请等待新的动态码。")
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE cloud_admin_2fa SET active_secret=?,enabled=1,pending_secret=?,pending_expires_at=0,challenge_id='',last_used_step=?,disabled_override=0 WHERE id=1`, s.pending, []byte{}, step)
	if err == nil {
		err = c.revokeOtherAdminSessions(r.Context(), tx, r)
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "cloud_2fa_failed", "无法绑定双重验证。")
		return
	}
	s.active = s.pending
	s.pending = nil
	s.enabled = 1
	s.override = 0
	respond(w, 200, s.status(c.twoFactorTime()))
}
func (c *cloudService) toggleTwoFactor(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var in struct {
		Password string `json:"password"`
		OTP      string `json:"otp"`
		Enabled  *bool  `json:"enabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Enabled == nil {
		fail(w, 400, "cloud_2fa_invalid", "请选择启用或停用双重验证。")
		return
	}
	if !c.twoFactorPassword(w, r, in.Password) {
		return
	}
	in.Password = ""
	c.twoFactorMu.Lock()
	defer c.twoFactorMu.Unlock()
	tx, err := c.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法修改双重验证。")
		return
	}
	defer tx.Rollback()
	s, err := c.lockedTwoFactor(r.Context(), tx)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法读取双重验证状态。")
		return
	}
	if c.twoFactorSession(r.Context(), tx, r) != nil {
		fail(w, 401, "cloud_auth_required", "登录会话已失效，请重新登录。")
		return
	}
	if len(s.active) == 0 {
		fail(w, 409, "cloud_2fa_not_bound", "请先扫描二维码并完成绑定。")
		return
	}
	secret, err := c.decryptTwoFactor(s.active)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "双重验证信息不可用。")
		return
	}
	step, err := cloudVerifyTOTP(secret, in.OTP, s.lastStep, c.twoFactorTime())
	if err != nil {
		fail(w, 401, "cloud_2fa_otp_invalid", "动态码错误或已使用，请等待新的动态码。")
		return
	}
	enabled, override := 0, 1
	if *in.Enabled {
		enabled, override = 1, 0
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE cloud_admin_2fa SET enabled=?,disabled_override=?,last_used_step=? WHERE id=1`, enabled, override, step)
	if err == nil {
		err = c.revokeOtherAdminSessions(r.Context(), tx, r)
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "cloud_2fa_failed", "无法修改双重验证。")
		return
	}
	s.enabled = enabled
	s.override = override
	respond(w, 200, s.status(c.twoFactorTime()))
}

// Lock the security row through session creation, so an enable/disable race
// cannot issue a password-only session after another request enables TOTP.
func (c *cloudService) issueAdminSession(w http.ResponseWriter, r *http.Request, u CloudUser, otp string) {
	c.twoFactorMu.Lock()
	defer c.twoFactorMu.Unlock()
	tx, err := c.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "cloud_session_failed", "无法建立登录会话。")
		return
	}
	defer tx.Rollback()
	s, err := c.lockedTwoFactor(r.Context(), tx)
	if err != nil {
		fail(w, 500, "cloud_2fa_failed", "无法读取双重验证状态。")
		return
	}
	if s.enabled == 1 {
		if otp == "" {
			fail(w, 401, "cloud_2fa_otp_required", "请输入验证器中的六位动态码。")
			return
		}
		secret, e := c.decryptTwoFactor(s.active)
		if e != nil {
			fail(w, 500, "cloud_2fa_failed", "双重验证信息不可用。")
			return
		}
		step, e := cloudVerifyTOTP(secret, otp, s.lastStep, c.twoFactorTime())
		if e != nil {
			fail(w, 401, "cloud_2fa_otp_invalid", "动态码错误或已使用，请等待新的动态码。")
			return
		}
		result, e := tx.ExecContext(r.Context(), `UPDATE cloud_admin_2fa SET last_used_step=? WHERE id=1 AND last_used_step<? AND enabled=1 AND active_secret=?`, step, step, s.active)
		if e != nil {
			fail(w, 500, "cloud_2fa_failed", "无法验证动态码。")
			return
		}
		n, e := result.RowsAffected()
		if e != nil || n != 1 {
			fail(w, 401, "cloud_2fa_otp_invalid", "动态码错误或已使用，请等待新的动态码。")
			return
		}
	}
	status := s.status(c.twoFactorTime())
	u.TwoFactorRequired = status.Required
	u.TwoFactorEnabled = status.Enabled
	token := randomID()
	expiry := time.Now().UTC().Add(cloudSessionTTL).Truncate(time.Second)
	_, err = tx.ExecContext(r.Context(), `INSERT INTO cloud_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)`, tokenHash(token), u.ID, expiry.Unix())
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "cloud_session_failed", "无法建立登录会话。")
		return
	}
	respond(w, 200, map[string]any{"sessionId": token, "expiresAt": expiry.Format(time.RFC3339), "user": u})
}
