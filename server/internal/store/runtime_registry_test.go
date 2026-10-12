package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func registryDigest(b string) string { return fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(b))) }
func TestRuntimeRegistryManifestProof(t *testing.T) {
	for _, mode := range []string{"valid", "changed", "configchanged", "childchanged", "unsupported", "architecture", "malformed", "redirect", "large", "ambiguous", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			cfg := `{"architecture":"amd64","os":"linux"}`
			if mode == "architecture" {
				cfg = `{"architecture":"arm64","os":"linux"}`
			}
			manifest := fmt.Sprintf(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":%q,"size":%d},"layers":[]}`, registryDigest(cfg), len(cfg))
			index := fmt.Sprintf(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":%q,"size":%d,"platform":{"os":"linux","architecture":"amd64"}}]}`, registryDigest(manifest), len(manifest))
			if mode == "ambiguous" {
				index = strings.Replace(index, "]}", ","+strings.Split(strings.Split(index, "manifests\":[")[1], "]}")[0]+"]}", 1)
			}
			if mode == "unsupported" {
				index = strings.Replace(index, "amd64", "arm64", 1)
			}
			if mode == "unknown" {
				index = strings.Replace(index, "amd64", "unknown", 1)
			}
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if mode == "redirect" {
					http.Redirect(w, r, "http://127.0.0.1:1/escaped", 302)
					return
				}
				b := index
				if strings.Contains(r.URL.Path, "/blobs/") {
					b = cfg
					if mode == "configchanged" {
						b = `{ "architecture":"amd64", "os":"linux" }`
					}
				} else if strings.HasSuffix(r.URL.Path, registryDigest(manifest)) {
					b = manifest
					if mode == "childchanged" {
						b += " "
					}
				}
				if mode == "malformed" {
					b = "{"
				}
				if mode == "large" {
					b = strings.Repeat("x", 5<<20)
				}
				w.Header().Set("Docker-Content-Digest", registryDigest(b))
				if mode == "changed" {
					w.Header().Set("Docker-Content-Digest", "sha256:"+strings.Repeat("0", 64))
				}
				fmt.Fprint(w, b)
			}))
			defer srv.Close()
			resolver := RuntimeRegistryResolver{Client: srv.Client(), Endpoint: func(string) string { return srv.URL }}
			recipe, _ := RuntimeRecipeFor("navidrome", "")
			images, err := resolver.Resolve(context.Background(), recipe, "linux/amd64")
			if mode == "valid" {
				if err != nil || len(images) != 1 || images[0].Digest != registryDigest(manifest) {
					t.Fatalf("proof: %+v %v", images, err)
				}
			} else if err == nil {
				t.Fatalf("accepted %s", mode)
			}
			if mode == "redirect" && calls != 1 {
				t.Fatal("followed redirect")
			}
		})
	}
}
func TestRuntimeRegistryRejectsUnapprovedRecipe(t *testing.T) {
	r, _ := RuntimeRecipeFor("navidrome", "")
	r.Services[0].Image = "docker.io/attacker/app:0.64.2"
	resolver := RuntimeRegistryResolver{}
	if _, err := resolver.Resolve(context.Background(), r, "linux/amd64"); err == nil {
		t.Fatal("unapproved publisher accepted")
	}
	r, _ = RuntimeRecipeFor("navidrome", "")
	if _, err := resolver.Resolve(context.Background(), r, "linux/arm64"); err == nil {
		t.Fatal("unreviewed platform accepted")
	}
}

// Explicit opt-in primary-source check; ordinary tests remain completely offline.
func TestRuntimeRegistryOfficialSources(t *testing.T) {
	if os.Getenv("STORE_VERIFY_OFFICIAL_IMAGES") != "1" {
		t.Skip("explicit primary-source verification only")
	}
	for _, latest := range RuntimeRecipes() {
		for _, version := range append([]string{latest.Version}, latest.CompatibleFrom...) {
			t.Run(latest.AppID+"/"+version, func(t *testing.T) {
				recipe, _ := RuntimeRecipeFor(latest.AppID, version)
				images, err := ResolveOfficialRuntimeImages(context.Background(), recipe, "linux/amd64")
				if err != nil {
					t.Fatal(err)
				}
				for _, image := range images {
					t.Logf("%s %s", image.TagReference, image.Reference)
				}
			})
		}
	}
}

func TestRuntimeRegistryAuthenticationIsBoundToOfficialRealm(t *testing.T) {
	for _, challenge := range []string{`Bearer realm="https://attacker.invalid/token",service="registry.docker.io",scope="repository:deluan/navidrome:pull"`, `Bearer realm="https://auth.docker.io/token",service="attacker",scope="repository:deluan/navidrome:pull"`, `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:attacker/app:pull"`, `Bearer realm="https://auth.docker.io/token",realm="https://auth.docker.io/token",service="registry.docker.io"`} {
		calls := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.Header().Set("WWW-Authenticate", challenge)
			w.WriteHeader(401)
		}))
		resolver := RuntimeRegistryResolver{Client: srv.Client(), Endpoint: func(string) string { return srv.URL }}
		r, _ := RuntimeRecipeFor("navidrome", "")
		if _, err := resolver.Resolve(context.Background(), r, "linux/amd64"); err == nil {
			t.Fatal("unsafe challenge accepted")
		}
		srv.Close()
		if calls != 1 {
			t.Fatal("untrusted token endpoint requested")
		}
	}
}
func TestRuntimeRegistryDisablesProxyAndRedirects(t *testing.T) {
	proxyCalls := 0
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(*http.Request) (*url.URL, error) { proxyCalls++; return url.Parse("http://127.0.0.1:1") }
	resolver := RuntimeRegistryResolver{Client: &http.Client{Transport: transport}}
	client := resolver.client()
	if client.Transport.(*http.Transport).Proxy != nil || proxyCalls != 0 {
		t.Fatal("proxy inherited")
	}
	if client.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("redirects enabled")
	}
	if transport.Proxy == nil {
		t.Fatal("caller transport mutated")
	}
}
func TestRuntimeRegistryRejectsMutatedCommands(t *testing.T) {
	r, _ := RuntimeRecipeFor("navidrome", "")
	r.Services[0].HealthCommand = []string{"CMD", "arbitrary-command"}
	if _, err := (RuntimeRegistryResolver{}).Resolve(context.Background(), r, "linux/amd64"); err == nil {
		t.Fatal("modified runtime recipe accepted")
	}
}

func TestRuntimeRegistryPinnedDependencyUsesReviewedDigest(t *testing.T) {
	path := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { path = r.URL.Path; w.WriteHeader(404) }))
	defer srv.Close()
	recipe, _ := RuntimeRecipeFor("immich", "")
	resolver := RuntimeRegistryResolver{Client: srv.Client(), Endpoint: func(string) string { return srv.URL }}
	_, err := resolver.Resolve(context.Background(), recipe, "linux/amd64")
	if err == nil {
		t.Fatal("missing digest accepted")
	}
	expected := strings.Split(recipe.Services[0].Image, "@")[1]
	if !strings.HasSuffix(path, "/manifests/"+expected) {
		t.Fatalf("pinned dependency queried mutable tag: %s", path)
	}
}

// Replay exact primary-source manifest/config documents without changing trust rules.
func TestRuntimeRegistryCapturedOfficialDocuments(t *testing.T) {
	path := os.Getenv("STORE_OFFICIAL_IMAGE_DOCUMENTS")
	if path == "" {
		t.Skip("explicit captured-source verification only")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Documents map[string]string `json:"documents"`
	}
	if json.Unmarshal(raw, &corpus) != nil {
		t.Fatal("invalid source corpus")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := corpus.Documents[r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Docker-Content-Digest", registryDigest(body))
		fmt.Fprint(w, body)
	}))
	defer srv.Close()
	resolver := RuntimeRegistryResolver{Client: srv.Client(), Endpoint: func(string) string { return srv.URL }}
	for _, latest := range RuntimeRecipes() {
		for _, version := range append([]string{latest.Version}, latest.CompatibleFrom...) {
			t.Run(latest.AppID+"/"+version, func(t *testing.T) {
				recipe, _ := RuntimeRecipeFor(latest.AppID, version)
				images, err := resolver.Resolve(context.Background(), recipe, "linux/amd64")
				if err != nil || len(images) != len(recipe.Services) {
					t.Fatalf("full source proof: %v", err)
				}
				for _, image := range images {
					t.Logf("%s %s", image.TagReference, image.Reference)
				}
			})
		}
	}
}

type runtimeRegistryTestTransport func(*http.Request) (*http.Response, error)

func (f runtimeRegistryTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestRuntimeRegistryOfficialConfigBlobRedirect(t *testing.T) {
	cases := []struct {
		name, location string
		want           bool
	}{{"official", "https://pkg-containers.githubusercontent.com/ghcr1/blobs/config?sig=opaque", true}, {"http", "http://pkg-containers.githubusercontent.com/ghcr1/blobs/config", false}, {"suffix", "https://pkg-containers.githubusercontent.com.attacker.invalid/blob", false}, {"userinfo", "https://user@pkg-containers.githubusercontent.com/blob", false}, {"port", "https://pkg-containers.githubusercontent.com:8443/blob", false}, {"loopback", "https://127.0.0.1/blob", false}, {"relative", "/blob", false}, {"fragment", "https://pkg-containers.githubusercontent.com/blob#fragment", false}}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cdnCalls := 0
			transport := runtimeRegistryTestTransport(func(req *http.Request) (*http.Response, error) {
				if req.URL.Host == "ghcr.io" {
					return &http.Response{StatusCode: 307, Header: http.Header{"Location": {c.location}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
				}
				cdnCalls++
				if req.Header.Get("Authorization") != "" {
					t.Fatal("registry bearer forwarded to CDN")
				}
				if req.URL.Host != "pkg-containers.githubusercontent.com" {
					t.Fatal("unapproved redirect dialed")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"architecture":"amd64","os":"linux"}`)), Request: req}, nil
			})
			r := RuntimeRegistryResolver{Client: &http.Client{Transport: transport}}
			s := runtimeRegistrySession{resolver: r, client: r.client(), registry: "ghcr.io", repo: "navidrome/navidrome", token: "private-test-bearer"}
			b, d, err := s.fetch(context.Background(), "/v2/navidrome/navidrome/blobs/sha256:"+strings.Repeat("a", 64), 1<<20, false)
			if c.want {
				if err != nil || d != registryDigest(string(b)) || cdnCalls != 1 {
					t.Fatalf("official307 failed: %v", err)
				}
			} else if err == nil || cdnCalls != 0 {
				t.Fatalf("unsafe location accepted %v", err)
			}
		})
	}
}
func TestRuntimeRegistryConfigBlobRedirectIsBounded(t *testing.T) {
	for _, mode := range []string{"manifest", "token", "loop", "large"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			transport := runtimeRegistryTestTransport(func(req *http.Request) (*http.Response, error) {
				calls++
				if mode == "large" && req.URL.Host == "pkg-containers.githubusercontent.com" {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", (1<<20)+1))), Request: req}, nil
				}
				return &http.Response{StatusCode: 307, Header: http.Header{"Location": {"https://pkg-containers.githubusercontent.com/ghcr1/blobs/config?sig=opaque"}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
			})
			r := RuntimeRegistryResolver{Client: &http.Client{Transport: transport}}
			s := runtimeRegistrySession{resolver: r, client: r.client(), registry: "ghcr.io", repo: "navidrome/navidrome"}
			path := "/v2/navidrome/navidrome/blobs/sha256:" + strings.Repeat("a", 64)
			manifest := false
			if mode == "manifest" {
				path = "/v2/navidrome/navidrome/manifests/0.64.2"
				manifest = true
			}
			if mode == "token" {
				path = "/token"
			}
			if _, _, err := s.fetch(context.Background(), path, 1<<20, manifest); err == nil {
				t.Fatal("unsafe redirect succeeded")
			}
			if (mode == "manifest" || mode == "token") && calls != 1 {
				t.Fatal("nonblob redirected")
			}
			if calls > 3 {
				t.Fatal("unbounded redirects")
			}
		})
	}
}

func TestRuntimeRegistryAuthenticatedResolutionWithConfigCDNProof(t *testing.T) {
	for _, mode := range []string{"valid", "wrong-body", "wrong-size", "token-redirect"} {
		t.Run(mode, func(t *testing.T) {
			config := `{"architecture":"amd64","os":"linux"}`
			size := len(config)
			if mode == "wrong-size" {
				size++
			}
			manifest := fmt.Sprintf(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":%q,"size":%d},"layers":[]}`, registryDigest(config), size)
			cdnCalls := 0
			transport := runtimeRegistryTestTransport(func(req *http.Request) (*http.Response, error) {
				status := 200
				body := ""
				headers := http.Header{}
				switch {
				case req.URL.Host == "pkg-containers.githubusercontent.com":
					cdnCalls++
					if req.Header.Get("Authorization") != "" || req.Header.Get("Cookie") != "" {
						t.Fatal("private headers forwarded")
					}
					body = config
					if mode == "wrong-body" {
						body += " "
					}
				case req.URL.Path == "/token":
					if req.URL.Query().Get("scope") != "repository:navidrome/navidrome:pull" || req.URL.Query().Get("service") != "ghcr.io" {
						t.Fatal("wrong official token scope")
					}
					body = `{"token":"private-fixture-bearer"}`
					if mode == "token-redirect" {
						status = 307
						headers.Set("Location", "https://pkg-containers.githubusercontent.com/ghcr1/blobs/config")
					}
				case req.Header.Get("Authorization") == "":
					status = 401
					headers.Set("WWW-Authenticate", `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:navidrome/navidrome:pull"`)
				case strings.Contains(req.URL.Path, "/manifests/"):
					body = manifest
					headers.Set("Docker-Content-Digest", registryDigest(body))
				case strings.Contains(req.URL.Path, "/blobs/"):
					status = 307
					headers.Set("Location", "https://pkg-containers.githubusercontent.com/ghcr1/blobs/config?sig=opaque")
				default:
					t.Fatalf("unexpected request %s", req.URL.Host+req.URL.Path)
				}
				return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
			})
			resolver := RuntimeRegistryResolver{Client: &http.Client{Transport: transport}}
			recipe, _ := RuntimeRecipeFor("navidrome", "")
			images, err := resolver.Resolve(context.Background(), recipe, "linux/amd64")
			if mode == "valid" {
				if err != nil || len(images) != 1 || images[0].Digest != registryDigest(manifest) || cdnCalls != 1 {
					t.Fatalf("authenticated CDN proof failed: %v", err)
				}
			} else if err == nil {
				t.Fatalf("invalid %s accepted", mode)
			}
			if mode == "token-redirect" && cdnCalls != 0 {
				t.Fatal("token redirect followed")
			}
		})
	}
}

func TestRuntimeRegistryClientDoesNotInheritCookies(t *testing.T) {
	jar, _ := cookiejar.New(nil)
	url, _ := url.Parse("https://pkg-containers.githubusercontent.com")
	jar.SetCookies(url, []*http.Cookie{{Name: "private", Value: "fixture-only"}})
	source := &http.Client{Jar: jar}
	resolver := RuntimeRegistryResolver{Client: source}
	if resolver.client().Jar != nil {
		t.Fatal("caller cookies inherited into official source/CDN requests")
	}
	if source.Jar == nil {
		t.Fatal("caller client mutated")
	}
}
