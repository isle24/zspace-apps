// Package nas adapts the NAS's read-only HTTP API. Tokens and credentials never
// leave this process; a restart requires a new normal NAS login.
package nas

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Options struct {
	DataDir    string
	HTTPClient *http.Client
}
type Service struct {
	mu          sync.RWMutex
	client      *http.Client
	mediaClient *http.Client
	deviceID    string
	sessions    map[string]*session
	media       map[string]mediaRef
}
type session struct {
	id                     string
	base                   *url.URL
	token, nasID, deviceID string
	user                   map[string]any
	expires                time.Time
}
type mediaRef struct {
	sessionID string
	source    *url.URL
	expires   time.Time
}
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *APIError) Error() string        { return e.Code + ": " + e.Message }
func failure(code, msg string) *APIError { return &APIError{code, msg} }
func New(o Options) (*Service, error) {
	deviceID, err := loadDeviceID(o.DataDir)
	if err != nil {
		return nil, err
	}
	c := &http.Client{Timeout: 30 * time.Second}
	if o.HTTPClient != nil {
		*c = *o.HTTPClient
		if c.Timeout == 0 {
			c.Timeout = 30 * time.Second
		}
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if c.Transport == nil {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.ResponseHeaderTimeout = 15 * time.Second
		tr.TLSHandshakeTimeout = 10 * time.Second
		c.Transport = tr
	} else if tr, ok := c.Transport.(*http.Transport); ok {
		clone := tr.Clone()
		if clone.ResponseHeaderTimeout == 0 {
			clone.ResponseHeaderTimeout = 15 * time.Second
		}
		c.Transport = clone
	}
	mediaClient := *c
	mediaClient.Timeout = 0
	return &Service{client: c, mediaClient: &mediaClient, deviceID: deviceID, sessions: map[string]*session{}, media: map[string]mediaRef{}}, nil
}

func (s *Service) Register(m *http.ServeMux) {
	m.HandleFunc("POST /api/nas/login", s.login)
	m.HandleFunc("POST /api/nas/read", s.read)
	m.HandleFunc("GET /api/nas/session", s.session)
	m.HandleFunc("POST /api/nas/logout", s.logout)
	m.HandleFunc("GET /api/nas/media/{id}", s.serveMedia)
}
func opaque() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("secure random unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func validateBase(raw string) (*url.URL, error) {
	u, e := url.Parse(raw)
	if e != nil || u == nil || u.User != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, failure("INVALID_BASE_URL", "请输入不含账号、密码、路径或查询参数的 NAS HTTP 地址")
	}
	u.Path = ""
	return u, nil
}
func DecodeResponse(b []byte) (any, error) {
	var v map[string]any
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.UseNumber()
	if d.Decode(&v) != nil || v == nil {
		return nil, failure("INVALID_RESPONSE", "NAS 返回了无法识别的响应")
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, failure("INVALID_RESPONSE", "NAS 返回了无法识别的响应")
	}
	code := fmt.Sprint(v["code"])
	success, exists := v["success"].(bool)
	if exists && !success {
		return nil, businessError(code)
	}
	valid := code == "200" || code == "S000200"
	if v["code"] == nil {
		if n, ok := v["error"].(json.Number); ok {
			valid = n.String() == "0"
			code = n.String()
		} else if exists {
			valid = success
		}
	}
	if !valid {
		return nil, businessError(code)
	}
	if data, ok := v["data"]; ok {
		return data, nil
	}
	delete(v, "success")
	delete(v, "code")
	delete(v, "error")
	return v, nil
}
func businessError(code string) *APIError {
	switch code {
	case "N001207", "N001208", "N001100", "N001413", "N001001", "N001209", "401", "403":
		return failure("SESSION_EXPIRED", "NAS 会话已过期，请重新登录")
	case "N001223":
		return failure("LOGIN_FAILED", "NAS 账号或密码验证失败")
	case "N001205", "N001206", "N001414":
		return failure("CHALLENGE_REQUIRED", "NAS 要求额外验证，请在官方页面完成验证")
	case "<nil>":
		return failure("INVALID_RESPONSE", "NAS 响应缺少成功状态")
	}
	return failure("NAS_BUSINESS_ERROR", "NAS 未能完成此请求")
}
func reply(w http.ResponseWriter, data any, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err == nil {
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": data})
		return
	}
	a := failure("NAS_UNAVAILABLE", "无法连接 NAS，请检查地址和网络")
	var supplied *APIError
	if errors.As(err, &supplied) {
		a = supplied
	}
	status := 502
	switch a.Code {
	case "INVALID_BASE_URL", "INVALID_REQUEST", "INVALID_PARAMS":
		status = 400
	case "NO_SESSION", "SESSION_EXPIRED":
		status = 401
	case "LOGIN_FAILED", "CHALLENGE_REQUIRED":
		status = 403
	case "UNSUPPORTED_OPERATION":
		status = 501
	}
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": a})
}
func decodeRequest(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		return failure("INVALID_REQUEST", "请求参数无效")
	}
	return nil
}
func (s *Service) call(ctx context.Context, ss *session, method, path string, p url.Values) (any, error) {
	if p == nil {
		p = url.Values{}
	}
	for k, v := range common(ss) {
		p.Set(k, v)
	}
	u := *ss.base
	route, e := url.Parse(path)
	if e != nil {
		return nil, e
	}
	u.Path = route.Path
	u.RawQuery = route.RawQuery
	var body io.Reader
	if method == http.MethodGet {
		q := u.Query()
		for k, vs := range p {
			q[k] = vs
		}
		u.RawQuery = q.Encode()
	} else {
		body = strings.NewReader(p.Encode())
	}
	req, e := http.NewRequestWithContext(ctx, method, u.String(), body)
	if e != nil {
		return nil, e
	}
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("token", ss.token)
	resp, e := s.client.Do(req)
	if e != nil {
		return nil, failure("NAS_UNAVAILABLE", "无法连接 NAS，请检查地址和网络")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, failure("SESSION_EXPIRED", "NAS 会话已过期，请重新登录")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, failure("NAS_HTTP_ERROR", "NAS 返回 HTTP 错误")
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	if e != nil || len(b) > 16<<20 {
		return nil, failure("INVALID_RESPONSE", "NAS 响应过大或不完整")
	}
	return DecodeResponse(b)
}
func common(ss *session) map[string]string {
	return map[string]string{"plat": "web", "version": "2.3.2026092801", "device_id": ss.deviceID, "device": "SpaceDesktop", "_l": "zh-CN", "webagent": "v2", "rnd": fmt.Sprint(time.Now().UnixMilli()), "token": ss.token, "nasid": ss.nasID}
}
func encrypt(key, text string) (string, error) {
	var der []byte
	if b, _ := pem.Decode([]byte(key)); b != nil {
		der = b.Bytes
	} else {
		var e error
		der, e = base64.StdEncoding.DecodeString(strings.ReplaceAll(strings.TrimSpace(key), "\n", ""))
		if e != nil {
			return "", e
		}
	}
	p, e := x509.ParsePKIXPublicKey(der)
	if e != nil {
		p, e = x509.ParsePKCS1PublicKey(der)
	}
	if e != nil {
		return "", e
	}
	rsaKey, ok := p.(*rsa.PublicKey)
	if !ok || rsaKey.N.BitLen() < 1024 {
		return "", errors.New("invalid RSA key")
	}
	v, e := rsa.EncryptPKCS1v15(rand.Reader, rsaKey, []byte(text))
	return base64.StdEncoding.EncodeToString(v), e
}
func (s *Service) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		BaseURL  string `json:"baseUrl"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if e := decodeRequest(w, r, &in); e != nil {
		reply(w, nil, e)
		return
	}
	base, e := validateBase(in.BaseURL)
	if e != nil {
		reply(w, nil, e)
		return
	}
	if in.Username == "" || in.Password == "" || len(in.Username) > 256 || len(in.Password) > 512 {
		reply(w, nil, failure("INVALID_REQUEST", "请输入 NAS 账号和密码"))
		return
	}
	ss := &session{base: base, deviceID: s.deviceID, expires: time.Now().Add(8 * time.Hour)}
	challenge, e := s.call(r.Context(), ss, "GET", "/key/pub", url.Values{"signme": {"1"}})
	if e != nil {
		reply(w, nil, e)
		return
	}
	ch, ok := challenge.(map[string]any)
	if !ok {
		reply(w, nil, failure("INVALID_RESPONSE", "NAS 公钥响应无效"))
		return
	}
	key, _ := ch["key"].(string)
	username, e := encrypt(key, in.Username)
	if e != nil {
		reply(w, nil, failure("INVALID_RESPONSE", "NAS 未提供有效的新鲜登录公钥"))
		return
	}
	password, e := encrypt(key, in.Password)
	if e != nil {
		reply(w, nil, failure("INVALID_REQUEST", "账号或密码长度超过 NAS 公钥支持范围"))
		return
	}
	ss.nasID = text(ch, "nasid", "nas_id")
	p := url.Values{"username": {username}, "password": {password}}
	if sign := text(ch, "sign"); sign != "" {
		p.Set("sign", sign)
	}
	data, e := s.call(r.Context(), ss, "POST", "/auth/login", p)
	in.Password = ""
	in.Username = ""
	if e != nil {
		reply(w, nil, e)
		return
	}
	d, ok := data.(map[string]any)
	if !ok || text(d, "token") == "" {
		reply(w, nil, failure("INVALID_RESPONSE", "NAS 登录响应缺少会话"))
		return
	}
	ss.token = text(d, "token")
	if n := text(d, "nasid", "nas_id"); n != "" {
		ss.nasID = n
	}
	ss.user = map[string]any{"username": text(d, "username"), "name": text(d, "nickname", "name", "username"), "role": text(d, "role", "user_type")}
	ss.user = s.clean(ss, ss.user).(map[string]any)
	ss.id = opaque()
	s.mu.Lock()
	s.pruneLocked()
	s.sessions[ss.id] = ss
	s.mu.Unlock()
	reply(w, map[string]any{"sessionId": ss.id, "user": ss.user, "baseUrl": base.String()}, nil)
}
func (s *Service) pruneLocked() {
	now := time.Now()
	for id, ss := range s.sessions {
		if now.After(ss.expires) {
			delete(s.sessions, id)
		}
	}
	for id, m := range s.media {
		if now.After(m.expires) || s.sessions[m.sessionID] == nil {
			delete(s.media, id)
		}
	}
}
func (s *Service) getSession(id string) (*session, error) {
	s.mu.RLock()
	ss := s.sessions[id]
	s.mu.RUnlock()
	if ss == nil || time.Now().After(ss.expires) {
		return nil, failure("NO_SESSION", "请先登录 NAS")
	}
	return ss, nil
}
func (s *Service) session(w http.ResponseWriter, r *http.Request) {
	ss, e := s.getSession(r.Header.Get("X-NAS-Session"))
	if e != nil {
		reply(w, nil, e)
		return
	}
	reply(w, map[string]any{"sessionId": ss.id, "user": ss.user, "baseUrl": ss.base.String(), "expiresAt": ss.expires.UTC().Format(time.RFC3339)}, nil)
}
func (s *Service) invalidate(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	for k, m := range s.media {
		if m.sessionID == id {
			delete(s.media, k)
		}
	}
	s.mu.Unlock()
}
func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	ss, e := s.getSession(r.Header.Get("X-NAS-Session"))
	if e != nil {
		reply(w, nil, e)
		return
	}
	s.invalidate(ss.id)
	reply(w, map[string]any{"loggedOut": true}, nil)
}
func text(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			switch v.(type) {
			case string, json.Number, float64, int:
				return fmt.Sprint(v)
			}
		}
	}
	return ""
}
