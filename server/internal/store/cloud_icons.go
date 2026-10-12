package store

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	_ "image/jpeg"
	"image/png"
	"net/http"
	"regexp"
	"strings"

	_ "golang.org/x/image/webp"
)

type cloudIconData struct {
	MimeType string `json:"mimeType"`
	Base64   string `json:"base64"`
}

var cloudTokenIconRE = regexp.MustCompile(`^/api/cloud/icons/[a-f0-9]{64}$`)
var cloudIconHashRE = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (c *cloudService) saveIcon(ctx context.Context, in cloudIconData) (string, error) {
	invalid := errors.New("invalid icon")
	if len(in.Base64) > 700000 || !map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true}[in.MimeType] {
		return "", invalid
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(in.Base64)
	if err != nil || len(raw) > 512<<10 {
		return "", invalid
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 1024 || config.Height > 1024 {
		return "", invalid
	}
	if "image/"+format != in.MimeType {
		return "", invalid
	}
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", invalid
	}
	var normalized bytes.Buffer
	if err := png.Encode(&normalized, decoded); err != nil || normalized.Len() > 512<<10 {
		return "", invalid
	}
	icon := normalized.Bytes()
	hash := tokenHash(string(icon))
	if _, err = c.db.ExecContext(ctx, `INSERT INTO cloud_icons(hash,body) VALUES(?,?) ON CONFLICT(hash) DO NOTHING`, hash, icon); err != nil {
		return "", errors.New("icon persistence unavailable")
	}
	return "/api/cloud/icons/" + hash, nil
}
func (c *cloudService) icon(w http.ResponseWriter, r *http.Request) {
	hash := strings.TrimSuffix(r.PathValue("hash"), ".png")
	if !cloudIconHashRE.MatchString(hash) {
		http.NotFound(w, r)
		return
	}
	var body []byte
	if err := c.db.QueryRowContext(r.Context(), `SELECT body FROM cloud_icons WHERE hash=?`, hash).Scan(&body); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+hash+`"`)
	if r.Header.Get("If-None-Match") == `"`+hash+`"` {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Write(body)
}
