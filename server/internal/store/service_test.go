package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeEngine struct {
	mu            sync.Mutex
	containers    map[string]Container
	runs          []RunSpec
	failPull      bool
	starts, stops int
}

func openTestDB(dir string) (*sql.DB, error) {
	return sql.Open("sqlite", filepath.Join(dir, "store.sqlite"))
}

func (f *fakeEngine) Probe(context.Context) error { return nil }
func (f *fakeEngine) ValidatePath(_ context.Context, root, p string, fresh bool) error {
	return validateLocalPath(root, p, fresh)
}
func (f *fakeEngine) Prepare(_ context.Context, root, p string) error {
	if err := validateLocalPath(root, p, true); err != nil {
		return err
	}
	return os.Mkdir(p, 0700)
}
func (f *fakeEngine) PortAvailable(context.Context, int) error { return nil }
func (f *fakeEngine) Pull(context.Context, string) error {
	if f.failPull {
		return errors.New("synthetic pull failure")
	}
	return nil
}
func (f *fakeEngine) Inspect(_ context.Context, n string) (Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.containers[n]
	if !ok {
		return Container{}, ErrNotFound
	}
	return c, nil
}
func (f *fakeEngine) Run(_ context.Context, r RunSpec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.containers[r.Name]; ok {
		return errors.New("already exists")
	}
	f.runs = append(f.runs, r)
	f.containers[r.Name] = Container{ID: "cid-" + r.Name, Name: r.Name, Labels: r.Labels, State: "running", Image: r.Image, Mounts: r.Mounts, Ports: []PortBinding{{HostIP: r.PublishHost, HostPort: r.HostPort, ContainerPort: r.ContainerPort, Protocol: "tcp"}}}
	return nil
}
func (f *fakeEngine) Health(context.Context, string, int, string) (string, error) {
	return "healthy", nil
}
func (f *fakeEngine) Start(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts++
	for n, c := range f.containers {
		if c.ID == id {
			c.State = "running"
			f.containers[n] = c
		}
	}
	return nil
}
func (f *fakeEngine) Stop(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops++
	for n, c := range f.containers {
		if c.ID == id {
			c.State = "exited"
			f.containers[n] = c
		}
	}
	return nil
}

type testRig struct {
	t           *testing.T
	s           *Service
	mux         *http.ServeMux
	e           *fakeEngine
	root, token string
	opts        Options
}

func newRig(t *testing.T) *testRig {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "storage")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	e := &fakeEngine{containers: map[string]Container{}}
	opts := Options{DataDir: filepath.Join(base, "state"), StorageRoot: root, EngineMode: "local", Engine: e}
	s, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	r := &testRig{t: t, s: s, mux: http.NewServeMux(), e: e, root: root, opts: opts}
	s.Register(r.mux)
	t.Cleanup(func() { s.Close() })
	return r
}
func (r *testRig) call(method, path, body, remote string) (int, map[string]any) {
	r.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = remote
	if r.token != "" {
		req.Header.Set("X-Store-Session", r.token)
	}
	w := httptest.NewRecorder()
	r.mux.ServeHTTP(w, req)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		r.t.Fatalf("bad response %s", w.Body.String())
	}
	return w.Code, out
}
func (r *testRig) setup() {
	r.t.Helper()
	status, out := r.call("POST", "/api/store/setup", `{"username":"synthetic-admin","password":"synthetic-pass-123"}`, "127.0.0.1:1234")
	if status != 201 {
		r.t.Fatalf("setup %d: %v", status, out)
	}
	r.token = out["data"].(map[string]any)["sessionId"].(string)
}
func (r *testRig) plan(app, dir, media string) map[string]any {
	r.t.Helper()
	input := map[string]any{"appId": app, "rootId": "storage", "directory": dir, "hostPort": 32123, "mediaPath": media}
	if media != "" {
		input["mediaRootId"] = "storage"
	}
	b, _ := json.Marshal(input)
	status, out := r.call("POST", "/api/store/plans", string(b), "127.0.0.1:1")
	if status != 201 {
		r.t.Fatalf("plan %d %v", status, out)
	}
	return out["data"].(map[string]any)
}
func (r *testRig) install(p map[string]any, request string) map[string]any {
	r.t.Helper()
	b, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": request})
	status, out := r.call("POST", "/api/store/install", string(b), "127.0.0.1:1")
	if status != 202 {
		r.t.Fatalf("install %d %v", status, out)
	}
	return out["data"].(map[string]any)
}
func (r *testRig) waitJob(id string) map[string]any {
	r.t.Helper()
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		_, out := r.call("GET", "/api/store/jobs", "", "127.0.0.1:1")
		for _, v := range out["data"].(map[string]any)["items"].([]any) {
			j := v.(map[string]any)
			if j["id"] == id && (j["status"] == "completed" || j["status"] == "failed" || j["status"] == "needs_attention") {
				return j
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	r.t.Fatal("job timeout")
	return nil
}

func TestAuthenticationAndSetupLoopback(t *testing.T) {
	r := newRig(t)
	for _, p := range []string{"roots", "instances", "jobs"} {
		status, _ := r.call("GET", "/api/store/"+p, "", "127.0.0.1:1")
		if status != 401 {
			t.Fatalf("%s status %d", p, status)
		}
	}
	status, _ := r.call("POST", "/api/store/setup", `{"username":"synthetic-admin","password":"synthetic-pass-123"}`, "192.0.2.1:12")
	if status != 403 {
		t.Fatal(status)
	}
	r.setup()
	status, _ = r.call("POST", "/api/store/setup", `{"username":"new","password":"synthetic-pass-123"}`, "127.0.0.1:1")
	if status != 409 {
		t.Fatal(status)
	}
	r.token = ""
	status, out := r.call("POST", "/api/store/login", `{"username":"synthetic-admin","password":"synthetic-pass-123"}`, "192.0.2.1:1")
	if status != 200 {
		t.Fatal(status, out)
	}
	if out["data"].(map[string]any)["sessionId"] == "" {
		t.Fatal("missing token")
	}
	var hash string
	if err := r.s.db.QueryRow("SELECT password_hash FROM admin WHERE id=1").Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(hash, "synthetic-pass") {
		t.Fatal("plaintext password")
	}
}

func TestPlansRejectEscapesSymlinksAndExistingDirectories(t *testing.T) {
	r := newRig(t)
	r.setup()
	if err := os.Mkdir(filepath.Join(r.root, "occupied"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.root, "occupied", "keep"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(r.root, "link")); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"../escape", "/tmp/escape", "link", "occupied", "a/b"} {
		b, _ := json.Marshal(map[string]any{"appId": "uptime-kuma", "rootId": "storage", "directory": dir, "hostPort": 32123})
		status, _ := r.call("POST", "/api/store/plans", string(b), "127.0.0.1:1")
		if status < 400 {
			t.Fatalf("accepted %s", dir)
		}
	}
}

func TestInstallIsIdempotentPersistentAndStopKeepsData(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := r.plan("uptime-kuma", "new-kuma", "")
	job := r.install(p, "synthetic-request-1")
	same := r.install(p, "synthetic-request-1")
	if job["id"] != same["id"] {
		t.Fatal("duplicate job")
	}
	done := r.waitJob(job["id"].(string))
	if done["status"] != "completed" {
		t.Fatal(done)
	}
	r.e.mu.Lock()
	if len(r.e.runs) != 1 {
		t.Fatal(r.e.runs)
	}
	r.e.mu.Unlock()
	_, out := r.call("GET", "/api/store/instances", "", "127.0.0.1:1")
	i := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if i["initialization"] != "pending" {
		t.Fatal(i)
	}
	native := i["nativeIntegration"].(map[string]any)
	if native["status"] != "handoff" || native["appUrl"] == "" || native["configUrl"] != "" {
		t.Fatal(native)
	}
	status, out := r.call("POST", "/api/store/instances/"+i["id"].(string)+"/stop", "{}", "127.0.0.1:1")
	if status != 200 {
		t.Fatal(status, out)
	}
	if out["data"].(map[string]any)["state"] != "exited" {
		t.Fatal("stop did not confirm engine state", out)
	}
	if _, err := os.Stat(filepath.Join(r.root, "new-kuma")); err != nil {
		t.Fatal("data removed", err)
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
	same = r.install(p, "synthetic-request-1")
	if same["id"] != job["id"] {
		t.Fatal("not durable")
	}
}

func TestPullFailurePreservesNewDirectoryAndStageHistory(t *testing.T) {
	r := newRig(t)
	r.e.failPull = true
	r.setup()
	p := r.plan("uptime-kuma", "failed-kuma", "")
	j := r.install(p, "synthetic-fail")
	done := r.waitJob(j["id"].(string))
	if done["status"] != "failed" {
		t.Fatal(done)
	}
	if _, err := os.Stat(filepath.Join(r.root, "failed-kuma")); err != nil {
		t.Fatal("failure removed data", err)
	}
	if done["stage"] != "pull" {
		t.Fatal(done)
	}
	if len(done["stages"].([]any)) < 2 {
		t.Fatal("missing stage history")
	}
	r.e.mu.Lock()
	defer r.e.mu.Unlock()
	if len(r.e.runs) != 0 {
		t.Fatal("ran after failed pull")
	}
}

func TestForeignContainerCannotBeMutated(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := r.plan("uptime-kuma", "ours", "")
	j := r.install(p, "synthetic-owned")
	if r.waitJob(j["id"].(string))["status"] != "completed" {
		t.Fatal("install failed")
	}
	_, out := r.call("GET", "/api/store/instances", "", "127.0.0.1:1")
	i := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	r.e.mu.Lock()
	c := r.e.containers[i["containerName"].(string)]
	c.Labels = map[string]string{}
	r.e.containers[i["containerName"].(string)] = c
	r.e.mu.Unlock()
	for _, action := range []string{"start", "stop"} {
		status, _ := r.call("POST", "/api/store/instances/"+i["id"].(string)+"/"+action, "{}", "127.0.0.1:1")
		if status != 409 {
			t.Fatal(status)
		}
	}
	if r.e.starts+r.e.stops != 0 {
		t.Fatal("mutated foreign container")
	}
}

func TestMediaMountIsReadOnlyAndNotDataPath(t *testing.T) {
	r := newRig(t)
	r.setup()
	media := filepath.Join(r.root, "music")
	os.Mkdir(media, 0700)
	os.WriteFile(filepath.Join(media, "keep.mp3"), []byte("keep"), 0600)
	p := r.plan("navidrome", "nav-new", media)
	j := r.install(p, "synthetic-music")
	if r.waitJob(j["id"].(string))["status"] != "completed" {
		t.Fatal("job failed")
	}
	r.e.mu.Lock()
	defer r.e.mu.Unlock()
	found := false
	for _, m := range r.e.runs[0].Mounts {
		if m.Target == "/music" {
			found = true
			if !m.ReadOnly || m.Source != media {
				t.Fatal(m)
			}
		}
	}
	if !found {
		t.Fatal("missing media mount")
	}
	b, err := os.ReadFile(filepath.Join(media, "keep.mp3"))
	if err != nil || string(b) != "keep" {
		t.Fatal("media changed")
	}
}

func TestExistingBroadStateDirectoryIsNeverChmodded(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(base, "user-owned")
	if err = os.Mkdir(state, 0755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "storage")
	os.Mkdir(root, 0700)
	s, err := New(Options{DataDir: state, StorageRoot: root, EngineMode: "disabled"})
	if err == nil {
		s.Close()
		t.Fatal("accepted broad existing data directory")
	}
	fi, err := os.Stat(state)
	if err != nil || fi.Mode().Perm() != 0755 {
		t.Fatal("changed user directory permissions")
	}
	entries, _ := os.ReadDir(state)
	if len(entries) != 0 {
		t.Fatal("populated rejected directory")
	}
}

func TestSetupRejectsForeignBrowserOrigin(t *testing.T) {
	r := newRig(t)
	req := httptest.NewRequest("POST", "http://localhost/api/store/setup", strings.NewReader(`{"username":"synthetic-admin","password":"synthetic-pass-123"}`))
	req.RemoteAddr = "127.0.0.1:1"
	req.Header.Set("Origin", "https://malicious.example")
	w := httptest.NewRecorder()
	r.mux.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatal(w.Code, "foreign browser origin configured administrator")
	}
}

func TestPlanCannotBeModifiedByInstallBody(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := r.plan("uptime-kuma", "immutable", "")
	b, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": "synthetic-plan-mutation", "image": "attacker/image", "dataPath": "/tmp/foreign"})
	status, _ := r.call("POST", "/api/store/install", string(b), "127.0.0.1:1")
	if status != 400 {
		t.Fatal(status)
	}
}

func TestQueuedJobsResumeAndRunningJobsRequireAttention(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := r.plan("uptime-kuma", "resume", "")
	r.s.Close()
	db, err := openTestDB(r.opts.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for _, status := range []string{"queued", "running"} {
		j := Job{ID: "recover-" + status, PlanID: p["id"].(string) + status, RequestID: "request-" + status, InstanceID: "instance-" + status, Status: status, Stage: "pull", Stages: []Stage{}, CreatedAt: now, UpdatedAt: now}
		if status == "queued" {
			j.PlanID = p["id"].(string)
			j.InstanceID = p["instanceId"].(string)
			i := Instance{ID: j.InstanceID, AppID: "uptime-kuma", DataPath: p["dataPath"].(string), HostPort: 32123, ContainerName: p["containerName"].(string), Image: p["image"].(string), Mounts: []Mount{{Source: p["dataPath"].(string), Target: "/app/data"}}, State: "queued", CreatedAt: now}
			i.PublishHost = p["publishHost"].(string)
			i.ContainerPort = int(p["containerPort"].(float64))
			i.RootPath = p["rootPath"].(string)
			b, _ := json.Marshal(i)
			if _, err = db.Exec(`INSERT INTO instances(id,data_path,port,body)VALUES(?,?,?,?)`, i.ID, i.DataPath, i.HostPort, string(b)); err != nil {
				t.Fatal(err)
			}
		}
		b, _ := json.Marshal(j)
		if _, err = db.Exec(`INSERT INTO jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)`, j.ID, j.PlanID, j.RequestID, j.Status, string(b)); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	s, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r.s = s
	r.mux = http.NewServeMux()
	s.Register(r.mux)
	if j := r.waitJob("recover-running"); j["status"] != "needs_attention" {
		t.Fatal(j)
	}
	if j := r.waitJob("recover-queued"); j["status"] != "completed" {
		t.Fatal(j)
	}
	if len(r.e.runs) != 1 {
		t.Fatal("running job retried")
	}
}

func TestStaleQueuedSnapshotCannotRunCompletedJobAgain(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := r.plan("uptime-kuma", "claim-once", "")
	out := r.install(p, "synthetic-claim")
	r.waitJob(out["id"].(string))
	var stale Job
	b, _ := json.Marshal(out)
	if err := json.Unmarshal(b, &stale); err != nil {
		t.Fatal(err)
	}
	stale.Status = "queued"
	r.s.execute(stale)
	j := r.waitJob(stale.ID)
	if j["status"] != "completed" {
		t.Fatal("stale queued snapshot corrupted completed job", j)
	}
	if len(r.e.runs) != 1 {
		t.Fatal("duplicate run")
	}
}
