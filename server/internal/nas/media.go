package nas

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (s *Service) serveMedia(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	m, ok := s.media[r.PathValue("id")]
	s.mu.RUnlock()
	if !ok || time.Now().After(m.expires) {
		reply(w, nil, failure("NO_SESSION", "媒体会话已过期，请刷新列表"))
		return
	}
	ss, e := s.getSession(m.sessionID)
	if e != nil {
		reply(w, nil, e)
		return
	}
	if supplied := r.Header.Get("X-NAS-Session"); supplied != "" && supplied != ss.id {
		reply(w, nil, failure("NO_SESSION", "媒体不属于此 NAS 会话"))
		return
	}
	if m.source.Scheme != ss.base.Scheme || !strings.EqualFold(m.source.Host, ss.base.Host) {
		reply(w, nil, failure("INVALID_REQUEST", "媒体地址不属于当前 NAS"))
		return
	}
	// A caller's Range may start after a manifest header. Verify source byte
	// zero independently before allowing any partial body, never classify only
	// the requested offset. The bounded probe follows the same NAS host binding.
	sourceVerified := false
	if r.Header.Get("Range") != "" {
		if err := s.verifyMediaSource(r.Context(), ss, m.source); err != nil {
			reply(w, nil, err)
			return
		}
		if _, err := s.getSession(ss.id); err != nil {
			reply(w, nil, err)
			return
		}
		sourceVerified = true
	}
	req, e := http.NewRequestWithContext(r.Context(), "GET", m.source.String(), nil)
	if e != nil {
		reply(w, nil, e)
		return
	}
	req.Header.Set("token", ss.token)
	for _, k := range []string{"Range", "If-Range", "If-None-Match", "If-Modified-Since"} {
		if v := r.Header.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	resp, e := s.mediaClient.Do(req)
	if e != nil {
		reply(w, nil, failure("NAS_UNAVAILABLE", "无法读取 NAS 媒体"))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		s.invalidate(ss.id)
		reply(w, nil, failure("SESSION_EXPIRED", "NAS 会话已过期，请重新登录"))
		return
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 && resp.StatusCode != 304 {
		reply(w, nil, failure("MEDIA_REDIRECT_BLOCKED", "NAS 媒体重定向被拒绝"))
		return
	}
	if resp.StatusCode != 200 && resp.StatusCode != 206 && resp.StatusCode != 304 && resp.StatusCode != 416 {
		reply(w, nil, failure("NAS_HTTP_ERROR", "NAS 无法提供此媒体"))
		return
	}

	ct, _, mimeErr := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	ct = strings.ToLower(ct)
	var prefix []byte
	if resp.StatusCode == 200 || resp.StatusCode == 206 {
		prefix = make([]byte, 512)
		n, readErr := io.ReadFull(resp.Body, prefix)
		prefix = prefix[:n]
		if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
			reply(w, nil, failure("NAS_UNAVAILABLE", "NAS 媒体读取中断"))
			return
		}
		trimmed := bytes.TrimSpace(bytes.TrimPrefix(prefix, []byte{0xef, 0xbb, 0xbf}))
		lower := strings.ToLower(string(trimmed))
		isJSON := strings.HasPrefix(lower, "{") || strings.HasPrefix(lower, "[") || strings.Contains(ct, "json")
		if isJSON {
			rest, readErr := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			body := append(prefix, rest...)
			if readErr != nil {
				reply(w, nil, failure("INVALID_RESPONSE", "NAS 媒体响应无效"))
				return
			}
			_, err := DecodeResponse(body)
			var ae *APIError
			if errors.As(err, &ae) && ae.Code == "SESSION_EXPIRED" {
				s.invalidate(ss.id)
			}
			if err != nil {
				reply(w, nil, err)
				return
			}
			reply(w, nil, failure("UNSUPPORTED_OPERATION", "NAS 返回了媒体描述，需要额外适配"))
			return
		}
		detected := strings.ToLower(strings.Split(http.DetectContentType(prefix), ";")[0])
		unsafeText := strings.HasPrefix(lower, "#extm3u") || strings.HasPrefix(lower, "<") || strings.Contains(ct, "mpegurl") || strings.Contains(ct, "html") || strings.Contains(ct, "javascript") || strings.Contains(ct, "xml") || strings.Contains(ct, "svg")
		if containsSecret(string(prefix), ss.token) {
			unsafeText = true
		}
		// An ASCII range is admitted only after independent byte-zero verification.
		if strings.HasPrefix(detected, "text/") && !(resp.StatusCode == 206 && sourceVerified) {
			unsafeText = true
		}
		if ct == "" || mimeErr != nil {
			ct = detected
		}
		if unsafeText || !passiveMediaType(ct) {
			reply(w, nil, failure("UNSUPPORTED_OPERATION", "NAS 返回的媒体格式需要额外适配"))
			return
		}
	}
	for _, k := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(k); v != "" && !containsSecret(v, ss.token) {
			w.Header().Set(k, v)
		}
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(resp.StatusCode)
	if resp.StatusCode == 200 || resp.StatusCode == 206 {
		io.Copy(w, io.MultiReader(bytes.NewReader(prefix), resp.Body))
	}
}

func passiveMediaType(ct string) bool {
	if ct == "application/octet-stream" {
		return true
	}
	if strings.HasPrefix(ct, "audio/") || strings.HasPrefix(ct, "video/") {
		return !strings.Contains(ct, "mpegurl")
	}
	switch ct {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/avif", "image/heic", "image/heif", "image/x-icon":
		return true
	}
	return false
}

// containsSecret checks the original text plus bounded URL-decoded forms.
// Query decoding treats plus as space; path decoding preserves literal plus.
func containsSecret(raw, token string) bool {
	if token == "" {
		return false
	}
	current := []string{raw}
	for depth := 0; depth < 3; depth++ {
		next := []string{}
		for _, value := range current {
			if strings.Contains(value, token) {
				return true
			}
			for _, decode := range []func(string) (string, error){url.QueryUnescape, url.PathUnescape} {
				decoded, err := decode(value)
				if err == nil && decoded != value {
					next = append(next, decoded)
				}
			}
		}
		current = next
	}
	for _, value := range current {
		if strings.Contains(value, token) {
			return true
		}
	}
	return false
}
func (s *Service) verifyMediaSource(ctx context.Context, ss *session, source *url.URL) error {
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, "GET", source.String(), nil)
	if err != nil {
		return failure("INVALID_RESPONSE", "媒体源无法验证")
	}
	req.Header.Set("token", ss.token)
	req.Header.Set("Range", "bytes=0-511")
	resp, err := s.mediaClient.Do(req)
	if err != nil {
		return failure("NAS_UNAVAILABLE", "无法验证 NAS 媒体源")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		s.invalidate(ss.id)
		return failure("SESSION_EXPIRED", "NAS 会话已过期，请重新登录")
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return failure("MEDIA_REDIRECT_BLOCKED", "NAS 媒体重定向被拒绝")
	}
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		return failure("NAS_HTTP_ERROR", "NAS 无法提供媒体源开头")
	}
	if resp.StatusCode == 206 && !strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Range")), "bytes 0-") {
		return failure("UNSUPPORTED_OPERATION", "NAS 未返回从开头开始的媒体验证范围")
	}
	prefix := make([]byte, 512)
	n, err := io.ReadFull(resp.Body, prefix)
	prefix = prefix[:n]
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return failure("NAS_UNAVAILABLE", "NAS 媒体源验证中断")
	}
	ct, _, mimeErr := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	ct = strings.ToLower(ct)
	detected := strings.ToLower(strings.Split(http.DetectContentType(prefix), ";")[0])
	trimmed := strings.ToLower(string(bytes.TrimSpace(bytes.TrimPrefix(prefix, []byte{0xef, 0xbb, 0xbf}))))
	if strings.HasPrefix(trimmed, "{") || strings.Contains(ct, "json") {
		_, decodeErr := DecodeResponse(prefix)
		var ae *APIError
		if errors.As(decodeErr, &ae) && ae.Code == "SESSION_EXPIRED" {
			s.invalidate(ss.id)
			return decodeErr
		}
		return failure("UNSUPPORTED_OPERATION", "NAS 返回了媒体描述，无法直接播放")
	}
	if ct == "" || mimeErr != nil {
		ct = detected
	}
	if n == 0 || strings.HasPrefix(detected, "text/") || strings.HasPrefix(trimmed, "#extm3u") || strings.HasPrefix(trimmed, "<") || containsSecret(string(prefix), ss.token) || strings.Contains(ct, "json") || strings.Contains(ct, "xml") || strings.Contains(ct, "svg") || strings.Contains(ct, "javascript") || !passiveMediaType(ct) {
		return failure("UNSUPPORTED_OPERATION", "媒体源开头未通过安全验证")
	}
	return nil
}
