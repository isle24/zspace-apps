package store

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

func inspectCachedCloudImage(ctx context.Context, raw string) (CloudImageInspection, error) {
	ref, err := cloudImageReference(raw)
	if err != nil || !cloudDigestRE.MatchString(ref.Identifier()) {
		return CloudImageInspection{}, runtimeCloudFailure
	}
	reference := cloudRepository(ref) + "@" + ref.Identifier()
	key := tokenHash(reference)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: cloudPublicDial}, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(route string, max int) ([]byte, error) {
		req, _ := http.NewRequestWithContext(ctx, "GET", "https://zstore.2iwm.com/v2/cache/"+key+"/"+route, nil)
		resp, err := client.Do(req)
		if err != nil {
			return nil, runtimeCloudFailure
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, runtimeCloudFailure
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, int64(max)+1))
		if err != nil || len(b) > max {
			return nil, runtimeCloudFailure
		}
		return b, nil
	}
	manifest, err := get("manifests/"+ref.Identifier(), 2<<20)
	if err != nil || "sha256:"+tokenHash(string(manifest)) != ref.Identifier() {
		return CloudImageInspection{}, runtimeCloudFailure
	}
	var doc runtimeManifest
	if json.Unmarshal(manifest, &doc) != nil || !cloudDigestRE.MatchString(doc.Config.Digest) {
		return CloudImageInspection{}, runtimeCloudFailure
	}
	config, err := get("blobs/"+doc.Config.Digest, 1<<20)
	if err != nil || "sha256:"+tokenHash(string(config)) != doc.Config.Digest {
		return CloudImageInspection{}, runtimeCloudFailure
	}
	var cfg struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
	}
	if json.Unmarshal(config, &cfg) != nil || cfg.OS != "linux" || cfg.Architecture != "amd64" {
		return CloudImageInspection{}, runtimeCloudFailure
	}
	return CloudImageInspection{Image: reference, ImageDigest: ref.Identifier(), Architecture: "linux/amd64"}, nil
}
