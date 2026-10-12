package store

import (
	"context"
	"embed"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

//go:embed cloud_icon_assets/*
var cloudBuiltinArtwork embed.FS

func cloudBuiltinIcon(source string) ([]byte, string) {
	u, err := url.Parse(source)
	if err != nil || u.Hostname() != "raw.githubusercontent.com" || !strings.HasPrefix(u.Path, "/isle24/nas-app-store-catalog/") || !strings.Contains(u.Path, "/assets/icons/") {
		return nil, ""
	}
	name := path.Base(u.Path)
	body, err := cloudBuiltinArtwork.ReadFile("cloud_icon_assets/" + name)
	if err != nil {
		return nil, ""
	}
	mime := http.DetectContentType(body)
	if strings.HasSuffix(name, ".svg") {
		mime = "image/svg+xml"
	}
	return body, mime
}

func (c *cloudService) artwork(w http.ResponseWriter, r *http.Request) {
	source := r.URL.Query().Get("url")
	if key := r.PathValue("hash"); key != "" {
		if !cloudIconHashRE.MatchString(key) {
			http.NotFound(w, r)
			return
		}
		source = ""
		apps, err := c.readApps(false)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		published, _ := c.readApps(true)
		apps = append(apps, published...)
		for _, app := range apps {
			if tokenHash(app.Icon) == key {
				source = app.Icon
				break
			}
		}
	}
	if !cloudIconURL(source) || strings.HasPrefix(source, "/") || strings.Contains(source, "zstore.2iwm.com") {
		http.NotFound(w, r)
		return
	}
	key := tokenHash(source)
	var body []byte
	var mime string
	if err := c.db.QueryRowContext(r.Context(), `SELECT body,mime FROM cloud_artwork WHERE hash=?`, key).Scan(&body, &mime); err != nil {
		body, mime = cloudBuiltinIcon(source)
		if len(body) == 0 {
			ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, "GET", source, nil)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			client := &http.Client{Timeout: 12 * time.Second, Transport: cloudRegistryTransport{base: &http.Transport{Proxy: nil, DialContext: cloudPublicDial, TLSHandshakeTimeout: 5 * time.Second}}, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
			// Artwork uses a separate host policy from registry credentials.
			client.Transport = cloudArtworkTransport{client.Transport.(cloudRegistryTransport).base}
			resp, err := client.Do(req)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				http.NotFound(w, r)
				return
			}
			body, err = io.ReadAll(io.LimitReader(resp.Body, 512<<10+1))
			if err != nil || len(body) > 512<<10 {
				http.NotFound(w, r)
				return
			}
			mime = http.DetectContentType(body)
			if strings.Contains(resp.Header.Get("Content-Type"), "image/svg+xml") && strings.Contains(string(body), "<svg") {
				mime = "image/svg+xml"
			}
			if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" && mime != "image/svg+xml" {
				http.NotFound(w, r)
				return
			}
		}
		if _, err = c.db.ExecContext(r.Context(), `INSERT INTO cloud_artwork(hash,body,mime) VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING`, key, body, mime); err != nil {
			http.NotFound(w, r)
			return
		}
	}
	hash := tokenHash(string(body))
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("ETag", `"`+hash+`"`)
	if r.Header.Get("If-None-Match") == `"`+hash+`"` {
		w.WriteHeader(304)
		return
	}
	w.Write(body)
}

type cloudArtworkTransport struct{ base http.RoundTripper }

func (t cloudArtworkTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if !cloudIconURL(r.URL.String()) {
		return nil, http.ErrNotSupported
	}
	return t.base.RoundTrip(r)
}
