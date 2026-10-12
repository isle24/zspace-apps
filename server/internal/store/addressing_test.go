package store

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLocalNASPlanUsesConfiguredLANAccessAndImmutablePublishHost(t *testing.T) {
	r := newRig(t)
	r.setup()
	r.s.Close()
	opts := r.opts
	opts.PublishHost = "0.0.0.0"
	opts.AccessHost = "192.0.2.56"
	s, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r.s = s
	r.mux = http.NewServeMux()
	s.Register(r.mux)
	p := r.plan("uptime-kuma", "lan-app", "")
	if p["accessUrl"] != "http://192.0.2.56:32123/" || p["publishHost"] != "0.0.0.0" {
		t.Fatal("standalone NAS plan points to client loopback", p)
	}
	s.opts.PublishHost = "127.0.0.1"
	s.opts.AccessHost = "changed.example"
	j := r.install(p, "synthetic-lan")
	if final := r.waitJob(j["id"].(string)); final["status"] != "completed" {
		t.Fatal(final)
	}
	if r.e.runs[0].PublishHost != "0.0.0.0" {
		t.Fatal("plan binding changed with config")
	}
}

func TestHostConfigurationRejectsURLsPortsAndInjection(t *testing.T) {
	r := newRig(t)
	cases := []struct{ publish, access string }{{"0.0.0.0;touch /tmp/injected", "192.0.2.56"}, {"192.0.2.56:1234", "192.0.2.56"}, {"192.0.2.0/24", "192.0.2.56"}, {"0.0.0.0", "https://evil.example/path"}, {"0.0.0.0", "evil.example:1234"}, {"0.0.0.0", "evil.example\nX-Header: injected"}, {"0.0.0.0", "--privileged"}}
	for _, c := range cases {
		opts := r.opts
		opts.PublishHost = c.publish
		opts.AccessHost = c.access
		opts.DataDir = filepath.Join(filepath.Dir(r.opts.DataDir), randomID())
		s, err := New(opts)
		if err == nil {
			s.Close()
			t.Fatalf("accepted unsafe host publish=%q access=%q", c.publish, c.access)
		}
	}
}

func TestLocalDockerPublishUsesExactConfiguredIP(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(base, "instance")
	os.Mkdir(data, 0755)
	pin, err := localPin(base, data, "synthetic-marker")
	if err != nil {
		t.Fatal(err)
	}
	var got string
	e := &commandEngine{mode: "local", root: base, runner: func(_ context.Context, n string, args ...string) (string, string, error) {
		for i, a := range args {
			if a == "--publish" {
				got = args[i+1]
			}
		}
		return "synthetic-id", "", nil
	}}
	err = e.Run(context.Background(), RunSpec{Name: "space-store-synthetic", Image: "louislam/uptime-kuma:2.5.6", PublishHost: "0.0.0.0", HostPort: 32123, ContainerPort: 3001, Provenance: pin, Labels: map[string]string{"io.spacedesktop.store": "synthetic-store", "io.spacedesktop.instance": "synthetic-instance"}, Mounts: []Mount{{Source: data, Target: "/app/data"}}})
	if err != nil {
		t.Fatal(err)
	}
	if got != "0.0.0.0:32123:3001" {
		t.Fatal("configured LAN publishing ignored", got)
	}
}

func TestSetupRejectsProxyForwardingHeadersDespiteLoopbackRemote(t *testing.T) {
	for _, header := range []string{"Forwarded", "X-Forwarded-For"} {
		t.Run(header, func(t *testing.T) {
			r := newRig(t)
			req := httptest.NewRequest("POST", "http://127.0.0.1/api/store/setup", strings.NewReader(`{"username":"synthetic-admin","password":"synthetic-pass-123"}`))
			req.RemoteAddr = "127.0.0.1:1234"
			req.Header.Set(header, "for=192.0.2.100")
			w := httptest.NewRecorder()
			r.mux.ServeHTTP(w, req)
			var out map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if w.Code != 403 || out["error"].(map[string]any)["code"] != "setup_loopback_only" {
				t.Fatal("reverse proxy granted first-owner setup", w.Code, out["error"])
			}
		})
	}
}

func TestBindingMismatchOrAdditionalPublishedPortRefusesControls(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := r.plan("uptime-kuma", "bound-app", "")
	j := r.install(p, "synthetic-bind-match")
	r.waitJob(j["id"].(string))
	for _, bad := range [][]PortBinding{{{HostIP: "0.0.0.0", HostPort: 32123, ContainerPort: 3001, Protocol: "tcp"}}, {{HostIP: "127.0.0.1", HostPort: 32123, ContainerPort: 3001, Protocol: "tcp"}, {HostIP: "127.0.0.1", HostPort: 5432, ContainerPort: 5432, Protocol: "tcp"}}} {
		r.e.mu.Lock()
		c := r.e.containers[p["containerName"].(string)]
		c.Ports = bad
		r.e.containers[p["containerName"].(string)] = c
		r.e.mu.Unlock()
		for _, action := range []string{"start", "stop"} {
			status, out := r.call("POST", "/api/store/instances/"+p["instanceId"].(string)+"/"+action, "{}", "127.0.0.1:1")
			if status != 409 {
				t.Fatal("binding mismatch allowed control", status, out)
			}
		}
	}
	if r.e.starts+r.e.stops != 0 {
		t.Fatal("mutated mismatched container")
	}
}

func TestHealthUsesSpecificPublishedIPv6Host(t *testing.T) {
	listener, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skip("IPv6 loopback unavailable")
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	server.Listener = listener
	server.Start()
	defer server.Close()
	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	e := &commandEngine{mode: "local", runner: func(context.Context, string, ...string) (string, string, error) {
		data := []map[string]any{{"Id": "synthetic-id", "Name": "/space-store-synthetic", "Config": map[string]any{"Image": "louislam/uptime-kuma:2.5.6"}, "State": map[string]any{"Status": "running"}, "HostConfig": map[string]any{"PortBindings": map[string]any{"3001/tcp": []map[string]string{{"HostIp": "::1", "HostPort": portText}}}}}}
		b, _ := json.Marshal(data)
		return string(b), "", nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	h, err := e.Health(ctx, "space-store-synthetic", port, "/")
	if err != nil || h != "healthy" {
		t.Fatal("specific bind health still used IPv4 loopback", h, err)
	}
}
