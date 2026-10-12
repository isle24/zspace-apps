package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/authn"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

type cloudCacheSettings struct {
	Enabled  bool  `json:"enabled"`
	MaxBytes int64 `json:"maxBytes"`
}
type cloudCacheEntry struct {
	Key       string `json:"key"`
	Image     string `json:"image"`
	Digest    string `json:"digest"`
	MediaType string `json:"mediaType"`
	SizeBytes int64  `json:"sizeBytes"`
	Hits      int64  `json:"hits"`
	LastUsed  int64  `json:"lastUsed"`
}
type cloudImageCache struct {
	readers        map[string]int
	mu             sync.Mutex
	fillMu         sync.Mutex
	reserved       int64
	downloadCancel context.CancelFunc
	c              *cloudService
	dir            string
	settings       cloudCacheSettings
	entries        map[string]cloudCacheEntry
	queue          chan string
	fetch          func(context.Context, string) (v1.Image, error)
}

func (c *cloudService) initializeCache() error {
	pool := &cloudImageCache{c: c, dir: filepath.Join(c.s.opts.DataDir, "image-cache"), entries: map[string]cloudCacheEntry{}, readers: map[string]int{}, queue: make(chan string, 32)}
	if err := os.MkdirAll(pool.dir, 0700); err != nil {
		return err
	}
	var raw []byte
	hasSettings := false
	if err := c.db.QueryRow(`SELECT value FROM cloud_private WHERE key='image_cache_settings'`).Scan(&raw); err == nil {
		hasSettings = true
		if json.Unmarshal(raw, &pool.settings) != nil {
			return errors.New("invalid cache settings")
		}
	}
	if err := c.db.QueryRow(`SELECT value FROM cloud_private WHERE key='image_cache_entries'`).Scan(&raw); err == nil {
		if json.Unmarshal(raw, &pool.entries) != nil {
			return errors.New("invalid cache index")
		}
	}
	for key, entry := range pool.entries {
		if !cloudIconHashRE.MatchString(key) || entry.Key != key || entry.SizeBytes < 0 {
			return errors.New("invalid cache entry")
		}
		if _, err := os.Stat(filepath.Join(pool.dir, key, "manifest.json")); err != nil {
			delete(pool.entries, key)
		}
	}
	// Recover only files owned by this cache after an interrupted download.
	children, err := os.ReadDir(pool.dir)
	if err != nil {
		return err
	}
	for _, child := range children {
		name := child.Name()
		_, indexed := pool.entries[name]
		if strings.HasPrefix(name, ".download-") || cloudIconHashRE.MatchString(name) && !indexed {
			if err := os.RemoveAll(filepath.Join(pool.dir, name)); err != nil {
				return err
			}
		}
	}
	if !hasSettings {
		if raw := os.Getenv("SPACE_IMAGE_CACHE_DEFAULT_BYTES"); raw != "" {
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || n < 16<<20 || n > 1<<40 {
				return errors.New("invalid default cache capacity")
			}
			pool.settings = cloudCacheSettings{Enabled: true, MaxBytes: n}
			b, _ := json.Marshal(pool.settings)
			if _, err := c.db.Exec(`INSERT INTO cloud_private(key,value) VALUES('image_cache_settings',?) ON CONFLICT(key) DO NOTHING`, b); err != nil {
				return err
			}
		}
	}
	pool.fetch = func(ctx context.Context, raw string) (v1.Image, error) {
		ref, err := cloudImageReference(raw)
		if err != nil {
			return nil, err
		}
		return remote.Image(ref, remote.WithContext(ctx), remote.WithAuth(authn.Anonymous), remote.WithPlatform(v1.Platform{OS: "linux", Architecture: "amd64"}), remote.WithTransport(cloudCacheTransport{cloudRegistryHTTPTransport()}))
	}
	c.cache = pool
	pool.evictLocked(0, "")
	c.s.wg.Add(1)
	go func() {
		defer c.s.wg.Done()
		timer := time.NewTicker(10 * time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-c.s.ctx.Done():
				return
			case image := <-pool.queue:
				ctx, cancel := context.WithTimeout(c.s.ctx, 10*time.Minute)
				_ = pool.ensure(ctx, image)
				cancel()
			case <-timer.C:
				pool.enqueueCatalog()
			}
		}
	}()
	pool.enqueueCatalog()
	return nil
}

// Registry metadata stays bounded. Layers are streamed into independently
// bounded files below; the inspection transport's 2MiB body limit does not apply.
type cloudCacheTransport struct{ base http.RoundTripper }

func (t cloudCacheTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(r)
	if err == nil && strings.Contains(r.URL.Path, "/blobs/") {
		if body, ok := resp.Body.(*cloudLimitedBody); ok {
			resp.Body = body.Closer.(io.ReadCloser)
		}
	}
	return resp, err
}

func (p *cloudImageCache) persistLocked() error {
	raw, err := json.Marshal(p.entries)
	if err != nil {
		return err
	}
	_, err = p.c.db.Exec(`INSERT INTO cloud_private(key,value) VALUES('image_cache_entries',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, raw)
	return err
}
func (p *cloudImageCache) usedLocked() int64 {
	var n int64
	for _, e := range p.entries {
		n += e.SizeBytes
	}
	return n
}
func (p *cloudImageCache) evictLocked(reserve int64, keep string) {
	for p.usedLocked()+reserve > p.settings.MaxBytes {
		var candidate *cloudCacheEntry
		for key, e := range p.entries {
			if key == keep || p.readers[key] > 0 {
				continue
			}
			e := e
			if candidate == nil || e.Hits < candidate.Hits || e.Hits == candidate.Hits && e.LastUsed < candidate.LastUsed {
				candidate = &e
			}
		}
		if candidate == nil {
			break
		}
		if cloudIconHashRE.MatchString(candidate.Key) {
			_ = os.RemoveAll(filepath.Join(p.dir, candidate.Key))
		}
		delete(p.entries, candidate.Key)
	}
	_ = p.persistLocked()
}
func (p *cloudImageCache) touch(key string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.entries[key]; ok {
		e.Hits++
		e.LastUsed = time.Now().Unix()
		p.entries[key] = e
		_ = p.persistLocked()
	}
}
func (p *cloudImageCache) enqueue(image string) {
	p.mu.Lock()
	enabled := p.settings.Enabled && p.settings.MaxBytes > 0
	p.mu.Unlock()
	if enabled {
		select {
		case p.queue <- image:
		default:
		}
	}
}
func (p *cloudImageCache) enqueueCatalog() {
	items, err := p.c.readApps(true)
	if err != nil {
		return
	}
	sort.SliceStable(items, func(i, j int) bool {
		var a, b int64
		_ = p.c.db.QueryRow(`SELECT count(*) FROM cloud_history WHERE app_id=?`, items[i].ID).Scan(&a)
		_ = p.c.db.QueryRow(`SELECT count(*) FROM cloud_history WHERE app_id=?`, items[j].ID).Scan(&b)
		return a > b
	})
	for _, app := range items {
		p.enqueue(app.Image)
	}
}

func (p *cloudImageCache) ensure(ctx context.Context, raw string) error {
	p.fillMu.Lock()
	defer p.fillMu.Unlock()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	p.mu.Lock()
	settings := p.settings
	p.downloadCancel = cancel
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.reserved = 0; p.downloadCancel = nil; p.mu.Unlock() }()
	if !settings.Enabled || settings.MaxBytes < 1 {
		return errors.New("cache disabled")
	}
	ref, err := cloudImageReference(raw)
	if err != nil {
		return err
	}
	// Existing pinned entries do not hit upstream registries.
	canonical := cloudRepository(ref) + "@" + ref.Identifier()
	key := tokenHash(canonical)
	p.mu.Lock()
	if e, ok := p.entries[key]; ok {
		e.Hits++
		e.LastUsed = time.Now().Unix()
		p.entries[key] = e
		err := p.persistLocked()
		p.mu.Unlock()
		return err
	}
	p.mu.Unlock()
	img, err := p.fetch(ctx, raw)
	if err != nil {
		return errors.New("cache registry unavailable")
	}
	digest, err := img.Digest()
	if err != nil {
		return err
	}
	canonical = cloudRepository(ref) + "@" + digest.String()
	key = tokenHash(canonical)
	p.mu.Lock()
	if e, ok := p.entries[key]; ok {
		e.Hits++
		e.LastUsed = time.Now().Unix()
		p.entries[key] = e
		err := p.persistLocked()
		p.mu.Unlock()
		return err
	}
	p.mu.Unlock()
	manifest, err := img.RawManifest()
	if err != nil || len(manifest) > 4<<20 || "sha256:"+tokenHash(string(manifest)) != digest.String() {
		return errors.New("invalid cache manifest")
	}
	m, err := img.Manifest()
	if err != nil {
		return err
	}
	if m.Config.Size < 1 || m.Config.Size > 1<<20 {
		return errors.New("invalid config size")
	}
	size := int64(len(manifest)) + m.Config.Size
	for _, layer := range m.Layers {
		if layer.Size < 0 || layer.Size > settings.MaxBytes-size {
			return errors.New("image exceeds cache capacity")
		}
		size += layer.Size
	}
	if size < 1 || size > settings.MaxBytes {
		return errors.New("image exceeds cache capacity")
	}
	// Evict first so even the temporary download fits the configured budget.
	p.mu.Lock()
	if !p.settings.Enabled || size > p.settings.MaxBytes {
		p.mu.Unlock()
		return errors.New("cache budget changed")
	}
	p.evictLocked(size, "")
	if p.usedLocked()+size > p.settings.MaxBytes {
		p.mu.Unlock()
		return errors.New("cache entries busy")
	}
	p.reserved = size
	p.downloadCancel = cancel
	p.mu.Unlock()
	stage, err := os.MkdirTemp(p.dir, ".download-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err = os.WriteFile(filepath.Join(stage, "manifest.json"), manifest, 0600); err != nil {
		return err
	}
	config, err := img.RawConfigFile()
	if err != nil || int64(len(config)) != m.Config.Size || "sha256:"+tokenHash(string(config)) != m.Config.Digest.String() {
		return errors.New("invalid image config")
	}
	var cfg v1.ConfigFile
	if json.Unmarshal(config, &cfg) != nil || cfg.OS != "linux" || cfg.Architecture != "amd64" {
		return errors.New("unsupported cache platform")
	}
	if err = os.WriteFile(filepath.Join(stage, m.Config.Digest.Hex), config, 0600); err != nil {
		return err
	}
	layers, err := img.Layers()
	if err != nil || len(layers) != len(m.Layers) {
		return errors.New("invalid layer list")
	}
	for i, layer := range layers {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		reader, err := layer.Compressed()
		if err != nil {
			return errors.New("layer unavailable")
		}
		f, err := os.OpenFile(filepath.Join(stage, m.Layers[i].Digest.Hex), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			reader.Close()
			return err
		}
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(reader, m.Layers[i].Size+1))
		reader.Close()
		closeErr := f.Close()
		if copyErr != nil || closeErr != nil || n != m.Layers[i].Size || hex.EncodeToString(h.Sum(nil)) != m.Layers[i].Digest.Hex {
			return errors.New("layer digest verification failed")
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if ctx.Err() != nil || !p.settings.Enabled || size > p.settings.MaxBytes {
		return errors.New("cache budget changed")
	}
	p.evictLocked(size, "")
	if err = os.Rename(stage, filepath.Join(p.dir, key)); err != nil {
		return err
	}
	e := cloudCacheEntry{Key: key, Image: canonical, Digest: digest.String(), MediaType: string(m.MediaType), SizeBytes: size, Hits: 1, LastUsed: time.Now().Unix()}
	p.entries[key] = e
	if err = p.persistLocked(); err != nil {
		delete(p.entries, key)
		_ = os.RemoveAll(filepath.Join(p.dir, key))
		return err
	}
	return nil
}

func (c *cloudService) registerCache(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/store/admin/image-cache", c.auth(true, c.getCacheSettings))
	mux.HandleFunc("POST /api/store/admin/image-cache", c.auth(true, c.saveCacheSettings))
	mux.HandleFunc("POST /api/store/admin/image-cache/warm", c.auth(true, c.warmCache))
	mux.HandleFunc("GET /v2/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Docker-Distribution-Api-Version", "registry/2.0")
		respond(w, 200, map[string]any{})
	})
	mux.HandleFunc("GET /v2/cache/", c.cacheRegistry)
}
func (c *cloudService) getCacheSettings(w http.ResponseWriter, r *http.Request) {
	p := c.cache
	p.mu.Lock()
	defer p.mu.Unlock()
	items := []cloudCacheEntry{}
	for _, e := range p.entries {
		items = append(items, e)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Hits > items[j].Hits })
	respond(w, 200, map[string]any{"enabled": p.settings.Enabled, "maxBytes": p.settings.MaxBytes, "usedBytes": p.usedLocked(), "downloadingBytes": p.reserved, "items": items})
}
func (c *cloudService) saveCacheSettings(w http.ResponseWriter, r *http.Request) {
	var in cloudCacheSettings
	if !decode(w, r, &in) {
		return
	}
	if in.MaxBytes < 0 || in.MaxBytes > 1<<40 || in.Enabled && in.MaxBytes < 16<<20 {
		fail(w, 400, "invalid_cache_size", "缓存容量须为16 MiB至1 TiB，关闭时可为0。")
		return
	}
	p := c.cache
	p.mu.Lock()
	if p.downloadCancel != nil {
		p.downloadCancel()
	}
	var active int64
	for key, n := range p.readers {
		if n > 0 {
			active += p.entries[key].SizeBytes
		}
	}
	p.mu.Unlock()
	if in.MaxBytes < active {
		fail(w, 409, "cache_busy", "缓存镜像正在传输，请传输完成后再缩小容量。")
		return
	}
	p.fillMu.Lock()
	defer p.fillMu.Unlock()
	p.mu.Lock()
	active = 0
	for key, n := range p.readers {
		if n > 0 {
			active += p.entries[key].SizeBytes
		}
	}
	if in.MaxBytes < active {
		p.mu.Unlock()
		fail(w, 409, "cache_busy", "缓存镜像正在传输，请传输完成后再缩小容量。")
		return
	}
	raw, _ := json.Marshal(in)
	_, err := c.db.ExecContext(r.Context(), `INSERT INTO cloud_private(key,value) VALUES('image_cache_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, raw)
	if err == nil {
		if p.downloadCancel != nil {
			p.downloadCancel()
		}
		p.settings = in
		p.evictLocked(0, "")
	}
	p.mu.Unlock()
	if err != nil {
		fail(w, 500, "cache_settings_failed", "缓存设置保存失败。")
		return
	}
	if in.Enabled {
		p.enqueueCatalog()
	}
	c.getCacheSettings(w, r)
}
func (c *cloudService) warmCache(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AppID string `json:"appId"`
	}
	if !decode(w, r, &in) {
		return
	}
	app, err := c.readApp(in.AppID, true)
	if err != nil {
		fail(w, 404, "app_not_found", "请选择已上架应用。")
		return
	}
	c.cache.enqueue(app.Image)
	respond(w, 202, map[string]any{"queued": true})
}
func (c *cloudService) cacheRegistry(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v2/cache/"), "/")
	if len(parts) != 3 || !cloudIconHashRE.MatchString(parts[0]) || !cloudDigestRE.MatchString(parts[2]) || parts[1] != "manifests" && parts[1] != "blobs" {
		http.NotFound(w, r)
		return
	}
	p := c.cache
	p.mu.Lock()
	e, ok := p.entries[parts[0]]
	if !ok || !p.settings.Enabled {
		p.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	file := strings.TrimPrefix(parts[2], "sha256:")
	media := "application/octet-stream"
	if parts[1] == "manifests" {
		if parts[2] != e.Digest {
			p.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		file = "manifest.json"
		media = e.MediaType
	}
	f, err := os.Open(filepath.Join(p.dir, e.Key, file))
	if err != nil {
		p.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		p.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	e.Hits++
	e.LastUsed = time.Now().Unix()
	p.entries[e.Key] = e
	_ = p.persistLocked()
	p.readers[e.Key]++
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.readers[e.Key]--; p.mu.Unlock() }()
	w.Header().Set("Content-Type", media)
	w.Header().Set("Docker-Content-Digest", parts[2])
	w.Header().Set("Docker-Distribution-Api-Version", "registry/2.0")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", fmt.Sprintf("%q", parts[2]))
	http.ServeContent(w, r, file, st.ModTime(), f)
}

func runtimeCacheReference(reference string) string {
	return "zstore.2iwm.com/cache/" + tokenHash(reference) + "@" + reference[strings.LastIndex(reference, "@")+1:]
}
