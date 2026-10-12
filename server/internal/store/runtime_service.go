package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

type runtimeInstance struct {
	NativeLicense      string `json:"nativeLicense,omitempty"`
	DeliveryLabel      string `json:"deliveryLabel,omitempty"`
	ID                 string `json:"id"`
	AppID              string `json:"appId"`
	Name               string `json:"name"`
	ActiveGenerationID string `json:"activeGenerationId"`
	Version            string `json:"version"`
	State              string `json:"state"`
	Health             string `json:"health"`
	Initialization     string `json:"initialization"`
	AccessURL          string `json:"accessUrl"`
	DataPath           string `json:"dataPath"`
	HostPort           int    `json:"hostPort"`
	Archived           bool   `json:"archived"`
	Legacy             bool   `json:"legacy"`
	UpdateAvailable    bool   `json:"updateAvailable"`
	IgnoredVersion     string `json:"ignoredVersion"`
}
type runtimeJob struct {
	SourceState string `json:"sourceState,omitempty"`
	Job
	Kind  string `json:"kind"`
	AppID string `json:"appId"`
}
type runtimeSettings struct {
	DefaultRootID      string `json:"defaultRootId"`
	Theme              string `json:"theme"`
	UpdateCheckEnabled bool   `json:"updateCheckEnabled"`
	UpdateCheckHours   int    `json:"updateCheckHours"`
}
type runtimePlanInput struct {
	Kind          string `json:"kind"`
	AppID         string `json:"appId"`
	InstanceID    string `json:"instanceId"`
	TargetVersion string `json:"targetVersion"`
	SnapshotID    string `json:"snapshotId"`
	RootID        string `json:"rootId"`
	Directory     string `json:"directory"`
	HostPort      int    `json:"hostPort"`
	PeerPort      int    `json:"peerPort"`
	DiscoveryPort int    `json:"discoveryPort"`
	MediaRootID   string `json:"mediaRootId"`
	MediaPath     string `json:"mediaPath"`
}

var errRuntimeAuth = errors.New("session expired")
var errRuntimeConflict = errors.New("reviewed plan expired, stale or conflicts with retained resources")

func (s *Service) initRuntime() error {
	if err := s.initRuntimeSecrets(); err != nil {
		return err
	}
	if err := s.initRuntimeCloud(); err != nil {
		return err
	}
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS runtime_plans(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS runtime_instances(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS runtime_generations(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS runtime_jobs(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS runtime_snapshots(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS runtime_settings(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS runtime_catalog(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
	} {
		if _, e := s.db.Exec(q); e != nil {
			return e
		}
	}
	jobs, e := runtimeRead[runtimeJob](s.db, "runtime_jobs")
	if e != nil {
		return e
	}
	for _, j := range jobs {
		if j.Status == "running" {
			j.Status = "needs_attention"
			j.Error = "服务重启中断任务，所有资源已保留；请显式核对状态。"
			j.UpdatedAt = time.Now().UTC()
			if e = s.runtimeSaveJob(j); e != nil {
				return e
			}
		}
	}
	s.wg.Add(1)
	go s.runtimeWorker()
	return nil
}

type runtimeQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func runtimeRead[T any](db runtimeQuerier, table string) ([]T, error) {
	return runtimeReadContext[T](context.Background(), db, table)
}
func runtimeReadContext[T any](ctx context.Context, db runtimeQuerier, table string) ([]T, error) {
	rows, e := db.QueryContext(ctx, "SELECT body FROM "+table+" ORDER BY rowid")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var body string
		var v T
		if e = rows.Scan(&body); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(body), &v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func runtimeGet[T any](db runtimeQuerier, table, id string) (T, error) {
	var v T
	var body string
	e := db.QueryRowContext(context.Background(), "SELECT body FROM "+table+" WHERE id=?", id).Scan(&body)
	if e == nil {
		e = json.Unmarshal([]byte(body), &v)
	}
	return v, e
}
func runtimePut(tx interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, ctx context.Context, table, id string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	_, e = tx.ExecContext(ctx, "INSERT INTO "+table+"(id,body)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET body=excluded.body", id, string(b))
	return e
}

// Engine operations may finish after an independent preference edit. Preserve
// that edit in the same SQL statement, including switch and rollback writes.
// Explicit user edits continue using runtimePut and are never merged away.
func runtimePutObservedInstance(tx interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, ctx context.Context, value runtimeInstance) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO runtime_instances(id,body)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET body=json_set(excluded.body,'$.ignoredVersion',coalesce(json_extract(runtime_instances.body,'$.ignoredVersion'),''))`, value.ID, string(body))
	return err
}

// SQL authorization is checked with the already-held connection. The NAS map
// mutex encloses only Commit, so there is no DB-pool/mutex inversion.
func (s *Service) runtimeMutation(w http.ResponseWriter, r *http.Request, fn func(*sql.Tx) error) bool {
	return s.runtimeAuthTransaction(w, r, func(tx *sql.Tx) error {
		if err := maintenanceReady(tx); err != nil {
			return err
		}
		return fn(tx)
	})
}

// This path bypasses maintenance only for its controllers and exact readonly
// job replay. Fresh admission must explicitly check maintenance in its held Tx.
func (s *Service) runtimeAuthTransaction(w http.ResponseWriter, r *http.Request, fn func(*sql.Tx) error) bool {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		if !s.runtimeAuthorized(r) {
			fail(w, 401, "store_auth_required", "会话已失效。")
			return false
		}
		fail(w, 500, "storage_failed", "无法开始保存操作。")
		return false
	}
	defer tx.Rollback()
	grant, nas := r.Context().Value(nasGrantKey{}).(nasRequestGrant)
	if !nas {
		var n int
		e = tx.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE token_hash=? AND expires_at>?`, tokenHash(r.Header.Get("X-Store-Session")), time.Now().Unix()).Scan(&n)
		if e != nil || n != 1 {
			fail(w, 401, "store_auth_required", "会话已失效。")
			return false
		}
	}
	if nas && !s.runtimeAuthorized(r) {
		fail(w, 401, "store_auth_required", "会话已失效。")
		return false
	}
	if e = fn(tx); e == nil {
		if nas {
			s.nasMu.Lock()
			if !s.validNASGrantLocked(ctx, grant) {
				e = errRuntimeAuth
			} else {
				e = tx.Commit()
			}
			s.nasMu.Unlock()
		} else {
			var n int
			e = tx.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE token_hash=? AND expires_at>?`, tokenHash(r.Header.Get("X-Store-Session")), time.Now().Unix()).Scan(&n)
			if e == nil && n == 1 {
				e = tx.Commit()
			} else {
				e = errRuntimeAuth
			}
		}
	}
	// A failed SQL/evidence callback may have observed request cancellation.
	// Classify that as lost authorization for both session kinds, without
	// borrowing the DB pool while this transaction still holds its connection.
	if r.Context().Err() != nil || (nas && !s.runtimeAuthorized(r)) {
		e = errRuntimeAuth
	}
	if e != nil {
		if errors.Is(e, errRuntimeAuth) {
			fail(w, 401, "store_auth_required", "会话已失效。")
		} else if maintenanceFailure(w, e) {
		} else if errors.Is(e, errRuntimeConflict) {
			fail(w, 409, "plan_conflict", e.Error())
		} else {
			fail(w, 500, "storage_failed", "无法保存操作。")
		}
		return false
	}
	return true
}
func (s *Service) runtimeAuthorized(r *http.Request) bool {
	if g, ok := r.Context().Value(nasGrantKey{}).(nasRequestGrant); ok {
		s.nasMu.Lock()
		defer s.nasMu.Unlock()
		return s.validNASGrantLocked(r.Context(), g)
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	var n int
	return r.Context().Err() == nil && s.db.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE token_hash=? AND expires_at>?`, tokenHash(r.Header.Get("X-Store-Session")), time.Now().Unix()).Scan(&n) == nil && n == 1
}
func (s *Service) registerRuntime(mux *http.ServeMux) {
	routes := map[string]http.HandlerFunc{"GET maintenance": s.maintenanceGet, "POST maintenance/quiesce": s.maintenanceQuiesce, "POST maintenance/{id}/resume": s.maintenanceResume, "GET catalog": s.runtimeCatalog, "GET recipes/{appID}": s.runtimeRecipes, "GET instances": s.runtimeInstances, "POST instances/reconcile": s.runtimeReconcile, "GET generations": s.runtimeGenerations, "GET jobs": s.runtimeJobs, "GET snapshots": s.runtimeSnapshots, "GET settings": s.runtimeGetSettings, "POST settings": s.runtimeSetSettings, "GET desktop": s.runtimeDesktop, "GET diagnostics": s.runtimeDiagnostics, "POST plans": s.runtimePlans, "POST jobs/{id}/retry-plan": s.runtimeRetryPlan, "POST execute": s.runtimeExecute, "POST batches": s.runtimeBatch, "GET jobs/events": s.runtimeEvents, "POST catalog/refresh": s.runtimeRefresh, "GET instances/{id}/logs": s.runtimeLogs, "GET snapshots/{id}/download": s.runtimeDownload, "POST instances/{id}/ignore-update": s.runtimeIgnore, "GET roots/{id}/directories": s.runtimeDirectories}
	for route, h := range routes {
		parts := strings.SplitN(route, " ", 2)
		mux.HandleFunc(parts[0]+" /api/store/v2/"+parts[1], s.auth(h))
	}
	mux.HandleFunc("POST /api/store/v2/cloud/install-plan", s.auth(s.runtimeCloudInstallPlan))
}
func (s *Service) runtimeCatalog(w http.ResponseWriter, r *http.Request) {
	items := []map[string]any{}
	for _, a := range s.runtimeRecipesAll() {
		versions := []string{a.Version}
		for _, v := range a.CompatibleFrom {
			versions = append(versions, v)
		}
		item := map[string]any{"id": a.AppID, "name": a.Name, "version": a.Version, "latestVersion": a.Version, "availableVersions": versions, "description": a.Description, "category": a.Category, "icon": a.Icon, "sourceUrl": a.SourceURL, "documentation": a.Documentation, "installable": !s.opts.CatalogOnly, "upgradeAllowed": true, "defaultPort": a.DefaultPort, "requiresMedia": a.RequiresMedia, "recipeRevision": a.Revision, "platforms": a.SupportedPlatforms, "services": a.Services, "license": a.License, "minimumMemoryBytes": a.MinimumMemoryBytes, "migrationStrategy": a.MigrationStrategy}
		if s.opts.CatalogOnly {
			item["icon"] = a.CatalogIconURL
		}
		if c, e := runtimeGet[runtimeCatalogEntry](s.db, "runtime_catalog", a.AppID); e == nil {
			item["latestVersion"] = c.LatestVersion
			item["sourceStatus"] = c.Status
			item["sourceError"] = c.Error
			item["checkedAt"] = c.CheckedAt
			_, item["upgradeAllowed"] = s.runtimeRecipeFor(a.AppID, c.LatestVersion)
		}
		if a.AppID == "nasreader" {
			item["latestVersion"] = a.Version
			item["upgradeAllowed"] = false
			item["deliveryLabel"] = a.DeliveryLabel
			item["nativeLicense"] = a.NativeLicense
			item["deliverySource"] = "owner-archive"
			item["sourceStatus"] = "fixed-author-delivery"
			item["sourceError"] = ""
		}
		items = append(items, item)
	}
	categories := []map[string]string{{"id": "monitoring", "name": "监控工具"}, {"id": "music", "name": "音乐播放"}, {"id": "video", "name": "影视媒体"}, {"id": "photos", "name": "照片管理"}, {"id": "sync", "name": "文件同步"}, {"id": "reading", "name": "图书阅读"}}
	s.runtimeRespond(w, r, 200, map[string]any{"items": items, "categories": categories})
}
func (s *Service) runtimeRecipes(w http.ResponseWriter, r *http.Request) {
	a, ok := s.runtimeRecipeFor(r.PathValue("appID"), r.URL.Query().Get("version"))
	if !ok {
		fail(w, 404, "recipe_unavailable", "没有审核配方。")
		return
	}
	s.runtimeRespond(w, r, 200, a)
}
func (s *Service) runtimeInstances(w http.ResponseWriter, r *http.Request) {
	items, e := s.runtimeInstanceView()
	if e != nil {
		fail(w, 500, "storage_failed", "无法读取实例。")
		return
	}
	s.runtimeRespond(w, r, 200, map[string]any{"items": items})
}
func (s *Service) runtimeInstanceView() ([]runtimeInstance, error) {
	items, e := runtimeRead[runtimeInstance](s.db, "runtime_instances")
	if e != nil {
		return nil, e
	}
	legacy, e := s.readInstances()
	if e != nil {
		return nil, e
	}
	for _, i := range legacy {
		items = append(items, runtimeInstance{ID: i.ID, AppID: i.AppID, Name: i.AppID, State: i.State, Health: i.Health, Initialization: i.Initialization, AccessURL: i.AccessURL, DataPath: i.DataPath, HostPort: i.HostPort, Legacy: true})
	}
	for n := range items {
		if items[n].AppID == "nasreader" {
			recipe, _ := RuntimeRecipeFor("nasreader", "")
			items[n].NativeLicense = recipe.NativeLicense
			items[n].DeliveryLabel = recipe.DeliveryLabel
			items[n].UpdateAvailable = false
			continue
		}
		if !items[n].Legacy {
			latest, _ := s.runtimeRecipeFor(items[n].AppID, "")
			if c, e := runtimeGet[runtimeCatalogEntry](s.db, "runtime_catalog", items[n].AppID); e == nil {
				latest.Version = c.LatestVersion
			}
			cmp, e := CompareRuntimeVersions(latest.Version, items[n].Version)
			items[n].UpdateAvailable = e == nil && cmp > 0 && latest.Version != items[n].IgnoredVersion
		}
	}
	return items, nil
}
func (s *Service) runtimeGenerations(w http.ResponseWriter, r *http.Request) {
	items, e := runtimeRead[RuntimeGeneration](s.db, "runtime_generations")
	if e != nil {
		fail(w, 500, "storage_failed", "无法读取运行代。")
		return
	}
	s.runtimeRespond(w, r, 200, map[string]any{"items": items})
}
func (s *Service) runtimeJobs(w http.ResponseWriter, r *http.Request) {
	items, e := runtimeRead[runtimeJob](s.db, "runtime_jobs")
	if e != nil {
		fail(w, 500, "storage_failed", "无法读取任务。")
		return
	}
	s.runtimeRespond(w, r, 200, map[string]any{"items": items})
}
func (s *Service) runtimeSnapshots(w http.ResponseWriter, r *http.Request) {
	items, e := runtimeRead[RuntimeSnapshot](s.db, "runtime_snapshots")
	if e != nil {
		fail(w, 500, "storage_failed", "无法读取快照。")
		return
	}
	s.runtimeRespond(w, r, 200, map[string]any{"items": items})
}
func (s *Service) runtimeSettingsValue() runtimeSettings {
	v, e := runtimeGet[runtimeSettings](s.db, "runtime_settings", "settings")
	if e != nil {
		return runtimeSettings{Theme: "light", UpdateCheckEnabled: true, UpdateCheckHours: 6}
	}
	return v
}
func (s *Service) runtimeGetSettings(w http.ResponseWriter, r *http.Request) {
	s.runtimeRespond(w, r, 200, s.runtimeSettingsValue())
}
func (s *Service) runtimeSetSettings(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Theme              string          `json:"theme"`
		UpdateCheckEnabled bool            `json:"updateCheckEnabled"`
		UpdateCheckHours   int             `json:"updateCheckHours"`
		DefaultRootID      json.RawMessage `json:"defaultRootId"`
	}
	if !decode(w, r, &input) {
		return
	}
	if (input.Theme != "light" && input.Theme != "dark" && input.Theme != "system") || input.UpdateCheckHours < 1 || input.UpdateCheckHours > 168 {
		fail(w, 400, "invalid_settings", "主题或检查周期无效。")
		return
	}
	var requestedRoot *string
	var verifiedRoot StorageRoot
	var proof StorageCandidate
	if len(input.DefaultRootID) > 0 {
		if json.Unmarshal(input.DefaultRootID, &requestedRoot) != nil || requestedRoot == nil {
			fail(w, 400, "invalid_default_root", "默认存储须为登记目录标识或空字符串。")
			return
		}
		if *requestedRoot != "" {
			if !segmentRE.MatchString(*requestedRoot) {
				fail(w, 400, "invalid_default_root", "请选择登记的数据目录，不能提交宿主路径。")
				return
			}
			var e error
			verifiedRoot, e = s.root(*requestedRoot)
			if e != nil {
				fail(w, 400, "unknown_storage_root", "默认存储目录没有登记。")
				return
			}
			if !runtimeRootHasDataRole(verifiedRoot) {
				fail(w, 400, "invalid_default_root", "只读媒体目录不能作为默认应用数据目录。")
				return
			}
			inspector, ok := s.engine.(storageInspector)
			if !ok {
				fail(w, 503, "storage_discovery_unavailable", "执行引擎无法核验默认存储介质。")
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			proof, e = inspector.InspectStorage(ctx, verifiedRoot.Path)
			cancel()
			if !s.runtimeAuthorized(r) {
				fail(w, 401, "store_auth_required", "会话已失效，未保存默认存储。")
				return
			}
			if e != nil || !safeDataStorage(proof) || (verifiedRoot.Storage.Identity != "" && verifiedRoot.Storage.Identity != proof.Identity) {
				fail(w, 409, "unsafe_storage", "默认存储不在已核验的数据卷上，或登记的目录身份已变化。")
				return
			}
		}
	}
	value := runtimeSettings{Theme: input.Theme, UpdateCheckEnabled: input.UpdateCheckEnabled, UpdateCheckHours: input.UpdateCheckHours}
	if s.runtimeMutation(w, r, func(tx *sql.Tx) error {
		if requestedRoot == nil {
			previous, e := runtimeGet[runtimeSettings](tx, "runtime_settings", "settings")
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return e
			}
			value.DefaultRootID = previous.DefaultRootID
		} else {
			value.DefaultRootID = *requestedRoot
		}
		if requestedRoot != nil && *requestedRoot != "" {
			current, e := runtimeGet[StorageRoot](tx, "storage_roots", *requestedRoot)
			if e != nil || !runtimeRootHasDataRole(current) || current.Path != verifiedRoot.Path || (current.Storage.Identity != "" && current.Storage.Identity != proof.Identity) {
				return errRuntimeConflict
			}
		}
		return runtimePut(tx, r.Context(), "runtime_settings", "settings", value)
	}) {
		s.runtimeRespond(w, r, 200, value)
	}
}
func runtimeRootHasDataRole(root StorageRoot) bool {
	for _, role := range root.Roles {
		if role == "data" {
			return true
		}
	}
	return false
}

func (s *Service) runtimeDesktop(w http.ResponseWriter, r *http.Request) {
	items, e := s.runtimeInstanceView()
	if e != nil {
		fail(w, 500, "storage_failed", "无法读取桌面。")
		return
	}
	out := []map[string]any{}
	for _, i := range items {
		if !i.Archived {
			out = append(out, map[string]any{"id": i.ID, "name": i.Name, "appId": i.AppID, "accessUrl": i.AccessURL, "state": i.State, "health": i.Health, "initialization": i.Initialization, "nativeLicense": i.NativeLicense, "deliveryLabel": i.DeliveryLabel, "nativeIntegration": map[string]any{"status": "handoff", "appUrl": i.AccessURL, "reason": "官方入口需在正常NAS管理员会话中确认与读回。"}})
		}
	}
	s.runtimeRespond(w, r, 200, map[string]any{"items": out})
}
func (s *Service) runtimeDiagnostics(w http.ResponseWriter, r *http.Request) {
	data := map[string]any{"storeId": s.storeID, "engineMode": s.opts.EngineMode, "version": "v2", "retention": "all generations, snapshots and failed resources retained", "runtimeSupported": false}
	publishers := []string{}
	seen := map[string]bool{}
	for _, recipe := range RuntimeRecipes() {
		for _, svc := range recipe.Services {
			repository := strings.Split(svc.Image, "@")[0]
			if pos := strings.LastIndex(repository, ":"); pos > strings.LastIndex(repository, "/") {
				repository = repository[:pos]
			}
			if !seen[repository] {
				publishers = append(publishers, repository)
				seen[repository] = true
			}
		}
	}
	data["source"] = map[string]any{"policy": "official publishers; immutable digests; executable versions require reviewed recipes", "publishers": publishers}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if engine, ok := s.engine.(RuntimeEngine); ok {
		data["runtimeSupported"] = true
		if facts, e := engine.RuntimeFacts(ctx); e == nil {
			data["facts"] = facts
		} else {
			data["factsError"] = "执行引擎事实无法核验。"
		}
	} else {
		data["factsError"] = "执行引擎未提供版本运行能力。"
	}
	storage := map[string]any{"dockerStorageSafe": false, "dockerStorage": nil, "message": "Docker存储介质无法核验。"}
	if engine, ok := s.engine.(storageInspector); ok {
		if candidate, e := engine.DockerStorage(ctx); e == nil {
			storage["dockerStorage"] = candidate
			storage["dockerStorageSafe"] = safeDockerStorage(candidate)
			storage["message"] = candidate.Reason
			if !safeDockerStorage(candidate) {
				storage["message"] = "Docker缓存不在可确认的非系统数据卷，禁止拉取镜像。"
			}
		}
	}
	data["storage"] = storage
	s.runtimeRespond(w, r, 200, data)
}

func (s *Service) runtimePlans(w http.ResponseWriter, r *http.Request) {
	var in runtimePlanInput
	if !decode(w, r, &in) {
		return
	}
	s.runtimeCreatePlan(w, r, in, nil)
}

func (s *Service) runtimeRetryPlan(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if !decode(w, r, &body) {
		return
	}
	if body == nil || len(body) != 0 {
		fail(w, 400, "invalid_request", "重试只接受空JSON对象。")
		return
	}
	j, e := runtimeGet[runtimeJob](s.db, "runtime_jobs", r.PathValue("id"))
	if e != nil {
		fail(w, 404, "retry_job_unavailable", "任务不存在。")
		return
	}
	if j.ID != r.PathValue("id") {
		fail(w, 409, "retry_job_unavailable", "任务身份无法核验。")
		return
	}
	if j.Status != "failed" {
		fail(w, 409, "retry_not_allowed", "仅失败的版本任务可重新核对计划。")
		return
	}
	p, e := runtimeGet[RuntimePlan](s.db, "runtime_plans", j.PlanID)
	if e != nil || p.ID != j.PlanID || p.StoreID != s.storeID || p.InstanceID != j.InstanceID || p.Kind != j.Kind || p.AppID != j.AppID || validateRuntimePlan(p) != nil {
		fail(w, 409, "retry_plan_unavailable", "任务没有本商店已核验的不可变版本计划。")
		return
	}
	in := runtimePlanInput{Kind: p.Kind, AppID: p.AppID, InstanceID: p.InstanceID, TargetVersion: p.TargetVersion, SnapshotID: p.SourceSnapshotID, RootID: p.RootID, HostPort: p.HostPort, PeerPort: p.PeerPort, DiscoveryPort: p.DiscoveryPort, MediaPath: p.MediaPath}
	if p.Kind == "install" {
		root, err := s.root(p.RootID)
		if err != nil || root.Path != p.RootPath || !runtimeRootHasDataRole(root) {
			fail(w, 409, "retry_root_changed", "原登记数据目录已变化，请重新核对安装。")
			return
		}
		name := filepath.Base(p.DataPath)
		if !segmentRE.MatchString(name) {
			fail(w, 409, "retry_plan_unavailable", "原数据目录无效。")
			return
		}
		if len(name) > 9 {
			name = name[:9]
		}
		in.Directory = name + "-retry-" + randomID()
		if p.MediaPath != "" {
			roots, err := s.readRoots()
			if err != nil {
				fail(w, 500, "storage_failed", "无法读取登记媒体目录。")
				return
			}
			for _, root := range roots {
				if root.Path == p.MediaRootPath && (root.Storage.Identity == "" || root.Storage.Identity == p.MediaStorageIdentity) {
					in.MediaRootID = root.ID
					break
				}
			}
			if in.MediaRootID == "" {
				fail(w, 409, "retry_root_changed", "原登记媒体目录已变化。")
				return
			}
		}
	}
	proof, e := s.runtimeVerifyRetry(r.Context(), j, p)
	if e != nil {
		fail(w, 409, "retry_resources_unverified", "原失败资源不能证明已停止或未创建，请核对实例。")
		return
	}
	var snapshot *RuntimeSnapshot
	if p.Kind == "restore" {
		record, err := runtimeGet[runtimePlanRecord](s.db, "runtime_plans", p.ID)
		if err != nil || record.SnapshotBinding == nil {
			fail(w, 409, "retry_snapshot_unverified", "原恢复计划没有不可变快照基线，请重新核对恢复。")
			return
		}
		current, err := runtimeGet[RuntimeSnapshot](s.db, "runtime_snapshots", p.SourceSnapshotID)
		if err != nil || !reflect.DeepEqual(current, *record.SnapshotBinding) {
			fail(w, 409, "retry_snapshot_changed", "原选快照已缺失或变化，请重新核对恢复。")
			return
		}
		verifier, ok := s.engine.(interface {
			VerifyRuntimeSnapshot(context.Context, RuntimeSnapshot) error
		})
		if !ok || verifier.VerifyRuntimeSnapshot(r.Context(), current) != nil {
			fail(w, 409, "retry_snapshot_changed", "原选快照材料无法核验。")
			return
		}
		snapshot = &current
	}
	s.runtimeCreatePlan(w, r, in, &runtimeRetryReview{job: j, plan: p, binding: proof, snapshot: snapshot})
}

type runtimePlanRecord struct {
	RuntimePlan
	SnapshotBinding *RuntimeSnapshot     `json:"_snapshotBinding,omitempty"`
	RetryBinding    *runtimeRetryBinding `json:"_retryBinding,omitempty"`
}
type runtimeRetryAncestor struct {
	Job        runtimeJob         `json:"job"`
	Plan       RuntimePlan        `json:"plan"`
	Instance   *runtimeInstance   `json:"instance,omitempty"`
	Generation *RuntimeGeneration `json:"generation,omitempty"`
}

// Bounded private ancestry, ordered parent to oldest; never exposed by API.
const runtimeMaxRetryAncestors = 64

type runtimeRetryBinding struct {
	runtimeRetryAncestor
	Ancestors []runtimeRetryAncestor `json:"ancestors,omitempty"`
}

func (b runtimeRetryBinding) members() []runtimeRetryAncestor {
	return append([]runtimeRetryAncestor{b.runtimeRetryAncestor}, b.Ancestors...)
}

type runtimeRetryLaunchKey struct{}

type runtimeRetryReview struct {
	job      runtimeJob
	plan     RuntimePlan
	binding  runtimeRetryBinding
	snapshot *RuntimeSnapshot
}

func (s *Service) runtimeCreatePlan(w http.ResponseWriter, r *http.Request, in runtimePlanInput, retry *runtimeRetryReview) {
	valid := false
	for _, k := range []string{"install", "update", "backup", "restore", "archive", "reactivate", "restart", "start", "stop"} {
		valid = valid || in.Kind == k
	}
	if !valid {
		fail(w, 400, "invalid_kind", "不支持该操作。")
		return
	}
	var source RuntimeGeneration
	var instance runtimeInstance
	var snap RuntimeSnapshot
	var e error
	if in.Kind != "install" {
		instance, e = runtimeGet[runtimeInstance](s.db, "runtime_instances", in.InstanceID)
		if e != nil {
			fail(w, 400, "unknown_instance", "请选择本商店实例。")
			return
		}
		if retry != nil && (instance.Legacy || instance.AppID != retry.plan.AppID || instance.ActiveGenerationID != retry.plan.SourceGenerationID) {
			fail(w, 409, "retry_source_changed", "当前运行代已变化，请从当前实例重新核对操作。")
			return
		}
		source, e = runtimeGet[RuntimeGeneration](s.db, "runtime_generations", instance.ActiveGenerationID)
		if e != nil {
			fail(w, 409, "generation_unavailable", "当前运行代需要核对。")
			return
		}
		if retry != nil && (instance.Legacy || instance.AppID != retry.plan.AppID || instance.ActiveGenerationID != retry.plan.SourceGenerationID || source.StoreID != s.storeID || source.ID != retry.plan.SourceGenerationID || source.Version != retry.plan.SourceVersion) {
			fail(w, 409, "retry_source_changed", "当前运行代已变化，请从当前实例重新核对操作。")
			return
		}
		in.AppID = instance.AppID
		if in.Kind != "update" && in.Kind != "restore" {
			in.TargetVersion = source.Version
		}
		if in.Kind == "restore" {
			snap, e = runtimeGet[RuntimeSnapshot](s.db, "runtime_snapshots", in.SnapshotID)
			if e != nil || snap.InstanceID != instance.ID || snap.Source.StoreID != s.storeID {
				fail(w, 400, "snapshot_unavailable", "快照不属于该实例。")
				return
			}
			in.TargetVersion = snap.Version
		}
	}
	recipe, ok := s.runtimeRecipeFor(in.AppID, in.TargetVersion)
	if strings.HasPrefix(in.AppID, "cloud-") && in.Kind != "install" && in.Kind != "update" {
		recipe = source.Recipe
		if in.Kind == "restore" {
			recipe = snap.Source.Recipe
		}
		ok = validateRuntimeRecipe(recipe) == nil
	}
	if !ok {
		fail(w, 400, "recipe_unavailable", "版本没有审核配方，不能执行。")
		return
	}
	if runtimeRecipeHasSecrets(recipe) && (in.Kind == "update" || in.Kind == "restore" || in.Kind == "backup") {
		fail(w, 422, "secret_generation_operation_unsupported", "此应用含 NAS 本地秘密参数；当前版本暂不支持更新、备份或恢复，请保留原实例。")
		return
	}
	if in.Kind == "update" {
		compatible := false
		for _, v := range recipe.CompatibleFrom {
			compatible = compatible || v == source.Version
		}
		if !compatible {
			fail(w, 400, "incompatible_update", "该更新路径未经审核。")
			return
		}
	}
	engine, ok := s.engine.(RuntimeEngine)
	if !ok {
		fail(w, 503, "runtime_unavailable", "执行引擎未启用版本运行能力。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	p := RuntimePlan{ID: randomID(), StoreID: s.storeID, GenerationID: randomID(), Kind: in.Kind, AppID: recipe.AppID, InstanceID: in.InstanceID, TargetVersion: recipe.Version, Recipe: recipe, ExpiresAt: time.Now().UTC().Add(30 * time.Minute), PublishHost: s.opts.PublishHost}
	if !s.runtimeSecretBindPlan(w, r, &p, source) {
		return
	}
	if retry != nil {
		p.RetryOfJobID = retry.job.ID
		p.RetryOfPlanID = retry.plan.ID
	}
	if in.Kind == "install" {
		p.InstanceID = randomID()
		if !segmentRE.MatchString(in.Directory) {
			fail(w, 400, "unsafe_path", "请选择单层全新目录。")
			return
		}
		root, e := s.root(in.RootID)
		if e != nil {
			fail(w, 400, "unknown_storage_root", "请选择登记目录。")
			return
		}
		data, docker, e := s.checkStorage(ctx, root)
		if e != nil {
			fail(w, 409, "unsafe_storage", e.Error())
			return
		}
		p.RootID = root.ID
		p.RootPath = root.Path
		p.DataPath = filepath.Join(root.Path, in.Directory)
		p.StorageIdentity = data.Identity
		p.DockerStorageIdentity = docker.Identity
		p.HostPort = in.HostPort
		if p.HostPort == 0 {
			p.HostPort = recipe.DefaultPort
		}
		p.PeerPort = in.PeerPort
		p.DiscoveryPort = in.DiscoveryPort
		if recipe.AppID == "syncthing" {
			if p.PeerPort == 0 {
				p.PeerPort = 22000
			}
			if p.DiscoveryPort == 0 {
				p.DiscoveryPort = 21027
			}
		}
		if recipe.RequiresMedia {
			root, e := s.root(in.MediaRootID)
			if e != nil {
				fail(w, 400, "media_required", "请选择登记的媒体目录。")
				return
			}
			v, e := s.inspectMediaRoot(ctx, root)
			if e != nil || (retry != nil && v.Identity != retry.plan.MediaStorageIdentity) || s.engine.ValidatePath(ctx, root.Path, in.MediaPath, false) != nil || pathsOverlap(p.DataPath, in.MediaPath) {
				fail(w, 400, "unsafe_media", "媒体目录不安全。")
				return
			}
			p.MediaPath = in.MediaPath
			p.MediaRootPath = root.Path
			p.MediaStorageIdentity = v.Identity
		} else if in.MediaPath != "" || in.MediaRootID != "" {
			fail(w, 400, "unexpected_media", "该配方不接受媒体目录。")
			return
		}
	} else {
		p.RootPath = source.RootPath
		p.RootID = in.RootID
		p.DataPath = source.DataPath
		p.StorageIdentity = source.StorageIdentity
		p.DockerStorageIdentity = source.DockerStorageIdentity
		p.MediaPath = source.MediaPath
		p.MediaRootPath = source.MediaRootPath
		p.MediaStorageIdentity = source.MediaStorageIdentity
		p.HostPort = source.HostPort
		p.PeerPort = source.PeerPort
		p.DiscoveryPort = source.DiscoveryPort
		p.PublishHost = source.PublishHost
		p.SourceGenerationID = source.ID
		p.SourceVersion = source.Version
		p.Images = source.Images
		p.GenerationID = source.ID
		if in.Kind == "update" || in.Kind == "restore" {
			p.GenerationID = randomID()
			p.DataPath = filepath.Join(source.RootPath, "generation-"+p.GenerationID)
			p.NewDataCopy = true
		}
		if in.Kind == "update" || in.Kind == "backup" || in.Kind == "restore" {
			p.SnapshotRequired = true
			p.SnapshotID = randomID()
			p.SnapshotRootPath = source.RootPath
			for _, svc := range source.Recipe.Services {
				p.StopServices = append(p.StopServices, svc.ID)
			}
		}
		if in.Kind == "restore" {
			p.SourceSnapshotID = snap.ID
		}
		if in.Kind == "stop" || in.Kind == "archive" || in.Kind == "restart" || in.Kind == "start" || in.Kind == "reactivate" {
			for _, svc := range source.Recipe.Services {
				p.StopServices = append(p.StopServices, svc.ID)
			}
		}
	}
	if in.Kind == "install" || in.Kind == "update" || in.Kind == "restore" {
		facts, e := engine.RuntimeFacts(ctx)
		if e != nil || facts.Platform != "linux/amd64" || facts.MemoryBytes < recipe.MinimumMemoryBytes {
			fail(w, 503, "runtime_requirements", "引擎平台或可用资源不满足配方。")
			return
		}
		images, e := engine.ResolveRuntimeImages(ctx, recipe, facts.Platform)
		if e != nil {
			if errors.Is(e, runtimeOwnerUnavailable) {
				fail(w, 503, "owner_image_unavailable", "作者软件尚未导入或完整身份无法核验，请先导入固定作者交付归档。")
				return
			}
			fail(w, 502, "image_verification_failed", "官方镜像身份解析失败。")
			return
		}
		p.Images = images
		if e = s.engine.ValidatePath(ctx, p.RootPath, p.DataPath, true); e != nil {
			fail(w, 409, "unsafe_path", "目标目录必须全新且安全。")
			return
		}
	}
	if retry != nil && p.Kind != "install" {
		if e = s.runtimeCheckStorage(ctx, p); e != nil {
			fail(w, 409, "unsafe_storage", "当前存储身份无法核验。")
			return
		}
		checked, err := engine.InspectGeneration(ctx, source)
		sourcePlan := p
		sourcePlan.GenerationID = source.ID
		sourcePlan.DataPath = source.DataPath
		sourcePlan.TargetVersion = source.Version
		sourcePlan.Recipe = source.Recipe
		sourcePlan.Images = source.Images
		if err != nil || !runtimeGenerationMatchesPlan(checked, sourcePlan) || (checked.State != "running" && checked.State != "stopped") {
			fail(w, 409, "retry_source_changed", "当前运行代无法核验，请先检查实例。")
			return
		}
	}
	host := s.opts.AccessHost
	if host == "" {
		host = "127.0.0.1"
		if h, ok := s.engine.(interface{ Host() string }); ok {
			host = h.Host()
		}
	}
	p.AccessURL = "http://" + net.JoinHostPort(host, fmt.Sprint(p.HostPort)) + "/"
	if validateRuntimePlan(p) != nil {
		fail(w, 400, "invalid_plan", "端口或配方参数无效。")
		return
	}
	if in.Kind == "install" {
		for _, port := range runtimePorts(p) {
			if e = s.engine.PortAvailable(ctx, port); e != nil {
				fail(w, 409, "port_conflict", "端口已被占用。")
				return
			}
		}
	}
	if p.Kind == "restore" {
		verifier, ok := s.engine.(interface {
			VerifyRuntimeSnapshot(context.Context, RuntimeSnapshot) error
		})
		if !ok || verifier.VerifyRuntimeSnapshot(ctx, snap) != nil {
			fail(w, 409, "snapshot_unverified", "快照材料无法核验。")
			return
		}
	}
	if retry != nil && p.Kind == "install" {
		current, err := s.runtimeVerifyRetry(ctx, retry.job, retry.plan)
		if err != nil || !reflect.DeepEqual(current, retry.binding) {
			fail(w, 409, "retry_resources_unverified", "原失败资源在核对期间已变化。")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runtimeMutation(w, r, func(tx *sql.Tx) error {
		var binding *runtimeRetryBinding
		if retry != nil {
			binding = &retry.binding
		}
		if e := s.runtimeReservationsWithRetry(tx, p, p.RetryOfPlanID, binding); e != nil {
			return e
		}
		record := runtimePlanRecord{RuntimePlan: p}
		if in.Kind == "restore" {
			record.SnapshotBinding = &snap
		}
		if retry != nil {
			if e := s.runtimeRetryFence(tx, p, retry.binding); e != nil {
				return e
			}
			record.RetryBinding = &retry.binding
			if retry.snapshot != nil && !reflect.DeepEqual(*retry.snapshot, snap) {
				return errRuntimeConflict
			}
		}
		if in.Kind == "install" {
			root, err := runtimeGet[StorageRoot](tx, "storage_roots", p.RootID)
			if err != nil || root.Path != p.RootPath || !runtimeRootHasDataRole(root) || (root.Storage.Identity != "" && root.Storage.Identity != p.StorageIdentity) {
				return errRuntimeConflict
			}
		}
		if in.Kind == "install" && p.MediaPath != "" {
			root, err := runtimeGet[StorageRoot](tx, "storage_roots", in.MediaRootID)
			if err != nil || root.Path != p.MediaRootPath || (root.Storage.Identity != "" && root.Storage.Identity != p.MediaStorageIdentity) {
				return errRuntimeConflict
			}
		}
		if record.SnapshotBinding != nil {
			current, err := runtimeGet[RuntimeSnapshot](tx, "runtime_snapshots", snap.ID)
			if err != nil || !reflect.DeepEqual(current, snap) {
				return errRuntimeConflict
			}
		}
		if e := s.runtimeSecretSavePlan(tx, r, p); e != nil {
			return e
		}
		b, _ := json.Marshal(record)
		_, e := tx.ExecContext(r.Context(), `INSERT INTO runtime_plans(id,body)VALUES(?,?)`, p.ID, string(b))
		return e
	}) {
		s.runtimeRespond(w, r, 201, p)
	}
}
func pathsOverlap(a, b string) bool {
	return a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/")
}
func runtimePorts(p RuntimePlan) []int {
	out := []int{p.HostPort}
	if p.PeerPort != 0 {
		out = append(out, p.PeerPort, p.DiscoveryPort)
	}
	return out
}
func (s *Service) runtimeReservations(tx *sql.Tx, p RuntimePlan, ignore string) error {
	var binding *runtimeRetryBinding
	if p.RetryOfJobID != "" {
		record, e := runtimeGet[runtimePlanRecord](tx, "runtime_plans", p.ID)
		if e != nil || record.RetryBinding == nil {
			return errRuntimeConflict
		}
		binding = record.RetryBinding
	}
	return s.runtimeReservationsWithRetry(tx, p, ignore, binding)
}
func (s *Service) runtimeReservationsWithRetry(tx *sql.Tx, p RuntimePlan, ignore string, binding *runtimeRetryBinding) error {
	if binding != nil {
		if e := s.runtimeRetryFence(tx, p, *binding); e != nil {
			return e
		}
	}
	if e := s.runtimeCrossReservations(tx, p.InstanceID, p.DataPath, runtimePorts(p), ignore, binding); e != nil {
		return e
	}
	jobs, e := runtimeRead[runtimeJob](tx, "runtime_jobs")
	if e != nil {
		return e
	}
	for _, j := range jobs {
		if j.InstanceID == p.InstanceID && (j.Status == "running" || j.Status == "queued" || j.Status == "needs_attention") {
			return errRuntimeConflict
		}
	}
	if p.SourceGenerationID != "" {
		i, e := runtimeGet[runtimeInstance](tx, "runtime_instances", p.InstanceID)
		if e != nil || i.ActiveGenerationID != p.SourceGenerationID {
			return errRuntimeConflict
		}
	}
	return nil
}
func (s *Service) runtimeExecute(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PlanID    string `json:"planId"`
		RequestID string `json:"requestId"`
	}
	if !decode(w, r, &in) {
		return
	}
	s.runtimeEnqueue(w, r, []string{in.PlanID}, in.RequestID, false)
}
func (s *Service) runtimeBatch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PlanIDs   []string `json:"planIds"`
		RequestID string   `json:"requestId"`
	}
	if !decode(w, r, &in) {
		return
	}
	s.runtimeEnqueue(w, r, in.PlanIDs, in.RequestID, true)
}

// A batch is either an exact replay of every ordered plan/request pair or a
// fresh admission. Partial matches and reused request/plan identities conflict.
func runtimeExistingJobs(tx runtimeQuerier, ids []string, request string, batch bool) ([]runtimeJob, error) {
	existing, err := runtimeRead[runtimeJob](tx, "runtime_jobs")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []runtimeJob
	for index, id := range ids {
		if seen[id] {
			return nil, errRuntimeConflict
		}
		seen[id] = true
		rid := request
		if batch {
			rid += ":" + fmt.Sprint(index)
		}
		for _, j := range existing {
			if j.RequestID == rid || j.PlanID == id {
				if j.RequestID != rid || j.PlanID != id {
					return nil, errRuntimeConflict
				}
				out = append(out, j)
				break
			}
		}
	}
	if len(out) != 0 && len(out) != len(ids) {
		return nil, errRuntimeConflict
	}
	if batch && len(out) > 0 {
		count := 0
		for _, j := range existing {
			if strings.HasPrefix(j.RequestID, request+":") {
				count++
			}
		}
		if count != len(ids) {
			return nil, errRuntimeConflict
		}
	}
	return out, nil
}

func (s *Service) runtimeEnqueue(w http.ResponseWriter, r *http.Request, ids []string, request string, batch bool) {
	if len(ids) == 0 || len(ids) > 20 || !segmentRE.MatchString(request) {
		fail(w, 400, "invalid_request", "计划或请求标识无效。")
		return
	}
	// Authenticate exact lookup at both sides of the readonly admission proof.
	// Another confirmation may persist and finish while that proof is in flight.
	var out []runtimeJob
	lookup := func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.runtimeAuthTransaction(w, r, func(tx *sql.Tx) error {
			var err error
			out, err = runtimeExistingJobs(tx, ids, request, batch)
			return err
		})
	}
	reply := func() {
		if batch {
			s.runtimeRespond(w, r, 202, map[string]any{"items": out})
		} else {
			s.runtimeRespond(w, r, 202, out[0])
		}
	}
	if !lookup() {
		return
	}
	if len(out) > 0 {
		reply()
		return
	}
	if len(out) == 0 {
		for _, id := range ids {
			p, err := runtimeGet[RuntimePlan](s.db, "runtime_plans", id)
			if err == nil && p.RetryOfJobID != "" {
				if err = s.runtimeVerifyRetryPlan(r.Context(), p); err != nil {
					if !lookup() {
						return
					}
					if len(out) > 0 {
						reply()
						return
					}
					fail(w, 409, "retry_resources_unverified", "重试源已变化或原资源无法核验。")
					return
				}
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.runtimeAuthTransaction(w, r, func(tx *sql.Tx) error {
		var lookupErr error
		out, lookupErr = runtimeExistingJobs(tx, ids, request, batch)
		if lookupErr != nil || len(out) > 0 {
			return lookupErr
		}
		if err := maintenanceReady(tx); err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, id := range ids {
			if seen[id] {
				return errRuntimeConflict
			}
			seen[id] = true
		}
		plans := []RuntimePlan{}
		for _, id := range ids {
			p, e := runtimeGet[RuntimePlan](tx, "runtime_plans", id)
			if e != nil {
				return errRuntimeConflict
			}
			plans = append(plans, p)
		}
		var e error
		out, e = runtimeExistingJobs(tx, ids, request, batch)
		if e != nil || len(out) > 0 {
			return e
		}
		for _, p := range plans {
			if e = s.runtimeSecretApprove(tx, r, p); e != nil {
				return e
			}
			if !time.Now().Before(p.ExpiresAt) {
				return errRuntimeConflict
			}
			if e = s.runtimeReservations(tx, p, p.ID); e != nil {
				return e
			}
		}
		instances := map[string]bool{}
		for index, p := range plans {
			if instances[p.InstanceID] {
				return errRuntimeConflict
			}
			instances[p.InstanceID] = true
			rid := request
			if batch {
				rid = request + ":" + fmt.Sprint(index)
			}
			now := time.Now().UTC()
			j := runtimeJob{Job: Job{ID: randomID(), PlanID: p.ID, RequestID: rid, InstanceID: p.InstanceID, Status: "queued", Stage: "queued", CreatedAt: now, UpdatedAt: now}, Kind: p.Kind, AppID: p.AppID}
			b, _ := json.Marshal(j)
			if _, e = tx.ExecContext(r.Context(), `INSERT INTO runtime_jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)`, j.ID, p.ID, rid, j.Status, string(b)); e != nil {
				return e
			}
			out = append(out, j)
		}
		return nil
	}) {
		return
	}
	if batch {
		s.runtimeRespond(w, r, 202, map[string]any{"items": out})
	} else {
		s.runtimeRespond(w, r, 202, out[0])
	}
}
func (s *Service) runtimeIgnore(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Version string `json:"version"`
	}
	if !decode(w, r, &in) {
		return
	}
	if _, e := CompareRuntimeVersions(in.Version, in.Version); e != nil {
		fail(w, 400, "invalid_version", "版本无效。")
		return
	}
	if s.runtimeMutation(w, r, func(tx *sql.Tx) error {
		i, e := runtimeGet[runtimeInstance](tx, "runtime_instances", r.PathValue("id"))
		if e != nil {
			return errRuntimeConflict
		}
		i.IgnoredVersion = in.Version
		return runtimePut(tx, r.Context(), "runtime_instances", i.ID, i)
	}) {
		s.runtimeRespond(w, r, 200, map[string]any{"ignoredVersion": in.Version})
	}
}

// Both controllers call this while holding s.mu and within their insertion
// transaction. Pending reviewed plans reserve their material identities too.
func (s *Service) runtimeCrossReservations(tx *sql.Tx, instance, path string, ports []int, ignore string, retries ...*runtimeRetryBinding) error {
	var retry *runtimeRetryBinding
	if len(retries) == 1 {
		retry = retries[0]
	}
	ancestorPlans := map[string]RuntimePlan{}
	ancestorGenerations := map[string]runtimeRetryAncestor{}
	if retry != nil && retry.Plan.Kind == "install" {
		for _, ancestor := range retry.members() {
			ancestorPlans[ancestor.Plan.ID] = ancestor.Plan
			if ancestor.Generation != nil {
				ancestorGenerations[ancestor.Generation.ID] = ancestor
			}
		}
	}
	conflict := func(otherInstance, otherPath string, otherPorts []int) bool {
		if instance == otherInstance {
			return false
		}
		if pathsOverlap(path, otherPath) {
			return true
		}
		for _, a := range ports {
			for _, b := range otherPorts {
				if a != 0 && a == b {
					return true
				}
			}
		}
		return false
	}
	legacy, e := runtimeRead[Instance](tx, "instances")
	if e != nil {
		return e
	}
	for _, i := range legacy {
		if conflict(i.ID, i.DataPath, []int{i.HostPort}) {
			return errRuntimeConflict
		}
	}
	plans, e := runtimeRead[Plan](tx, "plans")
	if e != nil {
		return e
	}
	for _, p := range plans {
		if p.ID == ignore {
			continue
		}
		var active int
		if e = tx.QueryRow(`SELECT count(*) FROM jobs WHERE plan_id=? AND status IN ('queued','running','needs_attention')`, p.ID).Scan(&active); e != nil {
			return e
		}
		if (active > 0 || time.Now().Before(p.ExpiresAt)) && conflict(p.InstanceID, p.DataPath, []int{p.HostPort}) {
			return errRuntimeConflict
		}
	}
	gens, e := runtimeRead[RuntimeGeneration](tx, "runtime_generations")
	if e != nil {
		return e
	}
	for _, g := range gens {
		gp := []int{g.HostPort, g.PeerPort, g.DiscoveryPort}
		if ancestor, ok := ancestorGenerations[g.ID]; ok && reflect.DeepEqual(g, *ancestor.Generation) {
			if pathsOverlap(path, g.DataPath) {
				return errRuntimeConflict
			}
			gp = nil
		}
		if conflict(g.InstanceID, g.DataPath, gp) {
			return errRuntimeConflict
		}
	}
	runtimePlans, e := runtimeRead[runtimePlanRecord](tx, "runtime_plans")
	if e != nil {
		return e
	}
	for _, record := range runtimePlans {
		// Ancestor paths stay reserved even when no resource was ever created and
		// its original plan expired. Only ports receive exact proven exemptions.
		if record.RetryBinding != nil {
			for _, ancestor := range record.RetryBinding.members() {
				if pathsOverlap(path, ancestor.Plan.DataPath) && instance != ancestor.Plan.InstanceID {
					return errRuntimeConflict
				}
			}
		}
		p := record.RuntimePlan
		if ancestor, ok := ancestorPlans[p.ID]; ok && reflect.DeepEqual(p, ancestor) {
			if pathsOverlap(path, p.DataPath) && instance != p.InstanceID {
				return errRuntimeConflict
			}
			continue
		}
		if p.ID == ignore {
			continue
		}
		var active int
		if e = tx.QueryRow(`SELECT count(*) FROM runtime_jobs WHERE plan_id=? AND status IN ('queued','running','needs_attention')`, p.ID).Scan(&active); e != nil {
			return e
		}
		if (active > 0 || time.Now().Before(p.ExpiresAt)) && conflict(p.InstanceID, p.DataPath, runtimePorts(p)) {
			return errRuntimeConflict
		}
	}
	return nil
}

func (s *Service) runtimeRespond(w http.ResponseWriter, r *http.Request, status int, data any) {
	if !s.runtimeAuthorized(r) {
		fail(w, 401, "store_auth_required", "会话已失效。")
		return
	}
	respond(w, status, data)
}

// Retry records are private persistence envelopes. API clients review only the
// ordinary immutable plan and its explicit job/plan provenance.
func (s *Service) runtimeVerifyRetry(ctx context.Context, j runtimeJob, old RuntimePlan) (runtimeRetryBinding, error) {
	direct, err := s.runtimeVerifyRetryAncestor(ctx, j, old)
	proof := runtimeRetryBinding{runtimeRetryAncestor: direct}
	if err != nil || old.Kind != "install" {
		return proof, err
	}
	record, err := runtimeGet[runtimePlanRecord](s.db, "runtime_plans", old.ID)
	if err != nil || !reflect.DeepEqual(record.RuntimePlan, old) {
		return proof, runtimeFailure
	}
	if old.RetryOfJobID != "" {
		if record.RetryBinding == nil || s.runtimeRetryFence(s.db, old, *record.RetryBinding) != nil {
			return proof, runtimeFailure
		}
		proof.Ancestors = record.RetryBinding.members()
	} else if old.RetryOfPlanID != "" || record.RetryBinding != nil {
		return proof, runtimeFailure
	}
	if len(proof.members()) > runtimeMaxRetryAncestors {
		return proof, runtimeFailure
	}
	seen := map[string]bool{old.ID: true}
	for _, ancestor := range proof.Ancestors {
		if seen[ancestor.Plan.ID] || ancestor.Plan.Kind != "install" {
			return proof, runtimeFailure
		}
		seen[ancestor.Plan.ID] = true
		current, err := s.runtimeVerifyRetryAncestor(ctx, ancestor.Job, ancestor.Plan)
		if err != nil || !reflect.DeepEqual(current, ancestor) {
			return proof, runtimeFailure
		}
	}
	return proof, nil
}
func (s *Service) runtimeVerifyRetryAncestor(ctx context.Context, j runtimeJob, old RuntimePlan) (runtimeRetryAncestor, error) {
	proof := runtimeRetryAncestor{Job: j, Plan: old}
	if j.Status != "failed" || j.PlanID != old.ID || j.InstanceID != old.InstanceID || j.AppID != old.AppID || j.Kind != old.Kind || old.StoreID != s.storeID || validateRuntimePlan(old) != nil {
		return proof, runtimeFailure
	}
	if old.Kind != "install" {
		return proof, nil
	}
	verifier, ok := s.engine.(interface {
		VerifyFailedInstall(context.Context, RuntimePlan, *RuntimeGeneration) error
	})
	if !ok {
		return proof, runtimeFailure
	}
	g, err := runtimeGet[RuntimeGeneration](s.db, "runtime_generations", old.GenerationID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return proof, err
	}
	i, instanceErr := runtimeGet[runtimeInstance](s.db, "runtime_instances", old.InstanceID)
	if errors.Is(err, sql.ErrNoRows) {
		if !errors.Is(instanceErr, sql.ErrNoRows) {
			return proof, runtimeFailure
		}
	} else {
		if instanceErr != nil || i.Legacy || i.ID != old.InstanceID || i.AppID != old.AppID || i.ActiveGenerationID != old.GenerationID || !runtimeGenerationMatchesPlan(g, old) || validateRuntimeGeneration(g) != nil || (g.State != "stopped" && g.State != "prepared") {
			return proof, runtimeFailure
		}
		proof.Generation = &g
		proof.Instance = &i
	}
	if err = verifier.VerifyFailedInstall(ctx, old, proof.Generation); err != nil {
		return proof, err
	}
	for _, port := range runtimePorts(old) {
		if err = s.engine.PortAvailable(ctx, port); err != nil {
			return proof, err
		}
	}
	return proof, nil
}

// SQL-only final fence: never makes engine/network calls while holding tx.
func (s *Service) runtimeRetryFence(tx runtimeQuerier, p RuntimePlan, proof runtimeRetryBinding) error {
	members := proof.members()
	if len(members) > runtimeMaxRetryAncestors || (p.Kind != "install" && len(members) != 1) {
		return errRuntimeConflict
	}
	seen := map[string]bool{p.ID: true}
	child := p
	for index, ancestor := range members {
		old := ancestor.Plan
		if seen[old.ID] || child.Kind != old.Kind || child.AppID != old.AppID || child.StoreID != old.StoreID || child.RetryOfJobID != ancestor.Job.ID || child.RetryOfPlanID != old.ID || old.StoreID != s.storeID {
			return errRuntimeConflict
		}
		seen[old.ID] = true
		if err := s.runtimeRetryAncestorFence(tx, p.ID, ancestor); err != nil {
			return err
		}
		if p.Kind == "install" {
			record, err := runtimeGet[runtimePlanRecord](tx, "runtime_plans", old.ID)
			if err != nil {
				return errRuntimeConflict
			}
			if index+1 == len(members) {
				if old.RetryOfJobID != "" || old.RetryOfPlanID != "" || record.RetryBinding != nil {
					return errRuntimeConflict
				}
			} else {
				expected := runtimeRetryBinding{runtimeRetryAncestor: members[index+1]}
				if index+2 < len(members) {
					expected.Ancestors = members[index+2:]
				}
				if record.RetryBinding == nil || !reflect.DeepEqual(*record.RetryBinding, expected) {
					return errRuntimeConflict
				}
			}
		}
		child = old
	}
	return nil
}

// Recheck every stored ancestor within the SQL-only final fence.
func (s *Service) runtimeRetryAncestorFence(tx runtimeQuerier, currentPlanID string, proof runtimeRetryAncestor) error {
	j, err := runtimeGet[runtimeJob](tx, "runtime_jobs", proof.Job.ID)
	old, planErr := runtimeGet[RuntimePlan](tx, "runtime_plans", proof.Plan.ID)
	if err != nil || planErr != nil || j.Status != "failed" || !reflect.DeepEqual(j, proof.Job) || !reflect.DeepEqual(old, proof.Plan) {
		return errRuntimeConflict
	}
	var status, planID, requestID string
	if tx.QueryRowContext(context.Background(), `SELECT status,plan_id,request_id FROM runtime_jobs WHERE id=?`, j.ID).Scan(&status, &planID, &requestID) != nil || status != "failed" || planID != j.PlanID || requestID != j.RequestID {
		return errRuntimeConflict
	}
	jobs, err := runtimeRead[runtimeJob](tx, "runtime_jobs")
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if job.PlanID != currentPlanID && job.InstanceID == old.InstanceID && (job.Status == "queued" || job.Status == "running" || job.Status == "needs_attention") {
			return errRuntimeConflict
		}
	}
	if old.Kind == "install" {
		g, genErr := runtimeGet[RuntimeGeneration](tx, "runtime_generations", old.GenerationID)
		i, instanceErr := runtimeGet[runtimeInstance](tx, "runtime_instances", old.InstanceID)
		if proof.Generation == nil {
			if !errors.Is(genErr, sql.ErrNoRows) || !errors.Is(instanceErr, sql.ErrNoRows) {
				return errRuntimeConflict
			}
		} else if genErr != nil || instanceErr != nil || proof.Instance == nil || !reflect.DeepEqual(g, *proof.Generation) || !reflect.DeepEqual(i, *proof.Instance) {
			return errRuntimeConflict
		}
	} else {
		i, err := runtimeGet[runtimeInstance](tx, "runtime_instances", old.InstanceID)
		if err != nil || i.Legacy || i.AppID != old.AppID || i.ActiveGenerationID != old.SourceGenerationID {
			return errRuntimeConflict
		}
	}
	return nil
}

func (s *Service) runtimeVerifyRetryPlan(ctx context.Context, p RuntimePlan) error {
	record, err := runtimeGet[runtimePlanRecord](s.db, "runtime_plans", p.ID)
	if err != nil || !reflect.DeepEqual(record.RuntimePlan, p) {
		return runtimeFailure
	}
	if p.Kind == "restore" {
		if record.SnapshotBinding == nil {
			return runtimeFailure
		}
		snapshot, err := runtimeGet[RuntimeSnapshot](s.db, "runtime_snapshots", p.SourceSnapshotID)
		verifier, ok := s.engine.(interface {
			VerifyRuntimeSnapshot(context.Context, RuntimeSnapshot) error
		})
		if err != nil || !ok || !reflect.DeepEqual(snapshot, *record.SnapshotBinding) || verifier.VerifyRuntimeSnapshot(ctx, snapshot) != nil {
			return runtimeFailure
		}
	}
	if p.RetryOfJobID == "" {
		return nil
	}
	if record.RetryBinding == nil || s.runtimeRetryFence(s.db, p, *record.RetryBinding) != nil {
		return errRuntimeConflict
	}
	proof, err := s.runtimeVerifyRetry(ctx, record.RetryBinding.Job, record.RetryBinding.Plan)
	if err != nil || !reflect.DeepEqual(proof, *record.RetryBinding) {
		return runtimeFailure
	}
	return nil
}
