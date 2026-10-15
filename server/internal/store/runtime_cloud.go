package store

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"spacedesktop/server/internal/storemanifest"
)

const runtimeCloudOrigin = "https://zstore.2iwm.com/api/cloud"

var runtimeCloudFailure = errors.New("cloud publication cannot be verified or is unsupported")
var runtimeCloudSecretBlocked = errors.New("secret parameters require transient secret handling; unsupported by this runtime")
var runtimeCloudApproved sync.Map

type runtimeCloudRecord struct {
	AllowSecretEnvironment bool                       `json:"allowSecretEnvironment,omitempty"`
	Recipe                 RuntimeRecipe              `json:"recipe"`
	Manifest               []byte                     `json:"manifest"`
	Payload                []byte                     `json:"payload"`
	Envelope               cloudCatalogEnvelope       `json:"envelope"`
	PublicKey              []byte                     `json:"publicKey"`
	Parameters             map[string]json.RawMessage `json:"parameters"`
}
type runtimeCloudTrust struct {
	PublicKey  []byte `json:"publicKey"`
	Sequence   int64  `json:"sequence"`
	PayloadSHA string `json:"payloadSha"`
}
type runtimeCloudSignedResponse struct {
	OK   bool `json:"ok"`
	Data struct {
		PayloadBase64 string               `json:"payloadBase64"`
		Envelope      cloudCatalogEnvelope `json:"envelope"`
	} `json:"data"`
}

func runtimeCloudRecipeHash(r RuntimeRecipe) string {
	b, _ := json.Marshal(r)
	return tokenHash(string(b))
}
func runtimeCloudRecipeApproved(r RuntimeRecipe) bool {
	if !strings.HasPrefix(r.AppID, "cloud-") {
		return false
	}
	_, ok := runtimeCloudApproved.Load(runtimeCloudRecipeHash(r))
	return ok
}

func (s *Service) initRuntimeCloud() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS runtime_cloud_recipes(id TEXT PRIMARY KEY,body TEXT NOT NULL)`); err != nil {
		return err
	}
	var trust runtimeCloudTrust
	err := s.db.QueryRow(`SELECT value FROM metadata WHERE key='cloud_catalog_trust'`).Scan(new(string))
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var trustRaw string
	if err := s.db.QueryRow(`SELECT value FROM metadata WHERE key='cloud_catalog_trust'`).Scan(&trustRaw); err != nil || json.Unmarshal([]byte(trustRaw), &trust) != nil || len(trust.PublicKey) != ed25519.PublicKeySize {
		return runtimeCloudFailure
	}
	rows, err := s.db.Query(`SELECT body FROM runtime_cloud_recipes ORDER BY rowid`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var body string
		var record runtimeCloudRecord
		if err := rows.Scan(&body); err != nil {
			return err
		}
		if json.Unmarshal([]byte(body), &record) != nil || !bytes.Equal(record.PublicKey, trust.PublicKey) {
			return runtimeCloudFailure
		}
		if err := validateRuntimeCloudRecord(record); err != nil {
			return err
		}
		runtimeCloudApproved.Store(runtimeCloudRecipeHash(record.Recipe), true)
	}
	return rows.Err()
}

func (s *Service) runtimeRecipeFor(appID, version string) (RuntimeRecipe, bool) {
	if r, ok := RuntimeRecipeFor(appID, version); ok {
		return r, true
	}
	if !strings.HasPrefix(appID, "cloud-") {
		return RuntimeRecipe{}, false
	}
	rows, err := s.db.Query(`SELECT body FROM runtime_cloud_recipes ORDER BY rowid DESC`)
	if err != nil {
		return RuntimeRecipe{}, false
	}
	defer rows.Close()
	for rows.Next() {
		var body string
		var record runtimeCloudRecord
		if rows.Scan(&body) != nil || json.Unmarshal([]byte(body), &record) != nil {
			continue
		}
		if record.Recipe.AppID == appID && (version == "" || record.Recipe.Version == version) && runtimeCloudRecipeApproved(record.Recipe) {
			return record.Recipe, true
		}
	}
	return RuntimeRecipe{}, false
}
func (s *Service) runtimeRecipesAll() []RuntimeRecipe {
	items := RuntimeRecipes()
	seen := map[string]bool{}
	rows, err := s.db.Query(`SELECT body FROM runtime_cloud_recipes ORDER BY rowid DESC`)
	if err != nil {
		return items
	}
	defer rows.Close()
	for rows.Next() {
		var body string
		var record runtimeCloudRecord
		if rows.Scan(&body) != nil || json.Unmarshal([]byte(body), &record) != nil {
			continue
		}
		r := record.Recipe
		if !seen[r.AppID] && runtimeCloudRecipeApproved(r) {
			items = append(items, r)
			seen[r.AppID] = true
		}
	}
	return items
}

func runtimeCloudAppID(id string) string {
	if len(id) <= 57 {
		return "cloud-" + id
	}
	return "cloud-" + id[:42] + "-" + tokenHash(id)[:14]
}

func compileRuntimeCloud(m storemanifest.Manifest, parameters map[string]json.RawMessage) (RuntimeRecipe, error) {
	return compileRuntimeCloudAuthorized(m, parameters, false)
}
func compileRuntimeCloudAuthorized(m storemanifest.Manifest, parameters map[string]json.RawMessage, allowSecrets bool) (RuntimeRecipe, error) {
	if m.Runtime.PermissionProfile != "restricted-v1" || len(m.Runtime.Services) != 1 || len(m.Runtime.Platforms) != 1 || m.Runtime.Platforms[0] != "linux/amd64" || m.Runtime.Entry.Path != "/" || m.Upgrade.Strategy != "copy-switch" || len(parameters) > 32 {
		return RuntimeRecipe{}, runtimeCloudFailure
	}
	service := m.Runtime.Services[0]
	if service.ID != m.Runtime.Entry.ServiceID || (service.UserMode != "host" && service.UserMode != "image-default") || len(service.Ports) != 1 || len(service.DependsOn) > 0 || service.Command != nil || service.Entrypoint != nil || service.SharedMemoryBytes != nil || service.Health.Type != "image" || service.Image.Type != "registry" || service.Image.Repository == nil || service.Image.ManifestDigest == nil || !cloudDigestRE.MatchString(*service.Image.ManifestDigest) {
		return RuntimeRecipe{}, runtimeCloudFailure
	}
	port := service.Ports[0]
	if port.ID != m.Runtime.Entry.PortID || port.ContainerPort == nil || port.Protocol != "tcp" || port.Mode != "container" || !port.Publish {
		return RuntimeRecipe{}, runtimeCloudFailure
	}
	image := *service.Image.Repository + ":zstore-" + m.ReleaseID + "@" + *service.Image.ManifestDigest
	if _, err := cloudImageReference(image); err != nil {
		return RuntimeRecipe{}, runtimeCloudFailure
	}
	for _, p := range m.Parameters {
		if p.Type == "secret" && !allowSecrets {
			return RuntimeRecipe{}, runtimeCloudSecretBlocked
		}
	}
	for key := range parameters {
		if _, ok := m.Parameters[key]; !ok {
			return RuntimeRecipe{}, runtimeCloudFailure
		}
	}
	environment := map[string]string{}
	for name, value := range service.Environment {
		if value.SecretRef != nil && allowSecrets && cloudEnvRE.MatchString(name) {
			environment[name] = "$secret:" + *value.SecretRef
			continue
		}
		if !cloudEnvRE.MatchString(name) || cloudSensitiveEnvRE.MatchString(name) || value.SecretRef != nil {
			return RuntimeRecipe{}, runtimeCloudSecretBlocked
		}
		var literal string
		if value.Literal != nil {
			literal = *value.Literal
		} else if value.ParameterRef != nil {
			p, ok := m.Parameters[*value.ParameterRef]
			if !ok || p.Type != "string" {
				return RuntimeRecipe{}, runtimeCloudFailure
			}
			raw, ok := parameters[*value.ParameterRef]
			if !ok {
				raw = p.Default
			}
			if len(raw) == 0 {
				if p.Required {
					return RuntimeRecipe{}, runtimeCloudFailure
				}
				literal = ""
			} else if json.Unmarshal(raw, &literal) != nil {
				return RuntimeRecipe{}, runtimeCloudFailure
			}
			if p.MinLength != nil && len([]rune(literal)) < *p.MinLength || p.MaxLength != nil && len([]rune(literal)) > *p.MaxLength || p.Pattern != nil {
				return RuntimeRecipe{}, runtimeCloudFailure
			}
		} else {
			return RuntimeRecipe{}, runtimeCloudFailure
		}
		if !cloudText(literal, 0, 512) || strings.HasPrefix(literal, "$managed:") || strings.ContainsAny(literal, "\r\n\x00") {
			return RuntimeRecipe{}, runtimeCloudFailure
		}
		environment[name] = literal
	}
	volumes := map[string]storemanifest.Volume{}
	for _, v := range m.Runtime.Volumes {
		if v.Kind != "managed" {
			return RuntimeRecipe{}, runtimeCloudFailure
		}
		volumes[v.ID] = v
	}
	mounts := []RuntimeVolume{}
	targets := []string{}
	for _, mount := range service.Mounts {
		v, ok := volumes[mount.VolumeID]
		if !ok || mount.ReadOnly || v.Role == nil {
			return RuntimeRecipe{}, runtimeCloudFailure
		}
		role := *v.Role
		if role == "sync-data" {
			role = "sync-write"
		}
		mounts = append(mounts, RuntimeVolume{Name: mount.VolumeID, Target: mount.Target, Role: role})
		targets = append(targets, mount.Target)
	}
	if !cloudValidateApp(CloudApp{ID: m.AppID, Name: m.Metadata.Name, Description: m.Metadata.Description, Category: m.Metadata.Category, Image: image, Version: m.Metadata.Version, ContainerPort: *port.ContainerPort, DataTargets: targets}) {
		return RuntimeRecipe{}, runtimeCloudFailure
	}
	parameterBytes, _ := json.Marshal(parameters)
	manifestBytes, _ := json.Marshal(m)
	r := RuntimeRecipe{AppID: runtimeCloudAppID(m.AppID), Name: m.Metadata.Name, Version: m.Metadata.Version, Revision: "cloud-" + tokenHash(string(manifestBytes))[:16] + "-" + tokenHash(string(parameterBytes))[:16], SourceURL: runtimeCloudOrigin + "/catalog/" + m.AppID, License: m.Metadata.License, Category: m.Metadata.Category, Description: m.Metadata.Description, DefaultPort: *port.ContainerPort, MigrationStrategy: "snapshot-copy-switch", Initialization: "administrator-setup", SupportedPlatforms: []string{"linux/amd64"}, CompatibleFrom: []string{}, MinimumMemoryBytes: uint64(m.Runtime.MinimumMemoryBytes), Services: []RuntimeService{{ID: service.ID, Image: image, UserMode: service.UserMode, Entry: true, ContainerPort: *port.ContainerPort, Volumes: mounts, Environment: environment, DependsOn: []string{}, HealthIntervalSeconds: 30, HealthTimeoutSeconds: 10, HealthRetries: 5}}}
	if m.Metadata.Icon.Kind == "asset" && m.Metadata.Icon.Path != nil {
		r.CatalogIconURL = runtimeCloudOrigin + "/" + *m.Metadata.Icon.Path
	} else if m.Metadata.Icon.Text != nil {
		r.Icon = *m.Metadata.Icon.Text
	}
	return r, nil
}

func verifyRuntimeCloudPayload(payload []byte, envelope cloudCatalogEnvelope, key []byte) (cloudSignedPayload, error) {
	var catalog cloudSignedPayload
	if len(key) != ed25519.PublicKeySize || len(payload) == 0 || len(payload) > 2<<20 || !uniqueNASJSON(payload) || envelope.SchemaVersion != "store.catalog-envelope.v1" || envelope.Payload.SizeBytes != len(payload) || envelope.Payload.SHA256 != tokenHash(string(payload)) || len(envelope.Signatures) != 1 {
		return catalog, runtimeCloudFailure
	}
	sig := envelope.Signatures[0]
	signature, err := base64.StdEncoding.Strict().DecodeString(sig.Signature)
	if err != nil || sig.Algorithm != "Ed25519" || sig.KeyID != "zstore-primary" || !ed25519.Verify(key, payload, signature) {
		return catalog, runtimeCloudFailure
	}
	if json.Unmarshal(payload, &catalog) != nil || catalog.SchemaVersion != "store.catalog.v1" || catalog.SourceID != "zstore-catalog" || catalog.Sequence < 1 || catalog.Sequence > 2147483647 || len(catalog.Apps) > 1000 || len(catalog.Withdrawn) > 0 {
		return catalog, runtimeCloudFailure
	}
	if _, err := time.Parse(time.RFC3339, catalog.PublishedAt); err != nil {
		return catalog, runtimeCloudFailure
	}
	if envelope.Payload.Path != fmt.Sprintf("catalogs/%d.json", catalog.Sequence) {
		return catalog, runtimeCloudFailure
	}
	return catalog, nil
}
func runtimeCloudRelease(catalog cloudSignedPayload, id string) (cloudCatalogRelease, error) {
	seen := map[string]bool{}
	for _, app := range catalog.Apps {
		if !cloudAppIDRE.MatchString(app.AppID) || seen[app.AppID] || len(app.Releases) < 1 || len(app.Releases) > 100 {
			return cloudCatalogRelease{}, runtimeCloudFailure
		}
		seen[app.AppID] = true
		if app.AppID != id {
			continue
		}
		for _, release := range app.Releases {
			if release.ReleaseID == app.LatestReleaseID && release.ReleaseNumber > 0 && release.Manifest.Path == fmt.Sprintf("manifests/%s/r%d.json", id, release.ReleaseNumber) && release.ReleaseID == fmt.Sprintf("r%d", release.ReleaseNumber) && release.Manifest.SizeBytes > 0 && release.Manifest.SizeBytes <= 1<<20 {
				return release, nil
			}
		}
	}
	return cloudCatalogRelease{}, runtimeCloudFailure
}
func validateRuntimeCloudRecord(record runtimeCloudRecord) error {
	catalog, err := verifyRuntimeCloudPayload(record.Payload, record.Envelope, record.PublicKey)
	if err != nil {
		return err
	}
	doc, issues := storemanifest.Parse(record.Manifest)
	if len(issues) > 0 || doc == nil {
		return runtimeCloudFailure
	}
	var selected *cloudCatalogRelease
	for _, app := range catalog.Apps {
		if app.AppID != doc.Manifest.AppID {
			continue
		}
		for _, release := range app.Releases {
			if release.ReleaseID == doc.Manifest.ReleaseID {
				copy := release
				selected = &copy
			}
		}
	}
	if selected == nil || selected.Manifest.SHA256 != doc.SHA256 || selected.Manifest.SizeBytes != len(record.Manifest) || selected.ReleaseNumber != doc.Manifest.ReleaseNumber {
		return runtimeCloudFailure
	}
	expected, err := compileRuntimeCloudAuthorized(doc.Manifest, record.Parameters, record.AllowSecretEnvironment)
	if err != nil {
		return err
	}
	if runtimeCloudRecipeHash(expected) != runtimeCloudRecipeHash(record.Recipe) {
		return runtimeCloudFailure
	}
	return nil
}

func runtimeCloudGet(ctx context.Context, client *http.Client, path, token string, max int) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", runtimeCloudOrigin+"/"+path, nil)
	if err != nil {
		return nil, runtimeCloudFailure
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(req)
	if err != nil {
		return runtimeCloudFallback(ctx, client, path, max)
	}
	defer response.Body.Close()
	if response.StatusCode >= 500 {
		return runtimeCloudFallback(ctx, client, path, max)
	}
	if response.StatusCode != 200 {
		return nil, runtimeCloudFailure
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, int64(max)+1))
	if err != nil || len(body) > max {
		return nil, runtimeCloudFailure
	}
	return body, nil
}

func (s *Service) runtimeCloudInstallPlan(w http.ResponseWriter, r *http.Request) {
	s.runtimeCloudInstallPlanWithClient(w, r, newNASClient())
}
func (s *Service) runtimeCloudInstallPlanWithClient(w http.ResponseWriter, r *http.Request, client *http.Client) {
	var in struct {
		AppID                  string                     `json:"appId"`
		RootID                 string                     `json:"rootId"`
		Name                   string                     `json:"name"`
		HostPort               int                        `json:"hostPort"`
		Parameters             map[string]json.RawMessage `json:"parameters"`
		AllowSecretEnvironment bool                       `json:"allowSecretEnvironment"`
		SecretParameters       map[string]string          `json:"secretParameters"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !cloudAppIDRE.MatchString(in.AppID) || !segmentRE.MatchString(in.RootID) || len(in.Parameters) > 32 {
		fail(w, 400, "invalid_cloud_app", "请选择云端应用和已登记的数据目录。")
		return
	}
	if s.opts.EngineMode != "local" || s.opts.CatalogOnly {
		fail(w, 422, "cloud_runtime_unsupported", "云端通用应用仅支持 NAS 本地 Docker 执行模式。")
		return
	}
	token := r.Header.Get("X-Cloud-Session")
	if !cloudTokenRE.MatchString(token) {
		fail(w, 401, "cloud_auth_required", "请先登录云端应用商店。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	keyRaw, err := runtimeCloudGet(ctx, client, "catalog-key", "", 16384)
	var keyResponse struct {
		OK   bool `json:"ok"`
		Data struct {
			PublicKey string `json:"publicKey"`
		} `json:"data"`
	}
	if err != nil || json.Unmarshal(keyRaw, &keyResponse) != nil || !keyResponse.OK {
		fail(w, 502, "cloud_publication_unavailable", "无法读取云端发布身份。")
		return
	}
	key, err := base64.StdEncoding.Strict().DecodeString(keyResponse.Data.PublicKey)
	if err != nil {
		fail(w, 502, "cloud_publication_unavailable", "云端发布身份无效。")
		return
	}
	var prior runtimeCloudTrust
	var priorRaw string
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key='cloud_catalog_trust'`).Scan(&priorRaw); err == nil {
		if json.Unmarshal([]byte(priorRaw), &prior) != nil || !bytes.Equal(key, prior.PublicKey) {
			fail(w, 409, "cloud_catalog_key_changed", "云端签名钥匙已变化，须由管理员核验后重置信任。")
			return
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		fail(w, 500, "cloud_trust_failed", "无法读取云端信任记录。")
		return
	}
	signedRaw, err := runtimeCloudGet(ctx, client, "catalog/signed", token, 4<<20)
	var signed runtimeCloudSignedResponse
	if err != nil || json.Unmarshal(signedRaw, &signed) != nil || !signed.OK {
		fail(w, 502, "cloud_publication_unavailable", "云端登录失效或签名目录暂不可用。")
		return
	}
	payload, err := base64.StdEncoding.Strict().DecodeString(signed.Data.PayloadBase64)
	if err != nil {
		fail(w, 502, "cloud_publication_invalid", "云端签名目录格式无效。")
		return
	}
	catalog, err := verifyRuntimeCloudPayload(payload, signed.Data.Envelope, key)
	if err != nil || catalog.Sequence < prior.Sequence || catalog.Sequence == prior.Sequence && prior.PayloadSHA != tokenHash(string(payload)) {
		fail(w, 502, "cloud_publication_invalid", "云端目录签名、内容身份或版本次序无效。")
		return
	}
	release, err := runtimeCloudRelease(catalog, in.AppID)
	if err != nil {
		fail(w, 422, "cloud_app_unavailable", "此应用尚未发布可验证的通用部署清单。")
		return
	}
	manifest, err := runtimeCloudGet(ctx, client, release.Manifest.Path, token, 1<<20)
	if err != nil || len(manifest) != release.Manifest.SizeBytes || tokenHash(string(manifest)) != release.Manifest.SHA256 {
		fail(w, 502, "cloud_publication_invalid", "云端应用清单内容身份无效。")
		return
	}
	doc, issues := storemanifest.Parse(manifest)
	if len(issues) > 0 || doc == nil || doc.Manifest.AppID != in.AppID || doc.Manifest.ReleaseID != release.ReleaseID || doc.Manifest.ReleaseNumber != release.ReleaseNumber {
		fail(w, 502, "cloud_publication_invalid", "云端应用清单未通过结构和身份校验。")
		return
	}
	recipe, err := compileRuntimeCloudAuthorized(doc.Manifest, in.Parameters, in.AllowSecretEnvironment)
	if err != nil {
		code := "cloud_manifest_unsupported"
		msg := "仅支持受限权限、单容器、一个TCP入口和专用数据卷的云端应用。"
		if errors.Is(err, runtimeCloudSecretBlocked) {
			code = "cloud_secret_parameters_unsupported"
			msg = "此应用需要秘密环境参数；当前运行时尚未提供安全的临时秘密句柄，不能安装。"
		}
		fail(w, 422, code, msg)
		return
	}
	// Public parameters are persisted in approved plans. Known cloud/NAS session
	// values must never become public environment defaults or directory names.
	for _, privateSession := range []string{token, r.Header.Get("X-Store-Session")} {
		if privateSession == "" {
			continue
		}
		if strings.Contains(in.Name, privateSession) {
			fail(w, 400, "invalid_public_parameters", "登录凭据不能用作应用数据目录或公开参数。")
			return
		}
		for _, value := range recipe.Services[0].Environment {
			if strings.Contains(value, privateSession) {
				fail(w, 400, "invalid_public_parameters", "登录凭据不能用作应用数据目录或公开参数。")
				return
			}
		}
	}
	if in.Name == "" {
		in.Name = recipe.AppID + "-" + randomID()[:8]
		if len(in.Name) > 64 {
			in.Name = in.Name[:55] + "-" + randomID()[:8]
		}
	}
	if !segmentRE.MatchString(in.Name) {
		fail(w, 400, "invalid_cloud_directory", "应用数据目录名须为单层字母、数字、下划线或短横线。")
		return
	}
	var submission runtimeSecretSubmission
	if runtimeRecipeHasSecrets(recipe) {
		values := map[string]string{}
		names := runtimeRecipeSecretNames(recipe)
		if !in.AllowSecretEnvironment || len(in.SecretParameters) > 32 {
			fail(w, 400, "invalid_secret_parameters", "请确认秘密环境参数仅保存于当前 NAS，并填写必填值。")
			return
		}
		used := map[string]bool{}
		for name, id := range names {
			value, ok := in.SecretParameters[id]
			if !ok || !privateField(value, 4096) || strings.Contains(value, token) || r.Header.Get("X-Store-Session") != "" && strings.Contains(value, r.Header.Get("X-Store-Session")) {
				fail(w, 400, "invalid_secret_parameters", "秘密参数缺失、超长或包含登录凭据。")
				return
			}
			values[name] = value
			used[id] = true
		}
		if len(used) != len(in.SecretParameters) {
			fail(w, 400, "invalid_secret_parameters", "秘密参数包含未声明的字段。")
			return
		}
		manager, err := s.runtimeSecretManager()
		if err != nil {
			fail(w, 503, "secret_storage_unavailable", "NAS 私有秘密存储无法核验。")
			return
		}
		submission = runtimeSecretSubmission{manager: manager, values: values, manifestSHA: doc.SHA256}
	} else if len(in.SecretParameters) > 0 {
		fail(w, 400, "invalid_secret_parameters", "此应用没有声明秘密参数。")
		return
	}
	record := runtimeCloudRecord{AllowSecretEnvironment: in.AllowSecretEnvironment, Recipe: recipe, Manifest: manifest, Payload: payload, Envelope: signed.Data.Envelope, PublicKey: key, Parameters: in.Parameters}
	body, _ := json.Marshal(record)
	trust := runtimeCloudTrust{PublicKey: key, Sequence: catalog.Sequence, PayloadSHA: tokenHash(string(payload))}
	trustBody, _ := json.Marshal(trust)
	if !s.runtimeMutation(w, r, func(tx *sql.Tx) error {
		var currentRaw string
		err := tx.QueryRowContext(r.Context(), `SELECT value FROM metadata WHERE key='cloud_catalog_trust'`).Scan(&currentRaw)
		if err == nil {
			var current runtimeCloudTrust
			if json.Unmarshal([]byte(currentRaw), &current) != nil || !bytes.Equal(current.PublicKey, key) || current.Sequence > catalog.Sequence || current.Sequence == catalog.Sequence && current.PayloadSHA != trust.PayloadSHA {
				return errRuntimeConflict
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO metadata(key,value) VALUES('cloud_catalog_trust',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, string(trustBody)); err != nil {
			return err
		}
		_, err = tx.ExecContext(r.Context(), `INSERT INTO runtime_cloud_recipes(id,body) VALUES(?,?) ON CONFLICT(id) DO NOTHING`, recipe.AppID+"@"+recipe.Revision, string(body))
		return err
	}) {
		return
	}
	runtimeCloudApproved.Store(runtimeCloudRecipeHash(recipe), true)
	r.Header.Del("X-Cloud-Session")
	if len(submission.values) > 0 {
		r = r.WithContext(context.WithValue(r.Context(), runtimeSecretSubmissionKey{}, submission))
	}
	s.runtimeCreatePlan(w, r, runtimePlanInput{Kind: "install", AppID: recipe.AppID, TargetVersion: recipe.Version, RootID: in.RootID, Directory: in.Name, HostPort: in.HostPort}, nil, &recipe)
}
