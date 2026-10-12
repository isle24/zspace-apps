package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoteCommandsHaveOptionsBeforeAliasAndQuoteEveryArgument(t *testing.T) {
	var gotName string
	var gotArgs []string
	e := &commandEngine{mode: "sshbind", alias: "synthetic-nas", runner: func(_ context.Context, n string, a ...string) (string, string, error) {
		gotName = n
		gotArgs = a
		return `{"exit_code":0,"stdout":"ok","stderr":"synthetic noise"}`, "", nil
	}}
	unsafe := "/DATA/user's music; echo injected"
	out, _, err := e.remote(context.Background(), "python3", "-c", "print('safe')", unsafe)
	if err != nil || out != "ok" {
		t.Fatal(out, err)
	}
	if gotName != "sshbind" || len(gotArgs) != 4 || gotArgs[0] != "exec" || gotArgs[1] != "--json" || gotArgs[2] != "synthetic-nas" {
		t.Fatal(gotName, gotArgs)
	}
	if !strings.Contains(gotArgs[3], "'"+strings.ReplaceAll(unsafe, "'", "'\"'\"'")+"'") {
		t.Fatal("unsafe shell quoting", gotArgs)
	}
}

func TestDirectEngineRejectsUnregisteredMountsAndIncompleteRecipe(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "storage")
	os.Mkdir(root, 0700)
	data := filepath.Join(root, "new")
	os.Mkdir(data, 0755)
	calls := 0
	e := &commandEngine{mode: "local", runner: func(context.Context, string, ...string) (string, string, error) { calls++; return "", "", nil }}
	spec := RunSpec{Name: "space-store-synthetic", Image: "louislam/uptime-kuma:2.5.6", HostPort: 32123, ContainerPort: 3001, Labels: map[string]string{"io.spacedesktop.store": "synthetic-store", "io.spacedesktop.instance": "synthetic-instance"}}
	for _, mounts := range [][]Mount{nil, {{Source: "/etc", Target: "/app/data"}}, {{Source: data, Target: "/music", ReadOnly: false}}, {{Source: data, Target: "/app/data"}, {Source: data, Target: "/app/data"}}} {
		spec.Mounts = mounts
		if err = e.Run(context.Background(), spec); err == nil {
			t.Fatal("accepted unsafe recipe", mounts)
		}
	}
	if calls != 0 {
		t.Fatal("executed invalid recipe")
	}
}

func TestDockerInspectDistinguishesMissingAndUnavailable(t *testing.T) {
	e := &commandEngine{mode: "local", runner: func(context.Context, string, ...string) (string, string, error) {
		return "", "Error: No such container: synthetic", errors.New("exit 1")
	}}
	if _, err := e.Inspect(context.Background(), "synthetic"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	e.runner = func(context.Context, string, ...string) (string, string, error) {
		return "", "permission denied", errors.New("exit 1")
	}
	if _, err := e.Inspect(context.Background(), "synthetic"); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestStopOnlyInvokesDockerStopNeverRemoval(t *testing.T) {
	e := &commandEngine{mode: "sshbind", alias: "synthetic-nas", runner: func(_ context.Context, n string, a ...string) (string, string, error) {
		if n != "sshbind" || a[1] != "--json" || a[2] != "synthetic-nas" {
			t.Fatal(n, a)
		}
		if a[3] != "'docker' 'container' 'stop' '--time' '30' 'synthetic-id'" {
			t.Fatal("unexpected command", a[3])
		}
		body, _ := json.Marshal(map[string]any{"exit_code": 0, "stdout": "synthetic-id"})
		return string(body), "", nil
	}}
	if err := e.Stop(context.Background(), "synthetic-id"); err != nil {
		t.Fatal(err)
	}
}

func TestPathValidationRejectsRootReplacement(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "root")
	os.Mkdir(root, 0700)
	outside := filepath.Join(base, "outside")
	os.Mkdir(outside, 0700)
	if err := os.Rename(root, root+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	if err := validateLocalPath(root, filepath.Join(root, "new"), true); err == nil {
		t.Fatal("accepted replaced root")
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); !os.IsNotExist(err) {
		t.Fatal("wrote outside root")
	}
}

func TestRegisteredLocalRecipeUsesOnlyStructuredDockerRun(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(base, "instance")
	media := filepath.Join(base, "music")
	os.Mkdir(data, 0755)
	os.Mkdir(media, 0755)
	pin, err := localPin(base, data, "synthetic-marker")
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	e := &commandEngine{mode: "local", root: base, runner: func(_ context.Context, name string, args ...string) (string, string, error) {
		calls++
		if name != "docker" || args[0] != "container" || args[1] != "run" {
			t.Fatal(name, args)
		}
		joined := strings.Join(args, " ")
		for _, bad := range []string{" --privileged", " --network host", " docker.sock", " --volume", "--rm", "sudo", "prune"} {
			if strings.Contains(joined, bad) {
				t.Fatal(joined)
			}
		}
		if !strings.Contains(joined, "dst=/music,readonly") || !strings.Contains(joined, "--pull=never") || !strings.Contains(joined, "127.0.0.1:32123:4533") {
			t.Fatal(joined)
		}
		return "synthetic-id", "", nil
	}}
	err = e.Run(context.Background(), RunSpec{Name: "space-store-synthetic", Image: "deluan/navidrome:0.64.2", HostPort: 32123, ContainerPort: 4533, Provenance: pin, Labels: map[string]string{"io.spacedesktop.store": "synthetic-store", "io.spacedesktop.instance": "synthetic-instance"}, Mounts: []Mount{{Source: data, Target: "/data"}, {Source: media, Target: "/music", ReadOnly: true}}})
	if err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
}

func TestRemoteProbeRejectsDockerContextPointingElsewhere(t *testing.T) {
	e := &commandEngine{mode: "sshbind", alias: "synthetic-nas", runner: func(_ context.Context, n string, a ...string) (string, string, error) {
		if len(a) != 4 {
			t.Fatal(a)
		}
		if !strings.Contains(a[3], "context") {
			return `{"exit_code":0,"stdout":"27.0.0","stderr":""}`, "", nil
		}
		return `{"exit_code":0,"stdout":"\"ssh://foreign-server\"","stderr":""}`, "", nil
	}}
	if err := e.Probe(context.Background()); err == nil {
		t.Fatal("accepted foreign Docker context on remote alias")
	}
}

func TestRemoteMountPerformsIdentityCheckAndRunInSameCommand(t *testing.T) {
	var commands []string
	e := &commandEngine{mode: "sshbind", root: "/DATA/storage", alias: "synthetic-nas", runner: func(_ context.Context, name string, args ...string) (string, string, error) {
		if name != "sshbind" || args[1] != "--json" || args[2] != "synthetic-nas" {
			t.Fatal(name, args)
		}
		commands = append(commands, args[3])
		return `{"exit_code":0,"stdout":"synthetic-id","stderr":""}`, "", nil
	}}
	err := e.Run(context.Background(), RunSpec{Name: "space-store-synthetic", Image: "louislam/uptime-kuma:2.5.6", HostPort: 32123, ContainerPort: 3001, Labels: map[string]string{"io.spacedesktop.store": "synthetic-store", "io.spacedesktop.instance": "synthetic-instance"}, Provenance: PathProvenance{RootIdentity: "100:1", DirectoryIdentity: "100:2", Marker: "synthetic-marker"}, Mounts: []Mount{{Source: "/DATA/storage/new", Target: "/app/data"}}})
	if err != nil {
		t.Fatal(err)
	}
	last := commands[len(commands)-1]
	for _, part := range []string{"os.execvp", ".space-store-owner", "st_ino", "'docker' 'container' 'run'"} {
		if !strings.Contains(last, part) {
			t.Fatal("identity check and mount separated across commands", last)
		}
	}
}

func TestInspectReadsPersistentConfiguredPortBindingsAfterStop(t *testing.T) {
	e := &commandEngine{mode: "local", runner: func(context.Context, string, ...string) (string, string, error) {
		return `[{"Id":"synthetic-id","Name":"/space-store-synthetic","Config":{"Image":"louislam/uptime-kuma:2.5.6","Labels":{}},"State":{"Status":"exited"},"Mounts":[],"HostConfig":{"PortBindings":{"3001/tcp":[{"HostIp":"0.0.0.0","HostPort":"32123"}]}},"NetworkSettings":{"Ports":null}}]`, "", nil
	}}
	c, err := e.Inspect(context.Background(), "space-store-synthetic")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Ports) != 1 || c.Ports[0] != (PortBinding{HostIP: "0.0.0.0", HostPort: 32123, ContainerPort: 3001, Protocol: "tcp"}) {
		t.Fatal("stopped container lost configured bindings", c)
	}
}

func TestOfficialSourceEngineUsesSameControlledRecipe(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(base, "instance")
	if err = os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	pin, err := localPin(base, data, "synthetic-marker")
	if err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	e := &commandEngine{mode: "local", root: base, runner: func(_ context.Context, name string, args ...string) (string, string, error) {
		if name != "docker" {
			t.Fatal(name)
		}
		calls = append(calls, args)
		return "synthetic-id", "", nil
	}}
	image := "ghcr.io/louislam/uptime-kuma:2.5.6"
	if err = e.Pull(context.Background(), image); err != nil {
		t.Fatal(err)
	}
	spec := RunSpec{Name: "space-store-synthetic", Image: image, HostPort: 32123, ContainerPort: 3001, Labels: map[string]string{"io.spacedesktop.store": "synthetic", "io.spacedesktop.instance": "instance"}, Mounts: []Mount{{Source: data, Target: "/app/data"}}, Provenance: pin}
	if err = e.Run(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[0][2] != image || calls[1][len(calls[1])-1] != image {
		t.Fatal(calls)
	}
	for _, bad := range []string{"ghcr.io/louislam/uptime-kuma:latest", "ghcr.io/louislam/uptime-kuma:2.5.5", "ghcr.io/evil/uptime-kuma:2.5.6", "louislam/uptime-kuma:2.5.6;echo injected"} {
		if e.Pull(context.Background(), bad) == nil {
			t.Fatal("pulled arbitrary image", bad)
		}
		spec.Image = bad
		if e.Run(context.Background(), spec) == nil {
			t.Fatal("ran arbitrary image", bad)
		}
	}
	if len(calls) != 2 {
		t.Fatal("unsafe image reached Docker", calls)
	}
}
