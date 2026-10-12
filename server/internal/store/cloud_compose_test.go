package store

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCloudComposeImportsSingleServiceAsSafeEditableDraft(t *testing.T) {
	input := `name: family-reader
services:
  reader:
    image: ghcr.io/acme/reader:1.2
    ports: ["8090:8080"]
    volumes:
      - ./data:/data
      - library:/books
    environment:
      TZ: Asia/Shanghai
      ADMIN_PASSWORD: local-secret-must-not-leak
      PUBLIC_URL: ${PUBLIC_URL:-https://example.com}
    restart: unless-stopped
volumes:
  library: {}
`
	app, warnings, err := parseCloudCompose(input)
	if err != nil {
		t.Fatal(err)
	}
	if app.ID != "family-reader" || app.Image != "ghcr.io/acme/reader:1.2" || app.ContainerPort != 8080 || app.Published || len(app.DataTargets) != 2 {
		t.Fatal("incomplete draft", app)
	}
	if !cloudValidateApp(app) || len(warnings) < 3 {
		t.Fatal("invalid editable draft", warnings)
	}
	encoded, _ := json.Marshal(app)
	if strings.Contains(string(encoded), "local-secret-must-not-leak") || strings.Contains(string(encoded), "./data") || strings.Contains(string(encoded), "8090") {
		t.Fatal("host/private data leaked")
	}
	for _, e := range app.Environment {
		if e.Name == "ADMIN_PASSWORD" && (!e.Secret || e.Default != nil) {
			t.Fatal("secret retained")
		}
		if e.Name == "PUBLIC_URL" && e.Default != nil {
			t.Fatal("interpolation flattened")
		}
	}
}

func TestCloudComposeRejectsServicesAndOptionsItCannotPreserve(t *testing.T) {
	for _, input := range []string{
		"services:\n  first:\n    image: nginx:stable\n    ports: [80]\n  second:\n    image: redis:7\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n    privileged: true\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n    pid: host\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n    volumes: [/var/run/docker.sock:/socket]\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n    volumes: [/etc:/config]\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n    build: .\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n    command: sh -c execute\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n    extra_hosts: [local:127.0.0.1]\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80, 81]\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80/udp]\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n    volumes: [library:/data:ro]\nvolumes:\n  library: {}\n",
		"services:\n  app:\n    image: nginx:stable\n    image: redis:7\n    ports: [80]\n",
		"services:\n  app: &app\n    image: nginx:stable\n    ports: [80]\n  second: *app\n",
		"services:\n  app:\n    image: nginx:stable\n    ports: [80]\n---\nservices: {}\n",
	} {
		if _, _, err := parseCloudCompose(input); err == nil {
			t.Fatal("unsupported compose accepted", input)
		}
	}
}

func TestCloudComposeEndpointAuthenticatesAndDoesNotSaveOrPublish(t *testing.T) {
	r, _, mux, admin := cloudAIRig(t)
	input := "services:\n  nginx:\n    image: nginx:stable\n    ports: [80]\n"
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/import-compose", "", map[string]string{"compose": input}); status != 401 {
		t.Fatal("anonymous import", status)
	}
	var before int
	r.s.db.QueryRow(`SELECT count(*) FROM cloud_apps`).Scan(&before)
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/import-compose", admin, map[string]string{"compose": input})
	if status != 200 || out["data"].(map[string]any)["app"].(map[string]any)["published"] != false {
		t.Fatal(status, out)
	}
	var after int
	r.s.db.QueryRow(`SELECT count(*) FROM cloud_apps`).Scan(&after)
	if before != after {
		t.Fatal("compose auto-saved/published")
	}
	status, out = cloudCall(t, mux, "POST", "/api/store/admin/import-compose", admin, map[string]string{"compose": input + "  redis:\n    image: redis:7\n"})
	if status != 422 || out["error"].(map[string]any)["code"] != "compose_unsupported" {
		t.Fatal("multi-service not explicit", status, out)
	}
}
