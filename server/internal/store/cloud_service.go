package store

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const cloudSessionTTL = 30 * 24 * time.Hour

type CloudUser struct {
	ID                string `json:"id"`
	Username          string `json:"username"`
	Role              string `json:"role"`
	TwoFactorRequired bool   `json:"twoFactorRequired,omitempty"`
	TwoFactorEnabled  bool   `json:"twoFactorEnabled,omitempty"`
}

type CloudEnvironment struct {
	Name    string  `json:"name"`
	Label   string  `json:"label"`
	Secret  bool    `json:"secret"`
	Default *string `json:"default,omitempty"`
}

// CloudApp deliberately contains public deployment metadata only. Registry
// image configurations, account credentials and local NAS paths never enter it.
type CloudApp struct {
	ID             string             `json:"id"`
	Name           string             `json:"name"`
	Description    string             `json:"description"`
	Category       string             `json:"category"`
	Icon           string             `json:"icon"`
	Image          string             `json:"image"`
	Version        string             `json:"version"`
	ContainerPort  int                `json:"containerPort"`
	DataTargets    []string           `json:"dataTargets"`
	Environment    []CloudEnvironment `json:"environment,omitempty"`
	Published      bool               `json:"published"`
	ReleaseNumber  int64              `json:"releaseNumber"`
	ManifestDigest string             `json:"manifestDigest,omitempty"`
	GithubSync     string             `json:"githubSync,omitempty"`
}

type cloudService struct {
	cache         *cloudImageCache
	s             *Service
	db            *cloudDB
	rateMu        sync.Mutex
	rates         map[string]cloudRate
	publicationMu sync.Mutex
	twoFactorMu   sync.Mutex
	twoFactorNow  func() time.Time
	dummyHash     []byte
	resolveImage  func(context.Context, string) (CloudImageInspection, error)
	signingKey    ed25519.PrivateKey
	githubClient  *http.Client
}
type cloudRate struct {
	count int
	until time.Time
}
type cloudActorKey struct{}

var cloudTokenRE = regexp.MustCompile(`^[a-f0-9]{48}$`)

// RegisterCloudHandlers is for the central catalog gateway. It never changes
// the existing administrator or exposes local controller/session APIs.
func (s *Service) RegisterCloudHandlers(mux *http.ServeMux) error {
	c, err := newCloudService(s)
	if err != nil {
		return err
	}
	c.register(mux)
	return nil
}

func newCloudService(s *Service) (*cloudService, error) {
	db, err := openCloudDB(s)
	if err != nil {
		return nil, err
	}
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS cloud_admin(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,username_key TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role='admin'))`,
		`CREATE TABLE IF NOT EXISTS cloud_accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL,username_key TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user' CHECK(role='user'))`,
		`CREATE TABLE IF NOT EXISTS cloud_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS cloud_apps(id TEXT PRIMARY KEY,draft_json TEXT NOT NULL,published_json TEXT,revision INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE IF NOT EXISTS cloud_releases(app_id TEXT NOT NULL,release_number INTEGER NOT NULL,app_json TEXT NOT NULL,manifest BLOB NOT NULL,PRIMARY KEY(app_id,release_number))`,
		`CREATE TABLE IF NOT EXISTS cloud_wishlist(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,image TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,app_id TEXT NOT NULL DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS cloud_history(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,app_id TEXT NOT NULL,app_name TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,device_name TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,app_id,device_name))`,
		`CREATE TABLE IF NOT EXISTS cloud_private(key TEXT PRIMARY KEY,value BLOB NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS cloud_icons(hash TEXT PRIMARY KEY,body BLOB NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS cloud_artwork(hash TEXT PRIMARY KEY,body BLOB NOT NULL,mime TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS cloud_publications(sequence INTEGER PRIMARY KEY,published_at TEXT NOT NULL,payload BLOB NOT NULL,envelope BLOB NOT NULL)`,
	} {
		if db.postgres {
			stmt = strings.ReplaceAll(stmt, " BLOB ", " BYTEA ")
		}
		if _, err := db.Exec(stmt); err != nil {
			return nil, errors.New("cloud schema initialization failed")
		}
	}
	c := &cloudService{s: s, db: db, rates: map[string]cloudRate{}, resolveImage: inspectCloudImage}
	if err := c.importLegacyAdmin(s.ctx); err != nil {
		return nil, errors.New("cloud administrator import failed")
	}
	c.dummyHash, err = bcrypt.GenerateFromPassword([]byte(randomID()), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	for _, r := range RuntimeRecipes() {
		app := CloudApp{ID: r.AppID, Name: r.Name, Description: r.Description, Category: r.Category, Icon: r.CatalogIconURL, Version: r.Version, Published: true, ReleaseNumber: 1, DataTargets: []string{}}
		for _, svc := range r.Services {
			if !svc.Entry {
				continue
			}
			app.Image = svc.Image
			app.ContainerPort = svc.ContainerPort
			for _, v := range svc.Volumes {
				if v.Role != "media-readonly" {
					app.DataTargets = append(app.DataTargets, v.Target)
				}
			}
			break
		}
		if app.Icon == "" {
			app.Icon = r.Icon
		}
		b, _ := json.Marshal(app)
		if _, err := db.Exec(`INSERT INTO cloud_apps(id,draft_json,published_json) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`, app.ID, string(b), string(b)); err != nil {
			return nil, err
		}
	}
	if err := c.initializeSigning(s.ctx); err != nil {
		return nil, errors.New("cloud catalog signing initialization failed")
	}
	if err := c.initializeCache(); err != nil {
		return nil, errors.New("cloud image cache initialization failed")
	}
	if err := c.initializeTwoFactor(s.ctx); err != nil {
		return nil, errors.New("cloud two factor initialization failed")
	}
	return c, nil
}

func (c *cloudService) register(mux *http.ServeMux) {
	c.registerTwoFactor(mux)
	c.registerCache(mux)
	mux.HandleFunc("POST /api/cloud/register", c.registerAccount)
	mux.HandleFunc("POST /api/cloud/login", c.loginAccount)
	mux.HandleFunc("GET /api/cloud/me", c.auth(false, func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]any{"user": cloudActor(r)}) }))
	mux.HandleFunc("POST /api/cloud/logout", c.auth(false, c.logoutAccount))
	mux.HandleFunc("GET /api/cloud/catalog", c.auth(false, c.catalog))
	mux.HandleFunc("GET /api/cloud/catalog/{id}", c.auth(false, c.catalogDetail))
	mux.HandleFunc("GET /api/cloud/catalog/signed", c.auth(false, c.signedCatalog))
	mux.HandleFunc("GET /api/cloud/catalog-key", c.catalogKey)
	mux.HandleFunc("GET /api/cloud/icons/{hash}", c.icon)
	mux.HandleFunc("GET /api/cloud/artwork", c.artwork)
	mux.HandleFunc("GET /api/cloud/artwork/{hash}", c.artwork)
	c.registerAdminAssist(mux)
	mux.HandleFunc("GET /api/cloud/manifests/{id}/{release}", c.auth(false, c.releaseManifest))
	mux.HandleFunc("GET /api/cloud/catalogs/{sequence}", c.auth(false, c.versionCatalog))
	mux.HandleFunc("GET /api/cloud/wishlist", c.auth(false, c.wishlist))
	mux.HandleFunc("POST /api/cloud/wishlist", c.auth(false, c.createWishlist))
	mux.HandleFunc("GET /api/cloud/history", c.auth(false, c.history))
	mux.HandleFunc("POST /api/cloud/history", c.auth(false, c.recordHistory))
	mux.HandleFunc("GET /api/store/admin/apps", c.auth(true, c.adminApps))
	mux.HandleFunc("POST /api/store/admin/apps", c.auth(true, c.saveApp))
	mux.HandleFunc("POST /api/store/admin/apps/{id}/publish", c.auth(true, c.publishApp))
	mux.HandleFunc("POST /api/store/admin/inspect-image", c.auth(true, c.inspectImage))
	mux.HandleFunc("GET /api/store/admin/wishlist", c.auth(true, c.adminWishlist))
	mux.HandleFunc("POST /api/store/admin/wishlist/{id}", c.auth(true, c.updateWishlist))
	mux.HandleFunc("GET /api/store/admin/cloud-settings", c.auth(true, c.getSettings))
	mux.HandleFunc("POST /api/store/admin/cloud-settings", c.auth(true, c.saveSettings))
}

func (c *cloudService) allowAuth(w http.ResponseWriter, r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	key := tokenHash(host)
	now := time.Now()
	c.rateMu.Lock()
	defer c.rateMu.Unlock()
	if len(c.rates) >= 4096 {
		for k, v := range c.rates {
			if now.After(v.until) {
				delete(c.rates, k)
			}
		}
	}
	a := c.rates[key]
	if now.After(a.until) {
		a = cloudRate{until: now.Add(15 * time.Minute)}
	}
	if a.count >= 30 || len(c.rates) >= 4096 && a.count == 0 {
		w.Header().Set("Retry-After", "900")
		fail(w, 429, "cloud_auth_rate_limited", "登录或注册尝试过多，请稍后再试。")
		return false
	}
	a.count++
	c.rates[key] = a
	return true
}

func (c *cloudService) registerAccount(w http.ResponseWriter, r *http.Request) {
	if !c.allowAuth(w, r) {
		return
	}
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	if len(in.Username) < 4 || !segmentRE.MatchString(in.Username) || utf8.RuneCountInString(in.Password) < 6 || len(in.Password) > 72 || !utf8.ValidString(in.Password) {
		fail(w, 400, "invalid_credentials", "用户名须为4至64位字母、数字、下划线或短横线；密码至少6位且不超过72字节。")
		return
	}
	var reserved int
	if err := c.importLegacyAdmin(r.Context()); err != nil {
		fail(w, 500, "cloud_account_failed", "无法创建账户。")
		return
	}
	if err := c.db.QueryRowContext(r.Context(), `SELECT count(*) FROM cloud_admin WHERE username_key=?`, strings.ToLower(in.Username)).Scan(&reserved); err != nil {
		fail(w, 500, "cloud_account_failed", "无法创建账户。")
		return
	}
	if reserved != 0 {
		fail(w, 409, "username_unavailable", "此用户名已被使用。")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	in.Password = ""
	if err != nil {
		fail(w, 500, "cloud_account_failed", "无法创建账户。")
		return
	}
	u := CloudUser{ID: randomID(), Username: in.Username, Role: "user"}
	if _, err = c.db.ExecContext(r.Context(), `INSERT INTO cloud_accounts(id,username,username_key,password_hash,role) VALUES(?,?,?,?,'user')`, u.ID, u.Username, strings.ToLower(u.Username), string(hash)); err != nil {
		var n int
		if e := c.db.QueryRowContext(r.Context(), `SELECT count(*) FROM cloud_accounts WHERE username_key=?`, strings.ToLower(u.Username)).Scan(&n); e == nil && n > 0 {
			fail(w, 409, "username_unavailable", "此用户名已被使用。")
		} else {
			fail(w, 500, "cloud_account_failed", "无法创建账户。")
		}
		return
	}
	c.issueSession(w, r, u, 201)
}

func (c *cloudService) loginAccount(w http.ResponseWriter, r *http.Request) {
	if !c.allowAuth(w, r) {
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
		OTP      string `json:"otp,omitempty"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !segmentRE.MatchString(in.Username) || len(in.Password) > 72 {
		fail(w, 401, "invalid_credentials", "用户名或密码错误。")
		return
	}
	u := CloudUser{ID: "admin:1", Role: "admin"}
	var hash string
	if err := c.importLegacyAdmin(r.Context()); err != nil {
		fail(w, 500, "cloud_account_failed", "无法读取登录账户。")
		return
	}
	err := c.db.QueryRowContext(r.Context(), `SELECT username,password_hash FROM cloud_admin WHERE id=1 AND username_key=?`, strings.ToLower(in.Username)).Scan(&u.Username, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		u = CloudUser{Role: "user"}
		err = c.db.QueryRowContext(r.Context(), `SELECT id,username,password_hash FROM cloud_accounts WHERE username_key=?`, strings.ToLower(in.Username)).Scan(&u.ID, &u.Username, &hash)
	}
	if err != nil {
		hash = string(c.dummyHash)
	}
	valid := bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) == nil
	in.Password = ""
	if err != nil || !valid {
		fail(w, 401, "invalid_credentials", "用户名或密码错误。")
		return
	}
	if u.Role == "admin" {
		c.issueAdminSession(w, r, u, in.OTP)
		return
	}
	c.issueSession(w, r, u, 200)
}

func (c *cloudService) issueSession(w http.ResponseWriter, r *http.Request, u CloudUser, status int) {
	token := randomID()
	expiry := time.Now().UTC().Add(cloudSessionTTL).Truncate(time.Second)
	_, err := c.db.ExecContext(r.Context(), `INSERT INTO cloud_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)`, tokenHash(token), u.ID, expiry.Unix())
	if err != nil {
		fail(w, 500, "cloud_session_failed", "无法建立登录会话。")
		return
	}
	c.db.ExecContext(r.Context(), `DELETE FROM cloud_sessions WHERE expires_at<=?`, time.Now().Unix())
	respond(w, status, map[string]any{"sessionId": token, "expiresAt": expiry.Format(time.RFC3339), "user": u})
}

func (c *cloudService) auth(admin bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") || !cloudTokenRE.MatchString(strings.TrimPrefix(auth, "Bearer ")) {
			fail(w, 401, "cloud_auth_required", "请先登录云端应用商店。")
			return
		}
		var id string
		var expiry int64
		err := c.db.QueryRowContext(r.Context(), `SELECT user_id,expires_at FROM cloud_sessions WHERE token_hash=? AND expires_at>?`, tokenHash(strings.TrimPrefix(auth, "Bearer ")), time.Now().Unix()).Scan(&id, &expiry)
		u := CloudUser{ID: id, Role: "user"}
		if err == nil {
			if id == "admin:1" {
				u.Role = "admin"
				err = c.db.QueryRowContext(r.Context(), `SELECT username FROM cloud_admin WHERE id=1 AND role='admin'`).Scan(&u.Username)
			} else {
				err = c.db.QueryRowContext(r.Context(), `SELECT username FROM cloud_accounts WHERE id=? AND role='user'`, id).Scan(&u.Username)
			}
		}
		if err != nil {
			fail(w, 401, "cloud_auth_required", "登录会话已失效，请重新登录。")
			return
		}
		if admin && u.Role != "admin" {
			fail(w, 403, "cloud_admin_required", "此操作需要商店管理员权限。")
			return
		}
		if u.Role == "admin" {
			state, stateErr := c.twoFactorState(r.Context())
			if stateErr != nil {
				fail(w, 500, "cloud_2fa_failed", "无法读取双重验证状态。")
				return
			}
			status := state.status(c.twoFactorTime())
			u.TwoFactorRequired, u.TwoFactorEnabled = status.Required, status.Enabled
			if admin && status.Required && !cloudTwoFactorRoute(r.URL.Path) {
				fail(w, 403, "cloud_2fa_setup_required", "请先绑定双重验证，再使用管理功能。")
				return
			}
		}
		ctx, cancel := context.WithDeadline(r.Context(), time.Unix(expiry, 0))
		defer cancel()
		next(w, r.WithContext(context.WithValue(ctx, cloudActorKey{}, u)))
	}
}
func cloudActor(r *http.Request) CloudUser {
	u, _ := r.Context().Value(cloudActorKey{}).(CloudUser)
	return u
}

func (c *cloudService) logoutAccount(w http.ResponseWriter, r *http.Request) {
	if _, err := c.db.ExecContext(r.Context(), `DELETE FROM cloud_sessions WHERE token_hash=?`, tokenHash(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))); err != nil {
		fail(w, 500, "cloud_session_failed", "无法注销登录会话。")
		return
	}
	respond(w, 200, map[string]bool{"loggedOut": true})
}

func cloudText(v string, min, max int) bool {
	return utf8.ValidString(v) && len(v) <= max && utf8.RuneCountInString(strings.TrimSpace(v)) >= min && strings.IndexFunc(v, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) < 0
}
