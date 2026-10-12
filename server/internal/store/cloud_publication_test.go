package store

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"spacedesktop/server/internal/storemanifest"
)

func cloudPublicationRig(t *testing.T) (*testRig, *cloudService, *http.ServeMux, string) {
	t.Helper()
	r := newRig(t)
	c, err := newCloudService(r.s)
	if err != nil {
		t.Fatal(err)
	}
	c.resolveImage = func(context.Context, string) (CloudImageInspection, error) {
		return CloudImageInspection{Image: "docker.io/library/nginx:stable", ImageDigest: "sha256:" + strings.Repeat("a", 64), Architecture: "linux/amd64", ExposedPorts: []int{80}, SuggestedName: "nginx"}, nil
	}
	mux := http.NewServeMux()
	c.register(mux)
	return r, c, mux, cloudAdmin(t, r, mux)
}
func cloudDraft() map[string]any {
	return map[string]any{"id": "test-app", "name": "Test app", "description": "A public Docker application", "category": "tools", "icon": "https://raw.githubusercontent.com/isle24/catalog/main/icon.png", "image": "nginx:stable", "version": "1.0", "containerPort": 80, "dataTargets": []string{"/data"}, "environment": []map[string]any{{"name": "MODE", "label": "Mode", "secret": false, "default": "public"}, {"name": "ADMIN_PASSWORD", "label": "Administrator password", "secret": true}}}
}

func TestCloudPublishCreatesValidatedImmutableManifest(t *testing.T) {
	r, c, mux, admin := cloudPublicationRig(t)
	status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, cloudDraft())
	if status != 201 {
		t.Fatal("save", status)
	}
	draftApp, err := c.readApp("test-app", false)
	if err != nil {
		t.Fatal(err)
	}
	draftApp.ReleaseNumber = 1
	info, err := c.resolveImage(context.Background(), draftApp.Image)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.compileManifest(draftApp, info); err != nil {
		t.Fatal(err)
	}
	user := cloudRegister(t, mux, "alice")
	if status, _ := cloudCall(t, mux, "GET", "/api/cloud/catalog/test-app", user, nil); status != 404 {
		t.Fatal("draft leaked", status)
	}
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/apps/test-app/publish", admin, map[string]any{})
	if status != 200 {
		t.Fatal("publish", status, out)
	}
	data := out["data"].(map[string]any)
	app := data["app"].(map[string]any)
	if app["published"] != true || app["releaseNumber"] != float64(1) || app["githubSync"] != "not-configured" {
		t.Fatal("publish result", app)
	}
	if !strings.Contains(app["image"].(string), "@sha256:") {
		t.Fatal("mutable image published")
	}
	b, _ := json.Marshal(data["manifest"])
	doc, issues := storemanifest.Parse(b)
	if len(issues) != 0 || doc == nil {
		t.Fatal("invalid manifest", issues)
	}
	if doc.Manifest.Runtime.PermissionProfile != "restricted-v1" || doc.Manifest.Runtime.Services[0].Image.ManifestDigest == nil {
		t.Fatal("publication permissions/digest")
	}
	if doc.Manifest.Runtime.Services[0].UserMode != "host" {
		t.Fatal("managed volume user does not match controller owner")
	}
	if _, ok := doc.Manifest.Parameters["admin-password"]; !ok {
		t.Fatal("secret input missing")
	}
	if len(doc.Manifest.Parameters["admin-password"].Default) != 0 {
		t.Fatal("secret default published")
	}
	draft := cloudDraft()
	draft["name"] = "Changed draft"
	draft["version"] = "2.0"
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, draft); status != 200 {
		t.Fatal("edit draft", status)
	}
	status, out = cloudCall(t, mux, "GET", "/api/cloud/catalog/test-app", user, nil)
	if status != 200 || out["data"].(map[string]any)["app"].(map[string]any)["name"] != "Test app" {
		t.Fatal("live release mutated")
	}
	c.resolveImage = func(context.Context, string) (CloudImageInspection, error) {
		return CloudImageInspection{}, errors.New("private token must never appear")
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps/test-app/publish", admin, map[string]any{}); status != 422 {
		t.Fatal("failed resolve published", status)
	}
	var n int
	if err := r.s.db.QueryRow(`SELECT count(*) FROM cloud_releases`).Scan(&n); err != nil || n != 1 {
		t.Fatal("failed publish damaged releases", n, err)
	}
}

func TestCloudDraftRejectsUnsafeSourcesTargetsAndSecretDefaults(t *testing.T) {
	_, _, mux, admin := cloudPublicationRig(t)
	for _, change := range []map[string]any{
		{"image": "http://127.0.0.1:5000/app"},
		{"image": "localhost:5000/app"},
		{"image": "registry.example.com/app"},
		{"dataTargets": []string{"/var/run/docker.sock"}},
		{"dataTargets": []string{"/proc"}},
		{"dataTargets": []string{"/data/../root"}},
		{"environment": []map[string]any{{"name": "ADMIN_PASSWORD", "label": "Password", "secret": true, "default": "must-not-save"}}},
		{"environment": []map[string]any{{"name": "API_TOKEN", "label": "Token", "secret": false, "default": "must-not-save"}}},
		{"icon": "https://127.0.0.1/icon.png"},
	} {
		draft := cloudDraft()
		for key, value := range change {
			draft[key] = value
		}
		if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, draft); status != 400 {
			t.Fatal("unsafe draft accepted", status, change)
		}
	}
}

func TestCloudCatalogSigningKeyIsStableAndPayloadAuthentic(t *testing.T) {
	r, _, mux, admin := cloudPublicationRig(t)
	cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, cloudDraft())
	cloudCall(t, mux, "POST", "/api/store/admin/apps/test-app/publish", admin, map[string]any{})
	user := cloudRegister(t, mux, "alice")
	status, out := cloudCall(t, mux, "GET", "/api/cloud/catalog/signed", user, nil)
	if status != 200 {
		t.Fatal("signed endpoint", status, out)
	}
	data := out["data"].(map[string]any)
	key, err := base64.StdEncoding.DecodeString(data["publicKey"].(string))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := base64.StdEncoding.DecodeString(data["payloadBase64"].(string))
	if err != nil {
		t.Fatal(err)
	}
	signatures := data["envelope"].(map[string]any)["signatures"].([]any)
	signature, _ := base64.StdEncoding.DecodeString(signatures[0].(map[string]any)["signature"].(string))
	if !ed25519.Verify(key, payload, signature) {
		t.Fatal("invalid catalog signature")
	}
	other, err := newCloudService(r.s)
	if err != nil {
		t.Fatal(err)
	}
	nextMux := http.NewServeMux()
	other.register(nextMux)
	_, otherOut := cloudCall(t, nextMux, "GET", "/api/cloud/catalog-key", "", nil)
	if otherOut["data"].(map[string]any)["publicKey"] != data["publicKey"] {
		t.Fatal("key changed on reopen")
	}
}
