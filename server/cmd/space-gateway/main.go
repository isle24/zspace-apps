package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"spacedesktop/server/internal/store"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:18435", "HTTP listen address; native uses 127.0.0.1:0")
	data := flag.String("data-dir", ".runtime", "Own metadata directory")
	web := flag.String("web-root", "", "Built H5 directory; empty means API only")
	engine := flag.String("engine", "disabled", "disabled, local or sshbind")
	alias := flag.String("ssh-alias", "", "Existing usable sshbind alias")
	root := flag.String("storage-root", "", "Explicit installation root for the selected engine")
	publicOrigin := flag.String("public-origin", "", "Explicit HTTPS/HTTP browser origin behind a trusted reverse proxy")
	publishHost := flag.String("publish-host", "", "IP for Docker published ports; local default is loopback")
	accessHost := flag.String("access-host", "", "Host clients use to open installed applications")
	apiOnly := flag.Bool("api-only", false, "Serve backend APIs without a storefront")
	catalogOnly := flag.Bool("catalog-only", false, "Serve a central directory; applications install on the NAS")
	nasAdminOnly := flag.Bool("nas-admin-only", false, "Use only the fixed NAS administrator identity; no independent password bootstrap")
	nasOrigin := flag.String("nas-origin", "", "Explicit fixed canonical NAS HTTP(S) identity origin; empty disables NAS authentication")
	flag.Parse()
	if err := run(*listen, *data, *web, *engine, *alias, *root, *publicOrigin, *publishHost, *accessHost, *nasOrigin, *nasAdminOnly, *catalogOnly, *apiOnly); err != nil {
		// Intentionally omit request, credentials and underlying command output.
		fmt.Fprintln(os.Stderr, "gateway startup/serve failed:", err)
		os.Exit(1)
	}
}

func run(listen, data, web, engine, alias, root, publicOrigin, publishHost, accessHost, nasOrigin string, nasOnly ...bool) error {
	if err := store.ValidateNASOrigin(nasOrigin); err != nil {
		return err
	}
	if err := validatePublicOrigin(publicOrigin); err != nil {
		return err
	}
	if err := os.MkdirAll(data, 0700); err != nil {
		return fmt.Errorf("metadata directory unavailable")
	}
	s, err := store.New(store.Options{CloudDatabaseURL: os.Getenv("SPACE_CLOUD_DATABASE_URL"), DataDir: filepath.Join(data, "store"), StorageRoot: root, EngineMode: engine, SSHAlias: alias, PublishHost: publishHost, AccessHost: accessHost, NASOrigin: nasOrigin, NASAdminOnly: len(nasOnly) >= 1 && nasOnly[0], CatalogOnly: len(nasOnly) > 1 && nasOnly[1]})
	if err != nil {
		return fmt.Errorf("store unavailable: %w", err)
	}
	defer s.Close()
	mux := http.NewServeMux()
	s.Register(mux)
	if len(nasOnly) > 1 && nasOnly[1] {
		if err := s.RegisterCloudHandlers(mux); err != nil {
			return fmt.Errorf("cloud catalog unavailable: %w", err)
		}
	}
	b := make([]byte, 16)
	if _, err = rand.Read(b); err != nil {
		return err
	}
	instance := hex.EncodeToString(b)
	mux.HandleFunc("GET /api/health", healthHandler(instance))
	if len(nasOnly) > 2 && nasOnly[2] {
		mux.Handle("/", apiOnlyWebHandler(web))
	} else {
		mux.Handle("/", webHandler(web))
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen address unavailable")
	}
	defer ln.Close()
	ip := ln.Addr().(*net.TCPAddr).IP
	native := ip.IsLoopback()
	server := &http.Server{Handler: boundaryOrigin(mux, native, publicOrigin), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	address := "http://" + ln.Addr().String()
	json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "ready", "address": address, "instanceId": instance})
	err = server.Serve(ln)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func apiOnlyWebHandler(root string) http.Handler {
	admin := http.StripPrefix("/admin", webHandler(root))
	status := apiOnlyHandler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/admin" {
			http.Redirect(w, r, "/admin/", http.StatusTemporaryRedirect)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/admin/") {
			admin.ServeHTTP(w, r)
			return
		}
		status.ServeHTTP(w, r)
	})
}

func apiOnlyHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path != "/" {
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": map[string]string{"code": "API_ONLY", "message": "此域名提供商店后台接口，商店界面位于客户端"}})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"service": "space-store", "mode": "api-only", "api": "/api/cloud", "admin": "/admin/", "loginRequired": true, "message": "空间商店后台接口"})
	})
}

func healthHandler(instance string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": map[string]any{"service": "space-store", "version": "0.1.0", "instanceId": instance, "controllerProtocol": "v1"}})
	}
}

// Only this client and same-origin H5 can talk to the gateway from a browser.
func boundary(next http.Handler, native bool) http.HandlerFunc {
	return boundaryOrigin(next, native, "")
}

func validatePublicOrigin(origin string) error {
	if origin == "" {
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("public-origin must be a bare HTTP(S) origin")
	}
	return nil
}

func boundaryOrigin(next http.Handler, native bool, publicOrigin string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		publicHost := ""
		if u, err := url.Parse(publicOrigin); err == nil && publicOrigin != "" {
			publicHost = u.Host
		}
		if native && host != "127.0.0.1" && host != "localhost" && host != "::1" && !strings.EqualFold(r.Host, publicHost) {
			writeError(w, 403, "HOST_REJECTED", "访问地址不属于本客户端")
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" {
			// Cloud endpoints authenticate an explicit bearer token and never cookies.
			// NAS clients use their own origins; privileged administration stays same-origin.
			if strings.HasPrefix(r.URL.Path, "/api/cloud/") {
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				if r.Method == "OPTIONS" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			same := "http://" + r.Host
			if r.TLS != nil {
				same = "https://" + r.Host
			}
			public := strings.TrimRight(publicOrigin, "/")
			allowed := origin == same || (public != "" && origin == public) || origin == "tauri://localhost" || origin == "http://tauri.localhost" || (native && (origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173"))
			if !allowed {
				writeError(w, 403, "ORIGIN_REJECTED", "此页面无权调用客户端服务")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Store-Session, X-Cloud-Session, Authorization, Range")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": map[string]string{"code": code, "message": message}})
}

func webHandler(root string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if root == "" || strings.HasPrefix(r.URL.Path, "/api/") || (r.Method != "GET" && r.Method != "HEAD") {
			http.NotFound(w, r)
			return
		}
		decoded, err := url.PathUnescape(r.URL.Path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		for _, segment := range strings.Split(decoded, "/") {
			if strings.HasPrefix(segment, ".") {
				http.NotFound(w, r)
				return
			}
		}
		rel := strings.TrimPrefix(decoded, "/")
		if rel == "" {
			rel = "store.html"
			if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
				rel = "index.html"
			}
		}
		// os.Root prevents static symlinks from escaping the build directory.
		dir, err := os.OpenRoot(root)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer dir.Close()
		f, err := dir.Open(rel)
		if err != nil {
			if !strings.Contains(filepath.Base(rel), ".") {
				f, err = dir.Open("store.html")
				if err != nil {
					f, err = dir.Open("index.html")
				}
			}
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || info.IsDir() || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		var _ fs.File = f
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: http: https:; media-src 'self' blob: http: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' http: https:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'")
		http.ServeContent(w, r, info.Name(), info.ModTime(), f)
	})
}
