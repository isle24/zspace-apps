// space-proxy：极空间部署用的前置代理。
//
// 为什么需要它：极空间 5055 上有一批路由（/v2/、/zmusic/、/zvideo/、/downloader/、
// /storagepool/、/network-settings/ …）由 nginx 的 auth.lua 保护，而 auth.lua 只认
// **cookie**（把全部 cookie 转发到 /auth/token 校验），并且拒绝时不会带 CORS 头。
// 浏览器直连 5055 属于跨源：既带不上 cookie，也读不到响应。官方网页版之所以能用，
// 是因为它本身就部署在 5055 上，是同源。
//
// 因此这里让页面与接口同源：静态前端、NAS 接口、独立商店接口都从本进程的一个端口出去。
// 只有下列固定前缀会被转发到 NAS，其余一律走本地静态文件，不构成开放代理。
package main

import (
	"flag"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// nasPrefixes 是允许转发到极空间 5055 的路径前缀（取自官方 5055 vhost 与官方前端调用）。
var nasPrefixes = []string{
	"/api/fileshare_service",
	"/AppStore", "/auth", "/docker/api", "/downloader", "/family", "/file/", "/file_search",
	"/hdmiapi", "/key", "/local/", "/login", "/manager", "/nas/proxy", "/netdisk",
	"/network-settings", "/open/", "/play/", "/replay", "/setting", "/settings", "/splay",
	"/status", "/storagepool", "/system", "/task", "/transcode", "/v1/vm", "/v2/",
	"/zhelper/state", "/zconn", "/zdocker", "/zrps", "/zmusic", "/zmusic_static", "/znetdisk", "/zreader", "/zspool", "/zstatus",
	"/ztianyiclub", "/zvideo", "/zvideo_static", "/zhelper",
}

func isNasPath(p string) bool {
	if p == "/kv/load" {
		return true
	}
	for _, prefix := range nasPrefixes {
		if p == prefix || strings.HasPrefix(p, prefix+"/") || strings.HasPrefix(p, prefix) && strings.HasSuffix(prefix, "/") {
			return true
		}
	}
	return false
}

func main() {
	listen := flag.String("listen", "0.0.0.0:18436", "监听地址")
	web := flag.String("web", "/web", "静态前端目录")
	nas := flag.String("nas", "", "极空间接口地址，例如 http://192.168.3.56:5055")
	store := flag.String("store", "http://127.0.0.1:18435", "独立商店网关地址")
	flag.Parse()

	if *nas == "" {
		log.Fatal("缺少 --nas（极空间接口地址）")
	}
	nasURL, err := url.Parse(*nas)
	if err != nil || (nasURL.Scheme != "http" && nasURL.Scheme != "https") {
		log.Fatalf("--nas 不是合法的 http(s) 地址: %q", *nas)
	}
	storeURL, err := url.Parse(*store)
	if err != nil {
		log.Fatalf("--store 非法: %v", err)
	}

	nasProxy := httputil.NewSingleHostReverseProxy(nasURL)
	origin := nasProxy.Director
	nasProxy.Director = func(r *http.Request) {
		origin(r)
		r.Host = nasURL.Host
		r.Header.Set("Referer", "") // 官方接口不校验 Referer，留空避免泄露本机地址
	}
	nasProxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("nas proxy %s %s: %v", r.Method, r.URL.Path, err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}
	nasProxy.FlushInterval = -1

	storeProxy := newStoreProxy(storeURL)

	root := http.Dir(*web)
	files := http.FileServer(root)
	// 静态资源优先发预压缩版本：实测未压缩时 client.js 有 964 KB，而 NAS 的
	// 反代不会自己 gzip。构建期生成 .gz（见 deploy/nas-appstore/build.sh），
	// 这里按 Accept-Encoding 选择，省掉约 3/4 的传输量。
	precompressed := precompressedFiles{root: root, next: files}

	mux := http.NewServeMux()

	// Docker：只读视图（见 docker.go）。没有 socket 时如实返回未启用，而不是假装有数据。
	mux.Handle("/api/docker/", newDockerHandler(nasURL))

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})

	// 独立商店：仅 /api/store/ 走网关，其余 /api 路径按 NAS 处理（例如 /api/fileshare_service）
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/shop.html" || r.URL.Path == "/space-store" || strings.HasPrefix(r.URL.Path, "/space-store/"):
			if _, err := os.Stat(filepath.Join(*web, "complete-store.html")); err == nil {
				copy := r.Clone(r.Context())
				copy.URL.Path = "/complete-store.html"
				precompressed.ServeHTTP(w, copy)
				return
			}
			r = r.Clone(r.Context())
			r.URL.Path = strings.TrimPrefix(r.URL.Path, "/space-store")
			if r.URL.Path == "" || r.URL.Path == "/" || r.URL.Path == "/shop.html" {
				r.URL.Path = "/store.html"
			}
			storeProxy.ServeHTTP(w, r)
			return
		case strings.HasPrefix(r.URL.Path, "/assets/") || strings.HasPrefix(r.URL.Path, "/app-icons/") || strings.HasPrefix(r.URL.Path, "/state/"):
			if _, err := os.Stat(filepath.Join(*web, filepath.Clean(r.URL.Path))); err != nil {
				storeProxy.ServeHTTP(w, r)
				return
			}
		case strings.HasPrefix(r.URL.Path, "/api/store/"):
			storeProxy.ServeHTTP(w, r)
			return
		case isNasPath(r.URL.Path):
			nasProxy.ServeHTTP(w, r)
			return
		}
		// 静态前端：找不到真实文件时回落到 index.html（单页外壳）
		if r.URL.Path != "/" {
			if info, err := os.Stat(filepath.Join(*web, filepath.Clean(r.URL.Path))); err != nil || info.IsDir() {
				if !strings.Contains(filepath.Base(r.URL.Path), ".") {
					r = r.Clone(r.Context())
					r.URL.Path = "/index.html"
				}
			}
		}
		if r.URL.Path == "/runtime-config.json" {
			w.Header().Set("Cache-Control", "no-store")
		}
		precompressed.ServeHTTP(w, r)
	})

	server := &http.Server{
		Addr:              *listen,
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Printf("space-proxy 监听 %s（静态 %s，NAS %s，商店 %s）", *listen, *web, nasURL, storeURL)
	log.Fatal(server.ListenAndServe())
}

// precompressedFiles 在客户端支持 gzip 且存在同名 .gz 时直接发压缩版本，
// 否则落回普通静态文件服务。
type precompressedFiles struct {
	root http.Dir
	next http.Handler
}

var compressible = map[string]bool{
	".js": true, ".css": true, ".html": true, ".svg": true, ".json": true, ".webmanifest": true,
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name := strings.TrimSpace(strings.SplitN(part, ";", 2)[0])
		if strings.EqualFold(name, "gzip") {
			return true
		}
	}
	return false
}

func (h precompressedFiles) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Entry documents must be fetched after an upgrade, even when their last
	// modification time would otherwise permit a browser's heuristic cache.
	if r.URL.Path == "/" || strings.HasSuffix(strings.ToLower(r.URL.Path), ".html") || r.URL.Path == "/runtime-config.json" {
		w.Header().Set("Cache-Control", "no-store")
	}
	if r.Method == http.MethodGet && acceptsGzip(r) && compressible[strings.ToLower(filepath.Ext(r.URL.Path))] {
		clean := filepath.Clean(r.URL.Path)
		if f, err := h.root.Open(clean + ".gz"); err == nil {
			defer f.Close()
			if info, statErr := f.Stat(); statErr == nil && !info.IsDir() {
				w.Header().Set("Content-Encoding", "gzip")
				// 让缓存按编码分开存，避免把 gzip 内容发给不支持它的客户端
				w.Header().Add("Vary", "Accept-Encoding")
				http.ServeContent(w, r, clean, info.ModTime(), f)
				return
			}
		}
	}
	h.next.ServeHTTP(w, r)
}

func newStoreProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) { director(r); r.Host = target.Host; r.Header.Del("Cookie") }
	return proxy
}
