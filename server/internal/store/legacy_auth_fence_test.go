package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Local fixtures only. Engine methods never call Docker, SSH or external HTTP.
type legacyFenceGate struct {
	entered, release chan struct{}
	once             atomic.Bool
}

func (g *legacyFenceGate) wait() {
	if g.once.CompareAndSwap(false, true) {
		close(g.entered)
		<-g.release
	}
}
func legacyFenceNewGate() *legacyFenceGate {
	return &legacyFenceGate{entered: make(chan struct{}), release: make(chan struct{})}
}
func legacyFenceEntered(t *testing.T, g *legacyFenceGate) {
	t.Helper()
	select {
	case <-g.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("fixture gate not reached")
	}
}
func legacyFenceRevoke(t *testing.T, r *testRig, how string) {
	t.Helper()
	if how == "logout" {
		if status, _ := r.call("POST", "/api/store/logout", "", "127.0.0.1:1"); status != 200 {
			t.Fatalf("logout status=%d", status)
		}
	} else if _, err := r.s.db.Exec(`UPDATE sessions SET expires_at=?`, time.Now().Add(-time.Minute).Unix()); err != nil {
		t.Fatal(err)
	}
}
func legacyFenceRequest(r *testRig, method, path, body string) (*httptest.ResponseRecorder, chan struct{}) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Store-Session", r.token)
	req.RemoteAddr = "127.0.0.1:1"
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); r.mux.ServeHTTP(w, req) }()
	return w, done
}

type legacyFenceStorageGate struct {
	*fakeEngine
	gate *legacyFenceGate
}

func (e *legacyFenceStorageGate) InspectStorage(ctx context.Context, p string) (StorageCandidate, error) {
	e.gate.wait()
	return e.fakeEngine.InspectStorage(ctx, p)
}

type legacyFenceInspectGate struct {
	*fakeEngine
	gate *legacyFenceGate
}

func (e *legacyFenceInspectGate) Inspect(ctx context.Context, name string) (Container, error) {
	e.gate.wait()
	return e.fakeEngine.Inspect(ctx, name)
}

type legacyFenceProbeGate struct {
	*retryEngine
	gate *legacyFenceGate
}

func (e *legacyFenceProbeGate) Probe(context.Context) error { e.gate.wait(); return nil }

type legacyFenceDiscoveryGate struct {
	*fakeEngine
	gate *legacyFenceGate
}

func (e *legacyFenceDiscoveryGate) DiscoverStorage(ctx context.Context) ([]StorageCandidate, error) {
	e.gate.wait()
	return e.fakeEngine.DiscoverStorage(ctx)
}

func TestLegacyFenceOrdinaryRootCannotCommitAfterRevocation(t *testing.T) {
	for _, how := range []string{"logout", "expiry"} {
		t.Run(how, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			root := filepath.Join(filepath.Dir(r.root), "new-root")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			g := legacyFenceNewGate()
			r.s.engine = &legacyFenceStorageGate{r.e, g}
			body, _ := json.Marshal(map[string]string{"path": root, "name": "Synthetic"})
			w, done := legacyFenceRequest(r, "POST", "/api/store/roots", string(body))
			legacyFenceEntered(t, g)
			legacyFenceRevoke(t, r, how)
			close(g.release)
			<-done
			var count int
			if err := r.s.db.QueryRow(`SELECT count(*) FROM storage_roots WHERE path=?`, root).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if w.Code != 401 || count != 0 {
				t.Errorf("revoked root request status=%d persisted_rows=%d; want 401 and 0", w.Code, count)
			}
		})
	}
}

func TestLegacyFenceOrdinaryControlsCannotMutateAfterRevocation(t *testing.T) {
	for _, action := range []string{"start", "stop"} {
		for _, how := range []string{"logout", "expiry"} {
			t.Run(action+"/"+how, func(t *testing.T) {
				r := newRig(t)
				r.setup()
				p := r.plan("uptime-kuma", "control", "")
				job := r.install(p, "fixture-install")
				if j := r.waitJob(job["id"].(string)); j["status"] != "completed" {
					t.Fatal("fixture install not completed")
				}
				i, err := r.s.readInstance(p["instanceId"].(string))
				if err != nil {
					t.Fatal(err)
				}
				if action == "start" {
					r.e.mu.Lock()
					c := r.e.containers[i.ContainerName]
					c.State = "exited"
					r.e.containers[i.ContainerName] = c
					r.e.mu.Unlock()
					i.State = "exited"
					if err := r.s.saveInstance(i); err != nil {
						t.Fatal(err)
					}
				}
				g := legacyFenceNewGate()
				r.s.engine = &legacyFenceInspectGate{r.e, g}
				w, done := legacyFenceRequest(r, "POST", "/api/store/instances/"+i.ID+"/"+action, "")
				legacyFenceEntered(t, g)
				legacyFenceRevoke(t, r, how)
				close(g.release)
				<-done
				r.e.mu.Lock()
				calls := r.e.stops
				if action == "start" {
					calls = r.e.starts
				}
				r.e.mu.Unlock()
				if w.Code != 401 || calls != 0 {
					t.Errorf("revoked %s request status=%d engine_mutations=%d; want 401 and 0", action, w.Code, calls)
				}
			})
		}
	}
}

func TestLegacyFenceOrdinaryRetryPlanCannotCommitAfterRevocation(t *testing.T) {
	for _, how := range []string{"logout", "expiry"} {
		t.Run(how, func(t *testing.T) {
			r, e, _, prior := failedRetryRig(t, false)
			var before, after int
			if err := r.s.db.QueryRow(`SELECT count(*) FROM plans`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			g := legacyFenceNewGate()
			r.s.engine = &legacyFenceProbeGate{e, g}
			w, done := legacyFenceRequest(r, "POST", "/api/store/instances/"+prior.InstanceID+"/retry-plan", "{}")
			legacyFenceEntered(t, g)
			legacyFenceRevoke(t, r, how)
			close(g.release)
			<-done
			if err := r.s.db.QueryRow(`SELECT count(*) FROM plans`).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if w.Code != 401 || before != after {
				t.Errorf("revoked retry-plan status=%d added_plans=%d; want 401 and 0", w.Code, after-before)
			}
		})
	}
}

func TestLegacyFenceOrdinaryStorageReadCannotReturnAfterRevocation(t *testing.T) {
	r := newRig(t)
	r.setup()
	g := legacyFenceNewGate()
	r.s.engine = &legacyFenceDiscoveryGate{r.e, g}
	w, done := legacyFenceRequest(r, "GET", "/api/store/storage", "")
	legacyFenceEntered(t, g)
	legacyFenceRevoke(t, r, "logout")
	close(g.release)
	<-done
	if w.Code != 401 {
		t.Errorf("revoked storage read status=%d private_result=%t; want 401", w.Code, strings.Contains(w.Body.String(), "dockerStorage"))
	}
}

func TestLegacyFenceLegacyPlanFinalSQLFenceStillRefusesRevocation(t *testing.T) {
	r := newRig(t)
	r.setup()
	e := &retryEngine{fakeEngine: r.e}
	g := legacyFenceNewGate()
	r.s.engine = &legacyFenceProbeGate{e, g}
	w, done := legacyFenceRequest(r, "POST", "/api/store/plans", `{"appId":"uptime-kuma","rootId":"storage","directory":"fresh","hostPort":32401}`)
	legacyFenceEntered(t, g)
	legacyFenceRevoke(t, r, "logout")
	close(g.release)
	<-done
	if w.Code != 401 {
		t.Errorf("legacy plan expected final SQL auth fence, got %d", w.Code)
	}
}

func TestLegacyFenceSourceRetryEngineProofDoesNotHoldSQLiteConnection(t *testing.T) {
	r, e, _, prior := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, prior.InstanceID)
	g := legacyFenceNewGate()
	r.s.engine = &legacyFenceProbeGate{e, g}
	// Keep the worker out so this is exactly the synchronous admission proof.
	r.s.operation.Lock()
	defer r.s.operation.Unlock()
	body, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": "source-sql-boundary"})
	w, done := legacyFenceRequest(r, "POST", "/api/store/install", string(body))
	legacyFenceEntered(t, g)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	var n int
	err := r.s.db.QueryRowContext(ctx, `SELECT count(*) FROM sessions`).Scan(&n)
	cancel()
	close(g.release)
	<-done
	if errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("source retry engine proof holds sole SQLite connection; metadata query timed out; admission status=%d", w.Code)
	} else if err != nil {
		t.Fatal(err)
	}
}

type legacyFenceBodyGate struct {
	reader *strings.Reader
	gate   *legacyFenceGate
}

func (b *legacyFenceBodyGate) Read(p []byte) (int, error) { b.gate.wait(); return b.reader.Read(p) }
func TestLegacyFenceLegacyInstallReplayRefusesBodyWaitRevocation(t *testing.T) {
	for _, replay := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh", true: "idempotent-replay"}[replay], func(t *testing.T) {
			r := newRig(t)
			r.setup()
			p := r.plan("uptime-kuma", "admission", "")
			if replay {
				j := r.install(p, "original-request")
				r.waitJob(j["id"].(string))
			}
			body, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": "original-request"})
			g := legacyFenceNewGate()
			req := httptest.NewRequest("POST", "/api/store/install", &legacyFenceBodyGate{strings.NewReader(string(body)), g})
			req.RemoteAddr = "127.0.0.1:1"
			req.Header.Set("X-Store-Session", r.token)
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { defer close(done); r.mux.ServeHTTP(w, req) }()
			legacyFenceEntered(t, g)
			legacyFenceRevoke(t, r, "logout")
			close(g.release)
			<-done
			if w.Code != 401 {
				t.Errorf("revoked install replay=%t status=%d; want 401", replay, w.Code)
			}
		})
	}
}

type legacyFenceGenerationGate struct {
	*controllerEngine
	gate *legacyFenceGate
}

func (e *legacyFenceGenerationGate) InspectGeneration(ctx context.Context, g RuntimeGeneration) (RuntimeGeneration, error) {
	e.gate.wait()
	return e.controllerEngine.InspectGeneration(ctx, g)
}
func TestLegacyFenceReconcilePreservesConcurrentIgnoredVersion(t *testing.T) {
	r, e := controllerRig(t)
	p := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","targetVersion":"2.5.5","rootId":"storage","directory":"ignore-race","hostPort":32501}`)
	if j := controllerWait(t, r, controllerSubmit(t, r, p, "ignore-race").ID); j.Status != "succeeded" {
		t.Fatal("fixture install failed")
	}
	g := legacyFenceNewGate()
	r.s.engine = &legacyFenceGenerationGate{e, g}
	w, done := legacyFenceRequest(r, "POST", "/api/store/v2/instances/reconcile", "")
	legacyFenceEntered(t, g)
	if status, _ := r.call("POST", "/api/store/v2/instances/"+p.InstanceID+"/ignore-update", `{"version":"2.5.6"}`, "127.0.0.1:1"); status != 200 {
		t.Fatalf("ignore status=%d", status)
	}
	close(g.release)
	<-done
	i, err := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", p.InstanceID)
	if err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || i.IgnoredVersion != "2.5.6" {
		t.Errorf("reconcile status=%d ignored_version=%q; successful concurrent ignore was lost", w.Code, i.IgnoredVersion)
	}
}

func TestLegacyFenceNASRoleRevocationStopsIdleSSE(t *testing.T) {
	var revoked atomic.Bool
	var providerChecks atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerChecks.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"username": "nas-admin", "is_master": !revoked.Load()}})
	}))
	defer up.Close()
	r := nasRig(t, up.URL)
	status, out := exchange(r, nil)
	if status != 200 {
		t.Fatalf("exchange status=%d", status)
	}
	r.token = out["data"].(map[string]any)["sessionId"].(string)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", "/api/store/v2/jobs/events", nil).WithContext(ctx)
	req.Header.Set("X-Store-Session", r.token)
	started := make(chan struct{})
	w := &revokeStreamWriter{ResponseRecorder: httptest.NewRecorder(), revoke: func() { revoked.Store(true); close(started) }}
	done := make(chan struct{})
	go func() { defer close(done); r.mux.ServeHTTP(w, req) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("stream did not start")
	}
	select {
	case <-done:
		if !strings.Contains(w.Body.String(), "auth-expired") {
			t.Fatal("stream closed without auth expiry")
		}
	case <-time.After(3200 * time.Millisecond):
		cancel()
		<-done
		t.Errorf("provider role revoked but SSE remained open; provider_checks=%d auth_expired=%t", providerChecks.Load(), strings.Contains(w.Body.String(), "auth-expired"))
	}
}

func TestLegacyFenceLifecyclePreservesConcurrentIgnoredVersion(t *testing.T) {
	for _, scenario := range []string{"stop", "update", "failed-update"} {
		t.Run(scenario, func(t *testing.T) {
			r, e := controllerRig(t)
			install := controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","targetVersion":"2.5.5","rootId":"storage","directory":"ignore-job","hostPort":32502}`)
			if j := controllerWait(t, r, controllerSubmit(t, r, install, "ignore-install").ID); j.Status != "succeeded" {
				t.Fatal("fixture install failed")
			}
			kind := scenario
			if scenario == "failed-update" {
				kind = "update"
				e.failLaunch = true
			}
			body, _ := json.Marshal(map[string]string{"kind": kind, "instanceId": install.InstanceID})
			plan := controllerPlan(t, r, string(body))
			gate := legacyFenceNewGate()
			r.s.engine = &legacyFenceGenerationGate{e, gate}
			job := controllerSubmit(t, r, plan, "ignore-lifecycle")
			legacyFenceEntered(t, gate)
			if status, _ := r.call("POST", "/api/store/v2/instances/"+install.InstanceID+"/ignore-update", `{"version":"2.5.6"}`, "127.0.0.1:1"); status != 200 {
				t.Fatalf("ignore status=%d", status)
			}
			close(gate.release)
			final := controllerWait(t, r, job.ID)
			i, err := runtimeGet[runtimeInstance](r.s.db, "runtime_instances", install.InstanceID)
			if err != nil {
				t.Fatal(err)
			}
			if i.IgnoredVersion != "2.5.6" {
				t.Errorf("%s terminal_status=%s ignored_version=%q; successful concurrent ignore was lost", scenario, final.Status, i.IgnoredVersion)
			}
		})
	}
}

func TestLegacyFenceSourceProofBindsSQLInputsAfterEngineWait(t *testing.T) {
	for _, changed := range []string{"root", "reviewed-plan", "failed-job"} {
		t.Run(changed, func(t *testing.T) {
			r, e, _, prior := failedRetryRig(t, false)
			plan := sourceRetryPlan(t, r, prior.InstanceID)
			r.s.operation.Lock()
			defer r.s.operation.Unlock()
			r.s.engine = &sourceInspectRace{retryEngine: e, mutate: func() {
				var table, id string
				var value any
				switch changed {
				case "root":
					root, err := r.s.root("storage")
					if err != nil {
						t.Fatal(err)
					}
					root.Roles = []string{"mediaReadOnly"}
					table, id, value = "storage_roots", root.ID, root
				case "reviewed-plan":
					current, err := r.s.readPlan(plan["id"].(string))
					if err != nil {
						t.Fatal(err)
					}
					current.AccessURL = "http://127.0.0.1:32999/"
					table, id, value = "plans", current.ID, current
				case "failed-job":
					current, err := retrySource(r.s.db, prior.InstanceID)
					if err != nil {
						t.Fatal(err)
					}
					current.Error = "synthetic changed failure evidence"
					table, id, value = "jobs", current.ID, current
				}
				body, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = r.s.db.Exec("UPDATE "+table+" SET body=? WHERE id=?", string(body), id); err != nil {
					t.Fatal(err)
				}
			}}
			body, _ := json.Marshal(map[string]any{"planId": plan["id"], "requestId": "changed-sql-proof"})
			status, _ := retryRequest(r, "/api/store/install", string(body))
			jobs, err := r.s.readJobs()
			if err != nil {
				t.Fatal(err)
			}
			if status != 409 || len(jobs) != 1 {
				t.Fatalf("%s changed during proof: status=%d jobs=%d; want 409 and original job only", changed, status, len(jobs))
			}
		})
	}
}
