package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
)

func TestRuntimeDisabledFailsWithoutCommands(t *testing.T) {
	e := &commandEngine{mode: "disabled", runner: func(context.Context, string, ...string) (string, string, error) {
		t.Fatal("disabled executed command")
		return "", "", nil
	}}
	if _, err := e.RuntimeFacts(context.Background()); err == nil {
		t.Fatal("disabled accepted")
	}
	if err := e.ControlGeneration(context.Background(), RuntimeGeneration{}, "stop"); err == nil {
		t.Fatal("invalid generation accepted")
	}
}
func TestRuntimeRejectsUncontrolledPlan(t *testing.T) {
	e := &commandEngine{mode: "local", runner: func(context.Context, string, ...string) (string, string, error) {
		t.Fatal("invalid plan executed command")
		return "", "", nil
	}}
	if _, err := e.PrepareGeneration(context.Background(), RuntimePlan{AppID: "foreign"}); err == nil {
		t.Fatal("foreign plan accepted")
	}
}

func runtimeTestPlan(t *testing.T) RuntimePlan {
	t.Helper()
	r, ok := RuntimeRecipeFor("uptime-kuma", "2.5.6")
	if !ok {
		t.Fatal("recipe missing")
	}
	d := "sha256:" + strings.Repeat("a", 64)
	return RuntimePlan{ID: "plan", StoreID: "store", GenerationID: "generation", InstanceID: "instance", AppID: r.AppID, TargetVersion: r.Version, RootPath: "/DATA/store", DataPath: "/DATA/store/generation", StorageIdentity: "storage", DockerStorageIdentity: "docker", HostPort: 32123, PublishHost: "127.0.0.1", Recipe: r, Images: []RuntimeImage{{ServiceID: r.Services[0].ID, TagReference: r.Services[0].Image, Reference: "ghcr.io/louislam/uptime-kuma@" + d, Digest: d, Platform: "linux/amd64", Publisher: "ghcr.io/louislam/uptime-kuma", DeliverySource: "ghcr.io"}}}
}
func TestRuntimePrepareUsesReviewedGenerationID(t *testing.T) {
	p := runtimeTestPlan(t)
	e := &commandEngine{mode: "local", runner: func(_ context.Context, n string, args ...string) (string, string, error) {
		if n != "python3" || args[2] != "prepare" {
			t.Fatal("uncontrolled command")
		}
		var in struct {
			Generation RuntimeGeneration `json:"generation"`
		}
		if json.Unmarshal([]byte(args[3]), &in) != nil {
			t.Fatal("payload invalid")
		}
		if in.Generation.ID != p.GenerationID || in.Generation.StoreID != p.StoreID {
			t.Fatal("reviewed identity changed")
		}
		b, _ := json.Marshal(in.Generation)
		return string(b), "", nil
	}}
	g, err := e.PrepareGeneration(context.Background(), p)
	if err != nil || g.ID != p.GenerationID {
		t.Fatalf("prepare failed %v", err)
	}
}
func TestRuntimeMutatedPlanRejectedBeforeRunner(t *testing.T) {
	for _, mutate := range []func(*RuntimePlan){func(p *RuntimePlan) { p.Recipe.Services[0].Image = "evil:latest" }, func(p *RuntimePlan) { p.Images[0].Platform = "linux/arm64" }, func(p *RuntimePlan) { p.Images[0].Reference = "evil@" + p.Images[0].Digest }, func(p *RuntimePlan) { p.DataPath = "/DATA/store/../foreign" }, func(p *RuntimePlan) { p.Images[0].Publisher = "evil" }, func(p *RuntimePlan) { p.StoreID = "" }, func(p *RuntimePlan) { p.GenerationID = "" }} {
		p := runtimeTestPlan(t)
		mutate(&p)
		e := &commandEngine{mode: "local", runner: func(context.Context, string, ...string) (string, string, error) {
			t.Fatal("mutated plan executed")
			return "", "", nil
		}}
		if _, err := e.PrepareGeneration(context.Background(), p); err == nil {
			t.Fatal("mutated plan accepted")
		}
	}
}
func TestRuntimeFailureDoesNotLeakCommandsOrOutputs(t *testing.T) {
	e := &commandEngine{mode: "local", runner: func(context.Context, string, ...string) (string, string, error) {
		return "password=synthetic-private-secret", "synthetic-private-secret", errors.New("synthetic-private-secret")
	}}
	_, err := e.RuntimeFacts(context.Background())
	if err == nil || strings.Contains(err.Error(), "synthetic-private-secret") {
		t.Fatal("private output leaked")
	}
}

func TestRuntimeSSHTimeoutBeforeAliasAndContextBounded(t *testing.T) {
	e := &commandEngine{mode: "sshbind", alias: "fixture", runner: func(ctx context.Context, n string, args ...string) (string, string, error) {
		if n != "sshbind" || len(args) < 6 || args[0] != "exec" || args[1] != "--json" || args[2] != "--timeout" || args[4] != "fixture" {
			t.Fatalf("options must precede alias; received %d args", len(args))
		}
		seconds, err := strconv.Atoi(args[3])
		if err != nil || seconds <= 120 || seconds > 1800 {
			t.Fatalf("unbounded launch timeout %q", args[3])
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("missing runner context fence")
		}
		return `{"exit_code":0,"stdout":"{}","stderr":""}`, "", nil
	}}
	if err := e.runtimeHost(context.Background(), "launch", map[string]string{}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeQuiesceUsesOptionalGuardedHostAction(t *testing.T) {
	p := runtimeTestPlan(t)
	g := RuntimeGeneration{ID: p.GenerationID, StoreID: p.StoreID, InstanceID: p.InstanceID, AppID: p.AppID, Version: p.TargetVersion, RecipeRevision: p.Recipe.Revision, Recipe: p.Recipe, Images: p.Images, RootPath: p.RootPath, DataPath: p.DataPath, StorageIdentity: p.StorageIdentity, DockerStorageIdentity: p.DockerStorageIdentity, HostPort: p.HostPort, PublishHost: p.PublishHost, Provenance: PathProvenance{RootIdentity: "root", DirectoryIdentity: "data", Marker: p.StoreID + ":" + p.InstanceID + ":" + p.GenerationID}}
	calls := 0
	e := &commandEngine{mode: "local", runner: func(_ context.Context, name string, args ...string) (string, string, error) {
		calls++
		if name != "python3" || args[2] != "quiesce" {
			t.Fatal("unexpected recovery action")
		}
		g.State = "prepared"
		body, _ := json.Marshal(g)
		return string(body), "", nil
	}}
	recovered, err := e.RuntimeQuiesceGeneration(context.Background(), g)
	if err != nil || recovered.State != "prepared" || calls != 1 {
		t.Fatalf("optional recovery failed: %v", err)
	}
	g.Provenance.Marker = "foreign"
	if _, err := e.RuntimeQuiesceGeneration(context.Background(), g); err == nil {
		t.Fatal("foreign generation accepted")
	}
	if calls != 1 {
		t.Fatal("foreign generation invoked helper")
	}
}
