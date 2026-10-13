package store

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestCloudPublicListingIsVisibleWithoutMakingItInstallable(t *testing.T) {
	r, c, mux, admin := cloudPublicationRig(t)
	draft := cloudDraft()
	draft["id"] = "native-app"
	draft["name"] = "Native reference"
	draft["catalogOnly"] = true
	draft["compatibilityNote"] = "飞牛原生应用，安装支持待适配。"
	draft["sourceURL"] = "https://github.com/conversun/fnos-apps/tree/main/apps/native-app"
	status, out := cloudCall(t, mux, "POST", "/api/store/admin/apps", admin, draft)
	if status != 201 {
		t.Fatalf("save listing %d %v", status, out)
	}
	status, _ = cloudCall(t, mux, "GET", "/api/cloud/public-catalog", "", nil)
	if status != 200 {
		t.Fatal("public catalog", status)
	}
	status, _ = cloudCall(t, mux, "POST", "/api/store/admin/apps/native-app/publish-listing", "", map[string]any{})
	if status != 401 {
		t.Fatal("anonymous publish", status)
	}
	status, out = cloudCall(t, mux, "POST", "/api/store/admin/apps/native-app/publish-listing", admin, map[string]any{})
	if status != 200 {
		t.Fatalf("publish listing %d %v", status, out)
	}
	status, out = cloudCall(t, mux, "GET", "/api/cloud/public-catalog", "", nil)
	if status != 200 {
		t.Fatal(status)
	}
	found := false
	for _, value := range out["data"].(map[string]any)["items"].([]any) {
		app := value.(map[string]any)
		if app["id"] != "native-app" {
			continue
		}
		found = true
		if app["catalogOnly"] != true || app["image"] != "" || app["containerPort"] != float64(0) || app["releaseNumber"] != float64(0) || app["manifestDigest"] != nil {
			t.Fatal("install fields leaked", app)
		}
	}
	if !found {
		t.Fatal("published listing absent")
	}
	var releases int
	if err := r.s.db.QueryRow(`SELECT count(*) FROM cloud_releases WHERE app_id='native-app'`).Scan(&releases); err != nil || releases != 0 {
		t.Fatal("listing produced release", releases, err)
	}
	status, _ = cloudCall(t, mux, "POST", "/api/store/admin/apps/native-app/publish", admin, map[string]any{})
	if status != 400 {
		t.Fatal("listing became installable", status)
	}
	user := cloudRegister(t, mux, "listing-user")
	status, _ = cloudCall(t, mux, "GET", "/api/cloud/manifests/native-app/r1.json", user, nil)
	if status != 404 {
		t.Fatal("listing manifest served", status)
	}
	items, err := c.readApps(true)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(items)
	if strings.Contains(string(raw), "ADMIN_PASSWORD") {
		t.Fatal("listing environment leaked")
	}
}
func TestCloudOperatorPreservesPublishedRowsAndFallsBackToListing(t *testing.T) {
	r, c, _, _ := cloudPublicationRig(t)
	var before string
	if err := r.s.db.QueryRow(`SELECT published_json FROM cloud_apps WHERE id='jellyfin'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	input := []CloudApp{{ID: "jellyfin", Name: "overwrite must not happen"}, {ID: "pending-reference", Name: "Reference", Description: "Public information", Category: "tools", Version: "1.0", CatalogOnly: true, CompatibilityNote: "待适配"}, {ID: "bad-image", Name: "Bad image", Description: "Public information", Category: "tools", Version: "1.0", Image: "nginx:stable", ContainerPort: 80, DataTargets: []string{}}}
	c.resolveImage = func(context.Context, string) (CloudImageInspection, error) {
		return CloudImageInspection{}, http.ErrHandlerTimeout
	}
	results, err := c.publishCloudApps(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 || results[0].Status != "preserved" || results[1].Status != "catalog-only" || results[2].Status != "catalog-only" {
		t.Fatalf("results %#v", results)
	}
	var after string
	r.s.db.QueryRow(`SELECT published_json FROM cloud_apps WHERE id='jellyfin'`).Scan(&after)
	if before != after {
		t.Fatal("existing release changed")
	}
	pending, err := c.readApp("bad-image", true)
	if err != nil || !pending.CatalogOnly || pending.Image != "" {
		t.Fatal("failed candidate exposed as installable", pending, err)
	}
}
