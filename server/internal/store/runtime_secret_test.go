package store

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func runtimeSecretFixture(t *testing.T) (*testRig, *http.Client, string) {
	t.Helper()
	_, _, mux, admin := cloudPublicationRig(t)
	draft := cloudDraft()
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, draft); status != 201 {
		t.Fatal(status)
	}
	if status, out := cloudCall(t, mux, "POST", "/api/store/admin/apps/test-app/publish", admin, map[string]any{}); status != 200 {
		t.Fatal(status, out)
	}
	token := cloudRegister(t, mux, "nasuser")
	client := &http.Client{Transport: cloudRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("X-Store-Session") != "" {
			t.Fatal("NAS session reached cloud")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		return w.Result(), nil
	})}
	r, engine := controllerRig(t)
	r.s.engine = &secretControllerEngine{controllerEngine: engine}
	return r, client, token
}

type secretControllerEngine struct{ *controllerEngine }

func (e *secretControllerEngine) PrepareGeneration(ctx context.Context, p RuntimePlan) (RuntimeGeneration, error) {
	g, err := e.controllerEngine.PrepareGeneration(ctx, p)
	if err != nil {
		return g, err
	}
	g.SecretSetID = p.SecretSetID
	e.runtimeMu.Lock()
	e.generations[g.ID] = g
	e.runtimeMu.Unlock()
	return g, nil
}
func runtimeSecretPlan(t *testing.T, r *testRig, client *http.Client, cloudToken, secret string) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"appId": "test-app", "rootId": "storage", "name": "secret-data", "hostPort": 32319, "allowSecretEnvironment": true, "secretParameters": map[string]string{"admin-password": secret}})
	req := httptest.NewRequest("POST", "/api/store/v2/cloud/install-plan", bytes.NewReader(body))
	req.Header.Set("X-Store-Session", r.token)
	req.Header.Set("X-Cloud-Session", cloudToken)
	w := httptest.NewRecorder()
	r.s.auth(func(w http.ResponseWriter, req *http.Request) { r.s.runtimeCloudInstallPlanWithClient(w, req, client) })(w, req)
	var out map[string]any
	if json.Unmarshal(w.Body.Bytes(), &out) != nil {
		t.Fatal("invalid secret response")
	}
	return w.Code, out
}
func TestRuntimeSecretPlanStoresOnlyCiphertextAndBindsApproval(t *testing.T) {
	r, client, token := runtimeSecretFixture(t)
	secret := "synthetic-local-password-9"
	status, out := runtimeSecretPlan(t, r, client, token, secret)
	if status != 201 {
		t.Fatal("secret plan", status, out)
	}
	raw, _ := json.Marshal(out)
	if bytes.Contains(raw, []byte(secret)) || bytes.Contains(raw, []byte(token)) {
		t.Fatal("response leaked secret")
	}
	var plan RuntimePlan
	data, _ := json.Marshal(out["data"])
	json.Unmarshal(data, &plan)
	if plan.SecretSetID == "" || plan.Recipe.Services[0].Environment["ADMIN_PASSWORD"] != "$secret:admin-password" {
		t.Fatal("missing opaque secret binding")
	}
	for _, table := range []string{"runtime_plans", "runtime_cloud_recipes"} {
		rows, err := r.s.db.Query(`SELECT body FROM ` + table)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var body string
			rows.Scan(&body)
			if strings.Contains(body, secret) {
				t.Fatal("plaintext persisted", table)
			}
		}
		rows.Close()
	}
	var ciphertext []byte
	if err := r.s.db.QueryRow(`SELECT ciphertext FROM runtime_secret_sets WHERE id=?`, plan.SecretSetID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte(secret)) {
		t.Fatal("plaintext encryption record")
	}
	manager, err := r.s.runtimeSecretManager()
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(manager.keyPath)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("private master key permissions", err)
	}
	values, err := manager.openForPlan(context.Background(), r.s.db, plan)
	if err != nil || values["ADMIN_PASSWORD"] != secret {
		t.Fatal("scoped decryption", err)
	}
	foreign := plan
	foreign.InstanceID = randomID()
	if _, err := manager.openForPlan(context.Background(), r.s.db, foreign); err == nil {
		t.Fatal("foreign instance decrypted")
	}
	foreign = plan
	foreign.Recipe.Revision = "tampered"
	if _, err := manager.openForPlan(context.Background(), r.s.db, foreign); err == nil {
		t.Fatal("foreign manifest decrypted")
	}
	if _, err := r.s.db.Exec(`UPDATE runtime_secret_sets SET ciphertext=? WHERE id=?`, append([]byte{1}, ciphertext[1:]...), plan.SecretSetID); err != nil {
		t.Fatal(err)
	}
	if status, _ := r.call("POST", "/api/store/v2/execute", `{"planId":"`+plan.ID+`","requestId":"secret-tampered"}`, "127.0.0.1:1"); status != 409 {
		t.Fatal("tampered secrets approved", status)
	}
}
func TestRuntimeSecretKnownSessionsAndMissingRequiredValuesAreRejected(t *testing.T) {
	r, client, token := runtimeSecretFixture(t)
	for _, secret := range []string{"", token, r.token} {
		if status, _ := runtimeSecretPlan(t, r, client, token, secret); status != 400 {
			t.Fatal("invalid secret parameter", status)
		}
	}
}
func TestRuntimeSecretCiphertextOwnerCannotBeRebound(t *testing.T) {
	r, client, token := runtimeSecretFixture(t)
	status, out := runtimeSecretPlan(t, r, client, token, "synthetic-bound-secret")
	if status != 201 {
		t.Fatal(status, out)
	}
	var plan RuntimePlan
	data, _ := json.Marshal(out["data"])
	json.Unmarshal(data, &plan)
	manager, err := r.s.runtimeSecretManager()
	if err != nil {
		t.Fatal(err)
	}
	var scopeRaw string
	if err := r.s.db.QueryRow(`SELECT scope FROM runtime_secret_sets WHERE id=?`, plan.SecretSetID).Scan(&scopeRaw); err != nil {
		t.Fatal(err)
	}
	var scope runtimeSecretScope
	if json.Unmarshal([]byte(scopeRaw), &scope) != nil {
		t.Fatal("scope decoding")
	}
	scope.OwnerHash = "another-account"
	tamperedScope, _ := json.Marshal(scope)
	if _, err := r.s.db.Exec(`UPDATE runtime_secret_sets SET scope=? WHERE id=?`, string(tamperedScope), plan.SecretSetID); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.openForPlan(context.Background(), r.s.db, plan); err == nil {
		t.Fatal("ciphertext owner metadata not authenticated")
	}
	if status, _ := r.call("POST", "/api/store/v2/execute", `{"planId":"`+plan.ID+`","requestId":"secret-foreign"}`, "127.0.0.1:1"); status != 409 {
		t.Fatal("foreign owner approved", status)
	}
}

func TestRuntimeSecretOwnerSurvivesRefreshedNasGrant(t *testing.T) {
	r := newRig(t)
	request := func(token, username string) *http.Request {
		entry := &nasMemorySession{username: username, credentials: nasCredentials{ProviderID: "https://nas.example", NASID: "stable-nas", Token: token}}
		req := httptest.NewRequest("POST", "/approve", nil)
		req.Header.Set("X-Store-Session", randomID())
		return req.WithContext(context.WithValue(req.Context(), nasGrantKey{}, nasRequestGrant{hash: randomID(), entry: entry}))
	}
	one, err := r.s.runtimeSecretOwnerHash(request("first-synthetic-token", "owner"), r.s.db)
	if err != nil {
		t.Fatal(err)
	}
	two, err := r.s.runtimeSecretOwnerHash(request("refreshed-synthetic-token", "owner"), r.s.db)
	if err != nil || one != two {
		t.Fatal("renewed NAS grant changed owner", err)
	}
	other, err := r.s.runtimeSecretOwnerHash(request("third-synthetic-token", "other-owner"), r.s.db)
	if err != nil || one == other {
		t.Fatal("different administrator shares secret owner")
	}
}

func TestRuntimeSecretHostTransportUsesPrivateFileAndRedactsOutput(t *testing.T) {
	r, client, token := runtimeSecretFixture(t)
	secret := "synthetic-private-transport"
	status, out := runtimeSecretPlan(t, r, client, token, secret)
	if status != 201 {
		t.Fatal(status, out)
	}
	var plan RuntimePlan
	raw, _ := json.Marshal(out["data"])
	json.Unmarshal(raw, &plan)
	manager, err := r.s.runtimeSecretManager()
	if err != nil {
		t.Fatal(err)
	}
	g := RuntimeGeneration{SecretSetID: plan.SecretSetID, ID: plan.GenerationID, StoreID: plan.StoreID, InstanceID: plan.InstanceID, Recipe: plan.Recipe, RecipeRevision: plan.Recipe.Revision}
	var filePath string
	e := &commandEngine{mode: "local", secrets: manager, runner: func(_ context.Context, command string, args ...string) (string, string, error) {
		if strings.Contains(strings.Join(args, " "), secret) {
			t.Fatal("secret entered argv")
		}
		var payload struct {
			SecretFile string `json:"secretFile"`
		}
		if json.Unmarshal([]byte(args[3]), &payload) != nil {
			t.Fatal("private path payload")
		}
		filePath = payload.SecretFile
		info, err := os.Stat(filePath)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("temporary secret file permission")
		}
		body, err := os.ReadFile(filePath)
		if err != nil || !bytes.Contains(body, []byte(secret)) {
			t.Fatal("secret unavailable to private host runtime")
		}
		return `{"logs":"` + secret + `"}`, "", nil
	}}
	var result map[string]string
	if err := e.runtimeHost(context.Background(), "logs", map[string]any{"generation": g}, &result); err != nil {
		t.Fatal(err)
	}
	if result["logs"] != "[redacted]" {
		t.Fatal("runtime output secret not redacted")
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatal("transient plaintext file retained")
	}
}

func TestRuntimeSecretInstallAndControlKeepEncryptedBinding(t *testing.T) {
	r, client, token := runtimeSecretFixture(t)
	status, out := runtimeSecretPlan(t, r, client, token, "synthetic-control-password")
	if status != 201 {
		t.Fatal(status, out)
	}
	var plan RuntimePlan
	body, _ := json.Marshal(out["data"])
	json.Unmarshal(body, &plan)
	job := controllerSubmit(t, r, plan, "secret-install")
	job = controllerWait(t, r, job.ID)
	if job.Status != "succeeded" {
		t.Fatal("secret install", job.Error)
	}
	fresh, err := r.s.newSession("synthetic-admin")
	if err != nil {
		t.Fatal(err)
	}
	r.token = fresh["sessionId"].(string)
	stop := controllerPlan(t, r, `{"kind":"stop","instanceId":"`+plan.InstanceID+`"}`)
	if stop.SecretSetID != plan.SecretSetID {
		t.Fatal("control lost original encrypted binding")
	}
	job = controllerSubmit(t, r, stop, "secret-stop")
	job = controllerWait(t, r, job.ID)
	if job.Status != "succeeded" {
		t.Fatal("renewed session control", job.Error)
	}
	if status, out := r.call("POST", "/api/store/v2/plans", `{"kind":"backup","instanceId":"`+plan.InstanceID+`"}`, "127.0.0.1:1"); status != 422 || out["error"].(map[string]any)["code"] != "secret_generation_operation_unsupported" {
		t.Fatal("unverified backup enabled", status, out)
	}
	if status, out := r.call("POST", "/api/store/v2/plans", `{"kind":"update","instanceId":"`+plan.InstanceID+`","targetVersion":"`+plan.TargetVersion+`"}`, "127.0.0.1:1"); status != 422 || out["error"].(map[string]any)["code"] != "secret_generation_operation_unsupported" {
		t.Fatal("unverified secret update enabled", status, out)
	}
}
