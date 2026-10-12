package store

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var runtimeSecretFailure = errors.New("secret binding unavailable or invalid")

type runtimeSecretManager struct {
	db                    *sql.DB
	key                   []byte
	keyPath, dir, storeID string
}
type runtimeSecretSubmission struct {
	manager     *runtimeSecretManager
	values      map[string]string
	manifestSHA string
}
type runtimeSecretSubmissionKey struct{}
type runtimeSecretScope struct {
	ID             string `json:"id"`
	PlanID         string `json:"planId"`
	StoreID        string `json:"storeId"`
	InstanceID     string `json:"instanceId"`
	GenerationID   string `json:"generationId"`
	RecipeRevision string `json:"recipeRevision"`
	RecipeSHA      string `json:"recipeSha"`
	ManifestSHA    string `json:"manifestSha"`
	OwnerHash      string `json:"ownerHash"`
}
type runtimeSecretConfig struct {
	SecretSetID    string            `json:"secretSetId"`
	StoreID        string            `json:"storeId"`
	InstanceID     string            `json:"instanceId"`
	GenerationID   string            `json:"generationId"`
	RecipeRevision string            `json:"recipeRevision"`
	Environment    map[string]string `json:"environment"`
}

func (s *Service) initRuntimeSecrets() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS runtime_secret_sets(id TEXT PRIMARY KEY,scope TEXT NOT NULL,ciphertext BLOB NOT NULL)`)
	if err != nil {
		return err
	}
	if e, ok := s.engine.(*commandEngine); ok && s.opts.EngineMode == "local" && !s.opts.CatalogOnly {
		manager, err := s.runtimeSecretManager()
		if err != nil {
			return err
		}
		e.secrets = manager
	}
	return nil
}
func (s *Service) runtimeSecretManager() (*runtimeSecretManager, error) {
	keyPath := filepath.Join(s.opts.DataDir, "runtime-secrets.key")
	file, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		key := make([]byte, 32)
		if _, err = rand.Read(key); err == nil {
			_, err = file.Write(key)
		}
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil || closeErr != nil {
			return nil, runtimeSecretFailure
		}
	} else if !os.IsExist(err) {
		return nil, runtimeSecretFailure
	}
	if err := noSymlinkPath(keyPath); err != nil {
		return nil, runtimeSecretFailure
	}
	file, err = os.Open(keyPath)
	if err != nil {
		return nil, runtimeSecretFailure
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || !runtimeSecretOwned(info) {
		return nil, runtimeSecretFailure
	}
	key, err := io.ReadAll(io.LimitReader(file, 33))
	if err != nil || len(key) != 32 {
		return nil, runtimeSecretFailure
	}
	return &runtimeSecretManager{db: s.db, key: key, keyPath: keyPath, dir: s.opts.DataDir, storeID: s.storeID}, nil
}
func (m *runtimeSecretManager) aead() (cipher.AEAD, error) {
	block, err := aes.NewCipher(m.key)
	if err != nil {
		return nil, runtimeSecretFailure
	}
	return cipher.NewGCM(block)
}
func runtimeRecipeSecretNames(recipe RuntimeRecipe) map[string]string {
	out := map[string]string{}
	for _, service := range recipe.Services {
		for name, value := range service.Environment {
			if strings.HasPrefix(value, "$secret:") {
				out[name] = strings.TrimPrefix(value, "$secret:")
			}
		}
	}
	return out
}
func runtimeRecipeHasSecrets(recipe RuntimeRecipe) bool {
	return len(runtimeRecipeSecretNames(recipe)) > 0
}

func (s *Service) runtimeSecretOwnerHash(r *http.Request, db runtimeQuerier) (string, error) {
	if grant, ok := r.Context().Value(nasGrantKey{}).(nasRequestGrant); ok && grant.entry != nil {
		identity := "nas:" + s.storeID + ":" + grant.entry.username + ":" + grant.entry.credentials.ProviderID + ":" + grant.entry.credentials.NASID
		return tokenHash(identity), nil
	}
	var username string
	if err := db.QueryRowContext(r.Context(), `SELECT username FROM sessions WHERE token_hash=? AND expires_at>?`, tokenHash(r.Header.Get("X-Store-Session")), time.Now().Unix()).Scan(&username); err != nil {
		return "", runtimeSecretFailure
	}
	return tokenHash("local:" + s.storeID + ":" + username), nil
}
func (m *runtimeSecretManager) seal(tx *sql.Tx, ctx context.Context, p RuntimePlan, submission runtimeSecretSubmission, owner string) error {
	scope := runtimeSecretScope{ID: p.SecretSetID, PlanID: p.ID, StoreID: p.StoreID, InstanceID: p.InstanceID, GenerationID: p.GenerationID, RecipeRevision: p.Recipe.Revision, RecipeSHA: runtimeCloudRecipeHash(p.Recipe), ManifestSHA: submission.manifestSHA, OwnerHash: owner}
	aad, _ := json.Marshal(scope)
	plain, _ := json.Marshal(submission.values)
	defer clear(plain)
	aead, err := m.aead()
	if err != nil {
		return err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return runtimeSecretFailure
	}
	sealed := aead.Seal(nonce, nonce, plain, aad)
	_, err = tx.ExecContext(ctx, `INSERT INTO runtime_secret_sets(id,scope,ciphertext) VALUES(?,?,?)`, scope.ID, string(aad), sealed)
	return err
}
func (m *runtimeSecretManager) read(ctx context.Context, db runtimeQuerier, id string) (runtimeSecretScope, map[string]string, error) {
	var scope runtimeSecretScope
	var raw string
	var ciphertext []byte
	if !cloudTokenRE.MatchString(id) {
		return scope, nil, runtimeSecretFailure
	}
	if err := db.QueryRowContext(ctx, `SELECT scope,ciphertext FROM runtime_secret_sets WHERE id=?`, id).Scan(&raw, &ciphertext); err != nil || len(raw) > 2048 || len(ciphertext) > 16384 || json.Unmarshal([]byte(raw), &scope) != nil || scope.ID != id {
		return scope, nil, runtimeSecretFailure
	}
	aead, err := m.aead()
	if err != nil || len(ciphertext) < aead.NonceSize()+aead.Overhead() {
		return scope, nil, runtimeSecretFailure
	}
	plain, err := aead.Open(nil, ciphertext[:aead.NonceSize()], ciphertext[aead.NonceSize():], []byte(raw))
	if err != nil {
		return scope, nil, runtimeSecretFailure
	}
	defer clear(plain)
	var values map[string]string
	if json.Unmarshal(plain, &values) != nil || len(values) == 0 || len(values) > 32 {
		return scope, nil, runtimeSecretFailure
	}
	for name, value := range values {
		if !cloudEnvRE.MatchString(name) || !privateField(value, 4096) {
			return scope, nil, runtimeSecretFailure
		}
	}
	return scope, values, nil
}
func runtimeSecretMatches(scope runtimeSecretScope, p RuntimePlan) bool {
	return scope.ID == p.SecretSetID && scope.StoreID == p.StoreID && scope.InstanceID == p.InstanceID && scope.GenerationID == p.GenerationID && scope.RecipeRevision == p.Recipe.Revision && scope.RecipeSHA == runtimeCloudRecipeHash(p.Recipe) && (p.Kind != "install" || scope.PlanID == p.ID)
}
func (m *runtimeSecretManager) openForPlan(ctx context.Context, db runtimeQuerier, p RuntimePlan) (map[string]string, error) {
	scope, values, err := m.read(ctx, db, p.SecretSetID)
	if err != nil || !runtimeSecretMatches(scope, p) {
		return nil, runtimeSecretFailure
	}
	names := runtimeRecipeSecretNames(p.Recipe)
	if len(names) != len(values) {
		return nil, runtimeSecretFailure
	}
	for name := range names {
		if values[name] == "" {
			return nil, runtimeSecretFailure
		}
	}
	return values, nil
}
func (s *Service) runtimeSecretApprove(tx *sql.Tx, r *http.Request, p RuntimePlan) error {
	if !runtimeRecipeHasSecrets(p.Recipe) {
		if p.SecretSetID != "" {
			return errRuntimeConflict
		}
		return nil
	}
	manager, err := s.runtimeSecretManager()
	if err != nil {
		return errRuntimeConflict
	}
	scope, _, err := manager.read(r.Context(), tx, p.SecretSetID)
	if err != nil || !runtimeSecretMatches(scope, p) {
		return errRuntimeConflict
	}
	owner, err := s.runtimeSecretOwnerHash(r, tx)
	if err != nil || owner != scope.OwnerHash {
		return errRuntimeConflict
	}
	return nil
}

func (s *Service) runtimeSecretBindPlan(w http.ResponseWriter, r *http.Request, p *RuntimePlan, source RuntimeGeneration) bool {
	if !runtimeRecipeHasSecrets(p.Recipe) {
		return true
	}
	if p.Kind == "install" {
		submission, ok := r.Context().Value(runtimeSecretSubmissionKey{}).(runtimeSecretSubmission)
		if !ok || len(submission.values) == 0 {
			fail(w, 422, "secret_parameters_required", "请重新核对云端应用并填写 NAS 本地秘密参数。")
			return false
		}
		p.SecretSetID = randomID()
		names := runtimeRecipeSecretNames(p.Recipe)
		for _, id := range names {
			p.SecretParameterNames = append(p.SecretParameterNames, id)
		}
		sort.Strings(p.SecretParameterNames)
		return true
	}
	if p.Kind == "update" || p.Kind == "restore" || p.Kind == "backup" {
		fail(w, 422, "secret_generation_operation_unsupported", "此应用含 NAS 本地秘密参数；当前版本暂不支持更新、备份或恢复，请保留原实例。")
		return false
	}
	p.SecretSetID = source.SecretSetID
	if p.SecretSetID == "" {
		fail(w, 409, "secret_binding_unavailable", "实例秘密参数绑定无法核验。")
		return false
	}
	return true
}
func (s *Service) runtimeSecretSavePlan(tx *sql.Tx, r *http.Request, p RuntimePlan) error {
	if p.SecretSetID == "" || p.Kind != "install" {
		return nil
	}
	submission, ok := r.Context().Value(runtimeSecretSubmissionKey{}).(runtimeSecretSubmission)
	if !ok {
		return errRuntimeConflict
	}
	owner, err := s.runtimeSecretOwnerHash(r, tx)
	if err != nil {
		return err
	}
	return submission.manager.seal(tx, r.Context(), p, submission, owner)
}

func (m *runtimeSecretManager) configFile(ctx context.Context, g RuntimeGeneration) (string, func(), map[string]string, error) {
	if g.SecretSetID == "" {
		if runtimeRecipeHasSecrets(g.Recipe) {
			return "", nil, nil, runtimeSecretFailure
		}
		return "", func() {}, nil, nil
	}
	p := RuntimePlan{SecretSetID: g.SecretSetID, StoreID: g.StoreID, InstanceID: g.InstanceID, GenerationID: g.ID, Recipe: g.Recipe}
	values, err := m.openForPlan(ctx, m.db, p)
	if err != nil {
		return "", nil, nil, err
	}
	config := runtimeSecretConfig{SecretSetID: g.SecretSetID, StoreID: g.StoreID, InstanceID: g.InstanceID, GenerationID: g.ID, RecipeRevision: g.Recipe.Revision, Environment: values}
	body, _ := json.Marshal(config)
	defer clear(body)
	file, err := os.CreateTemp(m.dir, ".runtime-secret-env-")
	if err != nil {
		return "", nil, nil, runtimeSecretFailure
	}
	path := file.Name()
	cleanup := func() { os.Remove(path) }
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(body)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		cleanup()
		return "", nil, nil, runtimeSecretFailure
	}
	return path, cleanup, values, nil
}
func runtimeSecretRedact(raw []byte, values map[string]string) []byte {
	for _, value := range values {
		if value == "" {
			continue
		}
		raw = bytes.ReplaceAll(raw, []byte(value), []byte("[redacted]"))
		encoded, _ := json.Marshal(value)
		if len(encoded) > 2 {
			raw = bytes.ReplaceAll(raw, encoded[1:len(encoded)-1], []byte("[redacted]"))
		}
	}
	return raw
}
