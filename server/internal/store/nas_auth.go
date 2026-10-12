package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const nasSessionLimit = 128
const nasSessionTTL = 20 * time.Minute
const nasResponseLimit = 64 << 10
const nasVerifyTimeout = 5 * time.Second

type nasCredentials struct {
	ProviderID string `json:"providerId"`
	StoreID    string `json:"storeId"`
	Token      string `json:"token"`
	DeviceID   string `json:"deviceId"`
	NASID      string `json:"nasId"`
}
type nasMemorySession struct {
	credentials nasCredentials
	username    string
	expiresAt   time.Time
	ctx         context.Context
	cancel      context.CancelFunc
}

// ValidateNASOrigin accepts one canonical, bare HTTP(S) origin. It deliberately
// rejects normalization ambiguities rather than forwarding private credentials
// to an origin that differs from the public trust binding.
func ValidateNASOrigin(origin string) error {
	if origin == "" {
		return nil
	}
	invalid := errors.New("NAS origin must be a canonical bare HTTP(S) origin")
	if len(origin) > 2048 || strings.ContainsAny(origin, "\\?#") || strings.IndexFunc(origin, unicode.IsSpace) >= 0 {
		return invalid
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return invalid
	}
	host, err := accessHost(u.Hostname())
	if err != nil || host == "" {
		return invalid
	}
	authority := host
	if strings.Contains(host, ":") {
		authority = "[" + host + "]"
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 || strconv.Itoa(n) != p || (u.Scheme == "http" && n == 80) || (u.Scheme == "https" && n == 443) {
			return invalid
		}
		authority += ":" + p
	}
	if origin != u.Scheme+"://"+authority {
		return invalid
	}
	return nil
}
func newNASClient() *http.Client {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: nasVerifyTimeout, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		MaxConnsPerHost:       32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   nasVerifyTimeout,
		ResponseHeaderTimeout: nasVerifyTimeout,
	}
	return &http.Client{Transport: transport, Timeout: nasVerifyTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func privateField(value string, max int) bool {
	return value != "" && len(value) <= max && strings.IndexFunc(value, unicode.IsControl) < 0
}
func (s *Service) verifyNAS(ctx context.Context, c nasCredentials) (string, error) {
	denied := errors.New("NAS identity verification failed")
	ctx, cancel := context.WithTimeout(ctx, nasVerifyTimeout)
	defer cancel()
	form := url.Values{"token": {c.Token}, "device_id": {c.DeviceID}, "nasid": {c.NASID}, "plat": {"web"}, "device": {"SpaceDesktop"}, "version": {"2.3.2026092801"}, "webagent": {"v2"}, "_l": {"zh-CN"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.opts.NASOrigin+"/auth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", denied
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.nasClient.Do(req)
	if err != nil {
		return "", denied
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", denied
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, nasResponseLimit+1))
	if err != nil || len(body) > nasResponseLimit {
		return "", denied
	}
	var envelope struct {
		Code json.RawMessage `json:"code"`
		Data struct {
			Username string          `json:"username"`
			Master   json.RawMessage `json:"is_master"`
		} `json:"data"`
		Error   json.RawMessage `json:"error"`
		Success *bool           `json:"success"`
		OK      *bool           `json:"ok"`
	}
	var fields map[string]json.RawMessage
	var identity map[string]json.RawMessage
	if !utf8.Valid(body) || !uniqueNASJSON(body) || json.Unmarshal(body, &fields) != nil || len(fields["code"]) == 0 || json.Unmarshal(fields["data"], &identity) != nil || len(identity["username"]) == 0 || len(identity["is_master"]) == 0 || json.Unmarshal(body, &envelope) != nil {
		return "", denied
	}
	// Only the canonical official success codes count, and conflicting failure
	// markers cannot turn a malformed envelope into an administrator identity.
	code := string(envelope.Code)
	if code != "200" && code != `"200"` && code != `"S000200"` {
		return "", denied
	}
	if envelope.Success != nil && !*envelope.Success || envelope.OK != nil && !*envelope.OK {
		return "", denied
	}
	if len(envelope.Error) > 0 && string(envelope.Error) != "null" && string(envelope.Error) != "0" && string(envelope.Error) != `""` {
		return "", denied
	}
	master := string(envelope.Data.Master)
	username := envelope.Data.Username
	if (master != "1" && master != "true") || !privateField(username, 128) || strings.TrimSpace(username) == "" || nasCredentialEcho(username, c.Token) {
		return "", denied
	}
	return username, nil
}
func (s *Service) pruneNASLocked(now time.Time) {
	for hash, entry := range s.nasSessions {
		if !now.Before(entry.expiresAt) {
			delete(s.nasSessions, hash)
			entry.cancel()
		}
	}
}
func (s *Service) nasSession(w http.ResponseWriter, r *http.Request) {
	if s.opts.NASOrigin == "" {
		fail(w, 403, "nas_auth_disabled", "商店未配置 NAS 身份提供者。")
		return
	}
	if !s.configured() {
		fail(w, 403, "store_setup_required", "请先通过本地连接配置独立商店管理员。")
		return
	}
	var c nasCredentials
	if !decode(w, r, &c) {
		return
	}
	if c.ProviderID != s.opts.NASOrigin || c.StoreID != s.storeID || !privateField(c.Token, 8192) || !privateField(c.DeviceID, 256) || !privateField(c.NASID, 256) {
		fail(w, 400, "invalid_nas_binding", "NAS 身份与商店绑定无效。")
		return
	}
	username, err := s.verifyNAS(r.Context(), c)
	if err != nil {
		fail(w, 401, "nas_auth_required", "NAS 管理员身份校验失败，请重新登录或检查提供者。")
		return
	}
	token := randomID()
	expiry := time.Now().UTC().Add(nasSessionTTL)
	s.nasMu.Lock()
	s.pruneNASLocked(time.Now())
	if s.nasClosed || r.Context().Err() != nil {
		s.nasMu.Unlock()
		fail(w, 401, "nas_auth_required", "NAS 会话已失效。")
		return
	}
	if len(s.nasSessions) >= nasSessionLimit {
		s.nasMu.Unlock()
		fail(w, 429, "nas_session_limit", "商店 NAS 会话已满，请稍后重试。")
		return
	}
	ctx, cancel := context.WithDeadline(s.ctx, expiry)
	s.nasSessions[tokenHash(token)] = &nasMemorySession{credentials: c, username: username, expiresAt: expiry, ctx: ctx, cancel: cancel}
	s.nasMu.Unlock()
	respond(w, 200, map[string]any{"sessionId": token, "username": username, "expiresAt": expiry, "authSource": "nas"})
}
func (s *Service) revokeNAS(hash string, entry *nasMemorySession) {
	s.nasMu.Lock()
	if s.nasSessions[hash] == entry {
		delete(s.nasSessions, hash)
		entry.cancel()
	}
	s.nasMu.Unlock()
}
func (s *Service) authenticateNAS(w http.ResponseWriter, r *http.Request, next http.HandlerFunc) bool {
	hash := tokenHash(r.Header.Get("X-Store-Session"))
	s.nasMu.Lock()
	s.pruneNASLocked(time.Now())
	entry := s.nasSessions[hash]
	s.nasMu.Unlock()
	if entry == nil {
		return false
	}
	ctx, cancel := context.WithDeadline(r.Context(), entry.expiresAt)
	defer cancel()
	stop := context.AfterFunc(entry.ctx, cancel)
	defer stop()
	username, err := s.verifyNAS(ctx, entry.credentials)
	if err != nil || username != entry.username {
		s.revokeNAS(hash, entry)
		fail(w, 401, "nas_auth_required", "NAS 管理员会话已失效，请重新登录。")
		return true
	}
	s.nasMu.Lock()
	valid := s.nasSessions[hash] == entry && time.Now().Before(entry.expiresAt) && ctx.Err() == nil && !s.nasClosed
	s.nasMu.Unlock()
	if !valid {
		fail(w, 401, "nas_auth_required", "NAS 会话已失效。")
		return true
	}
	ctx = context.WithValue(ctx, nasGrantKey{}, nasRequestGrant{hash: hash, entry: entry})
	next(w, r.WithContext(ctx))
	return true
}
func (s *Service) nasLogout(w http.ResponseWriter, r *http.Request) bool {
	hash := tokenHash(r.Header.Get("X-Store-Session"))
	s.nasMu.Lock()
	entry := s.nasSessions[hash]
	if entry != nil {
		delete(s.nasSessions, hash)
		entry.cancel()
	}
	s.nasMu.Unlock()
	if entry == nil {
		return false
	}
	respond(w, 200, map[string]bool{"loggedOut": true})
	return true
}
func (s *Service) closeNAS() {
	s.nasMu.Lock()
	s.nasClosed = true
	for hash, entry := range s.nasSessions {
		delete(s.nasSessions, hash)
		entry.cancel()
	}
	s.nasMu.Unlock()
	if s.nasClient != nil {
		s.nasClient.CloseIdleConnections()
	}
}

// Ambiguous duplicate fields are malformed identities, even when the last copy
// looks successful. Limit nesting as well as bytes before interpreting authority.
func uniqueNASJSON(body []byte) bool {
	d := json.NewDecoder(strings.NewReader(string(body)))
	d.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 32 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return true
		}
		switch delimiter {
		case '{':
			keys := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return false
				}
				name, ok := key.(string)
				name = strings.ToLower(name)
				if !ok || keys[name] {
					return false
				}
				keys[name] = true
				if !value(depth + 1) {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim('}')
		case '[':
			for d.More() {
				if !value(depth + 1) {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim(']')
		default:
			return false
		}
	}
	if !value(0) {
		return false
	}
	_, err := d.Token()
	return err == io.EOF
}

// Public identity is screened before it can be returned or retained. A provider
// must not echo private credentials through username, including common encodings.
func nasCredentialEcho(username, token string) bool {
	if len(token) > len(username) {
		return false
	}
	candidates := []string{token, base64.StdEncoding.EncodeToString([]byte(token)), base64.RawStdEncoding.EncodeToString([]byte(token)), base64.URLEncoding.EncodeToString([]byte(token)), base64.RawURLEncoding.EncodeToString([]byte(token))}
	folded := strings.ToLower(username)
	for _, candidate := range candidates {
		if strings.Contains(username, candidate) {
			return true
		}

		variants := []string{candidate}
		for i := 0; i < 2; i++ {
			next := make([]string, 0, len(variants)*3)
			for _, value := range variants {
				query := url.QueryEscape(value)
				for _, encoded := range []string{query, url.PathEscape(value), strings.ReplaceAll(query, "+", "%20")} {
					if strings.Contains(folded, strings.ToLower(encoded)) {
						return true
					}
					next = append(next, encoded)
				}
			}
			variants = next
		}
	}
	return false
}

type nasGrantKey struct{}
type nasRequestGrant struct {
	hash  string
	entry *nasMemorySession
}

func (s *Service) validNASGrantLocked(ctx context.Context, grant nasRequestGrant) bool {
	return !s.nasClosed && ctx.Err() == nil && s.nasSessions[grant.hash] == grant.entry && time.Now().Before(grant.entry.expiresAt)
}

// Recheck after request-body, mutex, database or engine waits. This does not
// initiate any provider/network request while a lock is held.
func (s *Service) requestAuthorized(w http.ResponseWriter, r *http.Request) bool {
	return s.requestAuthorizedReader(w, r, s.db)
}

func (s *Service) requestRespond(w http.ResponseWriter, r *http.Request, status int, value any) {
	if s.requestAuthorized(w, r) {
		respond(w, status, value)
	}
}

// Transaction callers must pass their held connection: asking the sole DB
// pool connection for a session while holding it would wait for themselves.
func (s *Service) requestAuthorizedReader(w http.ResponseWriter, r *http.Request, reader runtimeQuerier) bool {
	valid := r.Context().Err() == nil
	code := "store_auth_required"
	if grant, ok := r.Context().Value(nasGrantKey{}).(nasRequestGrant); ok {
		code = "nas_auth_required"
		s.nasMu.Lock()
		valid = s.validNASGrantLocked(r.Context(), grant)
		s.nasMu.Unlock()
	} else if valid {
		ctx, cancel := context.WithTimeout(r.Context(), nasVerifyTimeout)
		defer cancel()
		var n int
		err := reader.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE token_hash=? AND expires_at>?`, tokenHash(r.Header.Get("X-Store-Session")), time.Now().Unix()).Scan(&n)
		valid = ctx.Err() == nil && err == nil && n == 1
	}
	if !valid {
		fail(w, 401, code, "会话已失效，未提交新操作。")
		return false
	}
	return true
}

// Only short local metadata commits belong inside this fence: never engine or
// provider calls. Revocation and the final commit share the map mutex, so logout
// cannot acknowledge removal then allow an uncommitted request to enqueue work.
func (s *Service) requestMutation(w http.ResponseWriter, r *http.Request, tx *sql.Tx, commit func(context.Context) error) (error, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), nasVerifyTimeout)
	defer cancel()
	if grant, ok := ctx.Value(nasGrantKey{}).(nasRequestGrant); ok {
		s.nasMu.Lock()
		defer s.nasMu.Unlock()
		if !s.validNASGrantLocked(ctx, grant) {
			fail(w, 401, "nas_auth_required", "会话已失效，未提交新操作。")
			return nil, false
		}
	} else {
		if !s.requestAuthorizedReader(w, r.WithContext(ctx), tx) {
			return nil, false
		}
	}
	return commit(ctx), true
}

func (s *Service) requestLock(w http.ResponseWriter, r *http.Request, mutex *sync.Mutex) bool {
	for !mutex.TryLock() {
		if !s.requestAuthorized(w, r) {
			return false
		}
		select {
		case <-r.Context().Done():
			if !s.requestAuthorized(w, r) {
				return false
			}
		case <-time.After(time.Millisecond):
		}
	}
	if !s.requestAuthorized(w, r) {
		mutex.Unlock()
		return false
	}
	return true
}
func (s *Service) saveRequestInstance(w http.ResponseWriter, r *http.Request, i Instance) (error, bool) {
	body, err := json.Marshal(i)
	if err != nil {
		return err, true
	}
	return s.requestDBMutation(w, r, `UPDATE instances SET body=? WHERE id=?`, string(body), i.ID)
}

// Reserve the SQLite connection and stage the statement outside nasMu. The
// transaction remains invisible until its final fenced commit, avoiding an
// inverse map/DB lock order and keeping logout independent of DB pool waits.
func (s *Service) requestDBMutation(w http.ResponseWriter, r *http.Request, statement string, args ...any) (error, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), nasVerifyTimeout)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		if !s.requestAuthorized(w, r) {
			return nil, false
		}
		return err, true
	}
	defer tx.Rollback()
	if !s.requestAuthorizedReader(w, r, tx) {
		return nil, false
	}
	if maintenanceFailure(w, maintenanceReady(tx)) {
		return nil, false
	}
	if _, err = tx.ExecContext(ctx, statement, args...); err != nil {
		if !s.requestAuthorizedReader(w, r, tx) {
			return nil, false
		}
		return err, true
	}
	return s.requestMutation(w, r, tx, func(commitCtx context.Context) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if commitCtx.Err() != nil {
			return commitCtx.Err()
		}
		return tx.Commit()
	})
}
