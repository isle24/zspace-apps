package store

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudIconUploadNormalizesAndServesOnlyControlledBytes(t *testing.T) {
	_, _, mux, admin := cloudPublicationRig(t)
	pixels := image.NewRGBA(image.Rect(0, 0, 4, 4))
	pixels.Set(1, 1, color.RGBA{R: 123, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, pixels); err != nil {
		t.Fatal(err)
	}
	draft := cloudDraft()
	draft["iconData"] = map[string]string{"mimeType": "image/png", "base64": base64.StdEncoding.EncodeToString(buf.Bytes())}
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, draft)
	if status != 201 {
		t.Fatal("icon upload", status, out)
	}
	icon := out["data"].(map[string]any)["app"].(map[string]any)["icon"].(string)
	if !cloudTokenIconRE.MatchString(icon) {
		t.Fatal("uncontrolled icon URL")
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", icon, nil))
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || tokenHash(w.Body.String()) != strings.TrimPrefix(icon, "/api/cloud/icons/") {
		t.Fatal("icon response content")
	}
	status, out = cloudCall(t, mux, "POST", "/api/store/admin/apps/test-app/publish", admin, map[string]any{})
	if status != 200 {
		t.Fatal("asset manifest", status, out)
	}
	metadata := out["data"].(map[string]any)["manifest"].(map[string]any)["metadata"].(map[string]any)
	if metadata["icon"].(map[string]any)["kind"] != "asset" {
		t.Fatal("uploaded asset absent from manifest")
	}
	draft["iconData"] = map[string]string{"mimeType": "image/svg+xml", "base64": base64.StdEncoding.EncodeToString([]byte(`<svg onload="steal()"/>`))}
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, draft); status != 400 {
		t.Fatal("active SVG accepted", status)
	}
}

type cloudRoundTripFunc func(*http.Request) (*http.Response, error)

func (f cloudRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestCloudGithubTokenIsEncryptedAndExporterScopesPublicRecords(t *testing.T) {
	r, c, mux, admin := cloudPublicationRig(t)
	token := "synthetic-token-for-test-only"
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/cloud-settings", admin, map[string]string{"githubRepository": "acme/catalog", "githubToken": token})
	if status != 200 {
		t.Fatal("settings", status, out)
	}
	encoded, _ := json.Marshal(out)
	if bytes.Contains(encoded, []byte(token)) {
		t.Fatal("settings leaked token")
	}
	var stored []byte
	if err := r.s.db.QueryRow(`SELECT value FROM cloud_private WHERE key='github_token'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte(token)) {
		t.Fatal("token saved in cleartext")
	}
	requests := 0
	blobBodies := []string{}
	treePaths := []string{}
	c.githubClient = &http.Client{Transport: cloudRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests++
		if req.URL.Host != "api.github.com" || !strings.HasPrefix(req.URL.Path, "/repos/acme/catalog") || req.Header.Get("Authorization") != "Bearer "+token {
			t.Fatal("Github destination/auth")
		}
		var body map[string]any
		if req.Body != nil {
			json.NewDecoder(req.Body).Decode(&body)
		}
		response := `{"sha":"created"}`
		switch {
		case req.Method == "GET" && req.URL.Path == "/repos/acme/catalog":
			response = `{"default_branch":"main"}`
		case strings.Contains(req.URL.Path, "/git/ref/"):
			response = `{"object":{"sha":"head"}}`
		case req.Method == "GET" && strings.Contains(req.URL.Path, "/git/commits/"):
			response = `{"tree":{"sha":"base-tree"}}`
		case strings.HasSuffix(req.URL.Path, "/git/blobs"):
			raw, _ := base64.StdEncoding.DecodeString(body["content"].(string))
			blobBodies = append(blobBodies, string(raw))
			if strings.Contains(string(raw), token) || strings.Contains(string(raw), "password_hash") || strings.Contains(string(raw), "signing_seed") {
				t.Fatal("private data exported")
			}
		case strings.HasSuffix(req.URL.Path, "/git/trees"):
			for _, entry := range body["tree"].([]any) {
				treePaths = append(treePaths, entry.(map[string]any)["path"].(string))
			}
		case req.Method == "PATCH":
			if body["force"] != false {
				t.Fatal("forced Github rewrite")
			}
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(response)), Header: http.Header{}}, nil
	})}
	cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, cloudDraft())
	status, out = cloudCall(t, mux, "POST", "/api/store/admin/apps/test-app/publish", admin, map[string]any{})
	if status != 200 || out["data"].(map[string]any)["app"].(map[string]any)["githubSync"] != "synced" {
		t.Fatal("Github sync", status, out)
	}
	if requests < 7 || len(blobBodies) < 4 {
		t.Fatal("no public Github publication")
	}
	for _, p := range treePaths {
		if !strings.HasPrefix(p, "apps/") && !strings.HasPrefix(p, "manifests/") && !strings.HasPrefix(p, "icons/") && !strings.HasPrefix(p, "catalogs/") && p != "catalog-key.json" && p != "catalog-envelope.json" && p != "catalog-apps.json" {
			t.Fatal("out-of-scope path", p)
		}
	}
	if status, out := cloudCall(t, mux, "POST", "/api/store/admin/cloud-settings", admin, map[string]any{"githubRepository": "acme/catalog", "githubToken": ""}); status != 200 || out["data"].(map[string]any)["githubTokenConfigured"] != false {
		t.Fatal("token clearing", status, out)
	}
}

func TestCloudRegistryTargetsRejectCredentialAndLocalReferences(t *testing.T) {
	for _, ref := range []string{"localhost:5000/app:latest", "192.168.0.1:5000/app", "registry.example.com/app", "https://ghcr.io/acme/app", "ghcr.io/acme/app?token=synthetic", "ghcr.io/acme/app#bad", "ghcr.io/user:pass@app"} {
		if _, err := cloudImageReference(ref); err == nil {
			t.Fatal("unsafe registry reference", ref)
		}
	}
	for _, ref := range []string{"nginx:stable", "docker.io/library/nginx:stable", "ghcr.io/acme/app:1", "ghcr.io/acme/app@sha256:" + strings.Repeat("a", 64)} {
		if _, err := cloudImageReference(ref); err != nil {
			t.Fatal("public reference rejected", ref, err)
		}
	}
}

func TestCloudPostgresBindPreservesParameterizedArguments(t *testing.T) {
	q := `INSERT INTO cloud_history(id,user_id,app_id) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`
	if got := cloudBind(q, true); got != `INSERT INTO cloud_history(id,user_id,app_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING` {
		t.Fatal(got)
	}
	if cloudBind(q, false) != q {
		t.Fatal("SQLite query changed")
	}
}
