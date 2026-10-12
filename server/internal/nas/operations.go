package nas

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type operation struct{ method, path, params, app string }

// Each route is grounded in the current official client. No arbitrary NAS URL
// or action can be passed through this gateway.
var operations = map[string]operation{
	"files.roots":     {"POST", "/v2/file/sysdir", "", ""},
	"files.list":      {"POST", "/v2/file/list", "path start num sortby order show_hidden", ""},
	"files.info":      {"POST", "/v2/file/info", "path", ""},
	"files.recent":    {"POST", "/v2/recent/list", "start num scope show_hidden", ""},
	"photos.albums":   {"POST", "/v2/album/albums", "page page_size sortby", "album"},
	"photos.timeline": {"POST", "/v2/album/feed/timeline", "page page_size start end", "album"},
	"photos.feeds":    {"POST", "/v2/album/album/feeds", "album_id id page page_size sortby", "album"},
	"system.overview": {"POST", "/system", "", ""},
	"system.storage":  {"POST", "/storagepool/info2", "", ""},
	"system.network":  {"GET", "/network-settings/v1/interface/list", "", ""},
	"system.settings": {"POST", "/setting/load", "", ""},
	"video.libraries": {"POST", "/zvideo/classification/list", "", ""},
	"video.list":      {"POST", "/zvideo/video/v2/list", "classification_id start limit field sort system seen collection_type", ""},
	"video.info":      {"POST", "/zvideo/collection/v2/info", "id collection_id classification_id", ""},
	"video.play":      {"POST", "/zvideo/video/media", "id collection_id video_id path", ""},
	"music.songs":     {"POST", "/zmusic/api/v2/song/list", "page page_size filter_type filter_value sort_field order playlist_id", "music"},
	"music.albums":    {"GET", "/zmusic/api/v2/album/list", "page page_size filter_type filter_value sort_field order", "music"},
	"music.playlists": {"GET", "/zmusic/api/v2/playlist/list", "page page_size filter_type filter_value sort_field order", "music"},
	"music.lyrics":    {"GET", "/zmusic/api/v2/song/info/lyrics", "song_id id", "music"},
	"music.play":      {"GET", "/transcode/audio/play", "path file_path dest_fmt", "music"},
	"downloads.list":  {"POST", "/downloader/list", "type start size sortby order dir status", ""},
	"apps.list":       {"POST", "/AppStore/v1/list", "", ""},
}

func (s *Service) read(w http.ResponseWriter, r *http.Request) {
	ss, e := s.getSession(r.Header.Get("X-NAS-Session"))
	if e != nil {
		reply(w, nil, e)
		return
	}
	var in struct {
		Operation string         `json:"operation"`
		Params    map[string]any `json:"params"`
	}
	if e = decodeRequest(w, r, &in); e != nil {
		reply(w, nil, e)
		return
	}
	op, ok := operations[in.Operation]
	if !ok {
		reply(w, nil, failure("UNSUPPORTED_OPERATION", "当前 NAS 协议尚未验证此能力"))
		return
	}
	p := url.Values{}
	if in.Operation == "video.list" || in.Operation == "downloads.list" || in.Operation == "files.list" || in.Operation == "files.recent" {
		page, size := 1, 20
		for key, target := range map[string]*int{"page": &page, "pageSize": &size, "page_size": &size} {
			if value, ok := in.Params[key]; ok {
				n, err := strconv.Atoi(fmt.Sprint(value))
				if err != nil || n < 1 || n > 10000 || (key != "page" && n > 200) {
					reply(w, nil, failure("INVALID_PARAMS", "分页参数超出范围"))
					return
				}
				*target = n
				delete(in.Params, key)
			}
		}
		start := (page - 1) * size
		if in.Operation == "video.list" {
			start++
			p.Set("limit", strconv.Itoa(size))
		} else if in.Operation == "downloads.list" {
			p.Set("size", strconv.Itoa(size))
			p.Set("type", "loading")
		} else {
			p.Set("num", strconv.Itoa(size))
		}
		p.Set("start", strconv.Itoa(start))
	}
	for k, v := range in.Params {
		if k == "pageSize" {
			k = "page_size"
		}
		if !strings.Contains(" "+op.params+" ", " "+k+" ") {
			reply(w, nil, failure("INVALID_PARAMS", "读取请求包含不支持的参数"))
			return
		}
		switch v.(type) {
		case string, float64, bool:
		default:
			reply(w, nil, failure("INVALID_PARAMS", "读取参数必须为简单值"))
			return
		}
		if k == "page" || k == "page_size" {
			n, err := strconv.Atoi(fmt.Sprint(v))
			if err != nil || n < 1 || n > 10000 || (k == "page_size" && n > 200) {
				reply(w, nil, failure("INVALID_PARAMS", "分页参数超出范围"))
				return
			}
		}
		if in.Operation == "music.play" && k == "path" {
			k = "file_path"
		}
		p.Set(k, fmt.Sprint(v))
	}
	if in.Operation == "music.songs" && p.Get("playlist_id") != "" {
		op.method = "GET"
		op.path = "/zmusic/api/v2/playlist/record/list"
	}
	if in.Operation == "music.play" && p.Get("dest_fmt") == "" {
		p.Set("dest_fmt", "HQ")
	}
	if op.app != "" {
		p.Set("app", op.app)
	}
	data, e := s.call(r.Context(), ss, op.method, op.path, p)
	if e != nil {
		var ae *APIError
		if errors.As(e, &ae) && ae.Code == "SESSION_EXPIRED" {
			s.invalidate(ss.id)
		}
		reply(w, nil, e)
		return
	}
	reply(w, s.normalize(ss, data, in.Operation, in.Params), nil)
}
