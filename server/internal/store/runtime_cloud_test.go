package store

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"spacedesktop/server/internal/storemanifest"
)

func runtimeCloudFixture(t *testing.T) (*testRig, *http.Client, string) {
	t.Helper()
	_, _, mux, admin := cloudPublicationRig(t)
	draft := cloudDraft()
	draft["environment"] = []map[string]any{{"name": "MODE", "label": "Mode", "secret": false, "default": "public"}}
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, draft); status != 201 {
		t.Fatal(status)
	}
	if status, out := cloudCall(t, mux, "POST", "/api/store/admin/apps/test-app/publish", admin, map[string]any{}); status != 200 {
		t.Fatal(status, out)
	}
	token := cloudRegister(t, mux, "nasuser")
	client := &http.Client{Transport: cloudRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Scheme != "https" || req.URL.Host != "zstore.2iwm.com" || req.Header.Get("X-Store-Session") != "" || req.Header.Get("X-Cloud-Session") != "" {
			t.Fatal("NAS credential or arbitrary cloud origin")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		return w.Result(), nil
	})}
	r, _ := controllerRig(t)
	return r, client, token
}
func runtimeCloudPlan(t *testing.T, r *testRig, client *http.Client, token string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/store/v2/cloud/install-plan", strings.NewReader(`{"appId":"test-app","rootId":"storage","name":"cloud-data","hostPort":32314}`))
	req.Header.Set("X-Store-Session", r.token)
	req.Header.Set("X-Cloud-Session", token)
	w := httptest.NewRecorder()
	r.s.auth(func(w http.ResponseWriter, req *http.Request) { r.s.runtimeCloudInstallPlanWithClient(w, req, client) })(w, req)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal("invalid local cloud response")
	}
	return w.Code, out
}
func TestRuntimeCloudSignedManifestPlansInstallsAndPersists(t *testing.T) {
	r, client, token := runtimeCloudFixture(t)
	status, out := runtimeCloudPlan(t, r, client, token)
	if status != 201 {
		t.Fatal("signed install plan", status, out)
	}
	raw, _ := json.Marshal(out["data"])
	var plan RuntimePlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.AppID != "cloud-test-app" || plan.Recipe.Services[0].Volumes[0].Target != "/data" || plan.HostPort != 32314 || validateRuntimePlan(plan) != nil {
		t.Fatal("cloud plan did not retain runtime guards")
	}
	if strings.Contains(string(raw), token) {
		t.Fatal("cloud session persisted in plan")
	}
	job := controllerSubmit(t, r, plan, "cloud-install-test")
	job = controllerWait(t, r, job.ID)
	if job.Status != "succeeded" {
		t.Fatal("cloud execution", job.Status, job.Error)
	}
	if status, out := r.call("GET", "/api/store/v2/desktop", "", "127.0.0.1:1"); status != 200 || len(out["data"].(map[string]any)["items"].([]any)) != 1 {
		t.Fatal("cloud app missing desktop")
	}
	if err := r.s.initRuntimeCloud(); err != nil {
		t.Fatal("recipe hydration", err)
	}
	if recipe, ok := r.s.runtimeRecipeFor(plan.AppID, plan.TargetVersion); !ok || validateRuntimeRecipe(recipe) != nil {
		t.Fatal("cloud recipe unavailable after hydration")
	}
}
func TestRuntimeCloudSignatureAndNasAuthenticationFailClosed(t *testing.T) {
	r, client, token := runtimeCloudFixture(t)
	localToken := r.token
	r.token = ""
	if status, _ := runtimeCloudPlan(t, r, client, token); status != 401 {
		t.Fatal("anonymous NAS cloud mutation", status)
	}
	r.token = localToken
	if status, _ := runtimeCloudPlan(t, r, client, strings.Repeat("f", 48)); status != 502 {
		t.Fatal("cloud account session not required", status)
	}
	transport := client.Transport
	tampered := &http.Client{Transport: cloudRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(req)
		if err != nil {
			return nil, err
		}
		if strings.HasSuffix(req.URL.Path, "/catalog/signed") {
			raw, _ := io.ReadAll(response.Body)
			response.Body.Close()
			var data map[string]any
			json.Unmarshal(raw, &data)
			data["data"].(map[string]any)["payloadBase64"] = base64.StdEncoding.EncodeToString([]byte(`{}`))
			body, _ := json.Marshal(data)
			response.Body = io.NopCloser(bytes.NewReader(body))
		}
		return response, nil
	})}
	if status, _ := runtimeCloudPlan(t, r, tampered, token); status != 502 {
		t.Fatal("tampered signed payload accepted", status)
	}
	if status, _ := runtimeCloudPlan(t, r, client, token); status != 201 {
		t.Fatal("pinning verified publication", status)
	}
	changedKey := &http.Client{Transport: cloudRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(req)
		if err != nil {
			return nil, err
		}
		if strings.HasSuffix(req.URL.Path, "/catalog-key") {
			raw, _ := io.ReadAll(response.Body)
			response.Body.Close()
			var data map[string]any
			json.Unmarshal(raw, &data)
			data["data"].(map[string]any)["publicKey"] = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
			body, _ := json.Marshal(data)
			response.Body = io.NopCloser(bytes.NewReader(body))
		}
		return response, nil
	})}
	if status, _ := runtimeCloudPlan(t, r, changedKey, token); status != 409 {
		t.Fatal("changed cloud trust key accepted", status)
	}
}
func TestRuntimeCloudCompilerBlocksSecretsAndUnsupportedPermission(t *testing.T) {
	_, c, _, _ := cloudPublicationRig(t)
	var app CloudApp
	b, _ := json.Marshal(cloudDraft())
	json.Unmarshal(b, &app)
	app.ReleaseNumber = 1
	info, _ := c.resolveImage(t.Context(), app.Image)
	raw, err := c.compileManifest(app, info)
	if err != nil {
		t.Fatal(err)
	}
	doc, issues := storemanifest.Parse(raw)
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	if _, err := compileRuntimeCloud(doc.Manifest, nil); err == nil {
		t.Fatal("secret manifest entered persistent runtime")
	}
	doc.Manifest.Parameters = map[string]storemanifest.Parameter{}
	doc.Manifest.Runtime.Services[0].Environment = map[string]storemanifest.EnvironmentValue{}
	doc.Manifest.Runtime.PermissionProfile = "host-monitor-v1"
	if _, err := compileRuntimeCloud(doc.Manifest, nil); err == nil {
		t.Fatal("privileged profile accepted")
	}
}

func TestRuntimeCloudKnownSessionsCannotEnterPublicParameters(t *testing.T) {
	r, client, token := runtimeCloudFixture(t)
	body, _ := json.Marshal(map[string]any{"appId": "test-app", "rootId": "storage", "name": "cloud-private", "hostPort": 32317, "parameters": map[string]string{"mode": token}})
	req := httptest.NewRequest("POST", "/api/store/v2/cloud/install-plan", bytes.NewReader(body))
	req.Header.Set("X-Store-Session", r.token)
	req.Header.Set("X-Cloud-Session", token)
	w := httptest.NewRecorder()
	r.s.auth(func(w http.ResponseWriter, req *http.Request) { r.s.runtimeCloudInstallPlanWithClient(w, req, client) })(w, req)
	if w.Code != 400 {
		t.Fatalf("cloud session accepted as public persisted parameter: %d", w.Code)
	}
}
