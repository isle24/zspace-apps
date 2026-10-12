package nas

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestReviewCanonicalSecretLeak(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"code":200,"data":{"list":[{"id":"upstream-secret","name":"upstream-secret","path":"/my/upstream-secret","size":"upstream-secret"}],"total":1}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.list"})
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "upstream-secret") {
		t.Fatal("upstream token exposed by canonical fields")
	}
}
func TestReviewMediaSecretLeak(t *testing.T) {
	for _, ct := range []string{"application/x-mpegURL", "application/octet-stream", ""} {
		t.Run(ct, func(t *testing.T) {
			up := fake(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v2/file/info" {
					io.WriteString(w, `{"code":200,"data":{"name":"song","stream":"/play/manifest"}}`)
					return
				}
				if ct == "" {
					w.Header().Del("Content-Type")
				} else {
					w.Header().Set("Content-Type", ct)
				}
				io.WriteString(w, "#EXTM3U\n/play/segment.ts?token=upstream-secret\n")
			})
			g := gateway(t)
			id := sid(t, g.URL, up.URL)
			_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.info"})
			stream := v["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["stream"].(string)
			resp, e := http.Get(g.URL + stream)
			if e != nil {
				t.Fatal(e)
			}
			defer resp.Body.Close()
			b, _ := io.ReadAll(resp.Body)
			if strings.Contains(string(b), "upstream-secret") {
				t.Fatalf("authenticated HLS manifest returned raw: status %d, content-type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
			}
		})
	}
}
func TestReviewOfficialSongSchema(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"code":200,"data":{"list":[{"song_id":"s1","song_name":"a.mp3","song_path":"/my/a.mp3","song_cover":"/my/a.jpg","song_size":1000}],"count":1}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "music.songs"})
	item := v["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if item["path"] == "" || item["stream"] == "" || item["size"] == float64(0) {
		t.Fatalf("official song_path/song_size ignored: path=%q stream=%q size=%v", item["path"], item["stream"], item["size"])
	}
}
func TestReviewOfficialPlayURI(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"code":200,"data":{"uri":"/play/a.mp3"}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "music.play"})
	items := v["data"].(map[string]any)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("official data.uri produces zero normalized play items: %v", items)
	}
}

func TestReviewFilePagination(t *testing.T) {
	for _, op := range []string{"files.list", "files.recent"} {
		t.Run(op, func(t *testing.T) {
			up := fake(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Form.Get("start") != "12" || r.Form.Get("num") != "12" {
					t.Errorf("official zero-based start/num not sent: start=%q num=%q page=%q page_size=%q", r.Form.Get("start"), r.Form.Get("num"), r.Form.Get("page"), r.Form.Get("page_size"))
				}
				io.WriteString(w, `{"code":200,"data":{"list":[],"total":0}}`)
			})
			g := gateway(t)
			id := sid(t, g.URL, up.URL)
			request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": op, "params": map[string]any{"page": 2, "pageSize": 12}})
		})
	}
}

func TestCanonicalTypesAndCollectionKinds(t *testing.T) {
	s, _ := New(Options{})
	ss := &session{token: "upstream-secret", base: &url.URL{Scheme: "http", Host: "example.test"}}
	for _, op := range []string{"photos.albums", "video.libraries", "music.albums", "music.playlists", "files.roots"} {
		v := s.normalize(ss, map[string]any{"list": []any{map[string]any{"id": "good", "name": "good", "size": map[string]any{"raw": "upstream-secret"}}}, "total": "upstream-secret"}, op, nil)
		b, _ := json.Marshal(v)
		if strings.Contains(string(b), "upstream-secret") {
			t.Fatal("canonical field escaped final sanitizer")
		}
		item := v["items"].([]any)[0].(map[string]any)
		want := map[string]string{"photos.albums": "album", "video.libraries": "library", "music.albums": "album", "music.playlists": "playlist", "files.roots": "directory"}[op]
		if item["kind"] != want {
			t.Fatalf("%s kind %v", op, item["kind"])
		}
	}
}
func TestMusicPlayUsesTranscodeDescriptor(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transcode/audio/play" || r.Method != "GET" || r.Form.Get("file_path") != "/my/a.mp3" || r.Form.Get("app") != "music" {
			t.Error("wrong official playback request")
		}
		io.WriteString(w, `{"code":200,"data":{"uri":"/play/a.mp3"}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	code, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "music.play", "params": map[string]any{"path": "/my/a.mp3"}})
	if code != 200 || v["ok"] != true {
		t.Fatalf("play failed %v", v)
	}
	items := v["data"].(map[string]any)["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["stream"] == "" {
		t.Fatal("missing protected playback URI")
	}
}
func TestMediaMimeAndSniffRejectActiveContent(t *testing.T) {
	for _, body := range []string{"#EXTM3U\n/play/a?token=upstream-secret", `{"code":"N001208","token":"upstream-secret"}`, `<!doctype html><script>token=upstream-secret</script>`} {
		for _, mime := range []string{"Video/MP4", "Application/JSON", "application/octet-stream", ""} {
			t.Run(mime+body[:3], func(t *testing.T) {
				up := fake(t, func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/v2/file/info" {
						io.WriteString(w, `{"code":200,"data":{"name":"file","stream":"/play/unsafe"}}`)
						return
					}
					w.Header().Set("Content-Type", mime)
					io.WriteString(w, body)
				})
				g := gateway(t)
				id := sid(t, g.URL, up.URL)
				_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.info"})
				stream := v["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["stream"].(string)
				resp, e := http.Get(g.URL + stream)
				if e != nil {
					t.Fatal(e)
				}
				b, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				if resp.StatusCode < 400 || strings.Contains(string(b), "upstream-secret") {
					t.Fatal("active authenticated content escaped")
				}
			})
		}
	}
}
func TestMediaBodyOutlivesJSONTimeout(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/file/info" {
			io.WriteString(w, `{"code":200,"data":{"name":"file","stream":"/play/slow"}}`)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Write([]byte("\x00\x00\x00\x18ftyp"))
		w.(http.Flusher).Flush()
		time.Sleep(80 * time.Millisecond)
		w.Write([]byte("isom\x00\x00\x00\x00isommp42"))
	})
	s, _ := New(Options{HTTPClient: &http.Client{Timeout: 20 * time.Millisecond}})
	mux := http.NewServeMux()
	s.Register(mux)
	g := httptest.NewServer(mux)
	defer g.Close()
	id := sid(t, g.URL, up.URL)
	_, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "files.info"})
	stream := v["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["stream"].(string)
	resp, e := http.Get(g.URL + stream)
	if e != nil {
		t.Fatal(e)
	}
	b, e := io.ReadAll(resp.Body)
	resp.Body.Close()
	if e != nil || string(b) != "\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42" {
		t.Fatalf("media stream interrupted by JSON timeout: %q %v", b, e)
	}
}
func TestCollectionAndDownloadedItemSchema(t *testing.T) {
	s, _ := New(Options{})
	ss := &session{token: "upstream-secret", base: &url.URL{Scheme: "http", Host: "example.test"}}
	for op, row := range map[string]map[string]any{"music.playlists": {"playlist_id": "p1", "playlist_name": "mix"}, "music.albums": {"album_id": "a1", "album": "album"}, "downloads.list": {"id": "d1", "name": "file.mp4", "downloadDir": "/my/downloads", "size": 10}} {
		v := s.normalize(ss, map[string]any{"list": []any{row}}, op, nil)
		item := v["items"].([]any)[0].(map[string]any)
		if item["id"] == "" || item["name"] == "" {
			t.Fatalf("missing identity %s %v", op, item)
		}
		if op == "downloads.list" && item["path"] != "/my/downloads/file.mp4" {
			t.Fatal("download path lost")
		}
	}
}
func TestPlaylistSongsVerifiedReadRoute(t *testing.T) {
	up := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/zmusic/api/v2/playlist/record/list" || r.Method != "GET" || r.Form.Get("playlist_id") != "p1" {
			t.Error("wrong playlist read route")
		}
		io.WriteString(w, `{"code":200,"data":{"list":[]}}`)
	})
	g := gateway(t)
	id := sid(t, g.URL, up.URL)
	code, v := request(t, g.URL, "POST", "/api/nas/read", id, map[string]any{"operation": "music.songs", "params": map[string]any{"playlist_id": "p1"}})
	if code != 200 || v["ok"] != true {
		t.Fatalf("playlist songs failed %v", v)
	}
}
func TestLoginUserIdentityCannotContainNASToken(t *testing.T) {
	original := fake(t, func(w http.ResponseWriter, r *http.Request) {})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req, e := http.NewRequest(r.Method, original.URL+r.URL.RequestURI(), r.Body)
		if e != nil {
			t.Fatal(e)
		}
		req.Header = r.Header.Clone()
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		var v map[string]any
		json.NewDecoder(resp.Body).Decode(&v)
		if r.URL.Path == "/auth/login" {
			v["data"].(map[string]any)["username"] = "upstream-secret"
			v["data"].(map[string]any)["nickname"] = "upstream-secret"
			v["data"].(map[string]any)["role"] = "upstream-secret"
		}
		json.NewEncoder(w).Encode(v)
	}))
	defer up.Close()
	g := gateway(t)
	code, v := request(t, g.URL, "POST", "/api/nas/login", "", map[string]any{"baseUrl": up.URL, "username": "synthetic-user", "password": "synthetic-password"})
	b, _ := json.Marshal(v)
	if code != 200 || strings.Contains(string(b), "upstream-secret") {
		t.Fatal("NAS token leaked through login identity")
	}
}
