package store

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"

	"spacedesktop/server/internal/storemanifest"
)

var cloudAppIDRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
var cloudEnvRE = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
var cloudSensitiveEnvRE = regexp.MustCompile(`(?i)(password|passwd|secret|token|private.?key|api.?key|credential)`)

type cloudDraftInput struct {
	CloudApp
	IconData *cloudIconData `json:"iconData,omitempty"`
}

func cloudDecodeDraft(w http.ResponseWriter, r *http.Request, in *cloudDraftInput) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 768<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(in); err != nil || d.Decode(&struct{}{}) != io.EOF {
		fail(w, 400, "invalid_app", "应用资料格式无效或超过大小限制。")
		return false
	}
	return true
}

func cloudValidateApp(a CloudApp) bool {
	if !cloudAppIDRE.MatchString(a.ID) || !cloudText(a.Name, 1, 128) || !cloudText(a.Description, 1, 2048) || !cloudAppIDRE.MatchString(a.Category) || !cloudVersionRE.MatchString(a.Version) || a.ContainerPort < 1 || a.ContainerPort > 65535 || len(a.DataTargets) > 16 || len(a.Environment) > 32 {
		return false
	}
	if _, err := cloudImageReference(a.Image); err != nil {
		return false
	}
	if a.Icon != "" && !cloudIconURL(a.Icon) {
		return false
	}
	targets := map[string]bool{}
	for _, target := range a.DataTargets {
		if len(target) > 256 || !strings.HasPrefix(target, "/") || target == "/" || path.Clean(target) != target || strings.ContainsAny(target, "\\\x00\r\n\t") || targets[target] {
			return false
		}
		for _, protected := range []string{"/proc", "/sys", "/dev", "/run", "/var/run", "/etc", "/bin", "/sbin", "/usr"} {
			if target == protected || strings.HasPrefix(target, protected+"/") {
				return false
			}
		}
		if strings.Contains(strings.ToLower(target), "docker.sock") {
			return false
		}
		targets[target] = true
	}
	envNames := map[string]bool{}
	for _, env := range a.Environment {
		if !cloudEnvRE.MatchString(env.Name) || !cloudText(env.Label, 1, 128) || envNames[env.Name] || (env.Secret || cloudSensitiveEnvRE.MatchString(env.Name)) && env.Default != nil {
			return false
		}
		if cloudSensitiveEnvRE.MatchString(env.Name) && !env.Secret {
			return false
		}
		if env.Default != nil && (!cloudText(*env.Default, 0, 256) || strings.ContainsAny(*env.Default, "\r\n\x00")) {
			return false
		}
		envNames[env.Name] = true
	}
	return true
}

// URLs are rendered by clients only; the gateway never downloads them. A small
// trusted host allowlist prevents administrator typos from becoming tracking or
// local-network image requests in clients.
func cloudIconURL(raw string) bool {
	if cloudTokenIconRE.MatchString(raw) {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" || len(raw) > 1000 || strings.ContainsAny(raw, "\\\r\n\t") {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "raw.githubusercontent.com", "github.com", "cdn.jsdelivr.net", "zstore.2iwm.com":
		return true
	}
	return false
}

func (c *cloudService) saveApp(w http.ResponseWriter, r *http.Request) {
	var in cloudDraftInput
	if !cloudDecodeDraft(w, r, &in) {
		return
	}
	if !cloudValidateApp(in.CloudApp) {
		fail(w, 400, "invalid_app", "请检查应用资料、公开镜像、数据目录和环境参数；秘密参数不能设置默认值。")
		return
	}
	if in.IconData != nil {
		icon, err := c.saveIcon(r.Context(), *in.IconData)
		if err != nil {
			fail(w, 400, "invalid_icon", "图标仅支持512KiB内的PNG、JPEG、WebP，尺寸不超过1024×1024。")
			return
		}
		in.Icon = icon
	}
	if in.DataTargets == nil {
		in.DataTargets = []string{}
	}
	c.publicationMu.Lock()
	defer c.publicationMu.Unlock()
	old, err := c.readApp(in.ID, false)
	status := 200
	if err != nil {
		status = 201
	}
	in.Published = false
	in.ReleaseNumber = 0
	in.ManifestDigest = ""
	in.GithubSync = ""
	if err == nil {
		in.Published = old.Published
		in.ReleaseNumber = old.ReleaseNumber
		in.ManifestDigest = old.ManifestDigest
		in.GithubSync = old.GithubSync
	}
	b, err := json.Marshal(in.CloudApp)
	if err != nil {
		fail(w, 500, "cloud_app_failed", "无法保存应用资料。")
		return
	}
	if _, err = c.db.ExecContext(r.Context(), `INSERT INTO cloud_apps(id,draft_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,revision=cloud_apps.revision+1`, in.ID, string(b)); err != nil {
		fail(w, 500, "cloud_app_failed", "无法保存应用资料。")
		return
	}
	respond(w, status, map[string]any{"app": in.CloudApp})
}

func cloudString(v string) *string { return &v }
func cloudInt(v int) *int          { return &v }
func cloudInt64(v int64) *int64    { return &v }

func (c *cloudService) compileManifest(app CloudApp, info CloudImageInspection) ([]byte, error) {
	ref, err := cloudImageReference(app.Image)
	if err != nil {
		return nil, err
	}
	parameters := map[string]storemanifest.Parameter{}
	environment := map[string]storemanifest.EnvironmentValue{}
	capabilities := []string{"image.registry", "ports.tcp", "profile.restricted-v1"}
	for _, env := range app.Environment {
		id := strings.ToLower(strings.ReplaceAll(env.Name, "_", "-"))
		kind := "string"
		value := storemanifest.EnvironmentValue{ParameterRef: cloudString(id)}
		if env.Secret {
			kind = "secret"
			value = storemanifest.EnvironmentValue{SecretRef: cloudString(id)}
		}
		parameter := storemanifest.Parameter{Type: kind, Label: env.Label, Required: env.Secret}
		if env.Default != nil {
			parameter.Default, _ = json.Marshal(*env.Default)
		}
		parameters[id] = parameter
		environment[env.Name] = value
	}
	for _, env := range app.Environment {
		if env.Secret {
			capabilities = append(capabilities, "parameters.secret")
			break
		}
	}
	volumes := []storemanifest.Volume{}
	mounts := []storemanifest.Mount{}
	backups := []string{}
	for i, target := range app.DataTargets {
		id := fmt.Sprintf("data-%d", i+1)
		volumes = append(volumes, storemanifest.Volume{ID: id, Kind: "managed", Role: cloudString("data")})
		mounts = append(mounts, storemanifest.Mount{VolumeID: id, Target: target})
		backups = append(backups, id)
	}
	icon := storemanifest.Icon{Kind: "monogram", Text: cloudString(strings.ToUpper(string([]rune(app.Name)[0]))), Background: cloudString("#3558A8")}
	if cloudTokenIconRE.MatchString(app.Icon) {
		hash := strings.TrimPrefix(app.Icon, "/api/cloud/icons/")
		var size int64
		if err := c.db.QueryRow(`SELECT length(body) FROM cloud_icons WHERE hash=?`, hash).Scan(&size); err != nil {
			return nil, err
		}
		icon = storemanifest.Icon{Kind: "asset", Path: cloudString("icons/" + hash + ".png"), SHA256: cloudString(hash), SizeBytes: &size, MediaType: cloudString("image/png")}
	}
	manifest := storemanifest.Manifest{
		SchemaVersion: "store.app.v1", MinStoreProtocol: 1, RequiredCapabilities: capabilities, AppID: app.ID, ReleaseID: fmt.Sprintf("r%d", app.ReleaseNumber), ReleaseNumber: app.ReleaseNumber,
		Metadata:   storemanifest.Metadata{Name: app.Name, Version: app.Version, Description: app.Description, Category: app.Category, Author: "zstore administrator", SourceURL: "https://zstore.2iwm.com", License: "application-defined", Icon: icon},
		Runtime:    storemanifest.Runtime{Platforms: []string{"linux/amd64"}, PermissionProfile: "restricted-v1", MinimumMemoryBytes: 256 << 20, Services: []storemanifest.Service{{ID: "app", Image: storemanifest.Image{Type: "registry", Repository: cloudString(cloudRepository(ref)), ManifestDigest: &info.ImageDigest, Platform: "linux/amd64"}, UserMode: "host", Environment: environment, Ports: []storemanifest.Port{{ID: "web", Mode: "container", Protocol: "tcp", ContainerPort: &app.ContainerPort, Publish: true, DefaultHostPort: &app.ContainerPort, Bind: cloudString("lan")}}, Mounts: mounts, DependsOn: []string{}, Health: storemanifest.Health{Type: "image"}, StopTimeoutSeconds: 60}}, Volumes: volumes, Entry: storemanifest.Entry{ServiceID: "app", PortID: "web", Path: "/"}},
		Parameters: parameters, Upgrade: storemanifest.Upgrade{Strategy: "copy-switch", FromReleaseIDs: []string{}}, Backup: storemanifest.Backup{Strategy: "cold-copy", Volumes: backups}, Initialization: storemanifest.Initialization{Mode: "application-web"}, NativeLicense: storemanifest.NativeLicense{Requirement: "application-managed", Message: "授权及首次账户配置由应用自身处理。"},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return nil, err
	}
	if _, issues := storemanifest.Parse(raw); len(issues) != 0 {
		return nil, fmt.Errorf("manifest failed validation: %s at %s", issues[0].Code, issues[0].Path)
	}
	return raw, nil
}

func (c *cloudService) publishApp(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.publicationMu.Lock()
	defer c.publicationMu.Unlock()
	app, err := c.readApp(id, false)
	if err != nil {
		fail(w, 404, "cloud_app_not_found", "应用草稿不存在。")
		return
	}
	if !cloudValidateApp(app) {
		fail(w, 400, "invalid_app", "应用草稿无法发布，请重新保存完整应用资料。")
		return
	}
	info, err := c.resolveImage(r.Context(), app.Image)
	if err != nil || info.Architecture != "linux/amd64" || !cloudDigestRE.MatchString(info.ImageDigest) {
		fail(w, 422, "image_unavailable", "无法核验此公开镜像的 linux/amd64 版本，请检查引用和仓库访问权限。")
		return
	}
	ref, err := cloudImageReference(app.Image)
	if err != nil {
		fail(w, 400, "invalid_image", "公开镜像引用无效。")
		return
	}
	var prior int64
	if err := c.db.QueryRowContext(r.Context(), `SELECT COALESCE(max(release_number),0) FROM cloud_releases WHERE app_id=?`, app.ID).Scan(&prior); err != nil {
		fail(w, 500, "cloud_publish_failed", "无法读取发布记录。")
		return
	}
	app.ReleaseNumber = prior + 1
	if app.ReleaseNumber > 2147483647 {
		fail(w, 409, "release_limit", "此应用已达到版本发布上限。")
		return
	}
	app.Image = cloudRepository(ref) + "@" + info.ImageDigest
	app.Published = true
	app.GithubSync = "not-configured"
	manifest, err := c.compileManifest(app, info)
	if err != nil {
		fail(w, 400, "manifest_invalid", "应用部署清单未通过结构与权限校验。")
		return
	}
	app.ManifestDigest = tokenHash(string(manifest))
	// Github synchronization is best effort after the local atomic publication;
	// a repository outage never prevents the cloud catalog from serving a release.
	b, _ := json.Marshal(app)
	tx, err := c.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "cloud_publish_failed", "无法发布应用。")
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO cloud_releases(app_id,release_number,app_json,manifest) VALUES(?,?,?,?)`, app.ID, app.ReleaseNumber, string(b), manifest); err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE cloud_apps SET draft_json=?,published_json=? WHERE id=?`, string(b), string(b), app.ID)
	}
	if err == nil {
		err = c.appendSignedCatalog(r.Context(), tx)
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "cloud_publish_failed", "无法发布应用。")
		return
	}
	app.GithubSync = c.syncGithub(r.Context(), app, manifest)
	if app.GithubSync != "not-configured" {
		b, _ = json.Marshal(app)
		c.db.ExecContext(r.Context(), `UPDATE cloud_apps SET draft_json=?,published_json=? WHERE id=?`, string(b), string(b), app.ID)
		c.db.ExecContext(r.Context(), `UPDATE cloud_releases SET app_json=? WHERE app_id=? AND release_number=?`, string(b), app.ID, app.ReleaseNumber)
	}
	respond(w, 200, map[string]any{"app": app, "manifest": json.RawMessage(manifest), "protocol": "store.app.v1"})
}

var cloudDigestRE = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
