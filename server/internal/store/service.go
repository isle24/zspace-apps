package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

//go:embed catalog.json
var catalogJSON []byte
var segmentRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

type loginAttempt struct {
	Failures int
	Until    time.Time
}
type Service struct {
	controllerLocks    *controllerLocks
	runtimeStreams     chan struct{}
	runtimeRefreshWake chan struct{}
	runtimeCatalogMu   sync.Mutex
	nasMu              sync.Mutex
	nasSessions        map[string]*nasMemorySession
	nasClosed          bool
	nasClient          *http.Client
	db                 *sql.DB
	opts               Options
	engine             Engine
	apps               []App
	storeID            string
	ctx                context.Context
	cancel             context.CancelFunc
	wg                 sync.WaitGroup
	closeOnce          sync.Once
	mu                 sync.Mutex
	operation          sync.Mutex
	wake               chan struct{}
	attempts           map[string]loginAttempt
}

func New(opts Options) (*Service, error) {
	if err := validateSetupMode(opts); err != nil {
		return nil, err
	}
	if opts.NASAdminOnly && opts.NASOrigin == "" {
		return nil, errors.New("NAS administrator mode requires a fixed identity origin")
	}
	if err := ValidateNASOrigin(opts.NASOrigin); err != nil {
		return nil, err
	}
	if opts.EngineMode == "" {
		opts.EngineMode = "disabled"
	}
	var addressErr error
	opts.PublishHost, addressErr = publishHost(opts.PublishHost, opts.EngineMode)
	if addressErr != nil {
		return nil, addressErr
	}
	opts.AccessHost, addressErr = accessHost(opts.AccessHost)
	if addressErr != nil {
		return nil, addressErr
	}
	if opts.DataDir == "" {
		return nil, errors.New("store DataDir is required")
	}
	data, err := filepath.Abs(opts.DataDir)
	if err != nil {
		return nil, err
	}
	opts.DataDir = data
	if data == string(filepath.Separator) {
		return nil, errors.New("DataDir must be a dedicated private directory")
	}
	if fi, e := os.Lstat(data); e == nil {
		if !fi.IsDir() || fi.Mode().Perm()&0077 != 0 {
			return nil, errors.New("existing DataDir must be a private directory (0700); permissions will not be changed")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	ancestor := data
	for {
		if _, e := os.Lstat(ancestor); e == nil {
			break
		} else if !os.IsNotExist(e) {
			return nil, e
		}
		ancestor = filepath.Dir(ancestor)
	}
	if err = noSymlinkPath(ancestor); err != nil {
		return nil, fmt.Errorf("unsafe store data ancestor: %w", err)
	}
	if err = os.MkdirAll(data, 0700); err != nil {
		return nil, err
	}
	if err = noSymlinkPath(data); err != nil {
		return nil, fmt.Errorf("unsafe store data directory: %w", err)
	}
	if opts.EngineMode == "" {
		opts.EngineMode = "disabled"
	}
	if opts.StorageRoot == "" && opts.EngineMode != "sshbind" {
		opts.StorageRoot = filepath.Join(data, "instances")
		if err = os.MkdirAll(opts.StorageRoot, 0700); err != nil {
			return nil, err
		}
	}
	if opts.StorageRoot != "" && (!filepath.IsAbs(opts.StorageRoot) || filepath.Clean(opts.StorageRoot) == string(filepath.Separator)) {
		return nil, errors.New("StorageRoot must be a dedicated absolute directory")
	}
	if opts.StorageRoot != "" {
		opts.StorageRoot = filepath.Clean(opts.StorageRoot)
	}
	if opts.EngineMode != "sshbind" {
		if err = noSymlinkPath(opts.StorageRoot); err != nil {
			return nil, err
		}
		fi, e := os.Stat(opts.StorageRoot)
		if e != nil || !fi.IsDir() {
			return nil, errors.New("StorageRoot must already be a directory")
		}
	}
	locks, err := acquireControllerLocks(opts)
	if err != nil {
		return nil, err
	}
	keepLocks := false
	defer func() {
		if !keepLocks {
			locks.Close()
		}
	}()
	dbPath := filepath.Join(data, "store.sqlite")
	if fi, e := os.Lstat(dbPath); e == nil && (fi.Mode()&os.ModeSymlink != 0 || !fi.Mode().IsRegular()) {
		return nil, errors.New("unsafe store database path")
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, stmt := range []string{
		`PRAGMA busy_timeout=5000`, `PRAGMA journal_mode=WAL`,
		`CREATE TABLE IF NOT EXISTS admin(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,username TEXT NOT NULL,expires_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY,data_path TEXT NOT NULL UNIQUE,port INTEGER NOT NULL UNIQUE,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS storage_roots(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,body TEXT NOT NULL)`,
	} {
		if _, err = db.Exec(stmt); err != nil {
			db.Close()
			return nil, err
		}
	}
	if err = initMaintenanceSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	for _, p := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		if _, e := os.Stat(p); e == nil {
			if e = os.Chmod(p, 0600); e != nil {
				db.Close()
				return nil, e
			}
		}
	}
	id := randomID()
	if _, err = db.Exec(`INSERT OR IGNORE INTO metadata(key,value) VALUES('store_id',?)`, id); err != nil {
		db.Close()
		return nil, err
	}
	if err = db.QueryRow(`SELECT value FROM metadata WHERE key='store_id'`).Scan(&id); err != nil {
		db.Close()
		return nil, err
	}
	engine := opts.Engine
	if engine == nil {
		engine, err = newCommandEngine(opts)
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{controllerLocks: locks, db: db, opts: opts, engine: engine, storeID: id, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), attempts: map[string]loginAttempt{}, nasSessions: map[string]*nasMemorySession{}, nasClient: newNASClient()}
	if opts.StorageRoot != "" {
		root := StorageRoot{ID: "storage", Name: "默认应用目录", Path: opts.StorageRoot, Roles: []string{"data", "mediaReadOnly"}, Storage: StorageCandidate{Path: opts.StorageRoot, VolumeType: "unknown", Reason: "初始配置尚未核验设备；安装前将重新读取真实卷与Docker缓存位置。"}}
		b, _ := json.Marshal(root)
		if _, err = db.Exec(`INSERT OR IGNORE INTO storage_roots(id,path,body)VALUES(?,?,?)`, root.ID, root.Path, string(b)); err != nil {
			s.Close()
			return nil, err
		}
	}
	if err = json.Unmarshal(catalogJSON, &s.apps); err != nil {
		s.Close()
		return nil, err
	}
	for i := range s.apps {
		switch s.apps[i].ID {
		case "uptime-kuma":
			s.apps[i].ContainerPort = 3001
			s.apps[i].DataTarget = "/app/data"
			s.apps[i].HealthPath = "/"
		case "navidrome":
			s.apps[i].ContainerPort = 4533
			s.apps[i].DataTarget = "/data"
			s.apps[i].HealthPath = "/ping"
		}
	}
	// A crash during execution cannot safely be blindly retried. Preserve evidence and data.
	jobs, err := s.readJobs()
	if err != nil {
		s.Close()
		return nil, err
	}
	for _, j := range jobs {
		if j.Status == "running" {
			j.Status = "needs_attention"
			j.Error = "服务重启中断了任务；数据已保留，请检查实例状态。"
			j.UpdatedAt = time.Now().UTC()
			if err = s.saveJob(j); err != nil {
				s.Close()
				return nil, err
			}
		}
	}
	s.runtimeStreams = make(chan struct{}, 8)
	s.runtimeRefreshWake = make(chan struct{}, 1)
	if err = s.initRuntime(); err != nil {
		s.Close()
		return nil, err
	}
	s.wg.Add(1)
	go s.runtimeCatalogWorker()
	s.wg.Add(1)
	go s.worker()
	s.notify()
	keepLocks = true
	return s, nil
}

func (s *Service) Close() error {
	var err error
	s.closeOnce.Do(func() {
		s.closeNAS()
		s.cancel()
		s.wg.Wait()
		err = errors.Join(s.db.Close(), s.controllerLocks.Close())
	})
	return err
}
func randomID() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("secure random source unavailable")
	}
	return hex.EncodeToString(b[:])
}
func tokenHash(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": data})
}
func fail(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": map[string]string{"code": code, "message": msg}})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		fail(w, 400, "invalid_request", "请求格式无效或包含不允许的字段。")
		return false
	}
	if d.Decode(&struct{}{}) != io.EOF {
		fail(w, 400, "invalid_request", "只允许一个JSON对象。")
		return false
	}
	return true
}
func (s *Service) Register(mux *http.ServeMux) {
	s.registerRuntime(mux)
	mux.HandleFunc("GET /api/store/bootstrap", s.bootstrap)
	mux.HandleFunc("GET /api/store/status", s.auth(s.status))
	mux.HandleFunc("GET /api/store/catalog", s.auth(s.catalog))
	mux.HandleFunc("POST /api/store/setup", s.setup)
	mux.HandleFunc("POST /api/store/login", s.login)
	mux.HandleFunc("POST /api/store/nas-session", s.nasSession)
	mux.HandleFunc("POST /api/store/logout", s.logoutAuth)
	mux.HandleFunc("GET /api/store/roots", s.auth(s.roots))
	mux.HandleFunc("POST /api/store/roots", s.auth(s.registerRoot))
	mux.HandleFunc("GET /api/store/storage", s.auth(s.storage))
	mux.HandleFunc("GET /api/store/instances", s.auth(s.instances))
	mux.HandleFunc("GET /api/store/jobs", s.auth(s.jobs))
	mux.HandleFunc("POST /api/store/plans", s.auth(s.plans))
	mux.HandleFunc("POST /api/store/install", s.auth(s.install))
	mux.HandleFunc("POST /api/store/instances/{id}/start", s.auth(s.start))
	mux.HandleFunc("POST /api/store/instances/{id}/stop", s.auth(s.stop))
	mux.HandleFunc("POST /api/store/instances/{id}/retry-plan", s.auth(s.retryPlan))
}
func (s *Service) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if len(r.Header.Get("X-Store-Session")) == 48 && s.authenticateNAS(w, r, next) {
			return
		}
		if s.opts.NASAdminOnly {
			fail(w, 401, "nas_auth_required", "请连接当前 NAS 管理员身份。")
			return
		}
		t := r.Header.Get("X-Store-Session")
		if len(t) != 48 {
			fail(w, 401, "store_auth_required", "请先登录应用商店。")
			return
		}
		var expiry int64
		ctx, done := context.WithTimeout(r.Context(), nasVerifyTimeout)
		err := s.db.QueryRowContext(ctx, `SELECT expires_at FROM sessions WHERE token_hash=? AND expires_at>?`, tokenHash(t), time.Now().Unix()).Scan(&expiry)
		done()
		if err != nil {
			fail(w, 401, "store_auth_required", "请先登录应用商店。")
			return
		}
		ctx, cancel := context.WithDeadline(r.Context(), time.Unix(expiry, 0))
		defer cancel()
		next(w, r.WithContext(ctx))
	}
}
func (s *Service) configured() bool {
	if s.opts.NASAdminOnly {
		return true
	}
	var n int
	return s.db.QueryRow(`SELECT count(*) FROM admin`).Scan(&n) == nil && n == 1
}
func (s *Service) bootstrap(w http.ResponseWriter, r *http.Request) {
	mode := "independent"
	if s.opts.NASAdminOnly {
		mode = "nas-admin-only"
	}
	respond(w, 200, map[string]any{"authMode": mode, "configured": s.configured(), "setupRequiresLoopback": s.opts.SetupMode != "lan", "nasAuth": map[string]any{"enabled": s.opts.NASOrigin != "", "origin": s.opts.NASOrigin, "storeId": s.storeID}})
}

func (s *Service) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	err := s.engine.Probe(ctx)
	if !s.requestAuthorized(w, r) {
		return
	}
	msg := "执行引擎可用"
	if err != nil {
		msg = err.Error()
	}
	s.requestRespond(w, r, 200, map[string]any{"nasAuth": map[string]any{"enabled": s.opts.NASOrigin != "", "origin": s.opts.NASOrigin, "storeId": s.storeID}, "configured": s.configured(), "engineMode": s.opts.EngineMode, "engineReady": err == nil, "engineMessage": msg, "nativeIntegration": "handoff", "setupRequiresLoopback": s.opts.SetupMode != "lan"})
}
func (s *Service) catalog(w http.ResponseWriter, r *http.Request) {
	s.requestRespond(w, r, 200, map[string]any{"items": s.apps, "categories": []map[string]string{{"id": "monitoring", "name": "监控"}, {"id": "music", "name": "音乐"}, {"id": "video", "name": "视频"}, {"id": "photos", "name": "照片"}, {"id": "files", "name": "文件"}}})
}
func (s *Service) roots(w http.ResponseWriter, r *http.Request) {
	roots, err := s.readRoots()
	if err != nil {
		fail(w, 500, "storage_failed", "无法读取登记目录。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if inspector, ok := s.engine.(storageInspector); ok {
		for index := range roots {
			root := &roots[index]
			candidate, inspectErr := inspector.InspectStorage(ctx, root.Path)
			if inspectErr != nil || (root.Storage.Identity != "" && root.Storage.Identity != candidate.Identity) {
				root.Storage.InstallAllowed = false
				root.Storage.MediaReadAllowed = false
				root.Storage.Reason = "目录暂无法核验或设备身份已改变，请检查挂载后重试。"
				continue
			}
			if root.Storage.Identity == "" && (safeDataStorage(candidate) || safeMediaStorage(candidate)) {
				verified := *root
				verified.Storage = candidate
				verified.Roles = storageRoles(candidate)
				body, _ := json.Marshal(verified)
				mutationErr, authorized := s.requestDBMutation(w, r, `UPDATE storage_roots SET body=? WHERE id=? AND path=? AND COALESCE(json_extract(body,'$.storage.identity'),'')=''`, string(body), root.ID, root.Path)
				if !authorized {
					return
				}
				if mutationErr != nil {
					fail(w, 500, "storage_failed", "无法保存首次核验的目录身份。")
					return
				}
				pinned, readErr := s.root(root.ID)
				if readErr != nil {
					fail(w, 500, "storage_failed", "无法读取已核验的目录身份。")
					return
				}
				*root = pinned
				if pinned.Path != candidate.Path || pinned.Storage.Identity != candidate.Identity {
					root.Storage.InstallAllowed = false
					root.Storage.MediaReadAllowed = false
					root.Storage.Reason = "目录核验期间身份已变化，请检查挂载后重试。"
					continue
				}
			}
			root.Storage = candidate
			root.Roles = storageRoles(candidate)
			if root.ID == "storage" && root.Name == "初始登记目录（需核验介质）" {
				root.Name = "默认应用目录"
			}
		}
	}
	s.requestRespond(w, r, 200, map[string]any{"items": roots})
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Service) newSession(username string) (map[string]any, error) {
	t := randomID()
	exp := time.Now().UTC().Add(12 * time.Hour)
	_, err := s.db.Exec(`INSERT INTO sessions(token_hash,username,expires_at) VALUES(?,?,?)`, tokenHash(t), username, exp.Unix())
	return map[string]any{"sessionId": t, "username": username, "expiresAt": exp}, err
}
func (s *Service) setup(w http.ResponseWriter, r *http.Request) {
	if s.opts.NASAdminOnly {
		fail(w, 403, "nas_admin_only", "商店使用当前 NAS 管理员身份，无需另设密码。")
		return
	}
	if setupProxied(r) {
		fail(w, 403, "setup_loopback_only", "首次配置须通过直接本地连接或SSH转发完成，不能通过反向代理。")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		trustedNative := origin == "tauri://localhost" || origin == "http://tauri.localhost" || origin == "https://tauri.localhost" || origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173"
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if err != nil || (!(u.Scheme == "http" || u.Scheme == "https") || !strings.EqualFold(u.Host, r.Host)) && !(trustedNative && ip != nil && ip.IsLoopback()) {
			fail(w, 403, "foreign_origin", "首次配置仅允许当前网关页面发起。")
			return
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	requestHost, _, hostErr := net.SplitHostPort(r.Host)
	if hostErr != nil {
		requestHost = strings.Trim(r.Host, "[]")
	}
	requestIP := net.ParseIP(requestHost)
	if s.opts.SetupMode == "lan" && requestHost != "localhost" && (requestIP == nil || (!requestIP.IsPrivate() && !requestIP.IsLoopback())) {
		fail(w, 403, "setup_lan_address_required", "首次配置请直接打开 NAS 的局域网 IP 地址。")
		return
	}
	allowedLAN := s.opts.SetupMode == "lan" && ip != nil && ip.IsPrivate() && requestIP != nil && requestIP.IsPrivate() && r.Header.Get("Origin") != ""
	if err != nil || ip == nil || (!ip.IsLoopback() && !allowedLAN) {
		fail(w, 403, "setup_loopback_only", "首次配置须在网关主机的本地连接完成。")
		return
	}
	var c credentials
	if !decode(w, r, &c) {
		return
	}
	if !segmentRE.MatchString(c.Username) || len(c.Password) < 12 || len(c.Password) > 72 {
		fail(w, 400, "invalid_credentials", "用户名只允许字母、数字、下划线、短横线；密码长度须为12至72字节。")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.configured() {
		fail(w, 409, "already_configured", "商店已配置，请正常登录。")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	c.Password = ""
	if err != nil {
		fail(w, 500, "setup_failed", "无法建立管理员。")
		return
	}
	if _, err = s.db.Exec(`INSERT INTO admin(id,username,password_hash)VALUES(1,?,?)`, c.Username, string(hash)); err != nil {
		fail(w, 500, "setup_failed", "无法保存管理员。")
		return
	}
	v, err := s.newSession(c.Username)
	if err != nil {
		fail(w, 500, "session_failed", "无法建立会话，请登录。")
		return
	}
	respond(w, 201, v)
}
func (s *Service) login(w http.ResponseWriter, r *http.Request) {
	if s.opts.NASAdminOnly {
		fail(w, 403, "nas_admin_only", "请在客户端登录 NAS 管理员后连接商店。")
		return
	}
	var c credentials
	if !decode(w, r, &c) {
		return
	}
	if len(c.Username) > 64 || len(c.Password) > 72 {
		fail(w, 401, "invalid_credentials", "用户名或密码错误。")
		return
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	key := host
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.attempts[key]
	if a.Failures >= 5 && time.Now().Before(a.Until) {
		fail(w, 429, "login_rate_limited", "登录尝试过多，请稍后再试。")
		return
	}
	if time.Now().After(a.Until) {
		a = loginAttempt{}
	}
	var username, hash string
	err := s.db.QueryRow(`SELECT username,password_hash FROM admin WHERE id=1`).Scan(&username, &hash)
	if err != nil || username != c.Username || bcrypt.CompareHashAndPassword([]byte(hash), []byte(c.Password)) != nil {
		if len(s.attempts) > 1000 {
			for k, v := range s.attempts {
				if time.Now().After(v.Until) {
					delete(s.attempts, k)
				}
			}
		}
		a.Failures++
		a.Until = time.Now().Add(15 * time.Minute)
		s.attempts[key] = a
		fail(w, 401, "invalid_credentials", "用户名或密码错误。")
		return
	}
	c.Password = ""
	delete(s.attempts, key)
	s.db.Exec(`DELETE FROM sessions WHERE expires_at<=?`, time.Now().Unix())
	v, err := s.newSession(username)
	if err != nil {
		fail(w, 500, "session_failed", "无法建立会话。")
		return
	}
	respond(w, 200, v)
}
func (s *Service) logoutAuth(w http.ResponseWriter, r *http.Request) {
	if len(r.Header.Get("X-Store-Session")) == 48 && s.nasLogout(w, r) {
		return
	}
	s.auth(s.logout)(w, r)
}
func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, tokenHash(r.Header.Get("X-Store-Session"))); err != nil {
		fail(w, 500, "session_failed", "无法关闭会话。")
		return
	}
	respond(w, 200, map[string]bool{"loggedOut": true})
}

func (s *Service) app(id string) (App, bool) {
	for _, a := range s.apps {
		if a.ID == id {
			return a, true
		}
	}
	return App{}, false
}

type planInput struct {
	AppID       string `json:"appId"`
	RootID      string `json:"rootId"`
	Directory   string `json:"directory"`
	HostPort    int    `json:"hostPort"`
	MediaPath   string `json:"mediaPath"`
	MediaRootID string `json:"mediaRootId"`
}

func (s *Service) plans(w http.ResponseWriter, r *http.Request) {
	var in planInput
	if !decode(w, r, &in) {
		return
	}
	if !s.requestAuthorized(w, r) {
		return
	}
	a, ok := s.app(in.AppID)
	if !ok || !a.Installable {
		fail(w, 400, "recipe_unavailable", "该应用仍待适配，不能安装。")
		return
	}
	if !segmentRE.MatchString(in.Directory) {
		fail(w, 400, "unsafe_path", "请选择登记的根目录和单层全新实例目录名称。")
		return
	}
	if in.HostPort == 0 {
		in.HostPort = a.DefaultPort
	}
	if in.HostPort < 1024 || in.HostPort > 65535 || in.HostPort == 5055 {
		fail(w, 400, "invalid_port", "端口须在1024至65535之间，并保留NAS的5055端口。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if err := s.engine.Probe(ctx); err != nil {
		fail(w, 503, "engine_unavailable", err.Error())
		return
	}
	root, err := s.root(in.RootID)
	if err != nil {
		fail(w, 400, "unknown_storage_root", "请选择已登记并确认的存储目录。")
		return
	}
	volume, docker, err := s.checkStorage(ctx, root)
	if err != nil {
		fail(w, 409, "unsafe_install_storage", err.Error())
		return
	}
	if root.Storage.Identity == "" {
		root.Storage = volume
		root.Roles = storageRoles(volume)
		b, _ := json.Marshal(root)
		mutationErr, authorized := s.requestDBMutation(w, r, `UPDATE storage_roots SET body=? WHERE id=?`, string(b), root.ID)
		if !authorized {
			return
		}
		if mutationErr != nil {
			fail(w, 500, "storage_failed", "无法记录所选卷身份。")
			return
		}
	}
	target := filepath.Join(root.Path, in.Directory)
	if err := s.engine.ValidatePath(ctx, root.Path, target, true); err != nil {
		fail(w, 400, "unsafe_path", err.Error())
		return
	}
	var mediaRoot StorageRoot
	var mediaVolume StorageCandidate
	if a.RequiresMedia {
		if in.MediaPath == "" || in.MediaRootID == "" {
			fail(w, 400, "media_required", "请选择已存在的音乐目录；媒体始终只读。")
			return
		}
		mediaRoot, err = s.root(in.MediaRootID)
		if err != nil {
			fail(w, 400, "unknown_media_root", "请选择已登记的媒体根目录。")
			return
		}
		mediaVolume, err = s.inspectMediaRoot(ctx, mediaRoot)
		if err != nil {
			fail(w, 400, "unsafe_media_root", err.Error())
			return
		}
		if err := s.engine.ValidatePath(ctx, mediaRoot.Path, in.MediaPath, false); err != nil {
			fail(w, 400, "unsafe_media_path", err.Error())
			return
		}
		if filepath.Clean(in.MediaPath) == target || strings.HasPrefix(target, in.MediaPath+string(filepath.Separator)) || strings.HasPrefix(in.MediaPath, target+string(filepath.Separator)) {
			fail(w, 400, "unsafe_media_path", "媒体和全新数据目录必须分开。")
			return
		}
	} else if in.MediaPath != "" || in.MediaRootID != "" {
		fail(w, 400, "unexpected_media", "该配方不接受媒体目录。")
		return
	}
	if err := s.engine.PortAvailable(ctx, in.HostPort); err != nil {
		fail(w, 409, "port_conflict", err.Error())
		return
	}
	if !s.requestLock(w, r, &s.mu) {
		return
	}
	defer s.mu.Unlock()
	var count int
	if err := s.db.QueryRow(`SELECT count(*) FROM instances WHERE data_path=? OR port=?`, target, in.HostPort).Scan(&count); err != nil {
		fail(w, 500, "storage_failed", "无法校验已有实例。")
		return
	}
	if count > 0 {
		fail(w, 409, "instance_conflict", "数据目录或端口已属于已有商店实例。")
		return
	}
	iid := randomID()
	name := "space-store-" + s.storeID[:8] + "-" + iid[:12]
	if _, err := s.engine.Inspect(ctx, name); err == nil {
		fail(w, 409, "container_conflict", "容器名已存在，不能覆盖或重建。")
		return
	} else if !errors.Is(err, ErrNotFound) {
		fail(w, 503, "engine_unavailable", "无法校验容器名。")
		return
	}
	host := "127.0.0.1"
	if h, ok := s.engine.(interface{ Host() string }); ok {
		host = h.Host()
	}
	if s.opts.AccessHost != "" {
		host = s.opts.AccessHost
	}
	url := "http://" + net.JoinHostPort(host, fmt.Sprint(in.HostPort)) + "/"
	native := NativeIntegration{Status: "handoff", AppURL: url, Reason: "NAS原生入口未提供并发安全配置接口，官方配置页面地址待能力确认；可在NAS应用入口设置中手动添加appUrl。"}
	p := Plan{ID: randomID(), AppID: a.ID, RootID: root.ID, RootPath: root.Path, StorageIdentity: volume.Identity, DockerStorageIdentity: docker.Identity, DataPath: target, MediaPath: in.MediaPath, HostPort: in.HostPort, ContainerName: name, Image: a.Image, AccessURL: url, InstanceID: iid, ContainerPort: a.ContainerPort, HealthPath: a.HealthPath, ExpiresAt: time.Now().UTC().Add(30 * time.Minute), NativeIntegration: native, Mounts: []Mount{{Source: target, Target: a.DataTarget}}}
	p.PublishHost = s.opts.PublishHost
	if a.RequiresMedia {
		p.MediaRootID = mediaRoot.ID
		p.MediaRootPath = mediaRoot.Path
		p.MediaStorageIdentity = mediaVolume.Identity
		p.Mounts = append(p.Mounts, Mount{Source: in.MediaPath, Target: "/music", ReadOnly: true})
	}
	if !s.runtimeMutation(w, r, func(tx *sql.Tx) error {
		if e := s.runtimeCrossReservations(tx, p.InstanceID, p.DataPath, []int{p.HostPort}, p.ID); e != nil {
			return e
		}
		b, _ := json.Marshal(p)
		_, e := tx.ExecContext(r.Context(), `INSERT INTO plans(id,body)VALUES(?,?)`, p.ID, string(b))
		return e
	}) {
		return
	}

	s.requestRespond(w, r, 201, p)
}
func (s *Service) readPlan(id string) (Plan, error) {
	var b string
	var p Plan
	err := s.db.QueryRow(`SELECT body FROM plans WHERE id=?`, id).Scan(&b)
	if err == nil {
		err = json.Unmarshal([]byte(b), &p)
	}
	return p, err
}
func (s *Service) install(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PlanID    string `json:"planId"`
		RequestID string `json:"requestId"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !s.requestAuthorized(w, r) {
		return
	}
	if !segmentRE.MatchString(in.RequestID) || len(in.PlanID) != 48 {
		fail(w, 400, "invalid_request_id", "请提供有效计划ID和稳定的请求ID。")
		return
	}
	if !s.requestLock(w, r, &s.mu) {
		return
	}
	defer s.mu.Unlock()
	var body string
	err := s.db.QueryRow(`SELECT body FROM jobs WHERE request_id=?`, in.RequestID).Scan(&body)
	if err == nil {
		var j Job
		if json.Unmarshal([]byte(body), &j) != nil {
			fail(w, 500, "storage_failed", "任务记录无效。")
			return
		}
		if j.PlanID != in.PlanID {
			fail(w, 409, "request_id_conflict", "同一请求ID已用于另一计划。")
			return
		}
		s.requestRespond(w, r, 202, j)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		fail(w, 500, "storage_failed", "无法读取任务。")
		return
	}
	p, err := s.readPlan(in.PlanID)
	if err != nil {
		fail(w, 404, "plan_not_found", "安装计划不存在。")
		return
	}
	if time.Now().After(p.ExpiresAt) {
		fail(w, 409, "plan_expired", "安装计划已过期，请重新检查目录与端口。")
		return
	}
	var exists int
	if err = s.db.QueryRow(`SELECT count(*) FROM jobs WHERE plan_id=?`, p.ID).Scan(&exists); err != nil {
		fail(w, 500, "storage_failed", "无法检查计划。")
		return
	}
	if exists > 0 {
		fail(w, 409, "plan_used", "该计划已有任务，请查询原任务。")
		return
	}
	now := time.Now().UTC()
	j := Job{ID: randomID(), PlanID: p.ID, RequestID: in.RequestID, InstanceID: p.InstanceID, Status: "queued", Stage: "queued", Stages: []Stage{{Name: "queued", Status: "completed", At: now}}, CreatedAt: now, UpdatedAt: now}
	i := Instance{ID: p.InstanceID, AppID: p.AppID, RootPath: p.RootPath, MediaRootPath: p.MediaRootPath, MediaStorageIdentity: p.MediaStorageIdentity, ContainerName: p.ContainerName, Image: p.Image, DataPath: p.DataPath, HostPort: p.HostPort, AccessURL: p.AccessURL, State: "queued", Health: "unknown", Initialization: "pending", NativeIntegration: p.NativeIntegration, Mounts: p.Mounts, CreatedAt: now}
	i.PublishHost = p.PublishHost
	i.ContainerPort = p.ContainerPort
	if p.RetryOfJobID != "" {
		i, err = s.readInstance(p.InstanceID)
		if err != nil || !sameRetryBeforeEnqueue(p, i) {
			fail(w, 409, "retry_scope_mismatch", "保留实例与已确认计划不一致，拒绝重试。")
			return
		}
	}
	var sourceProof legacySourceRetryProof
	if p.PreviousImage != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		sourceProof, err = s.proveLegacySourceRetry(ctx, p, i)
		cancel()
		if !s.requestAuthorized(w, r) {
			return
		}
		if err != nil {
			fail(w, 409, "retry_unsafe", err.Error())
			return
		}
	}
	jb, _ := json.Marshal(j)
	ib, _ := json.Marshal(i)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		if !s.requestAuthorized(w, r) {
			return
		}
		fail(w, 500, "storage_failed", "无法创建任务。")
		return
	}
	defer tx.Rollback()
	if !s.requestAuthorizedReader(w, r, tx) {
		return
	}
	if maintenanceFailure(w, maintenanceReady(tx)) {
		return
	}
	if e := s.runtimeCrossReservations(tx, p.InstanceID, p.DataPath, []int{p.HostPort}, p.ID); e != nil {
		fail(w, 409, "instance_conflict", "数据目录或端口已被另一审核计划或运行代保留。")
		return
	}
	if p.RetryOfJobID != "" {
		prior, e := retrySource(tx, p.InstanceID)
		if e != nil || prior.ID != p.RetryOfJobID || prior.PlanID != p.RetryOfPlanID {
			fail(w, 409, "retry_unavailable", "实例已有活动任务或重试来源已变化，请重新生成计划。")
			return
		}
		if p.PreviousImage != "" {
			// The engine proof is already complete. Bind its exact SQL inputs in
			// the same short transaction that reserves the intended image and job.
			var currentBody string
			var current Instance
			e = tx.QueryRow(`SELECT body FROM instances WHERE id=?`, i.ID).Scan(&currentBody)
			if e == nil {
				e = json.Unmarshal([]byte(currentBody), &current)
			}
			if e != nil || !reflect.DeepEqual(current, i) || !sameRetryBeforeEnqueue(p, current) {
				fail(w, 409, "retry_scope_mismatch", "保留实例在入队前已改变。")
				return
			}
			e = sourceProof.verifySQL(tx, p, prior)
			if !s.requestAuthorizedReader(w, r, tx) {
				return
			}
			if e != nil {
				fail(w, 409, "retry_unsafe", e.Error())
				return
			}
			i.Image = p.Image
		}
		// Preserve the immutable instance identity, creation time and pinned data.
		i.State = "queued"
		i.Health = "unknown"
		ib, _ = json.Marshal(i)
		_, err = tx.ExecContext(r.Context(), `UPDATE instances SET body=? WHERE id=?`, string(ib), i.ID)
	} else {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO instances(id,data_path,port,body)VALUES(?,?,?,?)`, i.ID, i.DataPath, i.HostPort, string(ib))
	}
	if err != nil {
		fail(w, 409, "instance_conflict", "数据目录或端口已有商店任务，不能重复安装。")
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)`, j.ID, j.PlanID, j.RequestID, j.Status, string(jb)); err != nil {
		fail(w, 409, "install_conflict", "该计划或请求ID已有任务。")
		return
	}
	commitErr, authorized := s.requestMutation(w, r, tx, func(ctx context.Context) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return tx.Commit()
	})
	if !authorized {
		return
	}
	if commitErr != nil {
		if errors.Is(commitErr, errRuntimeAuth) {
			fail(w, 401, "store_auth_required", "会话已失效。")
			return
		}
		fail(w, 500, "storage_failed", "无法保存任务。")
		return
	}
	s.notify()
	s.requestRespond(w, r, 202, j)
}
func (s *Service) readJobs() ([]Job, error) {
	rows, err := s.db.Query(`SELECT body FROM jobs ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Job{}
	for rows.Next() {
		var b string
		var j Job
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(b), &j); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}
func (s *Service) jobs(w http.ResponseWriter, r *http.Request) {
	items, err := s.readJobs()
	if err != nil {
		fail(w, 500, "storage_failed", "无法读取任务。")
		return
	}
	s.requestRespond(w, r, 200, map[string]any{"items": items})
}
func (s *Service) readInstances() ([]Instance, error) {
	rows, err := s.db.Query(`SELECT body FROM instances ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Instance{}
	for rows.Next() {
		var b string
		var i Instance
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(b), &i); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}
func (s *Service) instances(w http.ResponseWriter, r *http.Request) {
	items, err := s.readInstances()
	if err != nil {
		fail(w, 500, "storage_failed", "无法读取实例。")
		return
	}
	// Reconciliation reads only names already in this store's database. Never adopt
	// a container without matching immutable recipe/labels and pinned directory.
	if s.operation.TryLock() {
		defer s.operation.Unlock()
		// This compatibility GET historically reconciled observations into metadata.
		// In maintenance return the retained private view without writing evidence.
		if maintenanceReady(s.db) != nil {
			s.requestRespond(w, r, 200, map[string]any{"items": items})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		for n, i := range items {
			if i.State == "queued" || i.Provenance.Marker == "" {
				continue
			}
			c, e := s.engine.Inspect(ctx, i.ContainerName)
			if e != nil {
				if errors.Is(e, ErrNotFound) {
					i.State = "missing"
					i.Health = "unknown"
					if _, authorized := s.saveRequestInstance(w, r, i); !authorized {
						return
					}
					items[n] = i
				}
				continue
			}
			candidate := i
			if candidate.ContainerID == "" {
				candidate.ContainerID = c.ID
			}
			if !s.owns(c, candidate) {
				i.State = "ownership_mismatch"
				i.Health = "unknown"
				if _, authorized := s.saveRequestInstance(w, r, i); !authorized {
					return
				}
				items[n] = i
				continue
			}
			if e = s.verifyDirectory(ctx, i.RootPath, i.DataPath, i.Provenance); e != nil {
				i.State = "path_identity_mismatch"
				i.Health = "unknown"
				if _, authorized := s.saveRequestInstance(w, r, i); !authorized {
					return
				}
				items[n] = i
				continue
			}
			if i.State != c.State {
				candidate.Health = "unknown"
			}
			candidate.State = c.State
			mutationErr, authorized := s.saveRequestInstance(w, r, candidate)
			if !authorized {
				return
			}
			if mutationErr == nil {
				items[n] = candidate
			}
		}
	}
	s.requestRespond(w, r, 200, map[string]any{"items": items})
}
func (s *Service) saveJob(j Job) error {
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE jobs SET status=?,body=? WHERE id=?`, j.Status, string(b), j.ID)
	return err
}
func (s *Service) saveInstance(i Instance) error {
	b, err := json.Marshal(i)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE instances SET body=? WHERE id=?`, string(b), i.ID)
	return err
}
func (s *Service) readInstance(id string) (Instance, error) {
	var b string
	var i Instance
	err := s.db.QueryRow(`SELECT body FROM instances WHERE id=?`, id).Scan(&b)
	if err == nil {
		err = json.Unmarshal([]byte(b), &i)
	}
	return i, err
}
func (s *Service) start(w http.ResponseWriter, r *http.Request) { s.changeState(w, r, true) }
func (s *Service) stop(w http.ResponseWriter, r *http.Request)  { s.changeState(w, r, false) }
func (s *Service) owns(c Container, i Instance) bool {
	if c.ID != i.ContainerID || c.Name != i.ContainerName || c.Image != i.Image || c.Labels["io.spacedesktop.store"] != s.storeID || c.Labels["io.spacedesktop.instance"] != i.ID {
		return false
	}
	if i.PublishHost == "" || i.ContainerPort == 0 || len(c.Ports) != 1 || c.Ports[0] != (PortBinding{HostIP: i.PublishHost, HostPort: i.HostPort, ContainerPort: i.ContainerPort, Protocol: "tcp"}) {
		return false
	}
	if len(c.Mounts) != len(i.Mounts) {
		return false
	}
	for _, want := range i.Mounts {
		found := false
		for _, have := range c.Mounts {
			if have == want {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func (s *Service) changeState(w http.ResponseWriter, r *http.Request, start bool) {
	if !s.requestLock(w, r, &s.operation) {
		return
	}
	defer s.operation.Unlock()
	if !s.requestMaintenanceReady(w, r) {
		return
	}
	i, err := s.readInstance(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "instance_not_found", "实例不存在。")
		return
	}
	if i.ContainerID == "" {
		fail(w, 409, "instance_unavailable", "任务尚未生成经校验的容器。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	c, err := s.engine.Inspect(ctx, i.ContainerName)
	if err != nil || !s.owns(c, i) {
		fail(w, 409, "ownership_mismatch", "容器身份、商店标签或挂载与登记实例不一致；拒绝管理。")
		return
	}
	if start {
		if err = s.verifyDirectory(ctx, i.RootPath, i.DataPath, i.Provenance); err != nil {
			fail(w, 409, "path_identity_mismatch", err.Error())
			return
		}
		if err = s.checkInstanceMedia(ctx, i); err != nil {
			fail(w, 409, "media_identity_mismatch", err.Error())
			return
		}
		var planID string
		if err = s.db.QueryRow(`SELECT plan_id FROM jobs WHERE json_extract(body,'$.instanceId')=? ORDER BY rowid DESC LIMIT 1`, i.ID).Scan(&planID); err != nil {
			fail(w, 409, "instance_plan_unavailable", "保留实例缺少已确认的安装计划，拒绝启动。")
			return
		}
		p, e := s.readPlan(planID)
		if e != nil || !sameRetryMaterial(p, i) {
			fail(w, 409, "instance_plan_mismatch", "保留实例与已确认安装范围不一致，拒绝启动。")
			return
		}
		starter, ok := s.engine.(guardedStarter)
		if !ok {
			fail(w, 409, "start_guard_unavailable", "执行引擎缺少启动边界校验能力，拒绝启动。")
			return
		}
		if !s.requestAuthorized(w, r) {
			return
		}
		err = starter.Resume(ctx, ResumeSpec{Plan: p, Instance: i, StoreID: s.storeID})
	} else {
		if !s.requestAuthorized(w, r) {
			return
		}
		err = s.engine.Stop(ctx, c.ID)
	}
	if err != nil {
		fail(w, 502, "engine_operation_failed", "容器操作失败，实例与数据已保留。")
		return
	}
	c, err = s.engine.Inspect(ctx, i.ContainerName)
	if err != nil || !s.owns(c, i) {
		fail(w, 502, "engine_state_unknown", "操作后无法确认容器状态，请检查执行引擎。")
		return
	}
	i.State = c.State
	i.Health = "unknown"
	if start {
		h, e := s.engine.Health(ctx, i.ContainerName, i.HostPort, healthPath(i.AppID))
		if e == nil {
			i.Health = h
		} else {
			i.Health = "unhealthy"
		}
	}
	mutationErr, authorized := s.saveRequestInstance(w, r, i)
	if !authorized {
		return
	}
	if mutationErr != nil {
		fail(w, 500, "storage_failed", "无法保存实例状态。")
		return
	}
	s.requestRespond(w, r, 200, i)
}
func healthPath(id string) string {
	if id == "navidrome" {
		return "/ping"
	}
	return "/"
}
func (s *Service) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *Service) worker() {
	defer s.wg.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
			jobs, err := s.readJobs()
			if err != nil {
				continue
			}
			for n := len(jobs) - 1; n >= 0; n-- {
				if s.ctx.Err() != nil {
					return
				}
				if jobs[n].Status == "queued" {
					s.execute(jobs[n])
				}
			}
		}
	}
}
func (s *Service) execute(j Job) {
	s.operation.Lock()
	defer s.operation.Unlock()
	if maintenanceReady(s.db) != nil {
		return
	}
	// Claim only the complete queued reservation read by the worker.
	if j.Status != "queued" {
		return
	}
	queuedBody, err := json.Marshal(j)
	if err != nil {
		return
	}
	j.Status = "running"
	j.UpdatedAt = time.Now().UTC()
	body, err := json.Marshal(j)
	if err != nil {
		return
	}
	claimed, err := s.db.Exec(`UPDATE jobs SET status='running',body=? WHERE id=? AND plan_id=? AND request_id=? AND status='queued' AND body=?`, string(body), j.ID, j.PlanID, j.RequestID, string(queuedBody))
	if err != nil {
		return
	}
	count, err := claimed.RowsAffected()
	if err != nil || count != 1 {
		return
	}
	p, err := s.readPlan(j.PlanID)
	if err != nil {
		j.Status = "needs_attention"
		j.Error = "持久任务的计划不可读取，请检查商店数据库。"
		s.saveSourceJob(j, string(body), "running")
		return
	}
	i, err := s.readInstance(j.InstanceID)
	if err != nil {
		j.Status = "needs_attention"
		j.Error = "持久任务的实例不可读取，请检查商店数据库。"
		s.saveSourceJob(j, string(body), "running")
		return
	}
	// Immutable byte snapshots avoid aliasing mutable stage/mount slices.
	expectedJobBody, expectedJobStatus := string(body), j.Status
	initialInstance, err := json.Marshal(i)
	if err != nil {
		return
	}
	expectedInstanceBody := string(initialInstance)
	persistJob := func() error {
		if p.PreviousImage == "" {
			return s.saveJob(j)
		}
		if err := s.saveSourceJob(j, expectedJobBody, expectedJobStatus); err != nil {
			return err
		}
		next, _ := json.Marshal(j)
		expectedJobBody, expectedJobStatus = string(next), j.Status
		return nil
	}
	persistInstance := func() error {
		if p.PreviousImage == "" {
			return s.saveInstance(i)
		}
		if err := s.saveSourceInstance(i, expectedInstanceBody, j, expectedJobBody, expectedJobStatus); err != nil {
			return err
		}
		next, _ := json.Marshal(i)
		expectedInstanceBody = string(next)
		return nil
	}
	ctx, cancel := context.WithTimeout(s.ctx, 20*time.Minute)
	defer cancel()
	j.Status = "running"
	stage := func(name string, fn func() error) bool {
		j.Stage = name
		j.UpdatedAt = time.Now().UTC()
		j.Stages = append(j.Stages, Stage{Name: name, Status: "running", At: j.UpdatedAt})
		if persistJob() != nil {
			return false
		}
		err := fn()
		if err != nil {
			j.Status = "failed"
			if i.ContainerID != "" || j.Stage == "start" || p.RetryOfJobID != "" {
				j.Status = "needs_attention"
			}
			if s.ctx.Err() != nil {
				j.Status = "needs_attention"
			}
			j.Error = err.Error()
			j.Stages[len(j.Stages)-1].Status = "failed"
			j.Stages[len(j.Stages)-1].Message = j.Error
			i.State = "failed"
			if i.ContainerID != "" || p.RetryOfJobID != "" {
				i.State = "needs_attention"
			}
			i.Health = "unknown"
			j.UpdatedAt = time.Now().UTC()
			if persistJob() == nil {
				persistInstance()
			}
			return false
		}
		j.Stages[len(j.Stages)-1].Status = "completed"
		j.UpdatedAt = time.Now().UTC()
		return persistJob() == nil
	}
	var retained bool
	if !stage("preflight", func() error {
		if p.RetryOfJobID != "" {
			if e := s.checkSourceExecution(ctx, p, i, j); e != nil {
				return e
			}
			if !sameRetryMaterial(p, i) {
				return errors.New("保留实例与重试计划范围不一致。")
			}
			c, exists, e := s.checkRetrySafety(ctx, p, i)
			if e != nil {
				return e
			}
			retained = exists
			if exists {
				i.ContainerID = c.ID
			}
			return persistInstance()
		}
		if err = s.engine.Probe(ctx); err != nil {
			return err
		}
		root, e := s.root(p.RootID)
		if e != nil || root.Path != p.RootPath {
			return errors.New("所选存储目录登记已改变，拒绝执行旧计划。")
		}
		volume, docker, e := s.checkStorage(ctx, root)
		if e != nil {
			return e
		}
		if p.StorageIdentity == "" || volume.Identity != p.StorageIdentity || p.DockerStorageIdentity == "" || docker.Identity != p.DockerStorageIdentity {
			return errors.New("用户数据卷或Docker镜像缓存身份与安装计划不一致，拒绝拉取镜像。")
		}
		if _, e := s.engine.Inspect(ctx, p.ContainerName); e == nil {
			return errors.New("容器名已存在，拒绝覆盖或重建。")
		} else if !errors.Is(e, ErrNotFound) {
			return errors.New("无法确认容器名可用。")
		}
		if err = s.engine.ValidatePath(ctx, p.RootPath, p.DataPath, true); err != nil {
			return err
		}
		if p.MediaPath != "" {
			if err = s.checkMediaPlan(ctx, p); err != nil {
				return err
			}
			if err = s.engine.ValidatePath(ctx, p.MediaRootPath, p.MediaPath, false); err != nil {
				return err
			}
		}
		if err = s.engine.PortAvailable(ctx, p.HostPort); err != nil {
			return err
		}
		if err = s.engine.Prepare(ctx, p.RootPath, p.DataPath); err != nil {
			return err
		}
		i.Provenance, err = s.pinDirectory(ctx, p.RootPath, p.DataPath, s.storeID+":"+i.ID)
		if err != nil {
			return err
		}
		return persistInstance()
	}) {
		return
	}
	if !stage("pull", func() error {
		if retained {
			return nil
		}
		if p.RetryOfJobID != "" {
			if e := s.checkSourceExecution(ctx, p, i, j); e != nil {
				return e
			}
			_, exists, e := s.checkRetrySafety(ctx, p, i)
			if e != nil {
				return e
			}
			if exists {
				return errors.New("预检后容器名被占用，拒绝接管。")
			}
		}
		root, e := s.root(p.RootID)
		if e != nil {
			return e
		}
		volume, docker, e := s.checkStorage(ctx, root)
		if e != nil {
			return e
		}
		if volume.Identity != p.StorageIdentity || docker.Identity != p.DockerStorageIdentity {
			return errors.New("卷或Docker镜像缓存位置已改变，拒绝拉取镜像。")
		}
		if e := s.checkSourceExecution(ctx, p, i, j); e != nil {
			return e
		}
		return s.engine.Pull(ctx, p.Image)
	}) {
		return
	}
	if !stage("start", func() error {
		if e := s.checkSourceExecution(ctx, p, i, j); e != nil {
			return e
		}
		if p.RetryOfJobID != "" {
			c, exists, e := s.checkRetrySafety(ctx, p, i)
			if e != nil {
				return e
			}
			if exists {
				if !retained {
					return errors.New("拉取期间容器名被占用，拒绝接管。")
				}
				if c.State != "running" {
					starter, ok := s.engine.(guardedStarter)
					if !ok {
						return errors.New("执行引擎缺少保留容器启动边界校验能力，拒绝启动。")
					}
					if e = starter.Resume(ctx, ResumeSpec{Plan: p, Instance: i, StoreID: s.storeID}); e != nil {
						return e
					}
				}
				c, e = s.engine.Inspect(ctx, p.ContainerName)
				if e != nil || !s.owns(c, i) {
					return errors.New("重试启动后容器身份无法确认。")
				}
				i.State = c.State
				return persistInstance()
			}
		}
		if err = s.verifyDirectory(ctx, p.RootPath, p.DataPath, i.Provenance); err != nil {
			return err
		}
		if _, e := s.engine.Inspect(ctx, p.ContainerName); e == nil {
			return errors.New("容器名被占用，拒绝覆盖。")
		} else if !errors.Is(e, ErrNotFound) {
			return e
		}
		if err = s.engine.PortAvailable(ctx, p.HostPort); err != nil {
			return err
		}
		if err = s.engine.ValidatePath(ctx, p.RootPath, p.DataPath, false); err != nil {
			return err
		}
		if p.MediaPath != "" {
			if err = s.checkMediaPlan(ctx, p); err != nil {
				return err
			}
		}
		spec := RunSpec{Name: p.ContainerName, Image: p.Image, HostPort: p.HostPort, ContainerPort: p.ContainerPort, Mounts: p.Mounts, Root: p.RootPath, MediaRootPath: p.MediaRootPath, MediaStorageIdentity: p.MediaStorageIdentity, Provenance: i.Provenance, Labels: map[string]string{"io.spacedesktop.store": s.storeID, "io.spacedesktop.instance": i.ID}}
		spec.PublishHost = p.PublishHost
		if i.AppID == "navidrome" {
			spec.Env = []string{"ND_SCANSCHEDULE=1h", "ND_LOGLEVEL=info"}
		}
		if e := s.checkSourceExecution(ctx, p, i, j); e != nil {
			return e
		}
		if err = s.engine.Run(ctx, spec); err != nil {
			// A source migration must never adopt a container after an uncertain
			// creation response. Preserve it for inspection and retain the failed job.
			if p.PreviousImage != "" {
				return err
			}
			readCtx, readCancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer readCancel()
			if c, e := s.engine.Inspect(readCtx, i.ContainerName); e == nil {
				candidate := i
				candidate.ContainerID = c.ID
				if s.owns(c, candidate) {
					i = candidate
					i.State = c.State
					persistInstance()
				}
			}
			return err
		}
		c, e := s.engine.Inspect(ctx, p.ContainerName)
		if e != nil {
			return errors.New("容器创建后无法确认身份，数据已保留。")
		}
		i.ContainerID = c.ID
		if !s.owns(c, i) {
			return errors.New("新容器身份或挂载校验失败，拒绝继续管理。")
		}
		i.State = c.State
		return persistInstance()
	}) {
		return
	}
	if !stage("health", func() error {
		h, e := s.engine.Health(ctx, p.ContainerName, p.HostPort, p.HealthPath)
		i.Health = h
		if e != nil {
			return e
		}
		if h != "healthy" {
			return errors.New("应用尚未通过健康检查；数据与容器已保留。")
		}
		return persistInstance()
	}) {
		return
	}
	if !stage("initialization", func() error { i.Initialization = "pending"; return persistInstance() }) {
		return
	}
	if !stage("native-entry", func() error { i.NativeIntegration = p.NativeIntegration; return persistInstance() }) {
		return
	}
	j.Status = "completed"
	j.Stage = "completed"
	j.UpdatedAt = time.Now().UTC()
	j.Stages = append(j.Stages, Stage{Name: "completed", Status: "completed", At: j.UpdatedAt})
	persistJob()
}

// Reject every symlink component; this also protects registered roots from replacement.
func noSymlinkPath(p string) error {
	p = filepath.Clean(p)
	for q := p; ; q = filepath.Dir(q) {
		fi, err := os.Lstat(q)
		if err != nil {
			return errors.New("目录不存在或不可访问。")
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return errors.New("路径含符号链接，不能作为商店目录。")
		}
		if q == filepath.Dir(q) {
			break
		}
	}
	return nil
}
func validateLocalPath(root, p string, fresh bool) error {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return errors.New("目录须为规范的绝对路径。")
	}
	rel, err := filepath.Rel(root, p)
	if err != nil || (rel == "." && fresh) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("目录必须位于登记的根目录内。")
	}
	if err = noSymlinkPath(root); err != nil {
		return err
	}
	if fresh {
		if filepath.Dir(p) != root {
			return errors.New("数据目录只允许根目录下的全新直接子目录。")
		}
		if _, err = os.Lstat(p); err == nil {
			return errors.New("目录已存在，拒绝复用、清空或覆盖。")
		} else if !os.IsNotExist(err) {
			return errors.New("无法安全检查目录。")
		}
		return nil
	}
	if err = noSymlinkPath(p); err != nil {
		return err
	}
	fi, err := os.Stat(p)
	if err != nil || !fi.IsDir() {
		return errors.New("路径须为已存在的目录。")
	}
	return nil
}
