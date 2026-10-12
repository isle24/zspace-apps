package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type retryEngine struct {
	*fakeEngine
	pullFailure   atomic.Bool
	healthFailure atomic.Bool
	pulls         atomic.Int32
}

func (e *retryEngine) Pull(context.Context, string) error {
	e.pulls.Add(1)
	if e.pullFailure.Load() {
		return errors.New("retry fixture pull failure")
	}
	return nil
}
func (e *retryEngine) Health(context.Context, string, int, string) (string, error) {
	if e.healthFailure.Load() {
		return "unhealthy", errors.New("retry fixture health failure")
	}
	return "healthy", nil
}
func retryRequest(r *testRig, path, body string) (int, map[string]any) {
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("X-Store-Session", r.token)
	req.RemoteAddr = "127.0.0.1:1"
	w := httptest.NewRecorder()
	r.mux.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}
func failedRetryRig(t *testing.T, health bool) (*testRig, *retryEngine, map[string]any, Job) {
	t.Helper()
	r := newRig(t)
	r.setup()
	e := &retryEngine{fakeEngine: r.e}
	e.pullFailure.Store(!health)
	e.healthFailure.Store(health)
	r.s.engine = e
	p := r.plan("uptime-kuma", "retained", "")
	j := r.install(p, "first-attempt")
	r.waitJob(j["id"].(string))
	jobs, err := r.s.readJobs()
	if err != nil {
		t.Fatal(err)
	}
	return r, e, p, jobs[0]
}
func retryPlan(t *testing.T, r *testRig, id string) map[string]any {
	t.Helper()
	status, out := retryRequest(r, "/api/store/instances/"+id+"/retry-plan", "{}")
	if status != 201 {
		t.Fatalf("retry plan status=%d response=%v", status, out)
	}
	return out["data"].(map[string]any)
}
func TestRetryRetainsExpiredAcceptedScopeAndSentinel(t *testing.T) {
	r, e, old, first := failedRetryRig(t, false)
	p, err := r.s.readPlan(first.PlanID)
	if err != nil {
		t.Fatal(err)
	}
	p.ExpiresAt = time.Now().Add(-time.Hour)
	b, _ := json.Marshal(p)
	if _, err = r.s.db.Exec("UPDATE plans SET body=? WHERE id=?", string(b), p.ID); err != nil {
		t.Fatal(err)
	}
	i, _ := r.s.readInstance(first.InstanceID)
	sentinel := filepath.Join(i.DataPath, "application.db")
	if err = os.WriteFile(sentinel, []byte("retained-user-data"), 0600); err != nil {
		t.Fatal(err)
	}
	// A catalog change must never silently upgrade the accepted material scope.
	for n := range r.s.apps {
		r.s.apps[n].Image = "unreviewed:upgrade"
	}
	retry := retryPlan(t, r, first.InstanceID)
	if retry["id"] == old["id"] || retry["instanceId"] != first.InstanceID || retry["retryOfPlanId"] != first.PlanID || retry["retryOfJobId"] != first.ID {
		t.Fatal("retry linkage or identity changed", retry)
	}
	clone, _ := r.s.readPlan(retry["id"].(string))
	clone.ID = p.ID
	clone.ExpiresAt = p.ExpiresAt
	// Ignore only server retry linkage; every accepted material field is preserved.
	cloneJSON, _ := json.Marshal(clone)
	var got, want map[string]any
	_ = json.Unmarshal(cloneJSON, &got)
	pb, _ := json.Marshal(p)
	_ = json.Unmarshal(pb, &want)
	delete(got, "retryOfPlanId")
	delete(got, "retryOfJobId")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("material scope changed got=%v want=%v", got, want)
	}
	e.pullFailure.Store(false)
	job := r.install(retry, "retry-same-data")
	final := r.waitJob(job["id"].(string))
	if final["status"] != "completed" {
		t.Fatal(final)
	}
	after, _ := r.s.readInstance(i.ID)
	if after.ID != i.ID || after.Provenance != i.Provenance || !after.CreatedAt.Equal(i.CreatedAt) {
		t.Fatal("instance replaced", after)
	}
	data, err := os.ReadFile(sentinel)
	if err != nil || string(data) != "retained-user-data" {
		t.Fatal("sentinel lost", err)
	}
	original, _ := r.s.readPlan(p.ID)
	if !original.ExpiresAt.Equal(p.ExpiresAt) {
		t.Fatal("original expiry changed")
	}
	items, _ := r.s.readInstances()
	jobs, _ := r.s.readJobs()
	if len(items) != 1 || len(jobs) != 2 {
		t.Fatal("records replaced", len(items), len(jobs))
	}
	if !reflect.DeepEqual(first, jobs[1]) {
		t.Fatal("original failed job was overwritten", jobs[1])
	}
}
func TestRetrySubmissionIdempotentConcurrentAndActiveGuard(t *testing.T) {
	r, _, _, first := failedRetryRig(t, false)
	p := retryPlan(t, r, first.InstanceID)
	other := retryPlan(t, r, first.InstanceID)
	// Stop the worker so queued reservations are deterministic while handlers race.
	r.s.cancel()
	r.s.wg.Wait()
	body, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": "concurrent-retry"})
	var wg sync.WaitGroup
	results := make(chan map[string]any, 12)
	for n := 0; n < 12; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, out := retryRequest(r, "/api/store/install", string(body))
			if status != 202 {
				t.Errorf("duplicate status %d %v", status, out)
				return
			}
			results <- out["data"].(map[string]any)
		}()
	}
	wg.Wait()
	close(results)
	id := ""
	for j := range results {
		if id != "" && j["id"] != id {
			t.Fatal("duplicate jobs")
		}
		id = j["id"].(string)
	}
	otherBody, _ := json.Marshal(map[string]any{"planId": other["id"], "requestId": "second-retry"})
	status, out := retryRequest(r, "/api/store/install", string(otherBody))
	if status != 409 {
		t.Fatal("active accepted", status, out)
	}
	status, _ = retryRequest(r, "/api/store/instances/"+first.InstanceID+"/retry-plan", "{}")
	if status != 409 {
		t.Fatal("active retry plan accepted", status)
	}
	jobs, _ := r.s.readJobs()
	if len(jobs) != 2 {
		t.Fatal("duplicate jobs", len(jobs))
	}
}
func TestRetryRejectsChangedOwnershipAndVolumes(t *testing.T) {
	for _, kind := range []string{"marker", "directory", "volume", "docker-cache", "foreign-container", "recorded-id", "uncertain-mount"} {
		t.Run(kind, func(t *testing.T) {
			r, e, _, first := failedRetryRig(t, false)
			i, _ := r.s.readInstance(first.InstanceID)
			switch kind {
			case "marker":
				if err := os.WriteFile(filepath.Join(i.DataPath, ownershipMarker), []byte("foreign"), 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Rename(i.DataPath, i.DataPath+"-original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(i.DataPath, 0700); err != nil {
					t.Fatal(err)
				}
			case "volume":
				root, _ := r.s.root("storage")
				root.Storage.Identity = "different-volume"
				b, _ := json.Marshal(root)
				_, _ = r.s.db.Exec("UPDATE storage_roots SET body=? WHERE id=?", string(b), root.ID)
			case "docker-cache":
				p, _ := r.s.readPlan(first.PlanID)
				p.DockerStorageIdentity = "different-cache"
				b, _ := json.Marshal(p)
				_, _ = r.s.db.Exec("UPDATE plans SET body=? WHERE id=?", string(b), p.ID)
			default:
				c := Container{ID: "retained-container", Name: i.ContainerName, Image: i.Image, Labels: map[string]string{"io.spacedesktop.store": r.s.storeID, "io.spacedesktop.instance": i.ID}, Mounts: i.Mounts, Ports: []PortBinding{{HostIP: i.PublishHost, HostPort: i.HostPort, ContainerPort: i.ContainerPort, Protocol: "tcp"}}}
				if kind == "foreign-container" {
					c.Labels["io.spacedesktop.store"] = "foreign"
				}
				if kind == "uncertain-mount" {
					c.Mounts = []Mount{{Source: "/foreign", Target: "/app/data"}}
				}
				if kind == "recorded-id" {
					i.ContainerID = "other-container"
					_ = r.s.saveInstance(i)
				}
				e.mu.Lock()
				e.containers[c.Name] = c
				e.mu.Unlock()
			}
			status, out := retryRequest(r, "/api/store/instances/"+i.ID+"/retry-plan", "{}")
			if status != 409 {
				t.Fatal("unsafe retry accepted", status, out)
			}
			if e.pulls.Load() != 1 {
				t.Fatal("unsafe retry pulled")
			}
			if len(e.runs) != 0 {
				t.Fatal("unsafe retry ran")
			}
		})
	}
}
func TestRetryResumesOwnedContainerWithoutRunOrPull(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "recorded", true: "uncertain-created"}[unknown], func(t *testing.T) {
			r, e, _, first := failedRetryRig(t, true)
			i, _ := r.s.readInstance(first.InstanceID)
			originalID := i.ContainerID
			e.mu.Lock()
			c := e.containers[i.ContainerName]
			c.State = "exited"
			e.containers[i.ContainerName] = c
			e.mu.Unlock()
			if unknown {
				i.ContainerID = ""
				_ = r.s.saveInstance(i)
			}
			p := retryPlan(t, r, i.ID)
			e.healthFailure.Store(false)
			j := r.install(p, "resume-owned")
			final := r.waitJob(j["id"].(string))
			if final["status"] != "completed" {
				t.Fatal(final)
			}
			after, _ := r.s.readInstance(i.ID)
			if after.ContainerID != originalID {
				t.Fatal("container identity changed")
			}
			e.mu.Lock()
			runs, starts := len(e.runs), e.starts
			e.mu.Unlock()
			if runs != 1 || starts != 1 || e.pulls.Load() != 1 {
				t.Fatal("owned recovery recreated or pulled", runs, starts, e.pulls.Load())
			}
		})
	}
}
func TestRetryRevalidatesAfterConfirmationAndRequiresAuthentication(t *testing.T) {
	r, e, _, first := failedRetryRig(t, false)
	p := retryPlan(t, r, first.InstanceID)
	i, _ := r.s.readInstance(first.InstanceID)
	if err := os.WriteFile(filepath.Join(i.DataPath, ownershipMarker), []byte("foreign-after-plan"), 0600); err != nil {
		t.Fatal(err)
	}
	e.pullFailure.Store(false)
	j := r.install(p, "changed-after-plan")
	final := r.waitJob(j["id"].(string))
	if final["status"] != "needs_attention" {
		t.Fatal("unsafe retained path classification", final)
	}
	if e.pulls.Load() != 1 {
		t.Fatal("pulled before ownership verification")
	}
	r.token = ""
	status, _ := retryRequest(r, "/api/store/instances/"+i.ID+"/retry-plan", "{}")
	if status != 401 {
		t.Fatal(status)
	}
}

// Simulate a path replacement immediately after preflight's successful proof.
// Pull must reread ownership rather than rely on the earlier proof.
type retrySwapAfterProofEngine struct {
	*retryEngine
	swap   atomic.Bool
	target string
}

func (e *retrySwapAfterProofEngine) PinDirectory(_ context.Context, root, p, marker string) (PathProvenance, error) {
	return localPin(root, p, marker)
}
func (e *retrySwapAfterProofEngine) VerifyDirectory(_ context.Context, root, p string, pin PathProvenance) error {
	if err := localVerify(root, p, pin); err != nil {
		return err
	}
	if e.swap.CompareAndSwap(true, false) {
		if err := os.Rename(e.target, e.target+"-owned"); err != nil {
			return err
		}
		return os.Mkdir(e.target, 0700)
	}
	return nil
}
func TestRetryRechecksOwnershipImmediatelyBeforePull(t *testing.T) {
	r, e, _, first := failedRetryRig(t, false)
	i, _ := r.s.readInstance(first.InstanceID)
	swap := &retrySwapAfterProofEngine{retryEngine: e, target: i.DataPath}
	r.s.engine = swap
	p := retryPlan(t, r, i.ID)
	swap.swap.Store(true)
	e.pullFailure.Store(false)
	j := r.install(p, "swap-before-pull")
	final := r.waitJob(j["id"].(string))
	if final["status"] != "needs_attention" {
		t.Fatal(final)
	}
	if e.pulls.Load() != 1 {
		t.Fatal("retry pulled after retained directory identity changed")
	}
}
func TestRetryCompetingPlansReserveOneInstance(t *testing.T) {
	r, _, _, first := failedRetryRig(t, false)
	plans := []map[string]any{retryPlan(t, r, first.InstanceID), retryPlan(t, r, first.InstanceID)}
	r.s.cancel()
	r.s.wg.Wait()
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for n, p := range plans {
		wg.Add(1)
		go func(n int, p map[string]any) {
			defer wg.Done()
			b, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": []string{"competing-a", "competing-b"}[n]})
			status, _ := retryRequest(r, "/api/store/install", string(b))
			statuses <- status
		}(n, p)
	}
	wg.Wait()
	close(statuses)
	accepted, conflicts := 0, 0
	for s := range statuses {
		if s == 202 {
			accepted++
		}
		if s == 409 {
			conflicts++
		}
	}
	if accepted != 1 || conflicts != 1 {
		t.Fatal("competing retry plans were not atomically reserved", accepted, conflicts)
	}
}
func TestRetryRejectsMissingProvenanceOrRecordedContainer(t *testing.T) {
	for _, kind := range []string{"no-provenance", "recorded-container-missing"} {
		t.Run(kind, func(t *testing.T) {
			r, _, _, first := failedRetryRig(t, false)
			i, _ := r.s.readInstance(first.InstanceID)
			if kind == "no-provenance" {
				i.Provenance = PathProvenance{}
			} else {
				i.ContainerID = "previous-owned-id"
			}
			_ = r.s.saveInstance(i)
			status, out := retryRequest(r, "/api/store/instances/"+i.ID+"/retry-plan", "{}")
			if status != 409 {
				t.Fatal(status, out)
			}
		})
	}
}
func TestRetryPlanRejectsClientLinkageAndFreshExpiry(t *testing.T) {
	r, _, _, first := failedRetryRig(t, false)
	path := "/api/store/instances/" + first.InstanceID + "/retry-plan"
	status, _ := retryRequest(r, path, `{"retryOfJobId":"forged"}`)
	if status != 400 {
		t.Fatal("client linkage accepted", status)
	}
	p := retryPlan(t, r, first.InstanceID)
	stored, _ := r.s.readPlan(p["id"].(string))
	stored.ExpiresAt = time.Now().Add(-time.Minute)
	b, _ := json.Marshal(stored)
	_, _ = r.s.db.Exec("UPDATE plans SET body=? WHERE id=?", string(b), stored.ID)
	input, _ := json.Marshal(map[string]any{"planId": stored.ID, "requestId": "expired-retry"})
	status, _ = retryRequest(r, "/api/store/install", string(input))
	if status != 409 {
		t.Fatal("expired fresh retry confirmation accepted", status)
	}
}

type retryChangedMediaEngine struct {
	*retryEngine
	mediaRoot string
	changed   atomic.Bool
}

func (e *retryChangedMediaEngine) InspectStorage(ctx context.Context, p string) (StorageCandidate, error) {
	c, err := e.fakeEngine.InspectStorage(ctx, p)
	if p == e.mediaRoot && e.changed.Load() {
		c.Identity = "changed-media-device"
	}
	return c, err
}
func TestRetryRejectsChangedMediaBeforePlanningAndExecution(t *testing.T) {
	for _, afterPlan := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-plan", true: "after-plan"}[afterPlan], func(t *testing.T) {
			r := newRig(t)
			r.setup()
			media := filepath.Join(filepath.Dir(r.root), "media")
			if err := os.Mkdir(media, 0700); err != nil {
				t.Fatal(err)
			}
			base := &retryEngine{fakeEngine: r.e}
			base.pullFailure.Store(true)
			e := &retryChangedMediaEngine{retryEngine: base, mediaRoot: media}
			r.s.engine = e
			c, err := e.InspectStorage(context.Background(), media)
			if err != nil {
				t.Fatal(err)
			}
			root := StorageRoot{ID: "music", Path: media, Name: "music", Storage: c, Roles: []string{"mediaReadOnly"}}
			b, _ := json.Marshal(root)
			if _, err = r.s.db.Exec("INSERT INTO storage_roots(id,path,body)VALUES(?,?,?)", root.ID, root.Path, string(b)); err != nil {
				t.Fatal(err)
			}
			in, _ := json.Marshal(map[string]any{"appId": "navidrome", "rootId": "storage", "directory": "media-retry", "hostPort": 32123, "mediaPath": media, "mediaRootId": "music"})
			status, out := r.call("POST", "/api/store/plans", string(in), "127.0.0.1:1")
			if status != 201 {
				t.Fatal(status, out)
			}
			p := out["data"].(map[string]any)
			job := r.install(p, "media-first")
			r.waitJob(job["id"].(string))
			if afterPlan {
				retry := retryPlan(t, r, p["instanceId"].(string))
				e.changed.Store(true)
				e.pullFailure.Store(false)
				j := r.install(retry, "media-changed-retry")
				final := r.waitJob(j["id"].(string))
				if final["status"] != "needs_attention" {
					t.Fatal(final)
				}
			} else {
				e.changed.Store(true)
				status, out = retryRequest(r, "/api/store/instances/"+p["instanceId"].(string)+"/retry-plan", "{}")
				if status != 409 {
					t.Fatal(status, out)
				}
			}
			if e.pulls.Load() != 1 {
				t.Fatal("unsafe media retry pulled")
			}
			e.mu.Lock()
			runs := len(e.runs)
			e.mu.Unlock()
			if runs != 0 {
				t.Fatal("unsafe media retry ran")
			}
		})
	}
}

// The last service-side proof is insufficient: media/name inspections can run
// after it, so the mutation boundary must verify the retained source itself.
type retrySwapBeforeRetainedStart struct {
	*retryEngine
	verifications atomic.Int32
	target        string
}

func (e *retrySwapBeforeRetainedStart) PinDirectory(_ context.Context, root, p, marker string) (PathProvenance, error) {
	return localPin(root, p, marker)
}
func (e *retrySwapBeforeRetainedStart) VerifyDirectory(_ context.Context, root, p string, pin PathProvenance) error {
	if err := localVerify(root, p, pin); err != nil {
		return err
	}
	if e.verifications.Add(1) == 3 {
		if err := os.Rename(e.target, e.target+"-original"); err != nil {
			return err
		}
		return os.Mkdir(e.target, 0700)
	}
	return nil
}
func TestRetryRetainedStartRevalidatesDirectoryAtMutation(t *testing.T) {
	r, e, _, first := failedRetryRig(t, true)
	i, _ := r.s.readInstance(first.InstanceID)
	e.mu.Lock()
	c := e.containers[i.ContainerName]
	c.State = "exited"
	e.containers[i.ContainerName] = c
	e.mu.Unlock()
	adversary := &retrySwapBeforeRetainedStart{retryEngine: e, target: i.DataPath}
	r.s.engine = adversary
	p := retryPlan(t, r, i.ID)
	e.healthFailure.Store(false)
	j := r.install(p, "guard-retained-start")
	final := r.waitJob(j["id"].(string))
	e.mu.Lock()
	starts := e.starts
	e.mu.Unlock()
	if starts != 0 || final["status"] != "needs_attention" {
		t.Fatalf("replacement started: starts=%d job=%v", starts, final)
	}
}

type unguardedRetryEngine struct {
	Engine
	storageInspector
}

func TestRetryRefusesRetainedStartWithoutEngineGuard(t *testing.T) {
	r, e, _, first := failedRetryRig(t, true)
	i, _ := r.s.readInstance(first.InstanceID)
	e.mu.Lock()
	c := e.containers[i.ContainerName]
	c.State = "exited"
	e.containers[i.ContainerName] = c
	e.mu.Unlock()
	r.s.engine = unguardedRetryEngine{Engine: e, storageInspector: e}
	p := retryPlan(t, r, i.ID)
	e.healthFailure.Store(false)
	j := r.install(p, "missing-start-guard")
	final := r.waitJob(j["id"].(string))
	e.mu.Lock()
	starts := e.starts
	e.mu.Unlock()
	if starts != 0 || final["status"] != "needs_attention" {
		t.Fatal("unguarded engine resumed", starts, final)
	}
}

// The fake engine implements the same final checks as a command engine; it
// reuses the real local directory proof rather than granting Resume blindly.
func (f *fakeEngine) Resume(ctx context.Context, r ResumeSpec) error {
	if err := validateResumeBoundary(ctx, f, r); err != nil {
		return err
	}
	if err := localVerify(r.Plan.RootPath, r.Plan.DataPath, r.Instance.Provenance); err != nil {
		return err
	}
	return f.Start(ctx, r.Instance.ContainerID)
}

func TestRemoteResumeBoundaryExecutesProofsBeforeStart(t *testing.T) {
	for _, mutation := range []string{"none", "directory", "foreign-label", "mount", "port", "container-id", "cache", "cache-after-inspect", "media", "media-after-inspect"} {
		t.Run(mutation, func(t *testing.T) {
			r, e, _, first := failedRetryRig(t, true)
			i, _ := r.s.readInstance(first.InstanceID)
			p, _ := r.s.readPlan(first.PlanID)
			e.mu.Lock()
			c := e.containers[i.ContainerName]
			e.mu.Unlock()
			var media StorageCandidate
			if mutation == "media" || mutation == "media-after-inspect" {
				mediaPath := filepath.Join(filepath.Dir(r.root), "media-boundary")
				if err := os.Mkdir(mediaPath, 0700); err != nil {
					t.Fatal(err)
				}
				media, _ = e.InspectStorage(context.Background(), mediaPath)
				p.AppID = "navidrome"
				p.Image = "deluan/navidrome:0.64.2"
				p.ContainerPort = 4533
				p.MediaRootID = "media"
				p.MediaRootPath = mediaPath
				p.MediaPath = mediaPath
				p.MediaStorageIdentity = media.Identity
				p.Mounts = []Mount{{Source: p.DataPath, Target: "/data"}, {Source: mediaPath, Target: "/music", ReadOnly: true}}
				i.AppID = p.AppID
				i.Image = p.Image
				i.ContainerPort = p.ContainerPort
				i.MediaRootPath = mediaPath
				i.MediaStorageIdentity = media.Identity
				i.Mounts = p.Mounts
				c.Image = p.Image
			}
			mounts := []map[string]any{}
			for _, mount := range p.Mounts {
				mounts = append(mounts, map[string]any{"Type": "bind", "Source": mount.Source, "Destination": mount.Target, "RW": !mount.ReadOnly})
			}
			raw := map[string]any{"Id": c.ID, "Name": "/" + c.Name, "Config": map[string]any{"Image": c.Image, "Labels": c.Labels}, "Mounts": mounts, "HostConfig": map[string]any{"PortBindings": map[string]any{strconv.Itoa(p.ContainerPort) + "/tcp": []map[string]any{{"HostIp": i.PublishHost, "HostPort": strconv.Itoa(i.HostPort)}}}}}
			switch mutation {
			case "foreign-label":
				raw["Config"].(map[string]any)["Labels"] = map[string]string{"io.spacedesktop.store": "foreign", "io.spacedesktop.instance": i.ID}
			case "mount":
				raw["Mounts"].([]map[string]any)[0]["Source"] = "/foreign"
			case "port":
				raw["HostConfig"].(map[string]any)["PortBindings"] = map[string]any{}
			case "container-id":
				raw["Id"] = "replacement-container"
			}
			rawJSON, _ := json.Marshal([]any{raw})
			body, _ := json.Marshal(ResumeSpec{Plan: p, Instance: i, StoreID: r.s.storeID})
			data, _ := e.InspectStorage(context.Background(), p.RootPath)
			cache, _ := e.DockerStorage(context.Background())
			if mutation == "cache" {
				cache.Identity = "different-cache"
			}
			storageJSON, _ := json.Marshal(map[string]StorageCandidate{"inspect": data, "docker": cache, "media": media})
			storageCode := "import sys,json\nkey='media' if sys.argv[1]=='inspect' and sys.argv[2]==" + strconv.Quote(p.MediaRootPath) + " else sys.argv[1]\nresult=json.loads(" + strconv.Quote(string(storageJSON)) + ")[key]\nif key=='docker' and getattr(sys,'synthetic_cache_changed',False): result['identity']='changed-after-inspect'\nif key=='media' and getattr(sys,'synthetic_media_changed',False): result['identity']='changed-after-inspect'"
			fixture := `import os,sys,json,subprocess
synthetic_raw=sys.argv[5];synthetic_swap=sys.argv[6]
def inspect(args,**kwargs):
 if args!=['docker','container','inspect',json.loads(sys.argv[1])['instance']['containerId']]: raise ValueError('unexpected docker command')
 if synthetic_swap=='cache-after-inspect': sys.synthetic_cache_changed=True
 if synthetic_swap=='media-after-inspect': sys.synthetic_media_changed=True
 if synthetic_swap=='directory':
  path=json.loads(sys.argv[1])['plan']['dataPath'];os.rename(path,path+'-owned');os.mkdir(path)
 return synthetic_raw
subprocess.check_output=inspect
os.execvp=lambda name,args:print(json.dumps(args))
`
			cmd := exec.Command("python3", "-c", fixture+remoteResumeScript, string(body), storageCode, remoteProvenanceScript, "pass", string(rawJSON), mutation)
			out, err := cmd.CombinedOutput()
			if mutation == "none" || mutation == "media" {
				if err != nil {
					t.Fatalf("valid retained resume refused: %v %s", err, out)
				}
				var command []string
				if json.Unmarshal(out, &command) != nil || !reflect.DeepEqual(command, []string{"docker", "container", "start", i.ContainerID}) {
					t.Fatalf("unexpected mutation command %s", out)
				}
			} else if err == nil {
				t.Fatalf("unsafe remote boundary accepted %s", out)
			}
		})
	}
}
func TestRemoteResumeUsesOneSSHCommandForProofAndStart(t *testing.T) {
	r, _, _, first := failedRetryRig(t, true)
	i, _ := r.s.readInstance(first.InstanceID)
	p, _ := r.s.readPlan(first.PlanID)
	var commands []string
	e := &commandEngine{mode: "sshbind", alias: "synthetic-nas", runner: func(_ context.Context, name string, args ...string) (string, string, error) {
		if name != "sshbind" || len(args) != 4 || args[0] != "exec" || args[1] != "--json" || args[2] != "synthetic-nas" {
			t.Fatal(name, args)
		}
		commands = append(commands, args[3])
		return `{"exit_code":0,"stdout":"synthetic-start","stderr":""}`, "", nil
	}}
	if err := e.Resume(context.Background(), ResumeSpec{Plan: p, Instance: i, StoreID: r.s.storeID}); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 {
		t.Fatal("proof and start split into commands", len(commands))
	}
	for _, part := range []string{"os.execvp", ".space-store-owner", "DockerRootDir", "PortBindings", "containerId", "O_NOFOLLOW"} {
		if !strings.Contains(commands[0], part) {
			t.Fatal("missing guarded proof", part)
		}
	}
}

type stateStartSwapEngine struct {
	*fakeEngine
	target string
}

func (e *stateStartSwapEngine) PinDirectory(_ context.Context, root, p, marker string) (PathProvenance, error) {
	return localPin(root, p, marker)
}
func (e *stateStartSwapEngine) VerifyDirectory(_ context.Context, root, p string, pin PathProvenance) error {
	if err := localVerify(root, p, pin); err != nil {
		return err
	}
	if err := os.Rename(e.target, e.target+"-original"); err != nil {
		return err
	}
	return os.Mkdir(e.target, 0700)
}
func TestInstanceStartRechecksDirectoryAtEngineBoundary(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := r.plan("uptime-kuma", "ordinary-start-guard", "")
	j := r.install(p, "ordinary-first")
	r.waitJob(j["id"].(string))
	i, _ := r.s.readInstance(p["instanceId"].(string))
	r.e.mu.Lock()
	c := r.e.containers[i.ContainerName]
	c.State = "exited"
	r.e.containers[i.ContainerName] = c
	r.e.mu.Unlock()
	r.s.engine = &stateStartSwapEngine{fakeEngine: r.e, target: i.DataPath}
	status, out := retryRequest(r, "/api/store/instances/"+i.ID+"/start", "{}")
	r.e.mu.Lock()
	starts := r.e.starts
	r.e.mu.Unlock()
	if status == 200 || starts != 0 {
		t.Fatal("ordinary start accepted replaced data", status, starts, out)
	}
}

func TestLocalResumeFinalDirectoryProofFollowsContainerInspection(t *testing.T) {
	for _, swap := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "swapped-after-inspect"}[swap], func(t *testing.T) {
			t.Setenv("DOCKER_HOST", "unix:///synthetic-docker.sock")
			r, _, _, first := failedRetryRig(t, true)
			i, _ := r.s.readInstance(first.InstanceID)
			p, _ := r.s.readPlan(first.PlanID)
			volume, _ := r.e.InspectStorage(context.Background(), p.RootPath)
			cache, _ := r.e.DockerStorage(context.Background())
			starts := 0
			raw, _ := json.Marshal([]any{map[string]any{"Id": i.ContainerID, "Name": "/" + i.ContainerName, "Config": map[string]any{"Image": i.Image, "Labels": map[string]string{"io.spacedesktop.store": r.s.storeID, "io.spacedesktop.instance": i.ID}}, "Mounts": []map[string]any{{"Type": "bind", "Source": i.DataPath, "Destination": "/app/data", "RW": true}}, "HostConfig": map[string]any{"PortBindings": map[string]any{"3001/tcp": []map[string]any{{"HostIp": i.PublishHost, "HostPort": strconv.Itoa(i.HostPort)}}}}}})
			e := &commandEngine{mode: "local", runner: func(_ context.Context, name string, args ...string) (string, string, error) {
				if name == "python3" {
					candidate := volume
					if args[len(args)-2] == "docker" {
						candidate = cache
					}
					out, _ := json.Marshal(candidate)
					return string(out), "", nil
				}
				if name == "docker" && len(args) >= 2 && args[0] == "container" && args[1] == "inspect" {
					if swap {
						if err := os.Rename(i.DataPath, i.DataPath+"-owned"); err != nil {
							return "", "", err
						}
						if err := os.Mkdir(i.DataPath, 0700); err != nil {
							return "", "", err
						}
					}
					return string(raw), "", nil
				}
				if name == "docker" && len(args) >= 2 && args[0] == "container" && args[1] == "start" {
					starts++
					if args[2] != i.ContainerID {
						t.Fatal("started replacement id", args)
					}
					return "started", "", nil
				}
				return `"synthetic-version"`, "", nil
			}}
			err := e.Resume(context.Background(), ResumeSpec{Plan: p, Instance: i, StoreID: r.s.storeID})
			if swap {
				if err == nil || starts != 0 {
					t.Fatal("started replaced local directory", err, starts)
				}
			} else if err != nil || starts != 1 {
				t.Fatal("valid local resume refused", err, starts)
			}
		})
	}
}

func sourceRetryPlan(t *testing.T, r *testRig, id string) map[string]any {
	t.Helper()
	status, out := retryRequest(r, "/api/store/instances/"+id+"/retry-plan", `{"imageSource":"ghcr"}`)
	if status != 201 {
		t.Fatalf("source retry status=%d response=%v", status, out)
	}
	return out["data"].(map[string]any)
}

func TestSourceRetryPreservesDataIdentityAndHistory(t *testing.T) {
	r, e, _, first := failedRetryRig(t, false)
	before, _ := r.s.readInstance(first.InstanceID)
	original, _ := r.s.readPlan(first.PlanID)
	sentinel := filepath.Join(before.DataPath, "application.db")
	if err := os.WriteFile(sentinel, []byte("retained-source-data"), 0600); err != nil {
		t.Fatal(err)
	}
	p := sourceRetryPlan(t, r, before.ID)
	if p["previousImage"] != before.Image || p["image"] != "ghcr.io/louislam/uptime-kuma:2.5.6" {
		t.Fatal(p)
	}
	unchanged, _ := r.s.readInstance(before.ID)
	if !reflect.DeepEqual(before, unchanged) {
		t.Fatal("plan mutated instance")
	}
	e.pullFailure.Store(false)
	j := r.install(p, "source-retry")
	if final := r.waitJob(j["id"].(string)); final["status"] != "completed" {
		t.Fatal(final)
	}
	after, _ := r.s.readInstance(before.ID)
	after.Image = before.Image
	after.State = before.State
	after.Health = before.Health
	after.ContainerID = before.ContainerID
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("instance scope changed before=%+v after=%+v", before, after)
	}
	retained, _ := os.ReadFile(sentinel)
	if string(retained) != "retained-source-data" {
		t.Fatal("data changed")
	}
	old, _ := r.s.readPlan(first.PlanID)
	jobs, _ := r.s.readJobs()
	instances, _ := r.s.readInstances()
	if !reflect.DeepEqual(old, original) || len(jobs) != 2 || len(instances) != 1 || !reflect.DeepEqual(jobs[1], first) {
		t.Fatal("history overwritten")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.runs) != 1 || e.runs[0].Image != p["image"] {
		t.Fatal("selected image not executed", e.runs)
	}
}

func TestSourceRetryRejectsInputsAndUnsupportedTuple(t *testing.T) {
	r, _, _, first := failedRetryRig(t, false)
	path := "/api/store/instances/" + first.InstanceID + "/retry-plan"
	for _, body := range []string{`{"imageSource":"docker.io"}`, `{"imageSource":"ghcr.io/evil:latest"}`, `{"image":"ghcr.io/louislam/uptime-kuma:2.5.6"}`, `{"imageSource":"ghcr","previousImage":"forged"}`, `{"imageSource":true}`} {
		status, _ := retryRequest(r, path, body)
		if status != 400 {
			t.Fatal(body, status)
		}
	}
	p, _ := r.s.readPlan(first.PlanID)
	i, _ := r.s.readInstance(first.InstanceID)
	p.Image = "louislam/uptime-kuma:2.5.5"
	i.Image = p.Image
	b, _ := json.Marshal(p)
	_, _ = r.s.db.Exec("UPDATE plans SET body=? WHERE id=?", string(b), p.ID)
	_ = r.s.saveInstance(i)
	if status, _ := retryRequest(r, path, `{"imageSource":"ghcr"}`); status != 409 {
		t.Fatal("unsupported tag", status)
	}
	p.AppID, i.AppID = "navidrome", "navidrome"
	p.Image, i.Image = "deluan/navidrome:0.64.2", "deluan/navidrome:0.64.2"
	b, _ = json.Marshal(p)
	_, _ = r.s.db.Exec("UPDATE plans SET body=? WHERE id=?", string(b), p.ID)
	_ = r.s.saveInstance(i)
	if status, _ := retryRequest(r, path, `{"imageSource":"ghcr"}`); status != 409 {
		t.Fatal("unsupported application", status)
	}
}

func TestSourceRetryRejectsContainerAndProvenanceAtPlanningAndEnqueue(t *testing.T) {
	for _, boundary := range []string{"planning", "enqueue"} {
		for _, kind := range []string{"owned-stopped", "foreign", "uncertain", "recorded", "missing-pin", "marker", "directory", "volume", "cache", "attempted-start", "inspect-error"} {
			t.Run(boundary+"/"+kind, func(t *testing.T) {
				r, e, _, first := failedRetryRig(t, false)
				i, _ := r.s.readInstance(first.InstanceID)
				var p map[string]any
				if boundary == "enqueue" {
					p = sourceRetryPlan(t, r, i.ID)
				}
				switch kind {
				case "inspect-error":
					r.s.engine = &sourceInspectRace{retryEngine: e, inspectionError: errors.New("inspection unavailable")}
				case "recorded":
					i.ContainerID = "recorded-ever"
					_ = r.s.saveInstance(i)
				case "missing-pin":
					i.Provenance = PathProvenance{}
					_ = r.s.saveInstance(i)
				case "marker":
					_ = os.WriteFile(filepath.Join(i.DataPath, ownershipMarker), []byte("foreign"), 0600)
				case "directory":
					_ = os.Rename(i.DataPath, i.DataPath+"-old")
					_ = os.Mkdir(i.DataPath, 0700)
				case "volume", "cache":
					old, _ := r.s.readPlan(first.PlanID)
					if kind == "volume" {
						old.StorageIdentity = "different"
					} else {
						old.DockerStorageIdentity = "different"
					}
					b, _ := json.Marshal(old)
					_, _ = r.s.db.Exec("UPDATE plans SET body=? WHERE id=?", string(b), old.ID)
				case "attempted-start":
					first.Stage = "start"
					first.Stages = append(first.Stages, Stage{Name: "start", Status: "failed"})
					_ = r.s.saveJob(first)
				default:
					c := Container{ID: "present", Name: i.ContainerName, Image: i.Image, State: "exited", Labels: map[string]string{"io.spacedesktop.store": r.s.storeID, "io.spacedesktop.instance": i.ID}, Mounts: i.Mounts, Ports: []PortBinding{{HostIP: i.PublishHost, HostPort: i.HostPort, ContainerPort: i.ContainerPort, Protocol: "tcp"}}}
					if kind == "foreign" {
						c.Labels["io.spacedesktop.store"] = "foreign"
					}
					if kind == "uncertain" {
						c.ID = ""
					}
					e.mu.Lock()
					e.containers[c.Name] = c
					e.mu.Unlock()
				}
				var status int
				if boundary == "planning" {
					status, _ = retryRequest(r, "/api/store/instances/"+i.ID+"/retry-plan", `{"imageSource":"ghcr"}`)
				} else {
					body, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": "denied-source"})
					status, _ = retryRequest(r, "/api/store/install", string(body))
				}
				if status != 409 {
					t.Fatal("unsafe source change accepted", status)
				}
				jobs, _ := r.s.readJobs()
				after, _ := r.s.readInstance(i.ID)
				if len(jobs) != 1 || after.Image != i.Image || e.pulls.Load() != 1 {
					t.Fatal("unsafe source mutation", jobs, after)
				}
			})
		}
	}
}

type sourceInspectRace struct {
	*retryEngine
	mutate          func()
	inspectionError error
}

func (e *sourceInspectRace) Inspect(ctx context.Context, name string) (Container, error) {
	c, err := e.retryEngine.Inspect(ctx, name)
	if e.inspectionError != nil {
		return Container{}, e.inspectionError
	}
	if e.mutate != nil {
		fn := e.mutate
		e.mutate = nil
		fn()
	}
	return c, err
}

func TestSourceRetryRechecksDirectoryAfterAbsenceProofAtEnqueue(t *testing.T) {
	r, e, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	i, _ := r.s.readInstance(first.InstanceID)
	r.s.engine = &sourceInspectRace{retryEngine: e, mutate: func() {
		if err := os.Rename(i.DataPath, i.DataPath+"-old"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(i.DataPath, 0700); err != nil {
			t.Fatal(err)
		}
	}}
	body, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": "source-directory-race"})
	if status, out := retryRequest(r, "/api/store/install", string(body)); status != 409 {
		t.Fatal("changed directory was queued", status, out)
	}
	after, _ := r.s.readInstance(i.ID)
	jobs, _ := r.s.readJobs()
	if after.Image != i.Image || len(jobs) != 1 {
		t.Fatal("enqueue changed retained state")
	}
}

func TestSourceRetryDefaultAfterFailedMigrationKeepsSelectedImage(t *testing.T) {
	r, _, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	j := r.install(p, "failed-source")
	if final := r.waitJob(j["id"].(string)); final["status"] != "needs_attention" {
		t.Fatal(final)
	}
	next := retryPlan(t, r, first.InstanceID)
	if _, present := next["previousImage"]; present || next["image"] != p["image"] {
		t.Fatal("default silently changed source", next)
	}
	stored, _ := r.s.readPlan(p["id"].(string))
	raw, _ := json.Marshal(stored)
	if !strings.Contains(string(raw), `"previousImage":"louislam/uptime-kuma:2.5.6"`) {
		t.Fatal("reviewed plan changed")
	}
}

func TestSourceRetryIdempotencyAndLatestTerminalJob(t *testing.T) {
	r, _, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	r.s.cancel()
	r.s.wg.Wait()
	body := func(plan map[string]any, id string) string {
		b, _ := json.Marshal(map[string]any{"planId": plan["id"], "requestId": id})
		return string(b)
	}
	if status, _ := retryRequest(r, "/api/store/install", body(p, first.RequestID)); status != 409 {
		t.Fatal("old request reused", status)
	}
	same := retryPlan(t, r, first.InstanceID)
	stale := sourceRetryPlan(t, r, first.InstanceID)
	accepted := r.install(same, "new-terminal")
	jobs, _ := r.s.readJobs()
	latest := jobs[0]
	latest.Status = "failed"
	_ = r.s.saveJob(latest)
	if accepted["id"] != latest.ID {
		t.Fatal(accepted, latest)
	}
	if status, _ := retryRequest(r, "/api/store/install", body(stale, "stale-source")); status != 409 {
		t.Fatal("stale source job accepted", status)
	}
	fresh := sourceRetryPlan(t, r, first.InstanceID)
	const concurrent = 8
	var wg sync.WaitGroup
	ids := make(chan string, concurrent)
	for n := 0; n < concurrent; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, out := retryRequest(r, "/api/store/install", body(fresh, "stable-source"))
			if status != 202 {
				t.Errorf("duplicate=%d %v", status, out)
				return
			}
			ids <- out["data"].(map[string]any)["id"].(string)
		}()
	}
	wg.Wait()
	close(ids)
	id := ""
	for got := range ids {
		if id != "" && got != id {
			t.Fatal("duplicate source jobs")
		}
		id = got
	}
	jobs, _ = r.s.readJobs()
	after, _ := r.s.readInstance(first.InstanceID)
	if len(jobs) != 3 || after.Image != fresh["image"] {
		t.Fatal("non atomic source reservation", jobs, after)
	}
	if status, _ := retryRequest(r, "/api/store/instances/"+first.InstanceID+"/retry-plan", `{"imageSource":"ghcr"}`); status != 409 {
		t.Fatal("active source retry accepted", status)
	}
}

func TestSourceRetryExecutionRejectsDrift(t *testing.T) {
	for _, kind := range []string{"container", "recorded", "pin", "image", "original-plan", "latest-job", "other-active"} {
		t.Run(kind, func(t *testing.T) {
			r, e, _, first := failedRetryRig(t, false)
			p := sourceRetryPlan(t, r, first.InstanceID)
			r.s.cancel()
			r.s.wg.Wait()
			accepted := r.install(p, "queued-source")
			jobs, _ := r.s.readJobs()
			queued := jobs[0]
			if accepted["id"] != queued.ID {
				t.Fatal(accepted)
			}
			i, _ := r.s.readInstance(first.InstanceID)
			switch kind {
			case "container":
				e.mu.Lock()
				e.containers[i.ContainerName] = Container{ID: "existing", Name: i.ContainerName, Image: i.Image}
				e.mu.Unlock()
			case "recorded":
				i.ContainerID = "previous"
				_ = r.s.saveInstance(i)
			case "pin":
				i.Provenance.Marker = "foreign"
				_ = r.s.saveInstance(i)
			case "image":
				i.Image = "arbitrary:latest"
				_ = r.s.saveInstance(i)
			case "original-plan":
				old, _ := r.s.readPlan(first.PlanID)
				old.Image = "arbitrary:latest"
				b, _ := json.Marshal(old)
				_, _ = r.s.db.Exec("UPDATE plans SET body=? WHERE id=?", string(b), old.ID)
			default:
				drift := first
				drift.ID = randomID()
				drift.RequestID = "drift-request"
				if kind == "other-active" {
					drift.Status = "queued"
				}
				b, _ := json.Marshal(drift)
				_, _ = r.s.db.Exec("INSERT INTO jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)", drift.ID, "other-plan", drift.RequestID, drift.Status, string(b))
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r.s.ctx = ctx
			e.pullFailure.Store(false)
			r.s.execute(queued)
			jobs, _ = r.s.readJobs()
			var result Job
			for _, j := range jobs {
				if j.ID == queued.ID {
					result = j
				}
			}
			e.mu.Lock()
			runs := len(e.runs)
			starts := e.starts
			e.mu.Unlock()
			if result.Status != "needs_attention" || e.pulls.Load() != 1 || runs != 0 || starts != 0 {
				t.Fatal("execution drift mutated engine", result, e.pulls.Load(), runs, starts)
			}
		})
	}
}

type sourcePullRace struct {
	*retryEngine
	mutate func()
}

func (e *sourcePullRace) Pull(ctx context.Context, image string) error {
	err := e.retryEngine.Pull(ctx, image)
	if e.mutate != nil {
		e.mutate()
	}
	return err
}

func TestSourceRetryRejectsContainerOrDirectoryAppearingDuringPull(t *testing.T) {
	for _, kind := range []string{"owned-stopped", "foreign", "directory"} {
		t.Run(kind, func(t *testing.T) {
			r, e, _, first := failedRetryRig(t, false)
			p := sourceRetryPlan(t, r, first.InstanceID)
			r.s.cancel()
			r.s.wg.Wait()
			_ = r.install(p, "source-pull-race")
			jobs, _ := r.s.readJobs()
			queued := jobs[0]
			i, _ := r.s.readInstance(first.InstanceID)
			r.s.engine = &sourcePullRace{retryEngine: e, mutate: func() {
				if kind == "directory" {
					_ = os.Rename(i.DataPath, i.DataPath+"-old")
					_ = os.Mkdir(i.DataPath, 0700)
					return
				}
				c := Container{ID: "late-container", Name: i.ContainerName, Image: i.Image, State: "exited", Labels: map[string]string{"io.spacedesktop.store": r.s.storeID, "io.spacedesktop.instance": i.ID}, Mounts: i.Mounts, Ports: []PortBinding{{HostIP: i.PublishHost, HostPort: i.HostPort, ContainerPort: i.ContainerPort, Protocol: "tcp"}}}
				if kind == "foreign" {
					c.Labels["io.spacedesktop.store"] = "foreign"
				}
				e.mu.Lock()
				e.containers[c.Name] = c
				e.mu.Unlock()
			}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r.s.ctx = ctx
			e.pullFailure.Store(false)
			r.s.execute(queued)
			jobs, _ = r.s.readJobs()
			after, _ := r.s.readInstance(i.ID)
			e.mu.Lock()
			runs := len(e.runs)
			starts := e.starts
			container := e.containers[i.ContainerName]
			e.mu.Unlock()
			if jobs[0].Status != "needs_attention" || e.pulls.Load() != 2 || runs != 0 || starts != 0 || after.ContainerID != "" {
				t.Fatal("late mutation adopted or replaced", jobs[0], after, runs, starts)
			}
			if kind != "directory" && container.ID != "late-container" {
				t.Fatal("existing container changed")
			}
		})
	}
}

func TestSourceRetryRequiresAuthenticationAndRejectsInstallOverrides(t *testing.T) {
	r, _, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	b, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": "forged-image", "image": "arbitrary:latest"})
	if status, _ := retryRequest(r, "/api/store/install", string(b)); status != 400 {
		t.Fatal("install accepted image override", status)
	}
	r.token = ""
	if status, _ := retryRequest(r, "/api/store/instances/"+first.InstanceID+"/retry-plan", `{"imageSource":"ghcr"}`); status != 401 {
		t.Fatal("unauthenticated source plan", status)
	}
	b, _ = json.Marshal(map[string]any{"planId": p["id"], "requestId": "unauth-source"})
	if status, _ := retryRequest(r, "/api/store/install", string(b)); status != 401 {
		t.Fatal("unauthenticated source enqueue", status)
	}
}

type sourceBeforeRunRace struct {
	*retryEngine
	mutate func()
}

func (e *sourceBeforeRunRace) ValidatePath(ctx context.Context, root, p string, fresh bool) error {
	err := e.retryEngine.ValidatePath(ctx, root, p, fresh)
	if e.mutate != nil {
		fn := e.mutate
		e.mutate = nil
		fn()
	}
	return err
}
func TestSourceRetryRechecksLatestJobAtRunBoundary(t *testing.T) {
	r, e, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	r.s.cancel()
	r.s.wg.Wait()
	_ = r.install(p, "source-run-race")
	jobs, _ := r.s.readJobs()
	queued := jobs[0]
	r.s.engine = &sourceBeforeRunRace{retryEngine: e, mutate: func() {
		drift := first
		drift.ID = randomID()
		drift.RequestID = "late-terminal"
		b, _ := json.Marshal(drift)
		_, err := r.s.db.Exec("INSERT INTO jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)", drift.ID, "late-plan", drift.RequestID, drift.Status, string(b))
		if err != nil {
			t.Fatal(err)
		}
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.s.ctx = ctx
	e.pullFailure.Store(false)
	r.s.execute(queued)
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.runs) != 0 {
		t.Fatal("latest-job drift before Run was ignored", e.runs)
	}
}

type sourceFailedRun struct{ *retryEngine }

func (e *sourceFailedRun) Run(ctx context.Context, spec RunSpec) error {
	if err := e.retryEngine.Run(ctx, spec); err != nil {
		return err
	}
	return errors.New("uncertain creation response")
}
func TestSourceRetryNeverAdoptsAfterUncertainRun(t *testing.T) {
	r, e, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	e.pullFailure.Store(false)
	r.s.engine = &sourceFailedRun{retryEngine: e}
	accepted := r.install(p, "source-uncertain-run")
	if final := r.waitJob(accepted["id"].(string)); final["status"] != "needs_attention" {
		t.Fatal(final)
	}
	i, _ := r.s.readInstance(first.InstanceID)
	if i.ContainerID != "" {
		t.Fatal("source change adopted uncertain container", i)
	}
	e.mu.Lock()
	container := e.containers[i.ContainerName]
	e.mu.Unlock()
	if container.ID == "" {
		t.Fatal("uncertain container lost")
	}
	if status, _ := retryRequest(r, "/api/store/instances/"+first.InstanceID+"/retry-plan", `{"imageSource":"ghcr"}`); status != 409 {
		t.Fatal("uncertain source migrated", status)
	}
}

func TestSourceRetryRechecksLatestJobAfterFinalEngineProof(t *testing.T) {
	r, e, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	r.s.cancel()
	r.s.wg.Wait()
	_ = r.install(p, "source-final-proof-race")
	jobs, _ := r.s.readJobs()
	queued := jobs[0]
	r.s.engine = &sourceBeforeRunRace{retryEngine: e, mutate: func() {
		r.s.engine = &sourceInspectRace{retryEngine: e, mutate: func() {
			drift := first
			drift.ID = randomID()
			drift.RequestID = "final-proof-terminal"
			b, _ := json.Marshal(drift)
			_, err := r.s.db.Exec("INSERT INTO jobs(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)", drift.ID, "final-proof-plan", drift.RequestID, drift.Status, string(b))
			if err != nil {
				t.Fatal(err)
			}
		}}
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.s.ctx = ctx
	e.pullFailure.Store(false)
	r.s.execute(queued)
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.runs) != 0 {
		t.Fatal("latest-job drift during final engine proof was ignored")
	}
}

func TestSourceRetryRechecksContainerAbsenceAtEnqueue(t *testing.T) {
	r, e, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	i, _ := r.s.readInstance(first.InstanceID)
	r.s.engine = &sourceInspectRace{retryEngine: e, mutate: func() {
		e.mu.Lock()
		e.containers[i.ContainerName] = Container{ID: "appeared-after-inspect", Name: i.ContainerName, Image: i.Image, State: "exited"}
		e.mu.Unlock()
	}}
	body, _ := json.Marshal(map[string]any{"planId": p["id"], "requestId": "source-absence-race"})
	if status, _ := retryRequest(r, "/api/store/install", string(body)); status != 409 {
		t.Fatal("container appearing after absence proof was queued", status)
	}
	after, _ := r.s.readInstance(i.ID)
	jobs, _ := r.s.readJobs()
	if after.Image != i.Image || len(jobs) != 1 {
		t.Fatal("container race changed retained state")
	}
}

type sourceJobRow struct{ PlanID, RequestID, Status, Body string }

func sourceJobSnapshot(t *testing.T, r *testRig, id string) sourceJobRow {
	t.Helper()
	var row sourceJobRow
	if err := r.s.db.QueryRow(`SELECT plan_id,request_id,status,body FROM jobs WHERE id=?`, id).Scan(&row.PlanID, &row.RequestID, &row.Status, &row.Body); err != nil {
		t.Fatal(err)
	}
	return row
}
func queuedSourceExecution(t *testing.T) (*testRig, *retryEngine, Job, Instance) {
	t.Helper()
	r, e, _, first := failedRetryRig(t, false)
	p := sourceRetryPlan(t, r, first.InstanceID)
	r.s.cancel()
	r.s.wg.Wait()
	_ = r.install(p, "review-source-execution")
	jobs, _ := r.s.readJobs()
	i, _ := r.s.readInstance(first.InstanceID)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r.s.ctx = ctx
	e.pullFailure.Store(false)
	return r, e, jobs[0], i
}
func atFinalSourceProof(r *testRig, e *retryEngine, mutate func()) {
	r.s.engine = &sourceBeforeRunRace{retryEngine: e, mutate: func() { r.s.engine = &sourceInspectRace{retryEngine: e, mutate: mutate} }}
}
func TestSourceRetryCurrentReservationDriftAtFinalProof(t *testing.T) {
	for _, kind := range []string{"plan-index", "request-index", "status-index", "body-plan", "body-request", "body-instance", "body-id", "body-status", "body-stage", "body-error"} {
		t.Run(kind, func(t *testing.T) {
			r, e, queued, _ := queuedSourceExecution(t)
			var changed sourceJobRow
			atFinalSourceProof(r, e, func() {
				changed = sourceJobSnapshot(t, r, queued.ID)
				var j Job
				if err := json.Unmarshal([]byte(changed.Body), &j); err != nil {
					t.Fatal(err)
				}
				switch kind {
				case "plan-index":
					changed.PlanID = "changed-plan"
				case "request-index":
					changed.RequestID = "changed-request"
				case "status-index":
					changed.Status = "queued"
				case "body-plan":
					j.PlanID = "changed-plan"
				case "body-request":
					j.RequestID = "changed-request"
				case "body-instance":
					j.InstanceID = "changed-instance"
				case "body-id":
					j.ID = "changed-id"
				case "body-status":
					j.Status = "failed"
				case "body-stage":
					j.Stage = "changed-stage"
				case "body-error":
					j.Error = "changed-evidence"
				}
				b, _ := json.Marshal(j)
				changed.Body = string(b)
				if _, err := r.s.db.Exec(`UPDATE jobs SET plan_id=?,request_id=?,status=?,body=? WHERE id=?`, changed.PlanID, changed.RequestID, changed.Status, changed.Body, queued.ID); err != nil {
					t.Fatal(err)
				}
			})
			r.s.execute(queued)
			after := sourceJobSnapshot(t, r, queued.ID)
			e.mu.Lock()
			runs := len(e.runs)
			e.mu.Unlock()
			if runs != 0 || after != changed {
				t.Fatalf("reservation drift kind=%s runs=%d preserved=%v status=%s", kind, runs, after == changed, after.Status)
			}
		})
	}
}
func TestSourceRetryTerminalDuringPullIsNotResurrected(t *testing.T) {
	r, e, queued, _ := queuedSourceExecution(t)
	var changed sourceJobRow
	r.s.engine = &sourcePullRace{retryEngine: e, mutate: func() {
		changed = sourceJobSnapshot(t, r, queued.ID)
		var current Job
		_ = json.Unmarshal([]byte(changed.Body), &current)
		current.Status = "needs_attention"
		current.Error = "external terminal evidence"
		b, _ := json.Marshal(current)
		changed.Body = string(b)
		changed.Status = current.Status
		if _, err := r.s.db.Exec(`UPDATE jobs SET status=?,body=? WHERE id=?`, changed.Status, changed.Body, queued.ID); err != nil {
			t.Fatal(err)
		}
	}}
	r.s.execute(queued)
	after := sourceJobSnapshot(t, r, queued.ID)
	e.mu.Lock()
	runs := len(e.runs)
	e.mu.Unlock()
	if runs != 0 || after != changed {
		t.Fatalf("terminal reservation runs=%d preserved=%v status=%s", runs, after == changed, after.Status)
	}
}
func TestSourceRetryLiveInstanceEvidenceSurvivesFinalProofRejection(t *testing.T) {
	for _, kind := range []string{"container-id", "provenance", "image", "directory", "port", "mount", "state-health"} {
		t.Run(kind, func(t *testing.T) {
			r, e, queued, i := queuedSourceExecution(t)
			var changed Instance
			atFinalSourceProof(r, e, func() {
				changed, _ = r.s.readInstance(i.ID)
				switch kind {
				case "container-id":
					changed.ContainerID = "new-recorded-evidence"
				case "provenance":
					changed.Provenance.Marker = "new-provenance-evidence"
				case "image":
					changed.Image = "changed:image"
				case "directory":
					changed.DataPath += "-changed"
				case "port":
					changed.HostPort++
				case "mount":
					changed.Mounts = []Mount{{Source: "/changed", Target: "/app/data"}}
				case "state-health":
					changed.State = "changed-state"
					changed.Health = "changed-health"
				}
				if err := r.s.saveInstance(changed); err != nil {
					t.Fatal(err)
				}
			})
			r.s.execute(queued)
			after, _ := r.s.readInstance(i.ID)
			e.mu.Lock()
			runs := len(e.runs)
			e.mu.Unlock()
			if runs != 0 || !reflect.DeepEqual(after, changed) {
				t.Fatalf("live instance kind=%s runs=%d preserved=%v", kind, runs, reflect.DeepEqual(after, changed))
			}
		})
	}
}
func TestSourceRetryQueuedReservationClaimDoesNotOverwriteDrift(t *testing.T) {
	r, e, queued, _ := queuedSourceExecution(t)
	changed := sourceJobSnapshot(t, r, queued.ID)
	changed.PlanID = "changed-queued-owner"
	if _, err := r.s.db.Exec(`UPDATE jobs SET plan_id=? WHERE id=?`, changed.PlanID, queued.ID); err != nil {
		t.Fatal(err)
	}
	r.s.execute(queued)
	after := sourceJobSnapshot(t, r, queued.ID)
	e.mu.Lock()
	runs := len(e.runs)
	e.mu.Unlock()
	if runs != 0 || after != changed {
		t.Fatalf("queued ownership runs=%d preserved=%v status=%s", runs, after == changed, after.Status)
	}
}
