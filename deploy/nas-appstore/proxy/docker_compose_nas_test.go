package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func composeNASFixture(t *testing.T, nasHandler http.HandlerFunc) http.Handler {
	t.Helper()
	dockerFixture(t, true, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/images/") {
			writeJSON(w, 200, map[string]any{"Id": "sha256:" + strings.Repeat("b", 64)})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/volumes/") {
			w.WriteHeader(404)
			return
		}
		if r.URL.Path == "/networks" || r.URL.Path == "/containers/json" {
			writeJSON(w, 200, []any{})
			return
		}
		t.Errorf("unexpected Engine operation %s", r.URL.Path)
		w.WriteHeader(500)
	})
	nas := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/token" {
			writeJSON(w, 200, map[string]any{"code": 200, "data": map[string]any{"username": "fixture", "is_master": true}})
			return
		}
		nasHandler(w, r)
	}))
	t.Cleanup(nas.Close)
	target, _ := url.Parse(nas.URL)
	return newDockerHandler(target)
}
func nasResponse(w http.ResponseWriter, data any) {
	writeJSON(w, 200, map[string]any{"code": 200, "success": true, "data": data})
}
func TestComposeUsesOfficialNASWriterAfterValidatingDirectoryAndReadsBothFiles(t *testing.T) {
	created := false
	writes := 0
	config := ""
	const env = "TAG='latest'\nPASSWORD=synthetic-private-value\n"
	h := composeNASFixture(t, func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		switch r.URL.Path {
		case "/system/polling2":
			nasResponse(w, map[string]any{"pools": []any{map[string]any{"key": "sata1", "mounted": true}}})
		case "/v2/file/info":
			nasResponse(w, map[string]any{"path": r.Form.Get("path"), "name": "projects", "is_dir": true})
		case "/zdocker/v2/compose/check_projectpath":
			if r.Form.Get("project_path") != "/tmp/zfsv3/sata1/_fixture/data/projects" {
				t.Error("wrong official directory mapping")
			}
			nasResponse(w, map[string]any{"result": false})
		case "/zdocker/v2/compose/check_projectname":
			nasResponse(w, map[string]any{"result": true})
		case "/zdocker/v2/compose/create_project":
			writes++
			if r.Form.Get("path") != "/tmp/zfsv3/sata1/_fixture/data/projects" || r.Form.Get("project_name") != "review" || r.Form.Get("start") != "false" || r.Form.Get("rw") != "false" || r.Form.Get("env") != env {
				t.Error("official writer body differs")
			}
			config = r.Form.Get("config")
			if strings.Contains(config, "${TAG}") {
				t.Error("writer used unresolved interpolation")
			}
			created = true
			nasResponse(w, map[string]any{"task_id": "fixture-task"})
		case "/zdocker/v2/compose/list_projects":
			if r.Header.Get("Content-Type") != "application/json" {
				t.Error("official list_projects requires JSON request")
			}
			if created {
				nasResponse(w, []any{map[string]any{"id": "fixture-project", "projectName": "review", "pathValid": true}})
			} else {
				nasResponse(w, []any{})
			}
		case "/zdocker/v2/compose/get_project_file":
			nasResponse(w, map[string]any{"exists": true, "file_content": config})
		case "/v2/file/list":
			if created {
				nasResponse(w, map[string]any{"list": []any{map[string]any{"name": "docker-compose.yml", "path": "/sata1/my/data/projects/docker-compose.yml", "is_dir": false}, map[string]any{"name": ".env", "path": "/sata1/my/data/projects/.env", "is_dir": false}}, "total": 2})
			} else {
				nasResponse(w, map[string]any{"list": []any{}, "total": 0})
			}
		case "/v2/file/download":
			if strings.HasSuffix(r.URL.Query().Get("path"), "/.env") {
				w.Write([]byte(env))
			} else {
				w.Write([]byte(config))
			}
		default:
			t.Errorf("unexpected NAS API %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	payload, _ := json.Marshal(map[string]any{"name": "review", "yaml": "services:\n  redis:\n    image: redis:${TAG}\n    environment:\n      PASSWORD: ${PASSWORD}\n", "env": env, "directory": "/sata1/my/data/projects", "start": false, "preview": true})
	preview := dockerRequest(t, h, "/api/docker/compose-create", string(payload), true)
	if preview.Code != 200 || writes != 0 {
		t.Fatalf("preview mutated project: %d", preview.Code)
	}
	payload, _ = json.Marshal(map[string]any{"name": "review", "yaml": "services:\n  redis:\n    image: redis:${TAG}\n    environment:\n      PASSWORD: ${PASSWORD}\n", "env": env, "directory": "/sata1/my/data/projects", "start": false, "preview": false})
	result := dockerRequest(t, h, "/api/docker/compose-create", string(payload), true)
	if result.Code != 201 || writes != 1 || !strings.Contains(result.Body.String(), `"saved":true`) || !strings.Contains(result.Body.String(), `"state":"saved"`) {
		t.Fatalf("NAS save unconfirmed: %d %s", result.Code, result.Body.String())
	}
	if strings.Contains(result.Body.String(), "synthetic-private-value") || strings.Contains(preview.Body.String(), "synthetic-private-value") {
		t.Error("returned environment secret")
	}
}
func TestComposeRefusesUnverifiedOrOccupiedNASDirectoriesBeforeWriting(t *testing.T) {
	for _, scenario := range []string{"unmounted", "conflict", "wrong-info", "name-conflict"} {
		t.Run(scenario, func(t *testing.T) {
			writes := 0
			h := composeNASFixture(t, func(w http.ResponseWriter, r *http.Request) {
				r.ParseForm()
				switch r.URL.Path {
				case "/system/polling2":
					nasResponse(w, map[string]any{"pools": []any{map[string]any{"key": "sata1", "mounted": scenario != "unmounted"}}})
				case "/v2/file/info":
					p := r.Form.Get("path")
					if scenario == "wrong-info" {
						p = "/other/my/data"
					}
					nasResponse(w, map[string]any{"path": p, "is_dir": true})
				case "/zdocker/v2/compose/check_projectpath":
					nasResponse(w, map[string]any{"result": scenario == "conflict"})
				case "/zdocker/v2/compose/check_projectname":
					nasResponse(w, map[string]any{"result": scenario != "name-conflict"})
				case "/v2/file/list":
					nasResponse(w, map[string]any{"list": []any{}, "total": 0})
				default:
					writes++
					w.WriteHeader(500)
				}
			})
			payload, _ := json.Marshal(map[string]any{"name": "review", "yaml": "services:\n  db:\n    image: redis:latest\n", "directory": "/sata1/my/data/projects", "preview": true})
			result := dockerRequest(t, h, "/api/docker/compose-create", string(payload), true)
			if result.Code < 400 || writes != 0 {
				t.Fatalf("accepted %s: %d writes=%d", scenario, result.Code, writes)
			}
		})
	}
}
func TestComposeRejectsArbitraryHostPathsEvenWhenAdministrator(t *testing.T) {
	for _, directory := range []string{"/tmp/zfsv3/sata1/_fixture/data", "/sata1/my/data/../private", "/sata1/public/data", "/sata1/other-user/data", "/sata1//my/data", "/etc"} {
		t.Run(directory, func(t *testing.T) {
			h := composeNASFixture(t, func(w http.ResponseWriter, r *http.Request) {
				t.Error("invalid path reached NAS API")
				w.WriteHeader(500)
			})
			payload, _ := json.Marshal(map[string]any{"name": "review", "yaml": "services:\n  db:\n    image: redis:latest\n", "directory": directory, "preview": true})
			result := dockerRequest(t, h, "/api/docker/compose-create", string(payload), true)
			if result.Code != 400 {
				t.Fatalf("accepted host/unscoped path: %d", result.Code)
			}
		})
	}
}

func TestComposeSavedSourceUsesReviewedInheritedEnvironmentAndRestart(t *testing.T) {
	composeNASFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected NAS request") })
	p, err := parseCompose("review", "services:\n  redis:\n    image: redis:latest\n    environment:\n      - MODE\n      - UNSET\n      - TOKEN=$$literal\n", "MODE=test\n")
	if err != nil {
		t.Fatal(err)
	}
	if err = prepareOfficialCompose(httptest.NewRequest("POST", "/", nil), &p); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(p.Source, "MODE: test") || strings.Contains(p.Source, "UNSET") || !strings.Contains(p.Source, "restart: unless-stopped") || !strings.Contains(p.Source, "TOKEN: $$literal") {
		t.Fatalf("saved source differs from preview: %s", p.Source)
	}
}

func TestComposeListIncludesSavedOfficialProjectsWithNoContainers(t *testing.T) {
	h := composeNASFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/zdocker/v2/compose/list_projects":
			nasResponse(w, []any{map[string]any{"id": "saved-id", "projectName": "saved", "pathValid": true, "path": "/sata1/my/data/projects"}})
		case "/zdocker/v2/compose/get_project_file":
			nasResponse(w, map[string]any{"exists": true, "file_content": "services: {}"})
		case "/system/polling2":
			nasResponse(w, map[string]any{"pools": []any{map[string]any{"key": "sata1", "mounted": true}}})
		default:
			t.Errorf("unexpected NAS list operation %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	result := dockerRequest(t, h, "/api/docker/compose", "", true)
	if result.Code != 200 || !strings.Contains(result.Body.String(), `"name":"saved"`) || !strings.Contains(result.Body.String(), `"state":"saved"`) || !strings.Contains(result.Body.String(), `"directory":"/sata1/my/data/projects"`) || !strings.Contains(result.Body.String(), `"total":0`) {
		t.Fatalf("saved project omitted: %d %s", result.Code, result.Body.String())
	}
}
