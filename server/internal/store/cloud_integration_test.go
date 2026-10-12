package store

import (
	"context"
	"database/sql"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// These tests require explicit disposable infrastructure. Their normal skip is
// never represented as PostgreSQL/registry acceptance evidence.
func TestCloudPostgresIntegration(t *testing.T) {
	dsn := os.Getenv("ZSTORE_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set ZSTORE_TEST_POSTGRES_DSN to a disposable test PostgreSQL database")
	}
	base, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal("PostgreSQL test connector failed")
	}
	t.Cleanup(func() { base.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	schema := "cloud_test_" + randomID()
	if _, err := base.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal("PostgreSQL test schema creation failed")
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		base.ExecContext(cleanupCtx, `DROP SCHEMA `+schema+` CASCADE`)
	})
	testDSN := dsn + " search_path=" + schema
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("PostgreSQL test config failed")
		}
		q := u.Query()
		q.Set("search_path", schema)
		u.RawQuery = q.Encode()
		testDSN = u.String()
	}
	r := newRig(t)
	r.setup()
	r.s.opts.CloudDatabaseURL = testDSN
	c, err := newCloudService(r.s)
	if err != nil {
		t.Fatal(err)
	}
	if !c.db.postgres || c.db.db == r.s.db {
		t.Fatal("cloud did not isolate PostgreSQL backend")
	}
	mux := http.NewServeMux()
	c.register(mux)
	status, out := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "synthetic-admin", "password": "synthetic-pass-123"})
	if status != 200 {
		t.Fatal("administrator import/login", status, out)
	}
	admin := out["data"].(map[string]any)["sessionId"].(string)
	c.resolveImage = func(context.Context, string) (CloudImageInspection, error) {
		return CloudImageInspection{ImageDigest: "sha256:" + strings.Repeat("b", 64), Architecture: "linux/amd64", ExposedPorts: []int{80}}, nil
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, cloudDraft()); status != 201 {
		t.Fatal("PG draft", status)
	}
	if status, out := cloudCall(t, mux, "POST", "/api/store/admin/apps/test-app/publish", admin, map[string]any{}); status != 200 {
		t.Fatal("PG publication transaction", status, out)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/cloud-settings", admin, map[string]string{"githubRepository": "acme/catalog", "githubToken": "synthetic-pg-token"}); status != 200 {
		t.Fatal("PG encrypted settings", status)
	}
	user := cloudRegister(t, mux, "alice")
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/wishlist", user, map[string]string{"name": "A reader", "description": "Please publish a reader"}); status != 201 {
		t.Fatal("PG wishlist create", status)
	}
	if status, out := cloudCall(t, mux, "GET", "/api/store/admin/wishlist", admin, nil); status != 200 || len(out["data"].(map[string]any)["items"].([]any)) != 1 {
		t.Fatal("PG wishlist join", status, out)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/history", user, map[string]string{"appId": "uptime-kuma", "version": "2.5.6", "status": "installed", "deviceName": "Home NAS"}); status != 201 {
		t.Fatal("PG history upsert", status)
	}
	var sqliteCloudTables int
	if err := r.s.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'cloud_%'`).Scan(&sqliteCloudTables); err != nil || sqliteCloudTables != 0 {
		t.Fatal("cloud records leaked into controller SQLite", sqliteCloudTables)
	}
	if _, err := r.s.db.Exec(`DELETE FROM admin`); err != nil {
		t.Fatal(err)
	}
	if status, _ := cloudCall(t, mux, "POST", "/api/cloud/login", "", map[string]string{"username": "synthetic-admin", "password": "synthetic-pass-123"}); status != 200 {
		t.Fatal("restored PG admin depended on legacy SQLite", status)
	}
}

func TestCloudPublicRegistryIntegration(t *testing.T) {
	if os.Getenv("ZSTORE_TEST_PUBLIC_REGISTRY") != "1" {
		t.Skip("set ZSTORE_TEST_PUBLIC_REGISTRY=1 for public registry inspection")
	}
	image := os.Getenv("ZSTORE_TEST_PUBLIC_IMAGE")
	if image == "" {
		image = "docker.io/library/nginx:stable"
	}
	info, err := inspectCloudImage(context.Background(), image)
	if err != nil {
		t.Fatal(err)
	}
	if info.Architecture != "linux/amd64" || !cloudDigestRE.MatchString(info.ImageDigest) || len(info.ExposedPorts) == 0 {
		t.Fatal("public image metadata incomplete")
	}
}
