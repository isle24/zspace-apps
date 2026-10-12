package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// Explicit opt-in only. The private authentication fixture is in this process;
// the real Docker Engine receives only a freshly named, isolated Redis project.
func TestRealComposeAcceptance(t *testing.T) {
	if os.Getenv("SPACE_DOCKER_ACCEPTANCE") != "1" {
		t.Skip("requires explicit NAS acceptance invocation")
	}
	name := "compose-acceptance-" + time.Now().UTC().Format("20060102150405")
	source := `services:
  redis:
    image: redis:latest
    volumes: ["data:/data"]
    restart: unless-stopped
volumes:
  data: {}
`
	nas := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"code": 200, "data": map[string]any{"username": "acceptance-fixture", "is_master": true}})
	}))
	defer nas.Close()
	origin, _ := url.Parse(nas.URL)
	handler := newDockerHandler(origin)
	payload, _ := json.Marshal(map[string]any{"name": name, "yaml": source, "preview": false})
	request := httptest.NewRequest("POST", "http://client.local/api/docker/compose-create", strings.NewReader(string(payload)))
	request.Header.Set("X-Space-Request", "1")
	request.AddCookie(&http.Cookie{Name: "token", Value: "synthetic-acceptance"})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, request)
	if w.Code != 201 {
		t.Fatalf("deployment status %d: %s", w.Code, w.Body.String())
	}
	var result struct {
		Created []string `json:"created"`
	}
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Created) != 1 {
		t.Fatal("missing created service")
	}
	for _, id := range result.Created {
		c, e := inspectContainer(id)
		if e != nil || c.Config.Labels["com.docker.compose.project"] != name || c.Config.Labels["space.client.managed"] != "true" || c.State.Status != "running" {
			t.Fatal("project state or identity differs")
		}
		t.Logf("confirmed isolated project %s service %s", name, id)
		t.Cleanup(func() {
			actual, e := inspectContainer(id)
			if e != nil || actual.Config.Labels["com.docker.compose.project"] != name || actual.Config.Labels["space.client.managed"] != "true" {
				t.Error("refused cleanup: own project identity changed")
				return
			}
			_, status, e := enginePost(context.Background(), "/containers/"+id+"/stop?t=5", nil)
			if e != nil || status != 204 {
				t.Error(fmt.Sprintf("stop unconfirmed: %d", status))
				return
			}
			actual, e = inspectContainer(id)
			if e != nil || actual.State.Status != "exited" {
				t.Error("test container did not stop")
			}
			t.Log("test container stopped; its data volume retained")
		})
	}
}
