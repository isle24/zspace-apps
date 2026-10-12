package store

import (
	"strings"
	"testing"
)

func TestCatalogHasChineseDescriptionsAndPublicDocumentation(t *testing.T) {
	for _, id := range []string{"uptime-kuma", "navidrome", "jellyfin", "immich", "syncthing", "nasreader"} {
		r, ok := RuntimeRecipeFor(id, "")
		if !ok || !strings.Contains(r.Documentation, "nas-app-store-catalog") || len(r.Description) < 20 {
			t.Fatalf("missing published display metadata %s", id)
		}
	}
}
func TestCatalogOnlyServiceDoesNotAdvertiseServerSideInstall(t *testing.T) {
	r := newRig(t)
	r.s.opts.CatalogOnly = true
	r.setup()
	code, out := r.call("GET", "/api/store/v2/catalog", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code, out)
	}
	items := out["data"].(map[string]any)["items"].([]any)
	if len(items) == 0 {
		t.Fatal("missing catalog")
	}
	for _, item := range items {
		if item.(map[string]any)["installable"] == true {
			t.Fatal("central directory advertised install on the remote server")
		}
	}
}
