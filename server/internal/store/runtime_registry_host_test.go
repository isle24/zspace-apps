package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestRuntimeSSHRegistryProofReplaysActualResolver(t *testing.T) {
	recipe, _ := RuntimeRecipeFor("navidrome", "")
	cfg := `{"architecture":"amd64","os":"linux"}`
	manifest := fmt.Sprintf(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"digest":%q,"size":%d},"layers":[]}`, registryDigest(cfg), len(cfg))
	index := fmt.Sprintf(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":%q,"size":%d,"platform":{"os":"linux","architecture":"amd64"}}]}`, registryDigest(manifest), len(manifest))
	repo := strings.SplitN(recipe.Services[0].Image, "/", 2)[1]
	at := strings.LastIndex(repo, ":")
	repo, tag := repo[:at], repo[at+1:]
	corpus := runtimeRegistryCorpus{}
	for path, body := range map[string]string{"/v2/" + repo + "/manifests/" + tag: index, "/v2/" + repo + "/manifests/" + registryDigest(manifest): manifest, "/v2/" + repo + "/blobs/" + registryDigest(cfg): cfg} {
		corpus.Documents = append(corpus.Documents, runtimeRegistryDocument{Host: "ghcr.io", Path: path, Body: base64.StdEncoding.EncodeToString([]byte(body))})
	}
	body, _ := json.Marshal(corpus)
	calls := 0
	e := &commandEngine{mode: "sshbind", alias: "fixture", runner: func(ctx context.Context, name string, args ...string) (string, string, error) {
		calls++
		if name != "sshbind" || args[2] != "--timeout" || args[4] != "fixture" {
			t.Fatal("registry did not use bounded registered transport")
		}
		if strings.Contains(args[5], "fixture-private-token") {
			t.Fatal("token escaped into command")
		}
		result, _ := json.Marshal(map[string]any{"exit_code": 0, "stdout": string(body)})
		return string(result), "", nil
	}}
	images, err := e.ResolveRuntimeImages(context.Background(), recipe, "linux/amd64")
	if err != nil || len(images) != 1 || images[0].Digest != registryDigest(manifest) {
		t.Fatalf("actual Go proof replay failed: %v", err)
	}
	if calls != 1 {
		t.Fatal("expected one remote corpus call")
	}
	corpus.Documents[0].Host = "evil.invalid"
	if _, err := replayRuntimeRegistryCorpus(context.Background(), recipe, "linux/amd64", corpus); err == nil {
		t.Fatal("foreign corpus accepted")
	}
}
