package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRuntimeControllerAnonymousContentIsDenied(t *testing.T) {
	r := newRig(t)
	for _, path := range []string{"catalog", "instances", "jobs", "snapshots", "settings", "desktop", "diagnostics"} {
		w := httptest.NewRecorder()
		r.mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/store/v2/"+path, nil))
		if w.Code != 401 {
			t.Errorf("%s returned %d, want authenticated boundary", path, w.Code)
		}
	}
}

func TestRuntimeControllerCatalogHasSixCompleteRecipes(t *testing.T) {
	r := newRig(t)
	r.setup()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/store/v2/catalog", nil)
	req.Header.Set("X-Store-Session", r.token)
	r.mux.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("catalog returned %d: %s", w.Code, w.Body.String())
	}
	var out struct {
		Data struct {
			Items []struct {
				ID          string
				Installable bool
				Services    []RuntimeService
			}
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Data.Items) != 6 {
		t.Fatalf("wanted six reviewed apps, got %d", len(out.Data.Items))
	}
	for _, app := range out.Data.Items {
		if !app.Installable || len(app.Services) == 0 {
			t.Fatalf("incomplete app %s", app.ID)
		}
	}
}

func TestRuntimeControllerSettingsValidateAndPersist(t *testing.T) {
	r := newRig(t)
	r.setup()
	for _, body := range []string{`{"theme":"invalid","updateCheckEnabled":true,"updateCheckHours":6}`, `{"theme":"light","updateCheckEnabled":true,"updateCheckHours":0}`} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/store/v2/settings", strings.NewReader(body))
		req.Header.Set("X-Store-Session", r.token)
		r.mux.ServeHTTP(w, req)
		if w.Code != 400 {
			t.Errorf("invalid settings returned %d", w.Code)
		}
	}
	status, out := r.call("POST", "/api/store/v2/settings", `{"theme":"dark","updateCheckEnabled":false,"updateCheckHours":12}`, "127.0.0.1:1")
	if status != 200 {
		t.Fatalf("save settings %d %v", status, out)
	}
	status, out = r.call("GET", "/api/store/v2/settings", "", "127.0.0.1:1")
	if status != 200 || out["data"].(map[string]any)["theme"] != "dark" {
		t.Fatalf("settings not retained: %d %v", status, out)
	}
}

func TestRuntimeControllerRejectsUnknownRecipeAndAnonymousMutation(t *testing.T) {
	r := newRig(t)
	r.setup()
	status, out := r.call("POST", "/api/store/v2/plans", `{"kind":"install","appId":"uptime-kuma","targetVersion":"99.9.9","rootId":"storage","directory":"fresh"}`, "127.0.0.1:1")
	if status != 400 {
		t.Fatalf("unreviewed release admitted: %d %v", status, out)
	}
	r.token = ""
	status, _ = r.call("POST", "/api/store/v2/execute", `{"planId":"anything","requestId":"anything"}`, "127.0.0.1:1")
	if status != 401 {
		t.Fatal(status)
	}
}

type controllerEngine struct {
	*fakeEngine
	runtimeMu          sync.Mutex
	generations        map[string]RuntimeGeneration
	failLaunch         bool
	resolveHook        func()
	snapshots          int
	launches           int
	initialization     string
	initializationHook func(RuntimeGeneration)
	failTargetStop     bool
	controlHook        func(RuntimeGeneration, string)
}

func (e *controllerEngine) RuntimeFacts(context.Context) (RuntimeFacts, error) {
	return RuntimeFacts{Platform: "linux/amd64", MemoryBytes: 32 << 30}, nil
}
func (e *controllerEngine) ResolveRuntimeImages(_ context.Context, r RuntimeRecipe, p string) ([]RuntimeImage, error) {
	if e.resolveHook != nil {
		e.resolveHook()
	}
	out := []RuntimeImage{}
	for _, svc := range r.Services {
		tag := strings.Split(svc.Image, "@")[0]
		digest := "sha256:" + strings.Repeat("a", 64)
		if parts := strings.Split(svc.Image, "@"); len(parts) == 2 {
			digest = parts[1]
		}
		repository := tag[:strings.LastIndex(tag, ":")]
		out = append(out, RuntimeImage{ServiceID: svc.ID, TagReference: svc.Image, Reference: repository + "@" + digest, Digest: digest, Platform: p, Publisher: repository, DeliverySource: strings.Replace(strings.Split(repository, "/")[0], "docker.io", "registry-1.docker.io", 1)})
	}
	return out, nil
}
func (e *controllerEngine) PrepareGeneration(ctx context.Context, p RuntimePlan) (RuntimeGeneration, error) {
	if err := e.ValidatePath(ctx, p.RootPath, p.DataPath, true); err != nil {
		return RuntimeGeneration{}, err
	}
	if err := os.Mkdir(p.DataPath, 0700); err != nil {
		return RuntimeGeneration{}, err
	}
	g := RuntimeGeneration{ID: p.GenerationID, StoreID: p.StoreID, InstanceID: p.InstanceID, AppID: p.AppID, Version: p.TargetVersion, RecipeRevision: p.Recipe.Revision, RootPath: p.RootPath, DataPath: p.DataPath, HostPort: p.HostPort, PeerPort: p.PeerPort, DiscoveryPort: p.DiscoveryPort, StorageIdentity: p.StorageIdentity, DockerStorageIdentity: p.DockerStorageIdentity, MediaPath: p.MediaPath, MediaRootPath: p.MediaRootPath, MediaStorageIdentity: p.MediaStorageIdentity, PublishHost: p.PublishHost, AccessURL: p.AccessURL, Recipe: p.Recipe, Images: p.Images, State: "prepared", Provenance: PathProvenance{Marker: p.StoreID + ":" + p.InstanceID + ":" + p.GenerationID, DirectoryIdentity: "fixture-directory", RootIdentity: "fixture-root"}}
	e.runtimeMu.Lock()
	e.generations[g.ID] = g
	e.runtimeMu.Unlock()
	return g, nil
}
func (e *controllerEngine) LaunchGeneration(_ context.Context, p RuntimePlan, g RuntimeGeneration) (RuntimeGeneration, error) {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	e.launches++
	g.Containers = []RuntimeContainer{{ServiceID: p.AppID, ID: g.ID + "-container", State: "running"}}
	g.State = "running"
	e.generations[g.ID] = g
	if e.failLaunch {
		return g, errors.New("fixture health failed")
	}
	return g, nil
}
func (e *controllerEngine) InspectGeneration(_ context.Context, g RuntimeGeneration) (RuntimeGeneration, error) {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	found, ok := e.generations[g.ID]
	if !ok {
		return g, ErrNotFound
	}
	return found, nil
}
func (e *controllerEngine) ControlGeneration(_ context.Context, g RuntimeGeneration, action string) error {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	found, ok := e.generations[g.ID]
	if !ok {
		return ErrNotFound
	}
	if e.failTargetStop && action == "stop" && strings.HasPrefix(filepath.Base(g.DataPath), "generation-") {
		return errors.New("fixture target stop failed")
	}
	if action == "stop" {
		found.State = "stopped"
	} else {
		found.State = "running"
	}
	e.generations[g.ID] = found
	if e.controlHook != nil {
		e.controlHook(g, action)
	}
	return nil
}
func (e *controllerEngine) SnapshotGeneration(_ context.Context, g RuntimeGeneration, root, id string) (RuntimeSnapshot, error) {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	if g.State != "stopped" {
		return RuntimeSnapshot{}, errors.New("running snapshot rejected")
	}
	if _, err := os.Stat(root); err != nil {
		return RuntimeSnapshot{}, err
	}
	e.snapshots++
	return RuntimeSnapshot{ID: id, InstanceID: g.InstanceID, GenerationID: g.ID, AppID: g.AppID, Version: g.Version, RecipeRevision: g.RecipeRevision, RootPath: root, Path: filepath.Join(root, id, "data.tar"), SHA256: strings.Repeat("b", 64), SizeBytes: 100, Source: g, CreatedAt: time.Now()}, nil
}
func (e *controllerEngine) RestoreGeneration(ctx context.Context, s RuntimeSnapshot, p RuntimePlan) (RuntimeGeneration, error) {
	if s.ID != p.SourceSnapshotID {
		return RuntimeGeneration{}, errors.New("source snapshot linkage missing")
	}
	return e.PrepareGeneration(ctx, p)
}
func (e *controllerEngine) RuntimeLogs(_ context.Context, g RuntimeGeneration, service string, _ int) (string, error) {
	if service == "" {
		return "", errors.New("missing service")
	}
	return "fixture log", nil
}
func (e *controllerEngine) RuntimeDirectories(context.Context, string, string) ([]string, error) {
	return []string{"sample"}, nil
}
func controllerRig(t *testing.T) (*testRig, *controllerEngine) {
	r := newRig(t)
	r.setup()
	e := &controllerEngine{fakeEngine: r.e, generations: map[string]RuntimeGeneration{}}
	r.s.engine = e
	r.opts.Engine = e
	return r, e
}
func controllerPlan(t *testing.T, r *testRig, body string) RuntimePlan {
	t.Helper()
	code, out := r.call("POST", "/api/store/v2/plans", body, "127.0.0.1:1")
	if code != 201 {
		t.Fatalf("plan %d %v", code, out)
	}
	b, _ := json.Marshal(out["data"])
	var p RuntimePlan
	json.Unmarshal(b, &p)
	return p
}
func controllerSubmit(t *testing.T, r *testRig, p RuntimePlan, request string) runtimeJob {
	t.Helper()
	b, _ := json.Marshal(map[string]string{"planId": p.ID, "requestId": request})
	code, out := r.call("POST", "/api/store/v2/execute", string(b), "127.0.0.1:1")
	if code != 202 {
		t.Fatalf("execute %d %v", code, out)
	}
	b, _ = json.Marshal(out["data"])
	var j runtimeJob
	json.Unmarshal(b, &j)
	return j
}
func controllerWait(t *testing.T, r *testRig, id string) runtimeJob {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		j, e := runtimeGet[runtimeJob](r.s.db, "runtime_jobs", id)
		if e == nil && (j.Status == "succeeded" || j.Status == "failed") {
			return j
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return runtimeJob{}
}
func TestRuntimeControllerPlanIdentityReservationAndConcurrentIdempotency(t *testing.T) {
	r, e := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"approved","hostPort":32301}`)
	if p.StoreID != r.s.storeID || p.GenerationID == "" || p.InstanceID == "" {
		t.Fatal("review lacks stable identities")
	}
	if _, err := os.Stat(p.DataPath); !os.IsNotExist(err) {
		t.Fatal("planning created resources")
	}
	code, _ := r.call("POST", "/api/store/v2/plans", `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"conflict","hostPort":32301}`, "127.0.0.1:1")
	if code != 409 {
		t.Fatalf("reserved port admitted: %d", code)
	}
	r.s.operation.Lock()
	var wg sync.WaitGroup
	ids := make(chan string, 6)
	for n := 0; n < 6; n++ {
		wg.Add(1)
		go func() { defer wg.Done(); j := controllerSubmit(t, r, p, "same-request"); ids <- j.ID }()
	}
	wg.Wait()
	close(ids)
	first := ""
	for id := range ids {
		if first == "" {
			first = id
		}
		if id != first {
			t.Fatal("duplicate durable job")
		}
	}
	r.s.operation.Unlock()
	j := controllerWait(t, r, first)
	if j.Status != "succeeded" {
		t.Fatal(j)
	}
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	if e.launches != 1 {
		t.Fatal(e.launches)
	}
}
func TestRuntimeControllerRevokedPasswordCannotCommitReviewedPlan(t *testing.T) {
	r, e := controllerRig(t)
	e.resolveHook = func() {
		_, err := r.s.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, tokenHash(r.token))
		if err != nil {
			t.Fatal(err)
		}
	}
	code, _ := r.call("POST", "/api/store/v2/plans", `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"revoked","hostPort":32302}`, "127.0.0.1:1")
	if code != 401 {
		t.Fatalf("revoked final commit %d", code)
	}
	plans, _ := runtimeRead[RuntimePlan](r.s.db, "runtime_plans")
	if len(plans) != 0 {
		t.Fatal("revoked plan retained")
	}
}
func TestRuntimeControllerBatchValidationIsAtomic(t *testing.T) {
	r, _ := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"batch","hostPort":32303}`)
	body, _ := json.Marshal(map[string]any{"planIds": []string{p.ID, "missing"}, "requestId": "batch-request"})
	code, _ := r.call("POST", "/api/store/v2/batches", string(body), "127.0.0.1:1")
	if code != 409 {
		t.Fatal(code)
	}
	jobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
	if len(jobs) != 0 {
		t.Fatal("partial batch enqueued")
	}
}
func TestRuntimeControllerFailedUpdateRetainsSnapshotCopyAndRestoresOriginal(t *testing.T) {
	r, e := controllerRig(t)
	recipe, _ := RuntimeRecipeFor("uptime-kuma", "")
	previous := recipe.CompatibleFrom[0]
	body, _ := json.Marshal(map[string]any{"kind": "install", "appId": "uptime-kuma", "targetVersion": previous, "rootId": "storage", "directory": "original", "hostPort": 32304})
	p := controllerPlan(t, r, string(body))
	j := controllerWait(t, r, controllerSubmit(t, r, p, "install-old").ID)
	if j.Status != "succeeded" {
		t.Fatal(j)
	}
	updateBody, _ := json.Marshal(map[string]any{"kind": "update", "instanceId": p.InstanceID})
	update := controllerPlan(t, r, string(updateBody))
	e.failLaunch = true
	j = controllerWait(t, r, controllerSubmit(t, r, update, "update-fails").ID)
	if j.Status != "failed" {
		t.Fatal(j)
	}
	i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if i.ActiveGenerationID != p.GenerationID {
		t.Fatal("failed target activated")
	}
	source, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", p.GenerationID)
	if source.State != "running" {
		t.Fatal("original running state lost", source.State)
	}
	snapshot, err := runtimeGet[RuntimeSnapshot](r.s.db, "runtime_snapshots", update.SnapshotID)
	if err != nil || snapshot.GenerationID != p.GenerationID {
		t.Fatal("snapshot not preserved", err)
	}
	failed, err := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", update.GenerationID)
	if err != nil || failed.State != "stopped" {
		t.Fatal("failed generation not retained", err)
	}
	for _, path := range []string{p.DataPath, update.DataPath} {
		if _, err = os.Stat(path); err != nil {
			t.Fatal("retained data missing", err)
		}
	}
	review, _ := runtimeGet[RuntimePlan](r.s.db, "runtime_plans", update.ID)
	if review.SourceSnapshotID != "" {
		t.Fatal("original immutable review mutated")
	}
}
func TestRuntimeControllerSuccessfulBackupArchiveReactivateAndRestore(t *testing.T) {
	r, _ := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"roundtrip","hostPort":32305}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "roundtrip-install").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	for _, kind := range []string{"stop", "start", "restart", "backup", "archive", "reactivate"} {
		body, _ := json.Marshal(map[string]string{"kind": kind, "instanceId": p.InstanceID})
		plan := controllerPlan(t, r, string(body))
		if j := controllerWait(t, r, controllerSubmit(t, r, plan, "roundtrip-"+kind).ID); j.Status != "succeeded" {
			t.Fatal(kind, j)
		}
		if kind == "stop" {
			i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
			if i.Health != "unknown" {
				t.Fatal("stopped instance advertises live health", i)
			}
		}
		if kind == "archive" {
			i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
			if !i.Archived {
				t.Fatal("archive not durable")
			}
		}
	}
	snapshots, _ := runtimeRead[RuntimeSnapshot](r.s.db, "runtime_snapshots")
	body, _ := json.Marshal(map[string]string{"kind": "restore", "instanceId": p.InstanceID, "snapshotId": snapshots[0].ID})
	restore := controllerPlan(t, r, string(body))
	if restore.DataPath == p.DataPath {
		t.Fatal("restore overwrites original")
	}
	if j := controllerWait(t, r, controllerSubmit(t, r, restore, "roundtrip-restore").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if i.ActiveGenerationID != restore.GenerationID || i.Archived {
		t.Fatal("restore active generation incorrect", i)
	}
	gens, _ := runtimeRead[RuntimeGeneration](r.s.db, "runtime_generations")
	if len(gens) != 2 {
		t.Fatal("old generation lost")
	}
}

func TestRuntimeControllerPrivateReadContract(t *testing.T) {
	r, _ := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"private-read","hostPort":32306}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "private-install").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	code, out := r.call("GET", "/api/store/v2/instances/"+p.InstanceID+"/logs", "", "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["text"] != "fixture log" {
		t.Fatal(code, out)
	}
	code, out = r.call("GET", "/api/store/v2/roots/storage/directories", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	items := out["data"].(map[string]any)["items"].([]any)
	if len(items) != 1 || items[0] != filepath.Join(r.root, "sample") {
		t.Fatal("directory contract requires absolute verified paths", items)
	}
	code, out = r.call("GET", "/api/store/v2/desktop", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	desktop := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if desktop["health"] != "healthy" || desktop["initialization"] != "required" {
		t.Fatal("desktop loses health/setup boundary", desktop)
	}
}

func TestRuntimeControllerCrossAPIConcurrentReservations(t *testing.T) {
	r, _ := controllerRig(t)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		code, _ := r.call("POST", "/api/store/plans", `{"appId":"uptime-kuma","rootId":"storage","directory":"legacy-reserve","hostPort":32307}`, "127.0.0.1:1")
		codes <- code
	}()
	go func() {
		defer wg.Done()
		code, _ := r.call("POST", "/api/store/v2/plans", `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"runtime-reserve","hostPort":32307}`, "127.0.0.1:1")
		codes <- code
	}()
	wg.Wait()
	close(codes)
	created, conflict := 0, 0
	for code := range codes {
		if code == 201 {
			created++
		}
		if code == 409 {
			conflict++
		}
	}
	if created != 1 || conflict != 1 {
		t.Fatalf("cross-API reservation admitted concurrent plans: created=%d conflicts=%d", created, conflict)
	}
}

func TestRuntimeControllerInstancesAreCachedUntilExplicitReconcile(t *testing.T) {
	r, e := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"cache-read","hostPort":32308}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "cache-install").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	e.runtimeMu.Lock()
	g := e.generations[p.GenerationID]
	g.State = "stopped"
	e.generations[p.GenerationID] = g
	e.runtimeMu.Unlock()
	code, out := r.call("GET", "/api/store/v2/instances", "", "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["state"] != "running" {
		t.Fatal("GET changed cached state", out)
	}
	code, out = r.call("POST", "/api/store/v2/instances/reconcile", `{}`, "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["state"] != "stopped" {
		t.Fatal("explicit refresh did not reconcile", out)
	}
}

type revokeStreamWriter struct {
	*httptest.ResponseRecorder
	revoke func()
	once   sync.Once
}

func (w *revokeStreamWriter) Flush() { w.ResponseRecorder.Flush(); w.once.Do(w.revoke) }
func TestRuntimeControllerIdleSSERevokesAndBoundsStreams(t *testing.T) {
	r, _ := controllerRig(t)
	writer := &revokeStreamWriter{ResponseRecorder: httptest.NewRecorder(), revoke: func() { r.s.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, tokenHash(r.token)) }}
	req := httptest.NewRequest("GET", "/api/store/v2/jobs/events", nil)
	req.Header.Set("X-Store-Session", r.token)
	r.mux.ServeHTTP(writer, req)
	if !strings.Contains(writer.Body.String(), "event: auth-expired") || !strings.Contains(writer.Body.String(), `"items":[]`) {
		t.Fatal(writer.Body.String())
	}
	r.token = ""
	_, login := r.call("POST", "/api/store/login", `{"username":"synthetic-admin","password":"synthetic-pass-123"}`, "127.0.0.1:1")
	r.token = login["data"].(map[string]any)["sessionId"].(string)
	for n := 0; n < cap(r.s.runtimeStreams); n++ {
		r.s.runtimeStreams <- struct{}{}
	}
	w := httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/store/v2/jobs/events", nil)
	req.Header.Set("X-Store-Session", r.token)
	r.mux.ServeHTTP(w, req)
	for n := 0; n < cap(r.s.runtimeStreams); n++ {
		<-r.s.runtimeStreams
	}
	if w.Code != 429 {
		t.Fatal("stream bound failed", w.Code)
	}
}
func TestRuntimeControllerRestartPreservesUncertainJobEvidence(t *testing.T) {
	r, _ := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"restart-evidence","hostPort":32309}`)
	j := controllerWait(t, r, controllerSubmit(t, r, p, "restart-evidence").ID)
	if j.Status != "succeeded" {
		t.Fatal(j)
	}
	j.Status = "running"
	j.Stage = "switch-generation"
	if err := r.s.runtimeSaveJob(j); err != nil {
		t.Fatal(err)
	}
	if err := r.s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	retained, err := runtimeGet[runtimeJob](s.db, "runtime_jobs", j.ID)
	if err != nil || retained.Status != "needs_attention" || retained.Error == "" {
		t.Fatal("restart hid uncertain work", retained, err)
	}
	gens, err := runtimeRead[RuntimeGeneration](s.db, "runtime_generations")
	if err != nil || len(gens) != 1 {
		t.Fatal("restart lost retained resources", err)
	}
	r.s = s
	r.mux = http.NewServeMux()
	s.Register(r.mux)
	code, out := r.call("POST", "/api/store/v2/instances/reconcile", `{}`, "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	retained, _ = runtimeGet[runtimeJob](s.db, "runtime_jobs", j.ID)
	if retained.Status != "failed" || retained.Stage != "reconciled" {
		t.Fatal("explicit reconciliation did not release uncertain job after ownership proof", retained)
	}
}

func (e *controllerEngine) RuntimeInitialization(_ context.Context, g RuntimeGeneration) (string, error) {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	if e.initializationHook != nil {
		e.initializationHook(g)
	}
	if e.initialization == "" {
		return "pending", nil
	}
	return e.initialization, nil
}
func TestRuntimeControllerInitializationUsesOwnedReadback(t *testing.T) {
	r, e := controllerRig(t)
	e.initialization = "complete"
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"initialized","hostPort":32310}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "init-readback").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if i.Initialization != "completed" {
		t.Fatal("owned readback not reflected", i.Initialization)
	}
}
func TestRuntimeControllerFailedInstallRetainsQuietGeneration(t *testing.T) {
	r, e := controllerRig(t)
	e.failLaunch = true
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"failed-install","hostPort":32311}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "failed-install").ID); j.Status != "failed" {
		t.Fatal(j)
	}
	i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if i.State != "stopped" || i.Health != "unknown" {
		t.Fatal("failed install loses proved quiet state", i)
	}
}

func TestRuntimeControllerDiagnosticsReportsActualFactsAndStorage(t *testing.T) {
	r, _ := controllerRig(t)
	code, out := r.call("GET", "/api/store/v2/diagnostics", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	data := out["data"].(map[string]any)
	facts, ok := data["facts"].(map[string]any)
	if !ok || facts["platform"] != "linux/amd64" {
		t.Fatal("missing verified engine facts", data)
	}
	storage, ok := data["storage"].(map[string]any)
	if !ok || storage["dockerStorageSafe"] != true {
		t.Fatal("storage safety missing", data)
	}
}

func TestRuntimeControllerRevokedNASCannotCommitReviewedPlan(t *testing.T) {
	r, _ := nasMutationRig(t)
	e := &controllerEngine{fakeEngine: r.e, generations: map[string]RuntimeGeneration{}}
	r.s.engine = e
	e.resolveHook = func() {
		code, _ := r.call("POST", "/api/store/logout", `{}`, "127.0.0.1:1")
		if code != 200 {
			t.Fatal(code)
		}
	}
	code, _ := r.call("POST", "/api/store/v2/plans", `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"nas-revoked","hostPort":32312}`, "127.0.0.1:1")
	if code != 401 {
		t.Fatal("NAS revoked final commit accepted", code)
	}
	plans, _ := runtimeRead[RuntimePlan](r.s.db, "runtime_plans")
	if len(plans) != 0 {
		t.Fatal("revoked NAS plan committed")
	}
}
func TestRuntimeControllerPrivateSnapshotDownloadRejectsTamperingAndRemoteTransport(t *testing.T) {
	r, e := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"download-source","hostPort":32313}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "download-install").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	source, err := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", p.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := e.SnapshotGeneration(context.Background(), func() RuntimeGeneration { source.State = "stopped"; return source }(), r.root, randomID())
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("private fixture archive")
	hash := sha256.Sum256(content)
	snapshot.SHA256 = hex.EncodeToString(hash[:])
	snapshot.SizeBytes = int64(len(content))
	if err = os.Mkdir(filepath.Join(snapshot.RootPath, snapshot.ID), 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(snapshot.Path, content, 0600)
	manifest, _ := json.Marshal(snapshot)
	os.WriteFile(filepath.Join(snapshot.RootPath, snapshot.ID, "manifest.json"), manifest, 0600)
	if err = runtimePut(r.s.db, context.Background(), "runtime_snapshots", snapshot.ID, snapshot); err != nil {
		t.Fatal(err)
	}
	request := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/store/v2/snapshots/"+snapshot.ID+"/download", nil)
		req.Header.Set("X-Store-Session", r.token)
		r.mux.ServeHTTP(w, req)
		return w
	}
	w := request()
	if w.Code != 200 || w.Body.String() != string(content) {
		t.Fatal("private archive refused", w.Code, w.Body.String())
	}
	os.WriteFile(snapshot.Path, []byte("tampered"), 0600)
	if w = request(); w.Code != 409 {
		t.Fatal("tampered archive served", w.Code)
	}
	r.s.opts.EngineMode = "sshbind"
	if w = request(); w.Code != 501 {
		t.Fatal("insecure remote transport enabled", w.Code)
	}
}

func TestRuntimeControllerClosePreservesQueueWhileLegacyOperationLockHeld(t *testing.T) {
	r, _ := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"close-queue","hostPort":32314}`)
	r.s.operation.Lock()
	j := controllerSubmit(t, r, p, "close-queue")
	time.Sleep(250 * time.Millisecond)
	closed := make(chan error, 1)
	go func() { closed <- r.s.Close() }()
	select {
	case err := <-closed:
		r.s.operation.Unlock()
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(150 * time.Millisecond):
		r.s.operation.Unlock()
		<-closed
		t.Fatal("close hung behind unrelated legacy execution lock")
	}
	s, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	retained, err := runtimeGet[runtimeJob](s.db, "runtime_jobs", j.ID)
	if err != nil || retained.ID != j.ID {
		t.Fatal("queued job lost on shutdown", retained, err)
	}
}

func TestRuntimeControllerSwitchCancellationKeepsOriginalActive(t *testing.T) {
	r, e := controllerRig(t)
	recipe, _ := RuntimeRecipeFor("uptime-kuma", "")
	body, _ := json.Marshal(map[string]any{"kind": "install", "appId": "uptime-kuma", "targetVersion": recipe.CompatibleFrom[0], "rootId": "storage", "directory": "switch-original", "hostPort": 32315})
	p := controllerPlan(t, r, string(body))
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "switch-original").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	body, _ = json.Marshal(map[string]string{"kind": "update", "instanceId": p.InstanceID})
	update := controllerPlan(t, r, string(body))
	e.runtimeMu.Lock()
	e.initializationHook = func(g RuntimeGeneration) {
		if g.ID == update.GenerationID {
			r.s.cancel()
		}
	}
	e.runtimeMu.Unlock()
	j := controllerWait(t, r, controllerSubmit(t, r, update, "switch-cancel").ID)
	if j.Status != "failed" {
		t.Fatal(j)
	}
	i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if i.ActiveGenerationID != p.GenerationID || i.DataPath != p.DataPath {
		t.Fatal("failed switch activated target", i)
	}
	source, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", p.GenerationID)
	if source.State != "running" {
		t.Fatal(source.State)
	}
}
func TestRuntimeControllerFailedTargetStopQuarantinesInstance(t *testing.T) {
	r, e := controllerRig(t)
	recipe, _ := RuntimeRecipeFor("uptime-kuma", "")
	body, _ := json.Marshal(map[string]any{"kind": "install", "appId": "uptime-kuma", "targetVersion": recipe.CompatibleFrom[0], "rootId": "storage", "directory": "quarantine-original", "hostPort": 32316})
	p := controllerPlan(t, r, string(body))
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "quarantine-original").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	body, _ = json.Marshal(map[string]string{"kind": "update", "instanceId": p.InstanceID})
	update := controllerPlan(t, r, string(body))
	e.runtimeMu.Lock()
	e.failLaunch = true
	e.failTargetStop = true
	e.runtimeMu.Unlock()
	j := controllerWaitAttention(t, r, controllerSubmit(t, r, update, "quarantine-update").ID)
	if j.Status != "needs_attention" {
		t.Fatal("unresolved rollback released operation fence", j)
	}
	i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if i.State != "needs_attention" || i.Health != "unknown" || i.ActiveGenerationID != p.GenerationID {
		t.Fatal("uncertain instance advertises running state", i)
	}
	body, _ = json.Marshal(map[string]string{"kind": "restart", "instanceId": p.InstanceID})
	code, _ := r.call("POST", "/api/store/v2/plans", string(body), "127.0.0.1:1")
	if code != 409 {
		t.Fatal("uncertain rollback admitted new mutation", code)
	}
}
func controllerWaitAttention(t *testing.T, r *testRig, id string) runtimeJob {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		j, e := runtimeGet[runtimeJob](r.s.db, "runtime_jobs", id)
		if e == nil && (j.Status == "succeeded" || j.Status == "failed" || j.Status == "needs_attention") {
			return j
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return runtimeJob{}
}

func TestRuntimeControllerInterruptedUpdateReconcilesCandidateAndSource(t *testing.T) {
	r, e := controllerRig(t)
	recipe, _ := RuntimeRecipeFor("uptime-kuma", "")
	body, _ := json.Marshal(map[string]any{"kind": "install", "appId": "uptime-kuma", "targetVersion": recipe.CompatibleFrom[0], "rootId": "storage", "directory": "interrupted-original", "hostPort": 32317})
	p := controllerPlan(t, r, string(body))
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "interrupted-original").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	body, _ = json.Marshal(map[string]string{"kind": "update", "instanceId": p.InstanceID})
	update := controllerPlan(t, r, string(body))
	source, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", p.GenerationID)
	e.ControlGeneration(context.Background(), source, "stop")
	source, _ = e.InspectGeneration(context.Background(), source)
	runtimePut(r.s.db, context.Background(), "runtime_generations", source.ID, source)
	target, err := e.PrepareGeneration(context.Background(), update)
	if err != nil {
		t.Fatal(err)
	}
	target, err = e.LaunchGeneration(context.Background(), update, target)
	if err != nil {
		t.Fatal(err)
	}
	runtimePut(r.s.db, context.Background(), "runtime_generations", target.ID, target)
	id := randomID()
	job := map[string]any{"id": id, "planId": update.ID, "requestId": "interrupted-update", "instanceId": p.InstanceID, "kind": "update", "appId": p.AppID, "status": "needs_attention", "stage": "launch-verify", "sourceState": "running", "createdAt": time.Now().UTC(), "updatedAt": time.Now().UTC()}
	b, _ := json.Marshal(job)
	if _, err = r.s.db.Exec(`INSERT INTO runtime_jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)`, id, update.ID, "interrupted-update", "needs_attention", string(b)); err != nil {
		t.Fatal(err)
	}
	code, out := r.call("POST", "/api/store/v2/instances/reconcile", `{}`, "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	j, _ := runtimeGet[runtimeJob](r.s.db, "runtime_jobs", id)
	if j.Status != "failed" || j.Stage != "reconciled" {
		t.Fatal("interrupted update remains permanently blocked", j)
	}
	current, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if current.ActiveGenerationID != source.ID || current.State != "running" {
		t.Fatal("source state not recovered", current)
	}
	failed, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", target.ID)
	if failed.State != "stopped" {
		t.Fatal("candidate still running", failed.State)
	}
}

func TestRuntimeControllerFailedReactivationRestoresArchivedStoppedSource(t *testing.T) {
	r, e := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"reactivate-original","hostPort":32318}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "reactivate-original").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	body, _ := json.Marshal(map[string]string{"kind": "archive", "instanceId": p.InstanceID})
	archive := controllerPlan(t, r, string(body))
	if j := controllerWait(t, r, controllerSubmit(t, r, archive, "archive-source").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	body, _ = json.Marshal(map[string]string{"kind": "reactivate", "instanceId": p.InstanceID})
	reactivate := controllerPlan(t, r, string(body))
	e.runtimeMu.Lock()
	var once sync.Once
	e.controlHook = func(g RuntimeGeneration, action string) {
		if action == "start" {
			once.Do(r.s.cancel)
		}
	}
	e.runtimeMu.Unlock()
	j := controllerWaitAttention(t, r, controllerSubmit(t, r, reactivate, "reactivate-fails").ID)
	if j.Status != "failed" {
		t.Fatal(j)
	}
	i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if !i.Archived || i.State != "stopped" {
		t.Fatal("failed reactivation lost original archive/stopped state", i)
	}
	source, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", p.GenerationID)
	if source.State != "stopped" {
		t.Fatal("original stopped state lost", source.State)
	}
}

func TestRuntimeControllerSSERevocationInterruptsDatabaseWait(t *testing.T) {
	r, _ := nasMutationRig(t)
	var reservation *sql.Tx
	entered := make(chan struct{})
	writer := &revokeStreamWriter{ResponseRecorder: httptest.NewRecorder(), revoke: func() {
		var err error
		reservation, err = r.s.db.Begin()
		if err != nil {
			t.Error(err)
		}
		close(entered)
	}}
	req := httptest.NewRequest("GET", "/api/store/v2/jobs/events", nil)
	req.Header.Set("X-Store-Session", r.token)
	done := make(chan struct{})
	go func() { r.mux.ServeHTTP(writer, req); close(done) }()
	<-entered
	time.Sleep(1100 * time.Millisecond)
	r.s.closeNAS()
	select {
	case <-done:
		reservation.Rollback()
	case <-time.After(300 * time.Millisecond):
		reservation.Rollback()
		<-done
		t.Fatal("revoked stream stayed blocked on database pool")
	}
	if !strings.Contains(writer.Body.String(), "event: auth-expired") {
		t.Fatal(writer.Body.String())
	}
}

func TestRuntimeControllerCatalogCategoriesAndControlStopScope(t *testing.T) {
	r, _ := controllerRig(t)
	code, out := r.call("GET", "/api/store/v2/catalog", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	categories, ok := out["data"].(map[string]any)["categories"].([]any)
	if !ok || len(categories) != 6 {
		t.Fatal("known Chinese categories missing", out)
	}
	for _, category := range categories {
		item := category.(map[string]any)
		if item["id"] == "" || item["name"] == item["id"] {
			t.Fatal(item)
		}
	}
	p := controllerPlan(t, r, `{"kind":"install","appId":"immich","rootId":"storage","directory":"stop-graph","hostPort":33319}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "graph-install").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	for _, kind := range []string{"stop", "archive", "restart", "reactivate"} {
		b, _ := json.Marshal(map[string]string{"kind": kind, "instanceId": p.InstanceID})
		plan := controllerPlan(t, r, string(b))
		if len(plan.StopServices) != len(p.Recipe.Services) {
			t.Fatal("review hides complete graph control/rollback scope", kind, plan.StopServices)
		}
	}
}
func controllerPrivateDownloadFixture(t *testing.T, r *testRig, e *controllerEngine, content []byte) RuntimeSnapshot {
	t.Helper()
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"download-framing","hostPort":33320}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "download-framing").ID); j.Status != "succeeded" {
		t.Fatal(j)
	}
	source, err := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", p.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	source.State = "stopped"
	snapshot, err := e.SnapshotGeneration(context.Background(), source, r.root, randomID())
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	snapshot.SHA256 = hex.EncodeToString(digest[:])
	snapshot.SizeBytes = int64(len(content))
	if err = os.Mkdir(filepath.Join(snapshot.RootPath, snapshot.ID), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(snapshot.Path, content, 0600); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(snapshot)
	if err = os.WriteFile(filepath.Join(snapshot.RootPath, snapshot.ID, "manifest.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	if err = runtimePut(r.s.db, context.Background(), "runtime_snapshots", snapshot.ID, snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}
func TestRuntimeControllerRealHTTPRevokedDownloadHasTruncationError(t *testing.T) {
	r, e := controllerRig(t)
	snapshot := controllerPrivateDownloadFixture(t, r, e, bytes.Repeat([]byte("private-data"), 4<<20))
	server := httptest.NewServer(r.mux)
	defer server.Close()
	req, _ := http.NewRequest("GET", server.URL+"/api/store/v2/snapshots/"+snapshot.ID+"/download", nil)
	req.Header.Set("X-Store-Session", r.token)
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	head := make([]byte, 1024)
	if _, err = io.ReadFull(response.Body, head); err != nil {
		t.Fatal(err)
	}
	logout, _ := http.NewRequest("POST", server.URL+"/api/store/logout", strings.NewReader(`{}`))
	logout.Header.Set("X-Store-Session", r.token)
	loggedOut, err := server.Client().Do(logout)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, loggedOut.Body)
	loggedOut.Body.Close()
	if loggedOut.StatusCode != 200 {
		t.Fatal(loggedOut.StatusCode)
	}
	n, readErr := io.Copy(io.Discard, response.Body)
	if response.ContentLength != snapshot.SizeBytes || readErr == nil || n+1024 >= snapshot.SizeBytes {
		t.Fatalf("revoked private download looked complete: declared=%d trusted=%d received=%d error=%v", response.ContentLength, snapshot.SizeBytes, n+1024, readErr)
	}
}

type quiescingControllerEngine struct {
	*controllerEngine
	proofGap     bool
	partial      bool
	quiesceCalls int
}

func (e *quiescingControllerEngine) LaunchGeneration(_ context.Context, p RuntimePlan, g RuntimeGeneration) (RuntimeGeneration, error) {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	e.launches++
	if e.partial {
		g.Containers = []RuntimeContainer{{ID: "receipt-owned-container", ServiceID: p.Recipe.Services[0].ID, State: "running"}}
		g.State = "needs_attention"
	}
	e.generations[g.ID] = g
	return g, errors.New("fixture interrupted image/service preparation")
}
func (e *quiescingControllerEngine) InspectGeneration(ctx context.Context, g RuntimeGeneration) (RuntimeGeneration, error) {
	g, err := e.controllerEngine.InspectGeneration(ctx, g)
	if err == nil && len(g.Containers) != len(g.Recipe.Services) {
		return g, runtimeFailure
	}
	return g, err
}
func (e *quiescingControllerEngine) ControlGeneration(ctx context.Context, g RuntimeGeneration, action string) error {
	if _, err := e.InspectGeneration(ctx, g); err != nil {
		return err
	}
	return e.controllerEngine.ControlGeneration(ctx, g, action)
}
func (e *quiescingControllerEngine) RuntimeQuiesceGeneration(_ context.Context, g RuntimeGeneration) (RuntimeGeneration, error) {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	e.quiesceCalls++
	if e.proofGap {
		return g, runtimeFailure
	}
	if len(g.Containers) == 0 {
		g.State = "prepared"
	} else {
		g.State = "stopped"
		for n := range g.Containers {
			g.Containers[n].State = "stopped"
		}
	}
	e.generations[g.ID] = g
	return g, nil
}
func TestRuntimeControllerInstallQuiesceRollbackAndExplicitRecovery(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(fmt.Sprint(partial), func(t *testing.T) {
			r, e := controllerRig(t)
			q := &quiescingControllerEngine{controllerEngine: e, proofGap: true, partial: partial}
			r.s.engine = q
			app := "uptime-kuma"
			if partial {
				app = "immich"
			}
			body, _ := json.Marshal(map[string]any{"kind": "install", "appId": app, "rootId": "storage", "directory": "quiesce-install", "hostPort": 33321})
			p := controllerPlan(t, r, string(body))
			j := controllerWaitAttention(t, r, controllerSubmit(t, r, p, "quiesce-install").ID)
			if j.Status != "needs_attention" || q.quiesceCalls == 0 {
				t.Fatal("rollback did not attempt receipt-aware quiet proof", j, q.quiesceCalls)
			}
			code, out := r.call("POST", "/api/store/v2/instances/reconcile", `{}`, "127.0.0.1:1")
			if code != 200 {
				t.Fatal(code, out)
			}
			j, _ = runtimeGet[runtimeJob](r.s.db, "runtime_jobs", j.ID)
			if j.Status != "needs_attention" {
				t.Fatal("unknown receipt gap released fence", j)
			}
			q.runtimeMu.Lock()
			q.proofGap = false
			q.runtimeMu.Unlock()
			code, out = r.call("POST", "/api/store/v2/instances/reconcile", `{}`, "127.0.0.1:1")
			if code != 200 {
				t.Fatal(code, out)
			}
			j, _ = runtimeGet[runtimeJob](r.s.db, "runtime_jobs", j.ID)
			i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
			if j.Status != "failed" || j.Stage != "reconciled" || (i.State != "prepared" && i.State != "stopped") || i.ActiveGenerationID != p.GenerationID || i.DataPath != p.DataPath {
				t.Fatal("proved failed install did not resolve without adoption/replay", j, i)
			}
			if q.launches != 1 {
				t.Fatal("failed install replayed", q.launches)
			}
		})
	}
}

func TestRuntimeControllerInstallReceiptProofProducesQuietFailedRollback(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(fmt.Sprint(partial), func(t *testing.T) {
			r, e := controllerRig(t)
			q := &quiescingControllerEngine{controllerEngine: e, partial: partial}
			r.s.engine = q
			app := "uptime-kuma"
			if partial {
				app = "immich"
			}
			b, _ := json.Marshal(map[string]any{"kind": "install", "appId": app, "rootId": "storage", "directory": "quiet-rollback", "hostPort": 33322})
			p := controllerPlan(t, r, string(b))
			j := controllerWaitAttention(t, r, controllerSubmit(t, r, p, "quiet-rollback").ID)
			i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
			g, err := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", p.GenerationID)
			if err != nil || j.Status != "failed" || i.ActiveGenerationID != p.GenerationID || i.DataPath != p.DataPath || (i.State != "prepared" && i.State != "stopped") || g.State != i.State || q.quiesceCalls != 1 {
				t.Fatal("receipt-aware rollback did not persist proved quiet retained failure", j, i, g, err)
			}
			if _, err = os.Stat(p.DataPath); err != nil {
				t.Fatal("failed data was removed", err)
			}
		})
	}
}

func TestRuntimeControllerHistoricalFailedInstallCannotStopLaterReviewedStart(t *testing.T) {
	for _, settled := range []bool{false, true} {
		t.Run(fmt.Sprint(settled), func(t *testing.T) {
			r, e := controllerRig(t)
			e.failLaunch = true
			p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"historical-failure","hostPort":33323}`)
			failed := controllerWaitAttention(t, r, controllerSubmit(t, r, p, "historical-failure").ID)
			if failed.Status != "failed" {
				t.Fatal(failed)
			}
			if settled {
				code, out := r.call("POST", "/api/store/v2/instances/reconcile", `{}`, "127.0.0.1:1")
				if code != 200 {
					t.Fatal(code, out)
				}
			}
			b, _ := json.Marshal(map[string]string{"kind": "start", "instanceId": p.InstanceID})
			start := controllerPlan(t, r, string(b))
			if j := controllerWait(t, r, controllerSubmit(t, r, start, "reviewed-recovery-start").ID); j.Status != "succeeded" {
				t.Fatal(j)
			}
			code, out := r.call("POST", "/api/store/v2/instances/reconcile", `{}`, "127.0.0.1:1")
			if code != 200 {
				t.Fatal(code, out)
			}
			i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
			if i.State != "running" || i.Health != "healthy" {
				t.Fatal("historical install failure stopped a later reviewed recovery", i)
			}
		})
	}
}

type blockedQuiesceControllerEngine struct{ *controllerEngine }

func (e *blockedQuiesceControllerEngine) RuntimeQuiesceGeneration(_ context.Context, g RuntimeGeneration) (RuntimeGeneration, error) {
	return g, runtimeFailure
}
func TestRuntimeControllerFullInstallCannotBypassFailedQuietProof(t *testing.T) {
	r, e := controllerRig(t)
	e.failLaunch = true
	r.s.engine = &blockedQuiesceControllerEngine{e}
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"blocked-proof","hostPort":33324}`)
	j := controllerWaitAttention(t, r, controllerSubmit(t, r, p, "blocked-proof").ID)
	if j.Status != "needs_attention" {
		t.Fatal(j)
	}
	code, out := r.call("POST", "/api/store/v2/instances/reconcile", `{}`, "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	j, _ = runtimeGet[runtimeJob](r.s.db, "runtime_jobs", j.ID)
	i, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if j.Status != "needs_attention" || i.State != "needs_attention" || i.Health != "unknown" {
		t.Fatal("ordinary complete inspection bypassed failed quiet proof", j, i)
	}
}

func TestRuntimeControllerDefaultStorageSettingsPreserveAndClear(t *testing.T) {
	r, _ := controllerRig(t)
	code, out := r.call("GET", "/api/store/v2/settings", "", "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["defaultRootId"] != "" {
		t.Fatal("default storage must begin with manual choice", code, out)
	}
	code, out = r.call("POST", "/api/store/v2/settings", `{"theme":"dark","updateCheckEnabled":true,"updateCheckHours":6,"defaultRootId":"storage"}`, "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["defaultRootId"] != "storage" {
		t.Fatal("verified data preference was not saved", code, out)
	}
	code, out = r.call("POST", "/api/store/v2/settings", `{"theme":"light","updateCheckEnabled":false,"updateCheckHours":12}`, "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["defaultRootId"] != "storage" {
		t.Fatal("older settings payload erased preference", code, out)
	}
	code, out = r.call("GET", "/api/store/v2/settings", "", "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["defaultRootId"] != "storage" {
		t.Fatal("compatible update did not durably preserve preference", code, out)
	}
	code, out = r.call("POST", "/api/store/v2/settings", `{"theme":"system","updateCheckEnabled":true,"updateCheckHours":6,"defaultRootId":""}`, "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["defaultRootId"] != "" {
		t.Fatal("explicit empty did not restore manual choice", code, out)
	}
}
func TestRuntimeControllerDefaultStorageRejectsUnknownAndMediaOnly(t *testing.T) {
	r, _ := controllerRig(t)
	media := StorageRoot{ID: "media-only", Name: "Read-only media", Path: filepath.Join(r.root, "media-existing"), Roles: []string{"mediaReadOnly"}}
	if err := os.Mkdir(media.Path, 0700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(media)
	if _, err := r.s.db.Exec(`INSERT INTO storage_roots(id,path,body)VALUES(?,?,?)`, media.ID, media.Path, string(body)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"missing", "media-only", r.root} {
		body, _ := json.Marshal(map[string]any{"theme": "light", "updateCheckEnabled": true, "updateCheckHours": 6, "defaultRootId": id})
		code, out := r.call("POST", "/api/store/v2/settings", string(body), "127.0.0.1:1")
		expectedCode := "invalid_default_root"
		if id == "missing" {
			expectedCode = "unknown_storage_root"
		}
		if code != 400 || out["error"].(map[string]any)["code"] != expectedCode {
			t.Fatal("unsafe or opaque root accepted/rejected for wrong reason", id, code, out)
		}
	}
	if _, err := os.Stat(filepath.Join(r.root, "preference")); !os.IsNotExist(err) {
		t.Fatal("preference validation created a directory")
	}
}

type settingsStorageProbeEngine struct {
	*fakeEngine
	inspectHook func()
	unsafe      bool
}

func (e *settingsStorageProbeEngine) InspectStorage(ctx context.Context, path string) (StorageCandidate, error) {
	candidate, err := e.fakeEngine.InspectStorage(ctx, path)
	if e.inspectHook != nil {
		e.inspectHook()
	}
	if e.unsafe {
		candidate.SystemDisk = true
		candidate.InstallAllowed = false
	}
	return candidate, err
}
func TestRuntimeControllerDefaultStorageRequiresActualSafeVolumeAndFinalSession(t *testing.T) {
	for _, mode := range []string{"unsafe", "expired", "revoked-nas"} {
		t.Run(mode, func(t *testing.T) {
			var r *testRig
			if mode == "revoked-nas" {
				r, _ = nasMutationRig(t)
			} else {
				r = newRig(t)
				r.setup()
			}
			probe := &settingsStorageProbeEngine{fakeEngine: r.e, unsafe: mode == "unsafe"}
			if mode == "expired" {
				probe.inspectHook = func() {
					if _, err := r.s.db.Exec(`UPDATE sessions SET expires_at=? WHERE token_hash=?`, time.Now().Unix()-1, tokenHash(r.token)); err != nil {
						t.Fatal(err)
					}
				}
			}
			if mode == "revoked-nas" {
				probe.inspectHook = func() { r.s.closeNAS() }
			}
			r.s.engine = probe
			code, _ := r.call("POST", "/api/store/v2/settings", `{"theme":"dark","updateCheckEnabled":true,"updateCheckHours":6,"defaultRootId":"storage"}`, "127.0.0.1:1")
			want := 409
			if mode != "unsafe" {
				want = 401
			}
			if code != want {
				t.Fatal("unsafe/expired preference committed", mode, code)
			}
			saved, err := runtimeGet[runtimeSettings](r.s.db, "runtime_settings", "settings")
			if !errors.Is(err, sql.ErrNoRows) {
				t.Fatal("failed preference mutated settings", saved, err)
			}
		})
	}
}

func TestRuntimeControllerDefaultStorageLegacyRowAndInvalidTypes(t *testing.T) {
	r, _ := controllerRig(t)
	old := `{"theme":"dark","updateCheckEnabled":false,"updateCheckHours":12}`
	if _, err := r.s.db.Exec(`INSERT INTO runtime_settings(id,body)VALUES('settings',?)`, old); err != nil {
		t.Fatal(err)
	}
	code, out := r.call("GET", "/api/store/v2/settings", "", "127.0.0.1:1")
	if code != 200 || out["data"].(map[string]any)["defaultRootId"] != "" || out["data"].(map[string]any)["theme"] != "dark" {
		t.Fatal("legacy persisted preferences did not migrate as manual choice", code, out)
	}
	for _, invalid := range []string{"null", "true", "7", "[]"} {
		body := `{"theme":"light","updateCheckEnabled":true,"updateCheckHours":6,"defaultRootId":` + invalid + `}`
		code, out = r.call("POST", "/api/store/v2/settings", body, "127.0.0.1:1")
		if code != 400 || out["error"].(map[string]any)["code"] != "invalid_default_root" {
			t.Fatal("invalid preference type accepted", invalid, code, out)
		}
	}
	var preserved string
	if err := r.s.db.QueryRow(`SELECT body FROM runtime_settings WHERE id='settings'`).Scan(&preserved); err != nil || preserved != old {
		t.Fatal("rejected preference overwrote existing settings", preserved, err)
	}
}

func controllerFailedReview(t *testing.T, r *testRig, p RuntimePlan, status string) runtimeJob {
	t.Helper()
	j := runtimeJob{Job: Job{ID: randomID(), PlanID: p.ID, InstanceID: p.InstanceID, RequestID: randomID(), Status: status}, Kind: p.Kind, AppID: p.AppID}
	body, _ := json.Marshal(j)
	if _, err := r.s.db.Exec(`INSERT INTO runtime_jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)`, j.ID, j.PlanID, j.RequestID, j.Status, string(body)); err != nil {
		t.Fatal(err)
	}
	return j
}

func controllerRetry(t *testing.T, r *testRig, j runtimeJob) RuntimePlan {
	t.Helper()
	code, out := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
	if code != 201 {
		t.Fatalf("retry plan %d %v", code, out)
	}
	body, _ := json.Marshal(out["data"])
	var p RuntimePlan
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatal(err)
	}
	binding := out["data"].(map[string]any)
	if binding["retryOfJobId"] != j.ID || binding["retryOfPlanId"] != j.PlanID {
		t.Fatal("retry provenance absent", binding)
	}
	return p
}

func TestRuntimeControllerRetryInstallCreatesOnlyFreshImmutableReview(t *testing.T) {
	r, e := controllerRig(t)
	old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"retained","hostPort":32400}`)
	e.failLaunch = true
	j := controllerWait(t, r, controllerSubmit(t, r, old, "failed-install").ID)
	if j.Status != "failed" {
		t.Fatal(j)
	}
	e.failLaunch = false
	p := controllerRetry(t, r, j)
	if p.ID == old.ID || p.InstanceID == old.InstanceID || p.GenerationID == old.GenerationID || p.DataPath == old.DataPath || p.RootPath != old.RootPath || p.RootID != old.RootID || p.HostPort != old.HostPort {
		t.Fatal("retry reused failed identities", p)
	}
	if filepath.Dir(p.DataPath) != old.RootPath || !segmentRE.MatchString(filepath.Base(p.DataPath)) {
		t.Fatal("unsafe fresh retry directory", p.DataPath)
	}
	if _, err := os.Stat(p.DataPath); !os.IsNotExist(err) {
		t.Fatal("retry planning created data")
	}
	if _, err := os.Stat(old.DataPath); err != nil {
		t.Fatal("failed data lost", err)
	}
	retained, _ := runtimeGet[RuntimePlan](r.s.db, "runtime_plans", old.ID)
	a, _ := json.Marshal(old)
	b, _ := json.Marshal(retained)
	if string(a) != string(b) {
		t.Fatal("old immutable plan changed")
	}
	jobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
	if len(jobs) != 1 || jobs[0].Status != "failed" || e.launches != 1 || e.snapshots != 0 {
		t.Fatal("retry submitted execution")
	}
	job := controllerSubmit(t, r, p, "retry-confirm")
	duplicate := controllerSubmit(t, r, p, "retry-confirm")
	if duplicate.ID != job.ID {
		t.Fatal("duplicate confirmation created extra job")
	}
	if done := controllerWait(t, r, job.ID); done.Status != "succeeded" {
		t.Fatal(done)
	}
}

func TestRuntimeControllerRetryRefusesIneligibleJobsAndInputs(t *testing.T) {
	for _, status := range []string{"queued", "running", "succeeded", "needs_attention", "unknown"} {
		t.Run(status, func(t *testing.T) {
			r, _ := controllerRig(t)
			p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"ineligible","hostPort":32401}`)
			j := controllerFailedReview(t, r, p, status)
			code, _ := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
			if code != 409 {
				t.Fatalf("ineligible retry returned %d", code)
			}
		})
	}
	r, _ := controllerRig(t)
	code, _ := r.call("POST", "/api/store/v2/jobs/missing/retry-plan", `{}`, "127.0.0.1:1")
	if code != 404 {
		t.Fatal("unknown job admitted", code)
	}
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"foreign","hostPort":32402}`)
	j := controllerFailedReview(t, r, p, "failed")
	for _, body := range []string{`{"directory":"chosen"}`, `null`, `[]`} {
		code, _ = r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", body, "127.0.0.1:1")
		if code != 400 {
			t.Fatal("nonempty/nonobject body admitted", code, body)
		}
	}
	p.StoreID = "foreign"
	if err := runtimePut(r.s.db, context.Background(), "runtime_plans", p.ID, p); err != nil {
		t.Fatal(err)
	}
	code, _ = r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
	if code != 409 {
		t.Fatal("foreign plan admitted", code)
	}
	r.token = ""
	code, _ = r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
	if code != 401 {
		t.Fatal("anonymous retry admitted", code)
	}
}

func TestRuntimeControllerRetryFinalAuthFenceAndCurrentStorage(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		t.Run(fmt.Sprint(revoked), func(t *testing.T) {
			r, e := controllerRig(t)
			p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"fence","hostPort":32403}`)
			j := controllerFailedReview(t, r, p, "failed")
			if revoked {
				e.resolveHook = func() {
					if _, err := r.s.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, tokenHash(r.token)); err != nil {
						t.Fatal(err)
					}
				}
			} else {
				r.s.engine = retryUnsafeRuntimeEngine{controllerEngine: e}
			}
			code, _ := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
			want := 409
			if revoked {
				want = 401
			}
			if code != want {
				t.Fatalf("retry fence %d, want %d", code, want)
			}
			plans, _ := runtimeRead[RuntimePlan](r.s.db, "runtime_plans")
			if len(plans) != 1 {
				t.Fatal("invalid retry plan persisted")
			}
		})
	}
}

type retryUnsafeRuntimeEngine struct{ *controllerEngine }

func (e retryUnsafeRuntimeEngine) DockerStorage(context.Context) (StorageCandidate, error) {
	return StorageCandidate{}, errors.New("unsafe cache")
}

func (e *controllerEngine) VerifyFailedInstall(ctx context.Context, p RuntimePlan, g *RuntimeGeneration) error {
	if g == nil {
		return e.ValidatePath(ctx, p.RootPath, p.DataPath, true)
	}
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	actual, ok := e.generations[g.ID]
	if !ok || actual.StoreID != p.StoreID || actual.InstanceID != p.InstanceID || actual.DataPath != p.DataPath || (actual.State != "stopped" && actual.State != "prepared") {
		return runtimeFailure
	}
	return nil
}
func (e *controllerEngine) VerifyRuntimeSnapshot(_ context.Context, snap RuntimeSnapshot) error {
	// Fixture snapshots used by existing lifecycle tests are engine-owned virtual
	// archives. Real file material cases below verify both manifest and bytes.
	body, err := os.ReadFile(filepath.Join(snap.RootPath, snap.ID, "manifest.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var manifest RuntimeSnapshot
	if json.Unmarshal(body, &manifest) != nil {
		return runtimeFailure
	}
	a, _ := json.Marshal(snap)
	b, _ := json.Marshal(manifest)
	if string(a) != string(b) {
		return runtimeFailure
	}
	content, err := os.ReadFile(snap.Path)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(content)
	if hex.EncodeToString(hash[:]) != snap.SHA256 || int64(len(content)) != snap.SizeBytes {
		return runtimeFailure
	}
	return nil
}

func TestRuntimeControllerRetryInstallRefusesUnownedOrRunningRetainedResources(t *testing.T) {
	for _, state := range []string{"unowned", "running", "unknown"} {
		t.Run(state, func(t *testing.T) {
			r, e := controllerRig(t)
			p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"uncertain","hostPort":32404}`)
			j := controllerFailedReview(t, r, p, "failed")
			if state == "unowned" {
				os.Mkdir(p.DataPath, 0700)
			} else {
				g, err := e.PrepareGeneration(context.Background(), p)
				if err != nil {
					t.Fatal(err)
				}
				g.State = state
				e.generations[g.ID] = g
				runtimePut(r.s.db, context.Background(), "runtime_generations", g.ID, g)
				runtimePut(r.s.db, context.Background(), "runtime_instances", p.InstanceID, runtimeInstance{ID: p.InstanceID, AppID: p.AppID, ActiveGenerationID: g.ID})
			}
			code, _ := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
			if code != 409 {
				t.Fatalf("uncertain retry admitted %d", code)
			}
		})
	}
}

func TestRuntimeControllerRetryCurrentSourceAndSnapshotBindings(t *testing.T) {
	for _, kind := range []string{"start", "stop", "restart", "archive", "reactivate", "backup", "update", "restore"} {
		t.Run(kind, func(t *testing.T) {
			r, e := controllerRig(t)
			recipe, _ := RuntimeRecipeFor("uptime-kuma", "")
			body, _ := json.Marshal(map[string]any{"kind": "install", "appId": "uptime-kuma", "targetVersion": recipe.CompatibleFrom[0], "rootId": "storage", "directory": "source", "hostPort": 32405})
			installed := controllerPlan(t, r, string(body))
			controllerWait(t, r, controllerSubmit(t, r, installed, "source-install").ID)
			input := map[string]any{"kind": kind, "instanceId": installed.InstanceID}
			var snapshot RuntimeSnapshot
			if kind == "restore" {
				snapshot = controllerPrivateDownloadFixtureForSource(t, r, e, installed.GenerationID)
				input["snapshotId"] = snapshot.ID
			}
			body, _ = json.Marshal(input)
			old := controllerPlan(t, r, string(body))
			j := controllerFailedReview(t, r, old, "failed")
			p := controllerRetry(t, r, j)
			if p.SourceGenerationID != installed.GenerationID || p.InstanceID != installed.InstanceID || p.Kind != old.Kind || (kind == "restore" && p.SourceSnapshotID != snapshot.ID) {
				t.Fatal("retry source binding lost", p)
			}
			if kind == "update" || kind == "restore" {
				if p.GenerationID == old.GenerationID || p.DataPath == old.DataPath || p.SnapshotID == old.SnapshotID {
					t.Fatal("retry reuses failed candidate", p)
				}
			}
			beforeJobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
			done := controllerWait(t, r, controllerSubmit(t, r, p, "retry-"+kind).ID)
			if done.Status != "succeeded" {
				t.Fatal("retry failed", done)
			}
			afterJobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
			if len(afterJobs) != len(beforeJobs)+1 {
				t.Fatal("retry history lost or duplicated")
			}
			originalJob, _ := runtimeGet[runtimeJob](r.s.db, "runtime_jobs", j.ID)
			if originalJob.Status != "failed" {
				t.Fatal("original job changed")
			}
			instance, _ := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", installed.InstanceID)
			instance.ActiveGenerationID = "changed"
			runtimePut(r.s.db, context.Background(), "runtime_instances", instance.ID, instance)
			code, out := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
			if code != 409 || out["error"].(map[string]any)["code"] != "retry_source_changed" {
				t.Fatalf("changed source %d %v", code, out)
			}
		})
	}
}

func controllerPrivateDownloadFixtureForSource(t *testing.T, r *testRig, e *controllerEngine, id string) RuntimeSnapshot {
	t.Helper()
	source, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", id)
	source.State = "stopped"
	snapshot, err := e.SnapshotGeneration(context.Background(), source, r.root, randomID())
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("original snapshot bytes")
	hash := sha256.Sum256(content)
	snapshot.SHA256 = hex.EncodeToString(hash[:])
	snapshot.SizeBytes = int64(len(content))
	if err = os.Mkdir(filepath.Join(snapshot.RootPath, snapshot.ID), 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(snapshot.Path, content, 0600)
	body, _ := json.Marshal(snapshot)
	os.WriteFile(filepath.Join(snapshot.RootPath, snapshot.ID, "manifest.json"), body, 0600)
	if err = runtimePut(r.s.db, context.Background(), "runtime_snapshots", snapshot.ID, snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestRuntimeControllerRetryRestoreRejectsChangedSnapshotMaterialAndDatabase(t *testing.T) {
	for _, change := range []string{"missing", "bytes", "database-and-manifest"} {
		t.Run(change, func(t *testing.T) {
			r, e := controllerRig(t)
			installed := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"snapshot-source","hostPort":32406}`)
			controllerWait(t, r, controllerSubmit(t, r, installed, "restore-source").ID)
			snapshot := controllerPrivateDownloadFixtureForSource(t, r, e, installed.GenerationID)
			body, _ := json.Marshal(map[string]any{"kind": "restore", "instanceId": installed.InstanceID, "snapshotId": snapshot.ID})
			old := controllerPlan(t, r, string(body))
			j := controllerFailedReview(t, r, old, "failed")
			if change == "missing" {
				r.s.db.Exec(`DELETE FROM runtime_snapshots WHERE id=?`, snapshot.ID)
			} else {
				content := []byte("other material")
				os.WriteFile(snapshot.Path, content, 0600)
				if change == "database-and-manifest" {
					hash := sha256.Sum256(content)
					snapshot.SHA256 = hex.EncodeToString(hash[:])
					snapshot.SizeBytes = int64(len(content))
					runtimePut(r.s.db, context.Background(), "runtime_snapshots", snapshot.ID, snapshot)
					body, _ := json.Marshal(snapshot)
					os.WriteFile(filepath.Join(snapshot.RootPath, snapshot.ID, "manifest.json"), body, 0600)
				}
			}
			code, _ := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
			if code != 409 {
				t.Fatal("changed restore material admitted", code)
			}
		})
	}
}

func TestRuntimeControllerRetryInstallRevalidatesAtPlanningExecuteAndLaunch(t *testing.T) {
	for _, stage := range []string{"planning", "execute", "launch"} {
		t.Run(stage, func(t *testing.T) {
			r, e := controllerRig(t)
			old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"fenced","hostPort":32407}`)
			e.failLaunch = true
			j := controllerWait(t, r, controllerSubmit(t, r, old, "failed-fenced").ID)
			e.failLaunch = false
			restart := func() {
				e.runtimeMu.Lock()
				g := e.generations[old.GenerationID]
				g.State = "running"
				e.generations[g.ID] = g
				e.runtimeMu.Unlock()
			}
			if stage == "planning" {
				e.resolveHook = restart
				code, _ := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
				if code != 409 {
					t.Fatal("live resource changed during planning admitted", code)
				}
				return
			}
			p := controllerRetry(t, r, j)
			if stage == "execute" {
				restart()
				code, _ := r.call("POST", "/api/store/v2/execute", fmt.Sprintf(`{"planId":%q,"requestId":"new-fenced"}`, p.ID), "127.0.0.1:1")
				if code != 409 {
					t.Fatal("live source changed before execute admitted", code)
				}
				return
			}
			fenced := &retryBeforeLaunchEngine{controllerEngine: e, beforePrepare: restart}
			r.s.engine = fenced
			done := controllerWait(t, r, controllerSubmit(t, r, p, "launch-fenced").ID)
			if done.Status != "failed" {
				t.Fatal("changed original source launched", done)
			}
			e.runtimeMu.Lock()
			launches := e.launches
			e.runtimeMu.Unlock()
			if launches != 1 {
				t.Fatal("new launch occurred after original restarted", launches)
			}
		})
	}
}

type retryBeforeLaunchEngine struct {
	*controllerEngine
	beforePrepare func()
}

func (e *retryBeforeLaunchEngine) PrepareGeneration(ctx context.Context, p RuntimePlan) (RuntimeGeneration, error) {
	g, err := e.controllerEngine.PrepareGeneration(ctx, p)
	e.beforePrepare()
	return g, err
}

func TestRuntimeControllerRetryFinalFenceRejectsChangedJobAndUnrelatedReservations(t *testing.T) {
	for _, change := range []string{"job", "other-generation"} {
		t.Run(change, func(t *testing.T) {
			r, e := controllerRig(t)
			old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"other-fence","hostPort":32408}`)
			e.failLaunch = true
			j := controllerWait(t, r, controllerSubmit(t, r, old, "other-failed").ID)
			e.failLaunch = false
			if change == "job" {
				e.resolveHook = func() {
					j.Status = "needs_attention"
					if err := r.s.runtimeSaveJob(j); err != nil {
						t.Fatal(err)
					}
				}
			} else {
				g, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", old.GenerationID)
				g.ID = randomID()
				g.InstanceID = randomID()
				g.DataPath = filepath.Join(g.RootPath, "unrelated")
				if err := runtimePut(r.s.db, context.Background(), "runtime_generations", g.ID, g); err != nil {
					t.Fatal(err)
				}
			}
			code, _ := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
			if code != 409 {
				t.Fatal("unsafe reservation/job change admitted", code)
			}
		})
	}
}

func TestRuntimeControllerRetryRevokedNASCannotCommit(t *testing.T) {
	r, _ := nasMutationRig(t)
	e := &controllerEngine{fakeEngine: r.e, generations: map[string]RuntimeGeneration{}}
	r.s.engine = e
	old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"nas-retry","hostPort":32409}`)
	j := controllerFailedReview(t, r, old, "failed")
	e.resolveHook = func() {
		if code, _ := r.call("POST", "/api/store/logout", `{}`, "127.0.0.1:1"); code != 200 {
			t.Fatal(code)
		}
	}
	code, _ := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
	if code != 401 {
		t.Fatal("revoked NAS retry admitted", code)
	}
	plans, _ := runtimeRead[RuntimePlan](r.s.db, "runtime_plans")
	if len(plans) != 1 {
		t.Fatal("revoked NAS retry persisted")
	}
}

func TestRuntimeControllerRetryInstallPreservesReviewedMediaAndNameBounds(t *testing.T) {
	r, _ := controllerRig(t)
	media := filepath.Join(r.root, "music")
	if err := os.Mkdir(media, 0700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"kind": "install", "appId": "navidrome", "rootId": "storage", "directory": strings.Repeat("d", 64), "hostPort": 32410, "mediaRootId": "storage", "mediaPath": media})
	old := controllerPlan(t, r, string(body))
	j := controllerFailedReview(t, r, old, "failed")
	p := controllerRetry(t, r, j)
	if p.MediaPath != old.MediaPath || p.MediaRootPath != old.MediaRootPath || p.MediaStorageIdentity != old.MediaStorageIdentity || len(filepath.Base(p.DataPath)) > 64 {
		t.Fatal("media or directory bounds changed", p)
	}
}

func TestRuntimeControllerRetryRestoreWithoutHistoricalBaselineIsRefused(t *testing.T) {
	r, e := controllerRig(t)
	installed := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"legacy-restore","hostPort":32411}`)
	controllerWait(t, r, controllerSubmit(t, r, installed, "legacy-source").ID)
	snapshot := controllerPrivateDownloadFixtureForSource(t, r, e, installed.GenerationID)
	body, _ := json.Marshal(map[string]any{"kind": "restore", "instanceId": installed.InstanceID, "snapshotId": snapshot.ID})
	old := controllerPlan(t, r, string(body))
	j := controllerFailedReview(t, r, old, "failed")
	if err := runtimePut(r.s.db, context.Background(), "runtime_plans", old.ID, old); err != nil {
		t.Fatal(err)
	}
	code, out := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
	if code != 409 || out["error"].(map[string]any)["code"] != "retry_snapshot_unverified" {
		t.Fatal("historical restore adopted", code, out)
	}
}

func TestRuntimeControllerRetryInstallFinalFenceRetainsRegisteredMediaSelection(t *testing.T) {
	r, e := controllerRig(t)
	mediaRoot := filepath.Join(filepath.Dir(r.root), "media-root")
	if err := os.Mkdir(mediaRoot, 0700); err != nil {
		t.Fatal(err)
	}
	root := StorageRoot{ID: "registered-media", Path: mediaRoot, Roles: []string{"media"}}
	rootBody, _ := json.Marshal(root)
	if _, err := r.s.db.Exec(`INSERT INTO storage_roots(id,path,body)VALUES(?,?,?)`, root.ID, root.Path, string(rootBody)); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"kind": "install", "appId": "navidrome", "rootId": "storage", "directory": "media-final", "hostPort": 32412, "mediaRootId": root.ID, "mediaPath": root.Path})
	old := controllerPlan(t, r, string(body))
	j := controllerFailedReview(t, r, old, "failed")
	e.resolveHook = func() {
		if _, err := r.s.db.Exec(`DELETE FROM storage_roots WHERE id=?`, root.ID); err != nil {
			t.Fatal(err)
		}
	}
	code, _ := r.call("POST", "/api/store/v2/jobs/"+j.ID+"/retry-plan", `{}`, "127.0.0.1:1")
	if code != 409 {
		t.Fatal("deregistered reviewed media admitted", code)
	}
}

func TestReviewRetryCompletedUpdateIdempotentReplay(t *testing.T) {
	r, e := controllerRig(t)
	recipe, _ := RuntimeRecipeFor("uptime-kuma", "")
	body, _ := json.Marshal(map[string]any{"kind": "install", "appId": "uptime-kuma", "targetVersion": recipe.CompatibleFrom[0], "rootId": "storage", "directory": "review-source", "hostPort": 32550})
	installed := controllerPlan(t, r, string(body))
	controllerWait(t, r, controllerSubmit(t, r, installed, "review-install").ID)
	_ = e
	body, _ = json.Marshal(map[string]any{"kind": "update", "instanceId": installed.InstanceID})
	original := controllerPlan(t, r, string(body))
	failed := controllerFailedReview(t, r, original, "failed")
	retry := controllerRetry(t, r, failed)
	job := controllerWait(t, r, controllerSubmit(t, r, retry, "review-retry-confirm").ID)
	if job.Status != "succeeded" {
		t.Fatal("prerequisite", job)
	}
	replay, _ := json.Marshal(map[string]string{"planId": retry.ID, "requestId": "review-retry-confirm"})
	code, out := r.call("POST", "/api/store/v2/execute", string(replay), "127.0.0.1:1")
	if code != 202 {
		t.Fatalf("same request after success returned %d; want existing job: %v", code, out)
	}
}
func TestReviewRetryInstallSecondFailure(t *testing.T) {
	r, e := controllerRig(t)
	original := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"review-repeat","hostPort":32551}`)
	e.failLaunch = true
	first := controllerWait(t, r, controllerSubmit(t, r, original, "review-first-failure").ID)
	if first.Status != "failed" {
		t.Fatal("prerequisite", first)
	}
	retry := controllerRetry(t, r, first)
	second := controllerWait(t, r, controllerSubmit(t, r, retry, "review-second-failure").ID)
	if second.Status != "failed" {
		t.Fatal("prerequisite", second)
	}
	code, out := r.call("POST", "/api/store/v2/jobs/"+second.ID+"/retry-plan", `{}`, "127.0.0.1:1")
	if code != 201 {
		t.Fatalf("second failed install cannot generate fresh retry: %d %v", code, out)
	}
}

type retryReplayEngine struct {
	*controllerEngine
	occupied   bool
	verifyHook func()
}

func (e *retryReplayEngine) PortAvailable(ctx context.Context, port int) error {
	if e.occupied {
		return runtimeFailure
	}
	return e.controllerEngine.PortAvailable(ctx, port)
}
func (e *retryReplayEngine) VerifyFailedInstall(ctx context.Context, p RuntimePlan, g *RuntimeGeneration) error {
	if e.verifyHook != nil {
		e.verifyHook()
		return runtimeFailure
	}
	return e.controllerEngine.VerifyFailedInstall(ctx, p, g)
}
func TestRuntimeControllerRetryReplayProofRace(t *testing.T) {
	r, e := controllerRig(t)
	old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"replay-race","hostPort":32552}`)
	failed := controllerFailedReview(t, r, old, "failed")
	p := controllerRetry(t, r, failed)
	completed := runtimeJob{Job: Job{ID: randomID(), PlanID: p.ID, RequestID: "replay-race", InstanceID: p.InstanceID, Status: "succeeded"}, Kind: p.Kind, AppID: p.AppID}
	r.s.engine = &retryReplayEngine{controllerEngine: e, verifyHook: func() {
		body, _ := json.Marshal(completed)
		if _, err := r.s.db.Exec(`INSERT INTO runtime_jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)`, completed.ID, completed.PlanID, completed.RequestID, completed.Status, string(body)); err != nil {
			t.Fatal(err)
		}
	}}
	code, out := r.call("POST", "/api/store/v2/execute", fmt.Sprintf(`{"planId":%q,"requestId":"replay-race"}`, p.ID), "127.0.0.1:1")
	if code != 202 || out["data"].(map[string]any)["id"] != completed.ID {
		t.Fatalf("concurrent exact admission lost after proof failed: %d %v", code, out)
	}
	if e.launches != 0 {
		t.Fatal("replayed job executed twice")
	}
}

func TestRuntimeControllerRetryCompletedReplayAcrossKinds(t *testing.T) {
	for _, kind := range []string{"install", "update", "restore"} {
		t.Run(kind, func(t *testing.T) {
			r, e := controllerRig(t)
			recipe, _ := RuntimeRecipeFor("uptime-kuma", "")
			input := map[string]any{"kind": "install", "appId": "uptime-kuma", "targetVersion": recipe.CompatibleFrom[0], "rootId": "storage", "directory": "completed-replay", "hostPort": 32553}
			body, _ := json.Marshal(input)
			old := controllerPlan(t, r, string(body))
			var failed runtimeJob
			if kind == "install" {
				e.failLaunch = true
				failed = controllerWait(t, r, controllerSubmit(t, r, old, "replay-failed").ID)
				e.failLaunch = false
			} else {
				controllerWait(t, r, controllerSubmit(t, r, old, "replay-source").ID)
				input = map[string]any{"kind": kind, "instanceId": old.InstanceID}
				if kind == "restore" {
					input["snapshotId"] = controllerPrivateDownloadFixtureForSource(t, r, e, old.GenerationID).ID
				}
				body, _ = json.Marshal(input)
				old = controllerPlan(t, r, string(body))
				failed = controllerFailedReview(t, r, old, "failed")
			}
			p := controllerRetry(t, r, failed)
			completed := controllerWait(t, r, controllerSubmit(t, r, p, "completed-replay").ID)
			if completed.Status != "succeeded" {
				t.Fatal(completed)
			}
			r.s.engine = &retryReplayEngine{controllerEngine: e, occupied: true, verifyHook: func() { t.Fatal("exact replay reverified mutable resources") }}
			replay := controllerSubmit(t, r, p, "completed-replay")
			if replay.ID != completed.ID || replay.Status != "succeeded" {
				t.Fatal("did not return exact persisted result", replay)
			}
			jobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
			before := len(jobs)
			for _, payload := range []string{fmt.Sprintf(`{"planId":%q,"requestId":"wrong-replay"}`, p.ID), fmt.Sprintf(`{"planId":%q,"requestId":"completed-replay"}`, old.ID)} {
				code, _ := r.call("POST", "/api/store/v2/execute", payload, "127.0.0.1:1")
				if code != 409 {
					t.Fatal("mismatched replay admitted", code)
				}
			}
			jobs, _ = runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
			if len(jobs) != before {
				t.Fatal("replay created duplicate jobs")
			}
			r.s.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, tokenHash(r.token))
			code, _ := r.call("POST", "/api/store/v2/execute", fmt.Sprintf(`{"planId":%q,"requestId":"completed-replay"}`, p.ID), "127.0.0.1:1")
			if code != 401 {
				t.Fatal("revoked replay admitted", code)
			}
		})
	}
}

func TestRuntimeControllerRetryBatchLostResponseReplay(t *testing.T) {
	r, e := controllerRig(t)
	old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"batch-old","hostPort":32554}`)
	failed := controllerFailedReview(t, r, old, "failed")
	p := controllerRetry(t, r, failed)
	other := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"batch-other","hostPort":32555}`)
	payload := fmt.Sprintf(`{"planIds":[%q,%q],"requestId":"batch-replay"}`, p.ID, other.ID)
	code, out := r.call("POST", "/api/store/v2/batches", payload, "127.0.0.1:1")
	if code != 202 {
		t.Fatal(code, out)
	}
	items := out["data"].(map[string]any)["items"].([]any)
	for _, item := range items {
		if j := controllerWait(t, r, item.(map[string]any)["id"].(string)); j.Status != "succeeded" {
			t.Fatal(j)
		}
	}
	r.s.engine = &retryReplayEngine{controllerEngine: e, occupied: true, verifyHook: func() { t.Fatal("batch replay reverified") }}
	code, out = r.call("POST", "/api/store/v2/batches", payload, "127.0.0.1:1")
	if code != 202 {
		t.Fatal("lost-response batch replay", code, out)
	}
	replay := out["data"].(map[string]any)["items"].([]any)
	for i, item := range replay {
		if item.(map[string]any)["id"] != items[i].(map[string]any)["id"] {
			t.Fatal("batch binding changed")
		}
	}
	fresh := RuntimePlan{ID: randomID()}
	for _, ids := range [][]string{{p.ID, fresh.ID}, {other.ID, p.ID}, {p.ID, p.ID}, {p.ID}} {
		body, _ := json.Marshal(map[string]any{"planIds": ids, "requestId": "batch-replay"})
		code, _ = r.call("POST", "/api/store/v2/batches", string(body), "127.0.0.1:1")
		if code != 409 {
			t.Fatal("partial/reordered batch admitted", code)
		}
	}
	jobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
	if len(jobs) != 3 {
		t.Fatal("partial batch wrote jobs", len(jobs))
	}
}

func controllerTwiceFailedInstall(t *testing.T, r *testRig, e *controllerEngine) (RuntimePlan, RuntimePlan, runtimeJob) {
	t.Helper()
	old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"ancestry-old","hostPort":32556}`)
	e.failLaunch = true
	first := controllerWait(t, r, controllerSubmit(t, r, old, "ancestor-first").ID)
	if first.Status != "failed" {
		t.Fatal(first)
	}
	// Natural plan expiry cannot release a retained failed ancestor's identity.
	old.ExpiresAt = time.Now().Add(-time.Minute)
	if err := runtimePut(r.s.db, context.Background(), "runtime_plans", old.ID, old); err != nil {
		t.Fatal(err)
	}
	parent := controllerRetry(t, r, first)
	second := controllerWait(t, r, controllerSubmit(t, r, parent, "ancestor-second").ID)
	if second.Status != "failed" {
		t.Fatal(second)
	}
	e.failLaunch = false
	return old, parent, second
}
func TestRuntimeControllerRetryFullAncestryThirdAttemptAndRetention(t *testing.T) {
	r, e := controllerRig(t)
	old, parent, second := controllerTwiceFailedInstall(t, r, e)
	// Expiry does not remove retained generations or ancestor reservations.
	oldRecord, _ := runtimeGet[runtimePlanRecord](r.s.db, "runtime_plans", old.ID)
	p := controllerRetry(t, r, second)
	record, _ := runtimeGet[runtimePlanRecord](r.s.db, "runtime_plans", p.ID)
	if record.RetryBinding == nil || len(record.RetryBinding.members()) != 2 {
		t.Fatal("ancestry dropped", record.RetryBinding)
	}
	if p.InstanceID == parent.InstanceID || p.InstanceID == old.InstanceID || p.GenerationID == parent.GenerationID || p.GenerationID == old.GenerationID || p.DataPath == parent.DataPath || p.DataPath == old.DataPath {
		t.Fatal("ancestor identity reused")
	}
	if done := controllerWait(t, r, controllerSubmit(t, r, p, "ancestor-third").ID); done.Status != "succeeded" {
		t.Fatal(done)
	}
	jobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
	gens, _ := runtimeRead[RuntimeGeneration](r.s.db, "runtime_generations")
	if len(jobs) != 3 || len(gens) != 3 {
		t.Fatal("history lost", len(jobs), len(gens))
	}
	current, _ := runtimeGet[runtimePlanRecord](r.s.db, "runtime_plans", old.ID)
	a, _ := json.Marshal(oldRecord)
	b, _ := json.Marshal(current)
	if string(a) != string(b) {
		t.Fatal("ancestor envelope changed")
	}
	for _, ancestor := range []RuntimePlan{old, parent} {
		if _, err := os.Stat(ancestor.DataPath); err != nil {
			t.Fatal("retained path lost", err)
		}
		g, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", ancestor.GenerationID)
		if g.State != "stopped" {
			t.Fatal("ancestor adopted", g.State)
		}
		input := map[string]any{"kind": "install", "appId": "uptime-kuma", "rootId": "storage", "directory": filepath.Base(ancestor.DataPath), "hostPort": 32557}
		body, _ := json.Marshal(input)
		code, _ := r.call("POST", "/api/store/v2/plans", string(body), "127.0.0.1:1")
		if code != 409 {
			t.Fatal("ancestor path reused", code)
		}
	}
}
func TestRuntimeControllerRetryGrandparentRecheckedAtEveryBoundary(t *testing.T) {
	for _, stage := range []string{"planning", "execute", "worker", "launch"} {
		for _, change := range []string{"running", "foreign", "changed", "needs_attention", "active-job"} {
			t.Run(stage+"/"+change, func(t *testing.T) {
				r, e := controllerRig(t)
				old, _, second := controllerTwiceFailedInstall(t, r, e)
				mutate := func() {
					if change == "needs_attention" || change == "active-job" {
						jobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
						j := jobs[0]
						if change == "active-job" {
							j.ID = randomID()
							j.PlanID = randomID()
							j.RequestID = randomID()
							j.Status = "running"
							body, _ := json.Marshal(j)
							if _, err := r.s.db.Exec(`INSERT INTO runtime_jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)`, j.ID, j.PlanID, j.RequestID, j.Status, string(body)); err != nil {
								t.Fatal(err)
							}
						} else {
							j.Status = "needs_attention"
							if err := r.s.runtimeSaveJob(j); err != nil {
								t.Fatal(err)
							}
						}
						return
					}
					e.runtimeMu.Lock()
					g := e.generations[old.GenerationID]
					if change == "running" {
						g.State = "running"
					}
					if change == "foreign" {
						g.StoreID = "foreign"
					}
					if change == "changed" {
						g.DataPath = filepath.Join(g.RootPath, "changed")
					}
					e.generations[g.ID] = g
					e.runtimeMu.Unlock()
					if change == "changed" {
						runtimePut(r.s.db, context.Background(), "runtime_generations", g.ID, g)
					}
				}
				if stage == "planning" {
					e.resolveHook = mutate
					code, _ := r.call("POST", "/api/store/v2/jobs/"+second.ID+"/retry-plan", `{}`, "127.0.0.1:1")
					if code != 409 {
						t.Fatal("changed grandparent admitted planning", code)
					}
					return
				}
				p := controllerRetry(t, r, second)
				if stage == "execute" {
					mutate()
					code, _ := r.call("POST", "/api/store/v2/execute", fmt.Sprintf(`{"planId":%q,"requestId":"ancestor-rejected"}`, p.ID), "127.0.0.1:1")
					if code != 409 {
						t.Fatal("changed grandparent admitted execute", code)
					}
					return
				}
				if stage == "worker" {
					// Hold the engine operation fence until the admitted job's source changes.
					r.s.operation.Lock()
					j := controllerFailedReview(t, r, p, "queued")
					mutate()
					r.s.operation.Unlock()
					got := controllerWait(t, r, j.ID)
					if got.Status != "failed" {
						t.Fatal("worker accepted changed grandparent", got)
					}
				} else {
					r.s.engine = &retryBeforeLaunchEngine{controllerEngine: e, beforePrepare: mutate}
					done := controllerWait(t, r, controllerSubmit(t, r, p, "ancestor-launch").ID)
					if done.Status != "failed" {
						t.Fatal(done)
					}
				}
				e.runtimeMu.Lock()
				launches := e.launches
				e.runtimeMu.Unlock()
				if launches != 2 {
					t.Fatal("new launch after grandparent changed", launches)
				}
			})
		}
	}
}

func TestRuntimeControllerRetryReplayRaceRejectsPartialMismatchAndRevocation(t *testing.T) {
	for _, mode := range []string{"partial-batch", "wrong-request", "expired", "revoked-nas"} {
		t.Run(mode, func(t *testing.T) {
			var r *testRig
			var e *controllerEngine
			if mode == "revoked-nas" {
				r, _ = nasMutationRig(t)
				e = &controllerEngine{fakeEngine: r.e, generations: map[string]RuntimeGeneration{}}
				r.s.engine = e
			} else {
				r, e = controllerRig(t)
			}
			old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"race-rejection","hostPort":32558}`)
			failed := controllerFailedReview(t, r, old, "failed")
			p := controllerRetry(t, r, failed)
			payload := fmt.Sprintf(`{"planId":%q,"requestId":"race-rejection"}`, p.ID)
			route := "/api/store/v2/execute"
			request := "race-rejection"
			if mode == "partial-batch" {
				other := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"race-batch","hostPort":32559}`)
				payload = fmt.Sprintf(`{"planIds":[%q,%q],"requestId":"race-rejection"}`, p.ID, other.ID)
				route = "/api/store/v2/batches"
				request += ":0"
			}
			if mode == "wrong-request" {
				request = "different"
			}
			r.s.engine = &retryReplayEngine{controllerEngine: e, verifyHook: func() {
				j := runtimeJob{Job: Job{ID: randomID(), PlanID: p.ID, RequestID: request, InstanceID: p.InstanceID, Status: "succeeded"}, Kind: p.Kind, AppID: p.AppID}
				body, _ := json.Marshal(j)
				if _, err := r.s.db.Exec(`INSERT INTO runtime_jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)`, j.ID, j.PlanID, j.RequestID, j.Status, string(body)); err != nil {
					t.Fatal(err)
				}
				if mode == "expired" {
					r.s.db.Exec(`UPDATE sessions SET expires_at=? WHERE token_hash=?`, time.Now().Unix()-1, tokenHash(r.token))
				}
				if mode == "revoked-nas" {
					r.s.closeNAS()
				}
			}}
			code, _ := r.call("POST", route, payload, "127.0.0.1:1")
			want := 409
			if mode == "expired" || mode == "revoked-nas" {
				want = 401
			}
			if code != want {
				t.Fatal("unsafe proof-race replay", code, want)
			}
			jobs, _ := runtimeRead[runtimeJob](r.s.db, "runtime_jobs")
			if len(jobs) != 2 || e.launches != 0 {
				t.Fatal("partial/race work admitted", len(jobs), e.launches)
			}
		})
	}
}
func TestRuntimeControllerRetryAncestryRefusesUnknownCyclesAndEnvelopeGaps(t *testing.T) {
	for _, change := range []string{"unknown-job", "missing-envelope", "cycle", "oversized", "indexed-status", "generation-gap", "root", "media", "port", "unrelated-reservation"} {
		t.Run(change, func(t *testing.T) {
			r, e := controllerRig(t)
			old, parent, second := controllerTwiceFailedInstall(t, r, e)
			record, _ := runtimeGet[runtimePlanRecord](r.s.db, "runtime_plans", parent.ID)
			switch change {
			case "unknown-job":
				r.s.db.Exec(`DELETE FROM runtime_jobs WHERE plan_id=?`, old.ID)
			case "missing-envelope":
				record.RetryBinding = nil
				runtimePut(r.s.db, context.Background(), "runtime_plans", parent.ID, record)
			case "cycle":
				record.RetryBinding.Plan.RetryOfPlanID = parent.ID
				record.RetryBinding.Plan.RetryOfJobID = second.ID
				runtimePut(r.s.db, context.Background(), "runtime_plans", parent.ID, record)
			case "oversized":
				record.RetryBinding.Ancestors = make([]runtimeRetryAncestor, runtimeMaxRetryAncestors)
				runtimePut(r.s.db, context.Background(), "runtime_plans", parent.ID, record)
			case "indexed-status":
				r.s.db.Exec(`UPDATE runtime_jobs SET status='needs_attention' WHERE plan_id=?`, old.ID)
			case "generation-gap":
				r.s.db.Exec(`DELETE FROM runtime_generations WHERE id=?`, old.GenerationID)
			case "root", "media", "port", "unrelated-reservation":
				g, _ := runtimeGet[RuntimeGeneration](r.s.db, "runtime_generations", old.GenerationID)
				if change == "root" {
					g.RootPath = filepath.Join(g.RootPath, "changed")
				}
				if change == "media" {
					g.MediaPath = filepath.Join(g.RootPath, "media")
					g.MediaRootPath = g.RootPath
					g.MediaStorageIdentity = "changed"
				}
				if change == "port" {
					g.HostPort++
				}
				if change == "unrelated-reservation" {
					g.ID = randomID()
					g.InstanceID = randomID()
					g.DataPath = filepath.Join(g.RootPath, "unrelated-retained")
					g.State = "stopped"
				}
				runtimePut(r.s.db, context.Background(), "runtime_generations", g.ID, g)
			}
			code, _ := r.call("POST", "/api/store/v2/jobs/"+second.ID+"/retry-plan", `{}`, "127.0.0.1:1")
			if code != 409 {
				t.Fatal("uncertain ancestry admitted", code)
			}
			if e.launches != 2 {
				t.Fatal("ancestry check executed resources")
			}
		})
	}
}

func TestRuntimeControllerRetryNeverCreatedAncestorPathRemainsReserved(t *testing.T) {
	r, _ := controllerRig(t)
	old := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"never-created-ancestor","hostPort":32560}`)
	first := controllerFailedReview(t, r, old, "failed")
	old.ExpiresAt = time.Now().Add(-time.Minute)
	runtimePut(r.s.db, context.Background(), "runtime_plans", old.ID, old)
	parent := controllerRetry(t, r, first)
	if done := controllerWait(t, r, controllerSubmit(t, r, parent, "never-created-success").ID); done.Status != "succeeded" {
		t.Fatal(done)
	}
	code, out := r.call("POST", "/api/store/v2/plans", `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"never-created-ancestor","hostPort":32561}`, "127.0.0.1:1")
	if code != 409 {
		t.Fatal("expired proven-never-created ancestor path released", code, out)
	}
}
