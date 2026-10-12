package store

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"
)

func (c *cloudService) artwork(w http.ResponseWriter, r *http.Request) {
	source := r.URL.Query().Get("url")
	if !cloudIconURL(source) || strings.HasPrefix(source, "/") || strings.Contains(source, "zstore.2iwm.com") {
		http.NotFound(w, r)
		return
	}
	key := tokenHash(source)
	var body []byte
	var mime string
	if err := c.db.QueryRowContext(r.Context(), `SELECT body,mime FROM cloud_artwork WHERE hash=?`, key).Scan(&body, &mime); err != nil {
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
