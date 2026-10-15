package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContainerListMarksManagedServicesProtected(t *testing.T) {
	h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"Id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Names":["/zspace-suite-ui-1"],"Labels":{"io.space-store.service":"space-store"}},{"Id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Names":["/unrelated-app"],"Labels":{}}]`))
	})
	w := dockerRequest(t, h, "/api/docker/containers", "", true)
	var result struct {
		Containers []containerView `json:"containers"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Containers) != 2 {
		t.Fatal(w.Body.String())
	}
	for _, item := range result.Containers {
		if item.Protected != (item.Name == "zspace-suite-ui-1") {
			t.Errorf("%s protected=%v", item.Name, item.Protected)
		}
	}
}

func dockerFixture(t *testing.T, master bool, engine http.HandlerFunc) http.Handler {
	t.Helper()
	dir, err := os.MkdirTemp("", "dk-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	listener, err := net.Listen("unix", filepath.Join(dir, "sock"))
	if err != nil {
		t.Fatal(err)
	}
	previous := dockerSocket
	dockerSocket = filepath.Join(dir, "sock")
	t.Cleanup(func() { dockerSocket = previous })
	server := &http.Server{Handler: engine}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	nas := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("token") != "synthetic-token" {
			writeJSON(w, 200, map[string]any{"code": "N001208"})
			return
		}
		writeJSON(w, 200, map[string]any{"code": 200, "data": map[string]any{"username": "fixture", "is_master": master}})
	}))
	t.Cleanup(nas.Close)
	origin, _ := url.Parse(nas.URL)
	return newDockerHandler(origin)
}
func dockerRequest(t *testing.T, h http.Handler, path, body string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	method := "GET"
	if body != "" {
		method = "POST"
	}
	r := httptest.NewRequest(method, "http://desktop.test"+path, strings.NewReader(body))
	if authenticated {
		r.AddCookie(&http.Cookie{Name: "token", Value: "synthetic-token"})
	}
	if method == "POST" {
		r.Header.Set("Origin", "http://desktop.test")
		r.Header.Set("X-Space-Request", "1")
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestDockerRequiresIdentityAndParsesRealPorts(t *testing.T) {
	calls := 0
	h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`[{"Id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Names":["/reader"],"Image":"reader:1","State":"running","Ports":[{"IP":"0.0.0.0","PrivatePort":8080,"PublicPort":18089,"Type":"tcp"}]}]`))
	})
	if w := dockerRequest(t, h, "/api/docker/containers", "", false); w.Code != 401 {
		t.Fatalf("anonymous status %d", w.Code)
	}
	if calls != 0 {
		t.Fatal("anonymous reached engine")
	}
	w := dockerRequest(t, h, "/api/docker/containers", "", true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "18089→8080/tcp") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
func TestDockerControlDeniesMembers(t *testing.T) {
	const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	h := dockerFixture(t, false, func(w http.ResponseWriter, r *http.Request) { t.Fatal("member reached engine") })
	w := dockerRequest(t, h, "/api/docker/control", `{"id":"`+id+`","action":"stop"}`, true)
	if w.Code != 403 {
		t.Fatalf("member status %d", w.Code)
	}
}
func TestDockerControlCrossSite(t *testing.T) {
	h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) { t.Fatal("cross-site reached engine") })
	r := httptest.NewRequest("POST", "http://desktop.test/api/docker/control", strings.NewReader(`{}`))
	r.AddCookie(&http.Cookie{Name: "token", Value: "synthetic-token"})
	r.Header.Set("Origin", "http://other.test")
	r.Header.Set("X-Space-Request", "1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("cross-site %d", w.Code)
	}
}
func TestDockerControlReadsBackExactIdentity(t *testing.T) {
	const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	running := true
	writes := 0
	h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/containers/" + id + "/json":
			state := "exited"
			if running {
				state = "running"
			}
			writeJSON(w, 200, map[string]any{"Id": id, "Name": "/fixture", "State": map[string]any{"Status": state}, "Config": map[string]any{"Labels": map[string]string{}}})
		case "/containers/" + id + "/stop":
			writes++
			running = false
			w.WriteHeader(204)
		default:
			t.Fatalf("unexpected %s", r.URL.Path)
		}
	})
	w := dockerRequest(t, h, "/api/docker/control", `{"id":"`+id+`","action":"stop"}`, true)
	if w.Code != 200 || writes != 1 || !strings.Contains(w.Body.String(), `"state":"exited"`) {
		t.Fatalf("%d writes %d %s", w.Code, writes, w.Body.String())
	}
}
func TestDockerProtectsOwnService(t *testing.T) {
	const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Fatal("self stopped")
		}
		w.Write([]byte(`{"Id":"` + id + `","Name":"/space-desktop","State":{"Status":"running"},"Config":{"Labels":{"com.docker.compose.project":"space-desktop"}}}`))
	})
	w := dockerRequest(t, h, "/api/docker/control", `{"id":"`+id+`","action":"stop"}`, true)
	if w.Code != 403 {
		t.Fatalf("self status %d", w.Code)
	}
}
func TestDockerCreateUsesExistingImageAndNamedVolume(t *testing.T) {
	image := "sha256:" + strings.Repeat("b", 64)
	id := strings.Repeat("a", 64)
	created := false
	h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/images/" + image + "/json":
			w.Write([]byte(`{"Id":"` + image + `"}`))
		case "/volumes/space-client-review":
			w.WriteHeader(404)
		case "/volumes/create":
			writeJSON(w, 201, map[string]any{"Name": "space-client-review", "Driver": "local", "Options": nil, "Labels": map[string]string{"space.client.managed": "true"}})
		case "/containers/create":
			created = true
			body, _ := io.ReadAll(r.Body)
			if strings.Contains(string(body), `"Privileged":true`) || strings.Contains(string(body), `"Binds"`) {
				t.Fatal("unsafe create")
			}
			if !strings.Contains(string(body), "space-client-review") || !strings.Contains(string(body), "8080/tcp") {
				t.Fatal(string(body))
			}
			writeJSON(w, 201, map[string]string{"Id": id})
		case "/containers/" + id + "/json":
			w.Write([]byte(`{"Id":"` + id + `","Name":"/review","State":{"Status":"created"},"Config":{"Image":"` + image + `"}}`))
		default:
			t.Fatal(r.URL.Path)
		}
	})
	w := dockerRequest(t, h, "/api/docker/create", `{"name":"review","imageId":"`+image+`","ports":[{"host":58080,"container":8080,"protocol":"tcp"}],"volumes":[{"name":"space-client-review","target":"/data"}],"environment":[]}`, true)
	if w.Code != 201 || !created {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
func TestDockerCreateRejectsUnrelatedVolumesAndSocket(t *testing.T) {
	for _, volume := range []string{`{"name":"mysql-production","target":"/data"}`, `{"name":"space-client-review","target":"/var/run/docker.sock"}`} {
		h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) { t.Fatal("invalid create reached engine") })
		w := dockerRequest(t, h, "/api/docker/create", `{"name":"review","imageId":"sha256:`+strings.Repeat("b", 64)+`","volumes":[`+volume+`]}`, true)
		if w.Code != 400 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
}
func TestDockerCreateRefusesPreexistingForeignOrBindVolumes(t *testing.T) {
	for _, volume := range []string{
		`{"Name":"space-client-review","Driver":"local","Options":null,"Labels":{}}`,
		`{"Name":"space-client-review","Driver":"local","Options":{"type":"none","o":"bind","device":"/root"},"Labels":{"space.client.managed":"true"}}`,
	} {
		calledCreate := false
		h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/images/") {
				writeJSON(w, 200, map[string]string{"Id": "sha256:" + strings.Repeat("b", 64)})
				return
			}
			if strings.HasPrefix(r.URL.Path, "/volumes/") {
				w.Write([]byte(volume))
				return
			}
			calledCreate = true
			writeJSON(w, 409, map[string]string{"error": "unexpected-create"})
		})
		w := dockerRequest(t, h, "/api/docker/create", `{"name":"review","imageId":"sha256:`+strings.Repeat("b", 64)+`","volumes":[{"name":"space-client-review","target":"/data"}]}`, true)
		if w.Code != 409 || calledCreate {
			t.Fatalf("foreign volume accepted: status=%d create=%v %s", w.Code, calledCreate, w.Body.String())
		}
	}
}
func TestStoreProxyDoesNotForwardNASCookie(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" {
			t.Error("NAS cookie crossed into store transport")
		}
		if r.Header.Get("X-Store-Session") != "synthetic-store-grant" {
			t.Error("store grant lost")
		}
		w.WriteHeader(200)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	request := httptest.NewRequest("GET", "http://desktop.test/api/store/bootstrap", nil)
	request.AddCookie(&http.Cookie{Name: "token", Value: "synthetic-nas-secret"})
	request.Header.Set("X-Store-Session", "synthetic-store-grant")
	response := httptest.NewRecorder()
	newStoreProxy(target).ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal(response.Code)
	}
}
func TestUntaggedImageUsesPublisherTitle(t *testing.T) {
	h := dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/images/json" {
			w.Write([]byte(`[{"Id":"sha256:bbbb","RepoTags":[],"Labels":{"org.opencontainers.image.title":"Reader Server"}}]`))
			return
		}
		w.Write([]byte(`[]`))
	})
	w := dockerRequest(t, h, "/api/docker/images", "", true)
	if !strings.Contains(w.Body.String(), `"displayName":"Reader Server"`) {
		t.Fatal(w.Body.String())
	}
}
