package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"time"
)

const runtimeManifestLimit = 4 << 20

var runtimeDigestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var runtimeRegistryError = errors.New("official image verification failed")

// Endpoint and Client are explicit transport injection points for offline tests.
// They never expand the approved recipe/repository/tag set.
type RuntimeRegistryResolver struct {
	Client   *http.Client
	Endpoint func(string) string
}

func ResolveOfficialRuntimeImages(ctx context.Context, recipe RuntimeRecipe, platform string) ([]RuntimeImage, error) {
	return RuntimeRegistryResolver{}.Resolve(ctx, recipe, platform)
}
func (r RuntimeRegistryResolver) Resolve(ctx context.Context, recipe RuntimeRecipe, platform string) ([]RuntimeImage, error) {
	if strings.HasPrefix(recipe.AppID, "cloud-") {
		return resolveRuntimeCloudImages(ctx, recipe, platform)
	}
	approved, ok := RuntimeRecipeFor(recipe.AppID, recipe.Version)
	if !ok || platform != "linux/amd64" || !reflect.DeepEqual(approved, recipe) {
		return nil, runtimeRegistryError
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	client := r.client()
	out := make([]RuntimeImage, 0, len(recipe.Services))
	for _, svc := range recipe.Services {
		parts := strings.SplitN(svc.Image, "/", 2)
		if len(parts) != 2 {
			return nil, runtimeRegistryError
		}
		host := parts[0]
		if host != "docker.io" && host != "ghcr.io" {
			return nil, runtimeRegistryError
		}
		repoTag := strings.SplitN(parts[1], "@", 2)
		expected := ""
		if len(repoTag) == 2 {
			expected = repoTag[1]
			if !runtimeDigestPattern.MatchString(expected) {
				return nil, runtimeRegistryError
			}
		}
		tagAt := strings.LastIndex(repoTag[0], ":")
		if tagAt < 1 {
			return nil, runtimeRegistryError
		}
		repo, tag := repoTag[0][:tagAt], repoTag[0][tagAt+1:]
		registry := host
		if registry == "docker.io" {
			registry = "registry-1.docker.io"
		}
		session := runtimeRegistrySession{resolver: r, client: client, registry: registry, repo: repo}
		manifestID := tag
		if expected != "" {
			manifestID = expected
		}
		b, digest, err := session.fetch(ctx, "/v2/"+repo+"/manifests/"+manifestID, runtimeManifestLimit, true)
		if err != nil {
			return nil, runtimeRegistryError
		}
		if expected != "" && digest != expected {
			return nil, runtimeRegistryError
		}
		var doc runtimeManifest
		if json.Unmarshal(b, &doc) != nil || doc.SchemaVersion != 2 {
			return nil, runtimeRegistryError
		}
		if doc.MediaType == "application/vnd.oci.image.index.v1+json" || doc.MediaType == "application/vnd.docker.distribution.manifest.list.v2+json" {
			if len(doc.Manifests) == 0 || len(doc.Manifests) > 1024 {
				return nil, runtimeRegistryError
			}
			var selected *runtimeDescriptor
			for i := range doc.Manifests {
				m := &doc.Manifests[i]
				if !runtimeDigestPattern.MatchString(m.Digest) || m.Size <= 0 || m.Size > runtimeManifestLimit {
					return nil, runtimeRegistryError
				}
				if m.Platform.OS == "unknown" && m.Platform.Architecture == "unknown" && m.Annotations["vnd.docker.reference.type"] == "attestation-manifest" {
					continue
				}
				if m.Platform.OS == "" || m.Platform.Architecture == "" || m.Platform.OS == "unknown" || m.Platform.Architecture == "unknown" {
					return nil, runtimeRegistryError
				}
				if m.Platform.OS == "linux" && m.Platform.Architecture == "amd64" && m.Platform.Variant == "" {
					if selected != nil {
						return nil, runtimeRegistryError
					}
					selected = m
				}
			}
			if selected == nil {
				return nil, runtimeRegistryError
			}
			b, digest, err = session.fetch(ctx, "/v2/"+repo+"/manifests/"+selected.Digest, runtimeManifestLimit, true)
			if err != nil || digest != selected.Digest || int64(len(b)) != selected.Size {
				return nil, runtimeRegistryError
			}
			if json.Unmarshal(b, &doc) != nil || doc.SchemaVersion != 2 {
				return nil, runtimeRegistryError
			}
		}
		if doc.MediaType != "application/vnd.oci.image.manifest.v1+json" && doc.MediaType != "application/vnd.docker.distribution.manifest.v2+json" {
			return nil, runtimeRegistryError
		}
		if !runtimeDigestPattern.MatchString(doc.Config.Digest) || doc.Config.Size <= 0 || doc.Config.Size > 1<<20 || doc.Layers == nil {
			return nil, runtimeRegistryError
		}
		for _, l := range doc.Layers {
			if !runtimeDigestPattern.MatchString(l.Digest) || l.Size < 0 {
				return nil, runtimeRegistryError
			}
		}
		config, configDigest, err := session.fetch(ctx, "/v2/"+repo+"/blobs/"+doc.Config.Digest, 1<<20, false)
		if err != nil || configDigest != doc.Config.Digest || int64(len(config)) != doc.Config.Size {
			return nil, runtimeRegistryError
		}
		var cfg struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
			Variant      string `json:"variant"`
		}
		if json.Unmarshal(config, &cfg) != nil || cfg.OS != "linux" || cfg.Architecture != "amd64" || cfg.Variant != "" {
			return nil, runtimeRegistryError
		}
		out = append(out, RuntimeImage{ServiceID: svc.ID, TagReference: svc.Image, Reference: host + "/" + repo + "@" + digest, Digest: digest, Platform: platform, Publisher: host + "/" + repo, DeliverySource: registry})
	}
	return out, nil
}
func (r RuntimeRegistryResolver) client() *http.Client {
	c := &http.Client{Timeout: 15 * time.Second}
	if r.Client != nil {
		*c = *r.Client
		if c.Timeout == 0 || c.Timeout > 15*time.Second {
			c.Timeout = 15 * time.Second
		}
	}
	if c.Transport == nil {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.Proxy = nil
		c.Transport = t
	} else if t, ok := c.Transport.(*http.Transport); ok {
		copy := t.Clone()
		copy.Proxy = nil
		c.Transport = copy
	}
	c.Jar = nil
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return c
}

type runtimeDescriptor struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
	Platform  struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
		Variant      string `json:"variant"`
	} `json:"platform"`
	Annotations map[string]string `json:"annotations"`
}
type runtimeManifest struct {
	SchemaVersion int                 `json:"schemaVersion"`
	MediaType     string              `json:"mediaType"`
	Manifests     []runtimeDescriptor `json:"manifests"`
	Config        runtimeDescriptor   `json:"config"`
	Layers        []runtimeDescriptor `json:"layers"`
}
type runtimeRegistrySession struct {
	resolver              RuntimeRegistryResolver
	client                *http.Client
	registry, repo, token string
}

func (s *runtimeRegistrySession) address(host, path string) (string, error) {
	base := "https://" + host
	if s.resolver.Endpoint != nil {
		base = s.resolver.Endpoint(host)
	}
	u, e := url.Parse(base)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(s.resolver.Endpoint != nil && u.Scheme == "http")) {
		return "", runtimeRegistryError
	}
	if u.Path != "" && u.Path != "/" {
		return "", runtimeRegistryError
	}
	return strings.TrimSuffix(base, "/") + path, nil
}
func (s *runtimeRegistrySession) request(ctx context.Context, host, path string, limit int64, manifest bool) ([]byte, http.Header, int, error) {
	address, e := s.address(host, path)
	if e != nil {
		return nil, nil, 0, e
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if e != nil {
		return nil, nil, 0, runtimeRegistryError
	}
	if s.token != "" && host == s.registry {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	if manifest {
		req.Header.Set("Accept", "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json")
	}
	resp, e := s.client.Do(req)
	if e != nil {
		return nil, nil, 0, runtimeRegistryError
	}
	defer resp.Body.Close()
	b, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil || int64(len(b)) > limit {
		return nil, nil, 0, runtimeRegistryError
	}
	return b, resp.Header, resp.StatusCode, nil
}
func (s *runtimeRegistrySession) fetch(ctx context.Context, path string, limit int64, manifest bool) ([]byte, string, error) {
	b, h, status, e := s.request(ctx, s.registry, path, limit, manifest)
	if e != nil {
		return nil, "", e
	}
	if status == http.StatusUnauthorized && s.token == "" {
		authHost, realm, service := "auth.docker.io", "https://auth.docker.io/token", "registry.docker.io"
		if s.registry == "ghcr.io" {
			authHost, realm, service = "ghcr.io", "https://ghcr.io/token", "ghcr.io"
		}
		// Never follow an upstream-controlled authentication URL or scope.
		challenge := h.Get("WWW-Authenticate")
		fields := regexp.MustCompile(`([a-z]+)="([^"]*)"`).FindAllStringSubmatch(challenge, -1)
		values := map[string]string{}
		for _, f := range fields {
			if _, exists := values[f[1]]; exists {
				return nil, "", runtimeRegistryError
			}
			values[f[1]] = f[2]
		}
		scope := "repository:" + s.repo + ":pull"
		if !strings.HasPrefix(challenge, "Bearer ") || values["realm"] != realm || values["service"] != service || (values["scope"] != "" && values["scope"] != scope) {
			return nil, "", runtimeRegistryError
		}
		tokenPath := "/token?" + url.Values{"service": {service}, "scope": {scope}}.Encode()
		tb, _, ts, te := s.request(ctx, authHost, tokenPath, 64<<10, false)
		if te != nil || ts != 200 {
			return nil, "", runtimeRegistryError
		}
		var token struct {
			Token       string `json:"token"`
			AccessToken string `json:"access_token"`
		}
		if json.Unmarshal(tb, &token) != nil {
			return nil, "", runtimeRegistryError
		}
		s.token = token.Token
		if s.token == "" {
			s.token = token.AccessToken
		}
		if s.token == "" || len(s.token) > 32<<10 || strings.ContainsAny(s.token, "\r\n") {
			return nil, "", runtimeRegistryError
		}
		b, h, status, e = s.request(ctx, s.registry, path, limit, manifest)
	}
	// GHCR config blobs use a signed publisher CDN redirect. Only this exact
	// reviewed blob path/HTTPS host is followed, without registry authorization.
	if e == nil && status == http.StatusTemporaryRedirect && !manifest && s.registry == "ghcr.io" && strings.HasPrefix(path, "/v2/"+s.repo+"/blobs/") {
		for redirects := 0; status == http.StatusTemporaryRedirect && redirects < 2; redirects++ {
			b, h, status, e = s.requestOfficialBlobCDN(ctx, h.Get("Location"), limit)
			if e != nil {
				break
			}
		}
	}
	if e != nil || status != 200 {
		return nil, "", runtimeRegistryError
	}
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256(b))
	if advertised := h.Get("Docker-Content-Digest"); advertised != "" && advertised != digest {
		return nil, "", runtimeRegistryError
	}
	return b, digest, nil
}

// This allowlist is based on observed authenticated official GHCR responses.
// An injected Endpoint never participates in redirect target authorization.
func (s *runtimeRegistrySession) requestOfficialBlobCDN(ctx context.Context, location string, limit int64) ([]byte, http.Header, int, error) {
	u, e := url.Parse(location)
	if e != nil || u.Scheme != "https" || u.Host != "pkg-containers.githubusercontent.com" || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.Path == "" {
		return nil, nil, 0, runtimeRegistryError
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if e != nil {
		return nil, nil, 0, runtimeRegistryError
	}
	// New request intentionally has no Authorization, cookies or upstream headers.
	resp, e := s.client.Do(req)
	if e != nil {
		return nil, nil, 0, runtimeRegistryError
	}
	defer resp.Body.Close()
	b, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil || int64(len(b)) > limit {
		return nil, nil, 0, runtimeRegistryError
	}
	return b, resp.Header, resp.StatusCode, nil
}
