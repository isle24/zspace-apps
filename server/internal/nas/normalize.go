package nas

import (
	"encoding/json"
	"math"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

func sensitive(k string) bool {
	k = strings.ToLower(strings.NewReplacer("_", "", "-", "", " ", "").Replace(k))
	for _, v := range []string{"token", "password", "passwd", "secret", "credential", "privatekey", "publickey", "authorization", "cookie", "apikey", "accesskey", "sign"} {
		if strings.Contains(k, v) {
			return true
		}
	}
	return k == "key"
}
func (s *Service) clean(ss *session, v any) any {
	switch x := v.(type) {
	case map[string]any:
		m := map[string]any{}
		for k, v := range x {
			if !sensitive(k) {
				m[k] = s.clean(ss, v)
			}
		}
		return m
	case []any:
		a := make([]any, 0, len(x))
		for _, v := range x {
			a = append(a, s.clean(ss, v))
		}
		return a
	case string:
		if containsSecret(x, ss.token) {
			return ""
		}
		if u, e := url.Parse(x); e == nil && (u.IsAbs() || strings.HasPrefix(x, "/")) {
			if u.User != nil {
				return ""
			}
			for k := range u.Query() {
				if sensitive(k) {
					return ""
				}
			}
		}
		return x
	default:
		return v
	}
}
func (s *Service) normalize(ss *session, data any, op string, params map[string]any) map[string]any {
	items := []any{}
	total := any(0)
	var rows []any
	values := s.clean(ss, data)
	switch x := data.(type) {
	case []any:
		rows = x
	case map[string]any:
		for _, k := range []string{"items", "list", "albums", "feeds", "songs", "tasks", "apps", "data"} {
			if a, ok := x[k].([]any); ok {
				rows = a
				break
			}
		}
		if n, ok := x["total"]; ok {
			total = safeNumber(n)
		} else if n, ok := x["count"]; ok {
			total = safeNumber(n)
		}
		if rows == nil {
			if info, ok := x["info"].(map[string]any); ok {
				rows = []any{info}
			} else if text(x, "id", "name", "path", "title", "song_id", "file_path", "song_path", "url", "play_url", "uri") != "" {
				rows = []any{x}
			}
		}
	}
	for _, raw := range rows {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		safe := s.clean(ss, m).(map[string]any)
		name := text(safe, "name", "title", "album_name", "album", "playlist_name", "song_name", "app_name", "n")
		p := text(safe, "path", "file_path", "song_path")
		if p == "" && name != "" && strings.HasPrefix(op, "files.") {
			if parent, _ := params["path"].(string); parent != "" {
				p = path.Join(parent, name)
			}
		}
		if p == "" && op == "downloads.list" {
			if dir := text(safe, "downloadDir"); dir != "" && name != "" {
				p = path.Join(dir, name)
			}
		}
		kind := "file"
		if m["is_dir"] == true || text(m, "is_dir", "di") == "1" {
			kind = "directory"
		} else {
			switch {
			case strings.HasPrefix(op, "photos."):
				kind = "photo"
			case strings.HasPrefix(op, "music."):
				kind = "music"
			case strings.HasPrefix(op, "video."):
				kind = "video"
			case op == "apps.list":
				kind = "app"
			case op == "downloads.list":
				kind = "download"
			}
		}
		switch op {
		case "photos.albums", "music.albums":
			kind = "album"
		case "music.playlists":
			kind = "playlist"
		case "video.libraries":
			kind = "library"
		case "files.roots":
			kind = "directory"
		}
		id := text(safe, "id", "file_id", "feed_id", "album_id", "playlist_id", "song_id", "collection_id", "classification_id", "app_name", "hash")
		if id == "" {
			id = p
		}
		cover := text(m, "thumbnail", "thumb", "poster", "cover", "cover_url", "image_url", "song_cover")
		thumb := s.mediaURL(ss, cover)
		if thumb == "" && strings.HasPrefix(cover, "/") && !strings.Contains(cover, "?") && !strings.HasPrefix(cover, "//") {
			cleanCover, _ := s.clean(ss, cover).(string)
			if cleanCover != "" {
				thumb = s.mediaURL(ss, "/transcode/thumb?file_path="+url.QueryEscape(cleanCover)+"&dest_fmt=small&request_purpose=5")
			}
		}
		stream := s.mediaURL(ss, text(m, "stream", "stream_url", "play_url", "url", "uri"))
		if thumb == "" && p != "" && kind != "directory" {
			ext := strings.ToLower(path.Ext(p))
			if strings.Contains(" .jpg .jpeg .png .webp .gif .bmp .heic .mp4 .mkv .mov ", " "+ext+" ") {
				thumb = s.mediaURL(ss, "/transcode/thumb?file_path="+url.QueryEscape(p)+"&dest_fmt=small&request_purpose=5")
			}
		}
		if stream == "" && p != "" && kind != "directory" {
			stream = s.mediaURL(ss, "/v2/file/download?path="+url.QueryEscape(p)+"&remote_port=8050")
		}
		size := safe["size"]
		if size == nil {
			size = safe["s"]
		}
		if size == nil {
			size = safe["song_size"]
		}
		size = safeNumber(size)
		items = append(items, map[string]any{"id": id, "name": name, "kind": kind, "path": p, "thumbnail": thumb, "stream": stream, "size": size, "metadata": s.clean(ss, m)})
	}
	if total == 0 {
		total = len(items)
	}
	return s.clean(ss, map[string]any{"items": items, "total": total, "values": values}).(map[string]any)
}
func (s *Service) mediaURL(ss *session, raw string) string {
	if raw == "" {
		return ""
	}
	u, e := url.Parse(raw)
	if e != nil || u.User != nil || u.Fragment != "" {
		return ""
	}
	u = ss.base.ResolveReference(u)
	if u.Scheme != ss.base.Scheme || !strings.EqualFold(u.Host, ss.base.Host) || !allowedMediaPath(u.Path) {
		return ""
	}
	q := u.Query()
	for k, v := range common(ss) {
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()
	id := opaque()
	s.mu.Lock()
	s.pruneLocked()
	if len(s.media) >= 8192 {
		s.mu.Unlock()
		return ""
	}
	s.media[id] = mediaRef{ss.id, u, time.Now().Add(30 * time.Minute)}
	s.mu.Unlock()
	return "/api/nas/media/" + id
}
func allowedMediaPath(p string) bool {
	for _, prefix := range []string{"/play/", "/transcode/thumb", "/thumb/", "/v2/file/download", "/zmusic/play/", "/zvideo/play/", "/transcode/audio/play", "/transcode/cover", "/zmusic/cover/"} {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}

// NAS size/count values must be finite nonnegative numbers, never raw objects or strings.
func safeNumber(v any) any {
	var n float64
	switch x := v.(type) {
	case json.Number:
		n, _ = strconv.ParseFloat(x.String(), 64)
	case float64:
		n = x
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case string:
		n, _ = strconv.ParseFloat(x, 64)
	default:
		return 0
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 9007199254740991 {
		return 0
	}
	return n
}
