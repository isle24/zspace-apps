package store

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var cloudGithubRepositoryRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)

type cloudGithubSettings struct {
	Repository string
	Token      string
}

func (c *cloudService) githubSettings(ctx context.Context) (cloudGithubSettings, error) {
	var settings cloudGithubSettings
	var repo, encrypted []byte
	err := c.db.QueryRowContext(ctx, `SELECT value FROM cloud_private WHERE key='github_repository'`).Scan(&repo)
	if err != nil && err != sql.ErrNoRows {
		return settings, err
	}
	settings.Repository = string(repo)
	err = c.db.QueryRowContext(ctx, `SELECT value FROM cloud_private WHERE key='github_token'`).Scan(&encrypted)
	if err == sql.ErrNoRows {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	if len(encrypted) > 0 {
		token, err := c.decryptGithubToken(encrypted)
		if err != nil {
			return settings, err
		}
		settings.Token = token
	}
	return settings, nil
}
func (c *cloudService) githubAEAD() (cipher.AEAD, error) {
	key := sha256.Sum256(append([]byte("zstore github token\x00"), c.signingKey.Seed()...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (c *cloudService) encryptGithubToken(token string) ([]byte, error) {
	aead, err := c.githubAEAD()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(token), []byte("github_token")), nil
}
func (c *cloudService) decryptGithubToken(raw []byte) (string, error) {
	aead, err := c.githubAEAD()
	if err != nil || len(raw) < aead.NonceSize() {
		return "", errors.New("github token unavailable")
	}
	plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte("github_token"))
	return string(plain), err
}
func (c *cloudService) getSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := c.githubSettings(r.Context())
	if err != nil {
		fail(w, 500, "cloud_settings_failed", "无法读取发布设置。")
		return
	}
	respond(w, 200, map[string]any{"githubRepository": settings.Repository, "githubTokenConfigured": settings.Token != "", "configured": settings.Repository != "" && settings.Token != ""})
}
func (c *cloudService) saveSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		GithubRepository string  `json:"githubRepository"`
		GithubToken      *string `json:"githubToken,omitempty"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.GithubRepository != "" && !cloudGithubRepositoryRE.MatchString(in.GithubRepository) {
		fail(w, 400, "invalid_repository", "仓库须填写 owner/repository，不支持URL或其他路径。")
		return
	}
	if in.GithubToken != nil && (len(*in.GithubToken) > 2048 || strings.ContainsAny(*in.GithubToken, " \t\r\n\x00")) {
		fail(w, 400, "invalid_token", "GitHub Token 格式无效。")
		return
	}
	c.publicationMu.Lock()
	defer c.publicationMu.Unlock()
	tx, err := c.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "cloud_settings_failed", "无法保存发布设置。")
		return
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(r.Context(), `INSERT INTO cloud_private(key,value) VALUES('github_repository',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, []byte(in.GithubRepository))
	if err == nil && in.GithubToken != nil {
		var encrypted []byte
		if *in.GithubToken != "" {
			encrypted, err = c.encryptGithubToken(*in.GithubToken)
		} else {
			encrypted = []byte{}
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO cloud_private(key,value) VALUES('github_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, encrypted)
		}
	}
	if in.GithubToken != nil {
		*in.GithubToken = ""
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "cloud_settings_failed", "无法保存发布设置。")
		return
	}
	c.getSettings(w, r)
}

type cloudGithubFile struct {
	path string
	body []byte
}

func (c *cloudService) syncGithub(ctx context.Context, app CloudApp, manifest []byte) string {
	settings, err := c.githubSettings(ctx)
	if err != nil {
		return "failed"
	}
	if settings.Repository == "" || settings.Token == "" {
		return "not-configured"
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	app.GithubSync = "synced"
	appRaw, _ := json.Marshal(app)
	files := []cloudGithubFile{{path: "apps/" + app.ID + "/app.json", body: appRaw}, {path: fmt.Sprintf("manifests/%s/r%d.json", app.ID, app.ReleaseNumber), body: manifest}}
	if apps, err := c.readApps(true); err == nil {
		catalog, _ := json.Marshal(map[string]any{"items": apps})
		files = append(files, cloudGithubFile{path: "catalog-apps.json", body: catalog})
	}
	var payload, envelope []byte
	var sequence int64
	if err := c.db.QueryRowContext(ctx, `SELECT sequence,payload,envelope FROM cloud_publications ORDER BY sequence DESC LIMIT 1`).Scan(&sequence, &payload, &envelope); err != nil {
		return "failed"
	}
	files = append(files, cloudGithubFile{path: fmt.Sprintf("catalogs/%d.json", sequence), body: payload}, cloudGithubFile{path: "catalog-envelope.json", body: envelope})
	key, _ := json.Marshal(map[string]string{"keyId": "zstore-primary", "algorithm": "Ed25519", "publicKey": base64.StdEncoding.EncodeToString(c.signingKey[32:])})
	files = append(files, cloudGithubFile{path: "catalog-key.json", body: key})
	if cloudTokenIconRE.MatchString(app.Icon) {
		hash := strings.TrimPrefix(app.Icon, "/api/cloud/icons/")
		var icon []byte
		if err := c.db.QueryRowContext(ctx, `SELECT body FROM cloud_icons WHERE hash=?`, hash).Scan(&icon); err != nil {
			return "failed"
		}
		files = append(files, cloudGithubFile{path: "icons/" + hash + ".png", body: icon})
	}
	if err := c.commitGithub(ctx, settings, files); err != nil {
		return "failed"
	}
	return "synced"
}

// One Git tree and non-forced ref update publish only explicitly allowlisted
// public paths. Private settings, signing seeds and account data are never read
// by this exporter.
func (c *cloudService) commitGithub(ctx context.Context, settings cloudGithubSettings, files []cloudGithubFile) error {
	base := "/repos/" + settings.Repository
	var repository struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := c.githubRequest(ctx, settings, "GET", base, nil, &repository); err != nil || repository.DefaultBranch == "" {
		return errors.New("repository unavailable")
	}
	refPath := base + "/git/refs/heads/" + url.PathEscape(repository.DefaultBranch)
	var head struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := c.githubRequest(ctx, settings, "GET", base+"/git/ref/heads/"+url.PathEscape(repository.DefaultBranch), nil, &head); err != nil || head.Object.SHA == "" {
		return errors.New("repository head unavailable")
	}
	var commit struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := c.githubRequest(ctx, settings, "GET", base+"/git/commits/"+head.Object.SHA, nil, &commit); err != nil || commit.Tree.SHA == "" {
		return errors.New("repository tree unavailable")
	}
	entries := []map[string]string{}
	for _, file := range files {
		var blob struct {
			SHA string `json:"sha"`
		}
		if err := c.githubRequest(ctx, settings, "POST", base+"/git/blobs", map[string]string{"content": base64.StdEncoding.EncodeToString(file.body), "encoding": "base64"}, &blob); err != nil || blob.SHA == "" {
			return errors.New("public asset sync failed")
		}
		entries = append(entries, map[string]string{"path": file.path, "mode": "100644", "type": "blob", "sha": blob.SHA})
	}
	var tree struct {
		SHA string `json:"sha"`
	}
	if err := c.githubRequest(ctx, settings, "POST", base+"/git/trees", map[string]any{"base_tree": commit.Tree.SHA, "tree": entries}, &tree); err != nil || tree.SHA == "" {
		return errors.New("public tree sync failed")
	}
	var created struct {
		SHA string `json:"sha"`
	}
	if err := c.githubRequest(ctx, settings, "POST", base+"/git/commits", map[string]any{"message": "Publish cloud application catalog", "tree": tree.SHA, "parents": []string{head.Object.SHA}}, &created); err != nil || created.SHA == "" {
		return errors.New("public commit sync failed")
	}
	return c.githubRequest(ctx, settings, "PATCH", refPath, map[string]any{"sha": created.SHA, "force": false}, &map[string]any{})
}

func (c *cloudService) githubRequest(ctx context.Context, settings cloudGithubSettings, method, path string, input, output any) error {
	var body []byte
	var err error
	if input != nil {
		body, err = json.Marshal(input)
		if err != nil {
			return errors.New("github request unavailable")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.github.com"+path, bytes.NewReader(body))
	if err != nil {
		return errors.New("github request unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+settings.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Content-Type", "application/json")
	client := c.githubClient
	if client == nil {
		client = newNASClient()
	}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("github API unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New("github sync rejected")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return errors.New("github response unavailable")
	}
	if err = json.Unmarshal(raw, output); err != nil {
		return errors.New("github response invalid")
	}
	return nil
}
