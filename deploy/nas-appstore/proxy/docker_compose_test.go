package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestComposePreviewSupportsCommonServiceFields(t *testing.T) {
	p, e := parseCompose("review", `services:
  web:
    image: redis:latest
    ports: ["58088:6379"]
    volumes: ["data:/data"]
    environment:
      MODE: test
    restart: unless-stopped
volumes:
  data: {}
`)
	if e != nil {
		t.Fatal(e)
	}
	if len(p.Services) != 1 || p.Services[0].Image != "redis:latest" || p.Services[0].Input.Volumes[0].Name != "space-client-review-data" {
		t.Fatalf("bad plan: %+v", p)
	}
}
func TestComposeRejectsUnsafeAndUnknownFieldsBeforeDeployment(t *testing.T) {
	for _, body := range []string{"services:\n  web:\n    image: redis:latest\n    privileged: true", "services:\n  web:\n    image: redis:latest\n    volumes: [/etc:/data]", "services:\n  web:\n    image: redis:latest\n    network_mode: host", "services:\n  web:\n    image: redis:latest\n    build: .", "services:\n  web:\n    image: redis:latest\n    image: alpine:latest"} {
		if _, err := parseCompose("review", body); err == nil {
			t.Errorf("accepted unsafe/unsupported YAML: %s", body)
		}
	}
	if _, err := parseCompose("space-desktop", "services: {}"); err == nil {
		t.Fatal("accepted reserved project")
	}
	if _, err := parseCompose("review", strings.Repeat("x", 100001)); err == nil {
		t.Fatal("accepted oversized input")
	}
}

func composePreview(t *testing.T, env, source string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"name": "review", "yaml": source, "env": env, "preview": true})
	request := httptest.NewRequest("POST", "/api/docker/compose-create", bytes.NewReader(body))
	response := httptest.NewRecorder()
	dockerComposeCreate(response, request)
	return response
}
func TestComposeDotenvInterpolationUsesOfficialDefaultsAndQuotes(t *testing.T) {
	response := composePreview(t, "# config\nBASE=redis\nTAG='7'\nIMAGE=\"${BASE}:${TAG}\"\n", "services:\n  web:\n    image: ${IMAGE:-redis:latest}\n    environment:\n      MODE: ${MODE:-test}\n")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"image":"redis:7"`) {
		t.Fatalf("dotenv preview failed: %d %s", response.Code, response.Body.String())
	}
}
func TestComposeInterpolationDoesNotReadProxyEnvironment(t *testing.T) {
	t.Setenv("SPACE_COMPOSE_SECRET", "sensitive-server-value")
	response := composePreview(t, "SAFE=${SPACE_COMPOSE_SECRET:-redis:latest}\n", "services:\n  web:\n    image: ${SAFE}\n")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"image":"redis:latest"`) || strings.Contains(response.Body.String(), "sensitive-server-value") {
		t.Fatalf("proxy environment used: %d %s", response.Code, response.Body.String())
	}
}
func TestComposeDotenvCannotSetComposeControlEnvironment(t *testing.T) {
	for _, env := range []string{"COMPOSE_FILE=/etc/private.yml", "DOCKER_HOST=tcp://host:1234", "INVALID=\"unterminated", "BAD=bad\x00value"} {
		response := composePreview(t, env, "services:\n  web:\n    image: redis:latest\n")
		if response.Code != 400 {
			t.Errorf("accepted invalid dotenv: %d", response.Code)
		}
	}
}
func TestComposeInterpolationCannotInjectNewYAMLFields(t *testing.T) {
	response := composePreview(t, "TAG='latest\n    privileged: true'\n", "services:\n  web:\n    image: redis:${TAG}\n")
	if response.Code != 400 {
		t.Fatalf("interpolation bypassed safe fields: %d", response.Code)
	}
}

func TestComposeDotenvMissingReferencesStayPrivate(t *testing.T) {
	const private = "syntheticPrivateVariableFromEnvValue"
	if os.Getenv("SPACE_COMPOSE_LOG_CHILD") == "1" {
		if _, e := parseCompose("review", "services:\n  web:\n    image: redis:latest\n", "UNUSED=$"+private+"\n"); e != nil {
			t.Fatal(e)
		}
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestComposeDotenvMissingReferencesStayPrivate$")
	cmd.Env = append(os.Environ(), "SPACE_COMPOSE_LOG_CHILD=1")
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("child parsing failed: %v", e)
	}
	if strings.Contains(string(out), private) {
		t.Fatal("dotenv value leaked through parser diagnostics")
	}
}
