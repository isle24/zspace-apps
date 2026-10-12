package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
)

var runtimeGithubPathRE = regexp.MustCompile(`^(catalog-key\.json|catalog-envelope\.json|catalogs/[0-9]+\.json|manifests/[a-z][a-z0-9-]{0,63}/r[0-9]+\.json)$`)

func runtimeGithubGet(ctx context.Context, client *http.Client, path string, max int) ([]byte, error) {
	if !runtimeGithubPathRE.MatchString(path) {
		return nil, runtimeCloudFailure
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://raw.githubusercontent.com/isle24/nas-app-store-catalog/main/"+path, nil)
	if err != nil {
		return nil, err
	}
	// Tokens never leave the catalog service. GitHub supplies public assets only.
	resp, err := client.Do(req)
	if err != nil {
		return nil, runtimeCloudFailure
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, runtimeCloudFailure
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(max)+1))
	if err != nil || len(body) > max {
		return nil, runtimeCloudFailure
	}
	return body, nil
}
func runtimeCloudFallback(ctx context.Context, client *http.Client, path string, max int) ([]byte, error) {
	switch path {
	case "catalog-key":
		raw, err := runtimeGithubGet(ctx, client, "catalog-key.json", max)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"ok": true, "data": json.RawMessage(raw)})
	case "catalog/signed":
		envelopeRaw, err := runtimeGithubGet(ctx, client, "catalog-envelope.json", 16384)
		if err != nil {
			return nil, err
		}
		var envelope cloudCatalogEnvelope
		if json.Unmarshal(envelopeRaw, &envelope) != nil {
			return nil, runtimeCloudFailure
		}
		payload, err := runtimeGithubGet(ctx, client, envelope.Payload.Path, 2<<20)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"ok": true, "data": map[string]any{"envelope": envelope, "payloadBase64": base64.StdEncoding.EncodeToString(payload)}})
	default:
		return runtimeGithubGet(ctx, client, path, max)
	}
}
