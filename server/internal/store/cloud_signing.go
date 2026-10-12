package store

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

type cloudCatalogManifestRef struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	SizeBytes int    `json:"sizeBytes"`
}
type cloudCatalogRelease struct {
	ReleaseID     string                  `json:"releaseId"`
	ReleaseNumber int64                   `json:"releaseNumber"`
	Manifest      cloudCatalogManifestRef `json:"manifest"`
}
type cloudCatalogApp struct {
	AppID           string                `json:"appId"`
	LatestReleaseID string                `json:"latestReleaseId"`
	Releases        []cloudCatalogRelease `json:"releases"`
}
type cloudSignedPayload struct {
	SchemaVersion string            `json:"schemaVersion"`
	SourceID      string            `json:"sourceId"`
	Sequence      int64             `json:"sequence"`
	PublishedAt   string            `json:"publishedAt"`
	Apps          []cloudCatalogApp `json:"apps"`
	Withdrawn     []any             `json:"withdrawn"`
}
type cloudSignature struct {
	KeyID     string `json:"keyId"`
	Algorithm string `json:"algorithm"`
	Signature string `json:"signature"`
}
type cloudCatalogEnvelope struct {
	SchemaVersion string                  `json:"schemaVersion"`
	Payload       cloudCatalogManifestRef `json:"payload"`
	Signatures    []cloudSignature        `json:"signatures"`
}

func (c *cloudService) signingSeed(ctx context.Context) ([]byte, error) {
	var seed []byte
	err := c.db.QueryRowContext(ctx, `SELECT value FROM cloud_private WHERE key='signing_seed'`).Scan(&seed)
	if errors.Is(err, sql.ErrNoRows) {
		seed = make([]byte, ed25519.SeedSize)
		if _, err = rand.Read(seed); err != nil {
			return nil, err
		}
		if _, err = c.db.ExecContext(ctx, `INSERT INTO cloud_private(key,value) VALUES('signing_seed',?) ON CONFLICT(key) DO NOTHING`, seed); err != nil {
			return nil, err
		}
		err = c.db.QueryRowContext(ctx, `SELECT value FROM cloud_private WHERE key='signing_seed'`).Scan(&seed)
	}
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("catalog signing identity unavailable")
	}
	return seed, nil
}
func (c *cloudService) initializeSigning(ctx context.Context) error {
	seed, err := c.signingSeed(ctx)
	if err != nil {
		return err
	}
	c.signingKey = ed25519.NewKeyFromSeed(seed)
	var n int
	if err := c.db.QueryRowContext(ctx, `SELECT count(*) FROM cloud_publications`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		tx, err := c.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if err = c.appendSignedCatalog(ctx, tx); err != nil {
			return err
		}
		return tx.Commit()
	}
	return nil
}

func (c *cloudService) appendSignedCatalog(ctx context.Context, tx *cloudTx) error {
	var sequence int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(max(sequence),0)+1 FROM cloud_publications`).Scan(&sequence); err != nil {
		return err
	}
	if sequence > 2147483647 {
		return errors.New("catalog sequence exhausted")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	payload := cloudSignedPayload{SchemaVersion: "store.catalog.v1", SourceID: "zstore-catalog", Sequence: sequence, PublishedAt: now, Apps: []cloudCatalogApp{}, Withdrawn: []any{}}
	rows, err := tx.QueryContext(ctx, `SELECT app_id,release_number,manifest FROM cloud_releases ORDER BY app_id,release_number`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var appID string
		var release int64
		var manifest []byte
		if err := rows.Scan(&appID, &release, &manifest); err != nil {
			rows.Close()
			return err
		}
		n := len(payload.Apps) - 1
		if n < 0 || payload.Apps[n].AppID != appID {
			payload.Apps = append(payload.Apps, cloudCatalogApp{AppID: appID, Releases: []cloudCatalogRelease{}})
			n++
		}
		entry := &payload.Apps[n]
		entry.LatestReleaseID = fmt.Sprintf("r%d", release)
		entry.Releases = append(entry.Releases, cloudCatalogRelease{ReleaseID: entry.LatestReleaseID, ReleaseNumber: release, Manifest: cloudCatalogManifestRef{Path: fmt.Sprintf("manifests/%s/r%d.json", appID, release), SHA256: tokenHash(string(manifest)), SizeBytes: len(manifest)}})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if len(raw) > 2<<20 {
		return errors.New("catalog publication too large")
	}
	signature := ed25519.Sign(c.signingKey, raw)
	envelope := cloudCatalogEnvelope{SchemaVersion: "store.catalog-envelope.v1", Payload: cloudCatalogManifestRef{Path: fmt.Sprintf("catalogs/%d.json", sequence), SHA256: tokenHash(string(raw)), SizeBytes: len(raw)}, Signatures: []cloudSignature{{KeyID: "zstore-primary", Algorithm: "Ed25519", Signature: base64.StdEncoding.EncodeToString(signature)}}}
	envelopeRaw, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO cloud_publications(sequence,published_at,payload,envelope) VALUES(?,?,?,?)`, sequence, now, raw, envelopeRaw)
	return err
}

func (c *cloudService) catalogKey(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]any{"keyId": "zstore-primary", "algorithm": "Ed25519", "publicKey": base64.StdEncoding.EncodeToString(c.signingKey.Public().(ed25519.PublicKey)), "signingInput": "raw catalog payload bytes", "sourceId": "zstore-catalog"})
}
func (c *cloudService) signedCatalog(w http.ResponseWriter, r *http.Request) {
	var payload, envelope []byte
	if err := c.db.QueryRowContext(r.Context(), `SELECT payload,envelope FROM cloud_publications ORDER BY sequence DESC LIMIT 1`).Scan(&payload, &envelope); err != nil {
		fail(w, 500, "catalog_unavailable", "签名目录暂不可用。")
		return
	}
	respond(w, 200, map[string]any{"payload": json.RawMessage(payload), "payloadBase64": base64.StdEncoding.EncodeToString(payload), "envelope": json.RawMessage(envelope), "publicKey": base64.StdEncoding.EncodeToString(c.signingKey.Public().(ed25519.PublicKey)), "protocol": "store.app.v1"})
}
func (c *cloudService) releaseManifest(w http.ResponseWriter, r *http.Request) {
	var raw []byte
	var release int64
	if _, err := fmt.Sscanf(r.PathValue("release"), "r%d.json", &release); err != nil || release < 1 || fmt.Sprintf("r%d.json", release) != r.PathValue("release") {
		fail(w, 404, "release_not_found", "应用交付不存在。")
		return
	}
	if err := c.db.QueryRowContext(r.Context(), `SELECT manifest FROM cloud_releases WHERE app_id=? AND release_number=?`, r.PathValue("id"), release).Scan(&raw); err != nil {
		fail(w, 404, "release_not_found", "应用交付不存在。")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Write(raw)
}
func (c *cloudService) versionCatalog(w http.ResponseWriter, r *http.Request) {
	var raw []byte
	var sequence int64
	if _, err := fmt.Sscanf(r.PathValue("sequence"), "%d.json", &sequence); err != nil || sequence < 1 || fmt.Sprintf("%d.json", sequence) != r.PathValue("sequence") {
		fail(w, 404, "catalog_not_found", "目录版本不存在。")
		return
	}
	if err := c.db.QueryRowContext(r.Context(), `SELECT payload FROM cloud_publications WHERE sequence=?`, sequence).Scan(&raw); err != nil {
		fail(w, 404, "catalog_not_found", "目录版本不存在。")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Write(raw)
}
