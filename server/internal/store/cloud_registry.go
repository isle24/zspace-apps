package store

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

type CloudImageInspection struct {
	Image         string `json:"image"`
	ImageDigest   string `json:"imageDigest"`
	Architecture  string `json:"architecture"`
	ExposedPorts  []int  `json:"exposedPorts"`
	SuggestedName string `json:"suggestedName"`
}

func cloudImageReference(raw string) (name.Reference, error) {
	if raw == "" || len(raw) > 300 || strings.ContainsAny(raw, "\\?# \t\r\n") || strings.Contains(raw, "://") {
		return nil, errors.New("invalid registry reference")
	}
	// WeakValidation performs the SDK's standard Docker Hub normalization
	// ("nginx:stable" -> index.docker.io/library/nginx:stable). The fixed registry
	// allowlist below still rejects custom endpoints and local registries.
	ref, err := name.ParseReference(raw, name.WeakValidation)
	if err != nil {
		return nil, errors.New("invalid registry reference")
	}
	switch ref.Context().RegistryStr() {
	case "index.docker.io", "docker.io", "ghcr.io":
	default:
		return nil, errors.New("registry not allowed")
	}
	if strings.Contains(raw, "@") && !strings.HasPrefix(ref.Identifier(), "sha256:") {
		return nil, errors.New("unsupported digest")
	}
	return ref, nil
}

func cloudRepository(ref name.Reference) string {
	if ref.Context().RegistryStr() == "index.docker.io" {
		return "docker.io/" + ref.Context().RepositoryStr()
	}
	return ref.Context().Name()
}

// The registry SDK handles OCI indexes and platform selection. Anonymous auth
// prevents accidental use of credentials from the gateway's Docker config.
func inspectCloudImage(ctx context.Context, raw string) (CloudImageInspection, error) {
	ref, err := cloudImageReference(raw)
	if err != nil {
		return CloudImageInspection{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	img, err := remote.Image(ref, remote.WithAuth(authn.Anonymous), remote.WithPlatform(v1.Platform{OS: "linux", Architecture: "amd64"}), remote.WithContext(ctx), remote.WithTransport(cloudRegistryHTTPTransport()))
	if err != nil {
		return CloudImageInspection{}, errors.New("public linux/amd64 registry image unavailable")
	}
	config, err := img.ConfigFile()
	if err != nil {
		return CloudImageInspection{}, errors.New("image configuration unavailable")
	}
	if config.OS != "linux" || config.Architecture != "amd64" {
		return CloudImageInspection{}, errors.New("image must support linux/amd64")
	}
	digest, err := img.Digest()
	if err != nil {
		return CloudImageInspection{}, errors.New("image digest unavailable")
	}
	ports := []int{}
	for port := range config.Config.ExposedPorts {
		p, protocol, ok := strings.Cut(port, "/")
		if !ok || protocol != "tcp" {
			continue
		}
		n, err := strconv.Atoi(p)
		if err == nil && n >= 1 && n <= 65535 {
			ports = append(ports, n)
		}
	}
	// Sort manually without inspecting or returning image Env/default secrets.
	for i := range ports {
		for j := i + 1; j < len(ports); j++ {
			if ports[j] < ports[i] {
				ports[i], ports[j] = ports[j], ports[i]
			}
		}
	}
	parts := strings.Split(ref.Context().RepositoryStr(), "/")
	return CloudImageInspection{Image: ref.Name(), ImageDigest: digest.String(), Architecture: "linux/amd64", ExposedPorts: ports, SuggestedName: parts[len(parts)-1]}, nil
}

type cloudRegistryTransport struct{ base http.RoundTripper }

func cloudRegistryHTTPTransport() http.RoundTripper {
	return cloudRegistryTransport{base: &http.Transport{Proxy: nil, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 60 * time.Second, DialContext: cloudPublicDial}}
}
func cloudPublicDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, errors.New("invalid remote address")
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, errors.New("remote lookup failed")
	}
	for _, ip := range ips {
		if !ip.IP.IsGlobalUnicast() || ip.IP.IsPrivate() || ip.IP.IsLoopback() || ip.IP.IsLinkLocalUnicast() || ip.IP.IsUnspecified() {
			return nil, errors.New("private remote address forbidden")
		}
	}
	dial := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	for _, ip := range ips {
		if conn, err := dial.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port)); err == nil {
			return conn, nil
		}
	}
	return nil, errors.New("remote connection failed")
}
func (t cloudRegistryTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	host := strings.ToLower(r.URL.Hostname())
	allowed := host == "index.docker.io" || host == "registry-1.docker.io" || host == "auth.docker.io" || host == "ghcr.io" || host == "pkg-containers.githubusercontent.com" || host == "production.cloudflare.docker.com" || strings.HasSuffix(host, ".r2.cloudflarestorage.com")
	if r.URL.Scheme != "https" || r.URL.User != nil || r.URL.Port() != "" && r.URL.Port() != "443" || !allowed {
		return nil, errors.New("registry destination forbidden")
	}
	resp, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	resp.Body = &cloudLimitedBody{Reader: io.LimitReader(resp.Body, 2<<20), Closer: resp.Body}
	return resp, nil
}

type cloudLimitedBody struct {
	io.Reader
	io.Closer
}

func (c *cloudService) inspectImage(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Image string `json:"image"`
	}
	if !decode(w, r, &in) {
		return
	}
	if _, err := cloudImageReference(in.Image); err != nil {
		fail(w, 400, "invalid_image", "镜像仅支持公开 Docker Hub 或 GHCR 引用。")
		return
	}
	info, err := c.resolveImage(r.Context(), in.Image)
	if err != nil {
		fail(w, 422, "image_unavailable", "无法核验此公开镜像的 linux/amd64 版本，请检查引用和仓库访问权限。")
		return
	}
	respond(w, 200, info)
}
