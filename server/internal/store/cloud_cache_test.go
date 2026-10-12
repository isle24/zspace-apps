package store

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/random"
)

func TestCloudImageCacheCapacityEvictionAndVerifiedRegistry(t *testing.T) {
	r := newRig(t)
	c, err := newCloudService(r.s)
	if err != nil {
		t.Fatal(err)
	}
	cache := c.cache
	a, _ := random.Image(2048, 1)
	b, _ := random.Image(2048, 1)
	d, _ := random.Image(2048, 1)
	for _, im := range []*v1.Image{&a, &b, &d} {
		config, _ := (*im).ConfigFile()
		config.OS = "linux"
		config.Architecture = "amd64"
		*im, _ = mutate.ConfigFile(*im, config)
	}
	images := map[string]v1.Image{"nginx:1": a, "nginx:2": b, "nginx:3": d}
	cache.fetch = func(ctx context.Context, ref string) (v1.Image, error) { return images[ref], nil }
	cache.settings = cloudCacheSettings{Enabled: true, MaxBytes: 9000}
	if err := cache.ensure(context.Background(), "nginx:1"); err != nil {
		t.Fatal(err)
	}
	if err := cache.ensure(context.Background(), "nginx:2"); err != nil {
		t.Fatal(err)
	}
	ad, _ := a.Digest()
	key := tokenHash("docker.io/library/nginx@" + ad.String())
	cache.touch(key)
	cache.touch(key)
	cache.mu.Lock()
	cache.settings.MaxBytes = cache.entries[key].SizeBytes + 100
	cache.evictLocked(0, "")
	cache.mu.Unlock()
	if _, ok := cache.entries[key]; !ok {
		t.Fatal("hot image evicted before cold image")
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v2/cache/"+key+"/manifests/"+ad.String(), nil)
	c.cacheRegistry(w, req)
	if w.Code != 200 || tokenHash(w.Body.String()) != ad.Hex {
		t.Fatal("registry did not preserve image manifest digest", w.Code)
	}
	cache.mu.Lock()
	cache.settings.MaxBytes = 1
	cache.evictLocked(0, "")
	cache.mu.Unlock()
	if cache.usedLocked() != 0 {
		t.Fatal("pool exceeded reduced budget")
	}
	if err := cache.ensure(context.Background(), "nginx:3"); err == nil {
		t.Fatal("oversized image admitted")
	}
}

func TestCloudImageCacheAdminIsolationAndDisabledFallback(t *testing.T) {
	r, mux := cloudRig(t)
	user := cloudRegister(t, mux, "cache-user")
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/image-cache", user, map[string]any{"enabled": true, "maxBytes": 100}); status != 403 {
		t.Fatal(status)
	}
	admin := cloudAdmin(t, r, mux)
	if status, _ := cloudCall(t, mux, "POST", "/api/store/admin/image-cache", admin, map[string]any{"enabled": false, "maxBytes": 0}); status != 200 {
		t.Fatal(status)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v2/cache/"+tokenHash("fake")+"/manifests/sha256:"+tokenHash("fake"), nil))
	if w.Code != 404 {
		t.Fatal("disabled cache must let Docker fall back", w.Code)
	}
}

func TestCloudImageCacheRecoversInterruptedFiles(t *testing.T) {
	r := newRig(t)
	dir := filepath.Join(r.s.opts.DataDir, "image-cache")
	if err := os.MkdirAll(filepath.Join(dir, ".download-interrupted"), 0700); err != nil {
		t.Fatal(err)
	}
	orphan := tokenHash("orphan")
	if err := os.Mkdir(filepath.Join(dir, orphan), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".download-interrupted", "layer"), make([]byte, 4096), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := newCloudService(r.s)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".download-interrupted")); !os.IsNotExist(err) {
		t.Fatal("partial download not recovered")
	}
	if _, err := os.Stat(filepath.Join(dir, orphan)); !os.IsNotExist(err) {
		t.Fatal("unindexed final image retained outside capacity")
	}
	if c.cache.usedLocked() != 0 {
		t.Fatal("invalid restored accounting")
	}
}

func TestCloudImageCacheWrongManifestDigestDoesNotBlockSubsequentRequests(t *testing.T) {
	r := newRig(t)
	c, err := newCloudService(r.s)
	if err != nil {
		t.Fatal(err)
	}
	p := c.cache
	manifest := []byte(`{"schemaVersion":2}`)
	digest := "sha256:" + tokenHash(string(manifest))
	key := tokenHash("docker.io/library/review@" + digest)
	if err = os.MkdirAll(filepath.Join(p.dir, key), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(p.dir, key, "manifest.json"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	p.settings = cloudCacheSettings{Enabled: true, MaxBytes: 1 << 20}
	p.entries[key] = cloudCacheEntry{Key: key, Digest: digest, MediaType: "application/vnd.oci.image.manifest.v1+json", SizeBytes: int64(len(manifest))}
	p.mu.Unlock()
	w := httptest.NewRecorder()
	c.cacheRegistry(w, httptest.NewRequest("GET", "/v2/cache/"+key+"/manifests/sha256:"+tokenHash("wrong"), nil))
	if w.Code != 404 {
		t.Fatal("wrong digest should miss", w.Code)
	}
	if !p.mu.TryLock() {
		t.Fatal("wrong digest request locked the cache permanently")
	}
	p.mu.Unlock()
	w = httptest.NewRecorder()
	c.cacheRegistry(w, httptest.NewRequest("GET", "/v2/cache/"+key+"/manifests/"+digest, nil))
	if w.Code != 200 || w.Body.String() != string(manifest) {
		t.Fatal("valid registry request blocked after miss")
	}
	w = httptest.NewRecorder()
	c.getCacheSettings(w, httptest.NewRequest("GET", "/api/store/admin/image-cache", nil))
	if w.Code != 200 {
		t.Fatal("settings blocked after wrong digest")
	}
}
