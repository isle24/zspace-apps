package store

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

func cloudAIRig(t *testing.T) (*testRig, *cloudService, *http.ServeMux, string) {
	t.Helper()
	r, c, _, admin := cloudPublicationRig(t)
	mux := http.NewServeMux()
	c.registerAdminAssist(mux)
	return r, c, mux, admin
}

func TestCloudAISettingsEncryptKeyAndPreserveOmittedKey(t *testing.T) {
	r, c, mux, admin := cloudAIRig(t)
	token := "synthetic-ai-key-only"
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/ai-settings", admin, map[string]any{"endpoint": "https://api.openai.com/v1", "model": "example-model", "apiKey": token})
	if status != 200 {
		t.Fatal(status, out)
	}
	encoded, _ := json.Marshal(out)
	if bytes.Contains(encoded, []byte(token)) {
		t.Fatal("key echoed")
	}
	var stored []byte
	if err := r.s.db.QueryRow(`SELECT value FROM cloud_private WHERE key='ai_api_key'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte(token)) {
		t.Fatal("cleartext key stored")
	}
	status, out = cloudCall(t, mux, "POST", "/api/store/admin/ai-settings", admin, map[string]any{"endpoint": "https://api.openai.com/v1", "model": "second-model"})
	if status != 200 {
		t.Fatal(status, out)
	}
	settings, err := c.aiSettings(context.Background())
	if err != nil || settings.APIKey != token || settings.Model != "second-model" {
		t.Fatal("omitted key not preserved")
	}
	status, out = cloudCall(t, mux, "GET", "/api/store/admin/ai-settings", admin, nil)
	if status != 200 || out["data"].(map[string]any)["apiKeyConfigured"] != true {
		t.Fatal(status, out)
	}
	encoded, _ = json.Marshal(out)
	if bytes.Contains(encoded, []byte(token)) {
		t.Fatal("GET leaked key")
	}
	if status, _ := cloudCall(t, mux, "GET", "/api/store/admin/ai-settings", "", nil); status != 401 {
		t.Fatal("anonymous settings", status)
	}
}

func TestCloudAIEndpointRejectsPrivateAndCredentialDestinations(t *testing.T) {
	for _, raw := range []string{"http://api.openai.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://192.168.1.1/v1", "https://[::1]/v1", "https://169.254.169.254/v1", "https://user:pass@api.openai.com/v1", "https://api.openai.com/v1?key=hidden", "https://api.openai.com:444/v1", "https://api.openai.com/../v1"} {
		if _, err := cloudAIEndpoint(raw); err == nil {
			t.Fatal("unsafe endpoint accepted", raw)
		}
	}
}

func TestCloudAIRejectsInvalidStructuredJSONAndStripsSecretDefaults(t *testing.T) {
	draft := map[string]any{"id": "reader", "name": "Reader", "description": "A reading app", "category": "reading", "icon": "https://127.0.0.1/icon.png", "version": "1.0", "containerPort": 80, "dataTargets": []string{"/data"}, "environment": []map[string]any{{"name": "API_TOKEN", "label": "Access token", "secret": false, "default": "hidden-token"}}}
	raw, _ := json.Marshal(map[string]any{"app": draft, "warnings": []string{"Confirm the storage directory"}})
	app, warnings, err := parseCloudAIResult(raw, "nginx:stable")
	if err != nil {
		t.Fatal(err)
	}
	if len(app.Environment) != 1 || !app.Environment[0].Secret || app.Environment[0].Default != nil {
		t.Fatal("secret default retained")
	}
	if app.Icon != "" || len(warnings) < 3 {
		t.Fatal("unsafe icon/assumptions not surfaced", app.Icon, warnings)
	}
	for _, bad := range []string{`{"app":{"id":"x"}}`, `{"app":{},"shell":"rm -rf /"}`, string(raw) + ` {}`, `markdown ` + string(raw)} {
		if _, _, err := parseCloudAIResult([]byte(bad), "nginx:stable"); err == nil {
			t.Fatal("invalid AI JSON accepted")
		}
	}
	draft["dataTargets"] = []string{"/var/run/docker.sock"}
	raw, _ = json.Marshal(map[string]any{"app": draft, "warnings": []string{}})
	if _, _, err := parseCloudAIResult(raw, "nginx:stable"); err == nil {
		t.Fatal("dangerous AI draft accepted")
	}
}

func TestCloudAICompletionBoundsResponseAndDoesNotExposeUpstreamErrors(t *testing.T) {
	settings := cloudAISettings{Endpoint: "https://api.openai.com/v1", Model: "example", APIKey: "never-echo-me"}
	client := &http.Client{Transport: cloudRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://api.openai.com/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer "+settings.APIKey {
			t.Fatal("AI destination/auth")
		}
		body, _ := io.ReadAll(r.Body)
		if bytes.Contains(body, []byte(settings.APIKey)) {
			t.Fatal("key in prompt")
		}
		return &http.Response{StatusCode: 401, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":"never-echo-me"}`))}, nil
	})}
	if _, err := cloudAICompletion(context.Background(), settings, CloudImageInspection{Image: "nginx:stable", SuggestedName: "nginx", ExposedPorts: []int{80}}, client); err == nil || strings.Contains(err.Error(), settings.APIKey) {
		t.Fatal("upstream details exposed")
	}
	client.Transport = cloudRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", cloudAIResponseLimit+1)))}, nil
	})
	if _, err := cloudAICompletion(context.Background(), settings, CloudImageInspection{Image: "nginx:stable"}, client); err == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestCloudAIFallbackIconIsDeterministicControlledPNG(t *testing.T) {
	_, c, _, _ := cloudAIRig(t)
	one, err := c.aiFallbackIcon(context.Background(), CloudApp{ID: "reader", Name: "Reader"})
	if err != nil || !cloudTokenIconRE.MatchString(one) {
		t.Fatal(one, err)
	}
	two, err := c.aiFallbackIcon(context.Background(), CloudApp{ID: "reader", Name: "Reader"})
	if err != nil || one != two {
		t.Fatal("fallback changes across calls")
	}
	var stored []byte
	if err := c.db.QueryRow(`SELECT body FROM cloud_icons WHERE hash=?`, strings.TrimPrefix(one, "/api/cloud/icons/")).Scan(&stored); err != nil || !bytes.HasPrefix(stored, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatal("fallback not PNG")
	}
}

func TestCloudAIPublicAddressesExcludeReservedNetworks(t *testing.T) {
	for _, raw := range []string{"0.1.2.3", "100.64.1.2", "198.18.1.2", "192.0.2.1", "2001:db8::1", "fec0::1", "::ffff:127.0.0.1"} {
		ip, err := netip.ParseAddr(raw)
		if err != nil {
			t.Fatal(err)
		}
		if cloudAIPublicIP(ip) {
			t.Fatal("reserved address accepted", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !cloudAIPublicIP(netip.MustParseAddr(raw)) {
			t.Fatal("public address rejected", raw)
		}
	}
}

func TestCloudAIEndpointAcceptsRootAndBasePath(t *testing.T) {
	for _, raw := range []string{"https://api.openai.com", "https://api.openai.com/", "https://api.openai.com/v1/"} {
		if _, err := cloudAIEndpoint(raw); err != nil {
			t.Fatal("base path rejected", raw)
		}
	}
}

func TestCloudAIAssistReturnsCompleteEditableDraftAfterImageInspection(t *testing.T) {
	r, c, mux, admin := cloudAIRig(t)
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/ai-settings", admin, map[string]any{"endpoint": "https://api.openai.com/v1", "model": "example-model", "apiKey": "synthetic-ai-secret"})
	if status != 200 {
		t.Fatal(status, out)
	}
	inspections := 0
	c.resolveImage = func(ctx context.Context, raw string) (CloudImageInspection, error) {
		inspections++
		if raw != "nginx:stable" {
			t.Fatal("wrong image")
		}
		return CloudImageInspection{Image: raw, ImageDigest: "sha256:" + strings.Repeat("b", 64), ExposedPorts: []int{80}, SuggestedName: "nginx"}, nil
	}
	content := `{"app":{"id":"nginx-demo","name":"Web server","description":"HTTP 文件与网页服务","category":"tools","icon":"","version":"1.0","containerPort":80,"dataTargets":["/data"],"environment":[{"name":"ADMIN_PASSWORD","label":"管理员密码","secret":true,"default":"must-not-leak"}]},"warnings":[]}`
	client := &http.Client{Transport: cloudRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		if !bytes.Contains(body, []byte("nginx:stable")) || bytes.Contains(body, []byte("synthetic-ai-secret")) {
			t.Fatal("prompt metadata/key")
		}
		raw, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}}}})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), Header: http.Header{}}, nil
	})}
	handler := http.NewServeMux()
	handler.HandleFunc("POST /api/store/admin/ai-assist", c.auth(true, func(w http.ResponseWriter, req *http.Request) { c.aiAssistWithClient(w, req, client) }))
	var before int
	r.s.db.QueryRow(`SELECT count(*) FROM cloud_apps`).Scan(&before)
	status, out = cloudCall(t, handler, "POST", "/api/store/admin/ai-assist", admin, map[string]string{"image": "nginx:stable"})
	if status != 200 || inspections != 1 {
		t.Fatal(status, out)
	}
	data := out["data"].(map[string]any)
	app := data["app"].(map[string]any)
	if app["id"] != "nginx-demo" || !cloudTokenIconRE.MatchString(app["icon"].(string)) || app["published"] != false || data["imageDigest"] != "sha256:"+strings.Repeat("b", 64) {
		t.Fatal("incomplete draft", data)
	}
	raw, _ := json.Marshal(out)
	if bytes.Contains(raw, []byte("must-not-leak")) || bytes.Contains(raw, []byte("synthetic-ai-secret")) {
		t.Fatal("AI secret leaked")
	}
	var after int
	r.s.db.QueryRow(`SELECT count(*) FROM cloud_apps`).Scan(&after)
	if before != after {
		t.Fatal("AI draft saved without edit")
	}
	content = `{"app":{},"command":"sensitive-upstream-text"}`
	status, out = cloudCall(t, handler, "POST", "/api/store/admin/ai-assist", admin, map[string]string{"image": "nginx:stable"})
	raw, _ = json.Marshal(out)
	if status != 422 || bytes.Contains(raw, []byte("sensitive-upstream-text")) {
		t.Fatal("invalid AI draft accepted/leaked", status, out)
	}
}

func TestCloudAIUnknownArtworkAndEchoedSecretWarningsAreRemoved(t *testing.T) {
	raw := []byte(`{"app":{"id":"reader","name":"Reader","description":"Read books","category":"reading","icon":"https://github.com/acme/reader","version":"1.0","containerPort":80,"dataTargets":[],"environment":[{"name":"API_KEY","label":"Key","secret":true,"default":"hidden-value"}]},"warnings":["Do not use hidden-value"]}`)
	app, warnings, err := parseCloudAIResult(raw, "nginx:stable")
	if err != nil {
		t.Fatal(err)
	}
	if app.Icon != "" {
		t.Fatal("unconfirmed artwork retained")
	}
	for _, w := range warnings {
		if strings.Contains(w, "hidden-value") {
			t.Fatal("secret echoed in warning")
		}
	}
}
