package store

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func ownedTestImage(t *testing.T) RuntimeImage {
	t.Helper()
	var im RuntimeImage
	err := json.Unmarshal([]byte(`{"serviceId":"nasreader","tagReference":"nasreader:free-platforms-reader-licensed-amd64-20261010","reference":"sha256:0f1ea3da17ac3c2a37a7525323dbaeb5ea1c3c0ae7a5508329ca8f6a008f9ccb","digest":"","platform":"linux/amd64","publisher":"nasreader","deliverySource":"owner-archive","configId":"sha256:0f1ea3da17ac3c2a37a7525323dbaeb5ea1c3c0ae7a5508329ca8f6a008f9ccb","archiveSha256":"90e7de4c1d97c548a838d086190b80ab52f7feb4be3abef013f3fcf4562fd491","archiveSizeBytes":44854784,"diffIds":["sha256:e63b02c2b5c761df2cb95e657d744f27d95da4e051235a13c80b88cd68eab188","sha256:15a1fd6977575dfbd3ce1a551140eeb3210e944b7d50bf69e69f5815b8506c7a","sha256:f8b32a7528ea40fb89aa834497fa3562c9099801ee2abbdc7e87714f48839408","sha256:54f59a3b6c5d3204c4d96327b21b1484fcb57919cbe1b72d6aa99adb311592b4","sha256:e36189ddb1f2188fd22b562f2a5551aec748aade5ba6a1c9204991e3c90ff2a7","sha256:287a4a9a15206855817ba3624df195400b576c9a78326bc156625555c2cfe25a"]}`), &im)
	if err != nil {
		t.Fatal(err)
	}
	return im
}
func TestOwnedNasReaderRecipeAndImage(t *testing.T) {
	r, ok := RuntimeRecipeFor("nasreader", "")
	if !ok {
		t.Fatal("nasReader installation recipe missing")
	}
	if r.Version != "0.1.0" || len(r.CompatibleFrom) != 0 || r.Category != "reading" || r.License != "AGPL-3.0" || !r.RequiresMedia || r.MediaTarget != "/library" {
		t.Fatalf("wrong recipe: %+v", r)
	}
	if _, ok := RuntimeRecipeFor("nasreader", "0.1.1"); ok {
		t.Fatal("desktop release offered as server")
	}
	s := r.Services[0]
	if s.UserMode != "host" || s.ContainerPort != 8080 || len(s.Environment) != 0 || len(s.Volumes) != 3 {
		t.Fatal("wrong restricted service")
	}
	if !reflect.DeepEqual(s.Volumes, []RuntimeVolume{{"data", "/data", "data"}, {"inbox", "/inbox", "data"}, {"media", "/library", "media-readonly"}}) {
		t.Fatal("wrong mounts")
	}
	im := ownedTestImage(t)
	if err := validateRuntimeImages(r, []RuntimeImage{im}); err != nil {
		t.Fatal("fixed author config identity rejected", err)
	}
	b, _ := json.Marshal(im)
	var doc map[string]any
	json.Unmarshal(b, &doc)
	for _, key := range []string{"configId", "archiveSha256", "archiveSizeBytes", "diffIds"} {
		if _, ok := doc[key]; !ok {
			t.Fatal("typed identity lost", key)
		}
	}
	for _, key := range []string{"configId", "archiveSha256", "archiveSizeBytes", "diffIds", "reference", "digest", "tagReference", "platform", "publisher", "deliverySource"} {
		copyDoc := map[string]any{}
		json.Unmarshal(b, &copyDoc)
		delete(copyDoc, key)
		if key == "digest" {
			copyDoc[key] = "sha256:" + strings.Repeat("a", 64)
		}
		raw, _ := json.Marshal(copyDoc)
		var bad RuntimeImage
		json.Unmarshal(raw, &bad)
		if validateRuntimeImages(r, []RuntimeImage{bad}) == nil {
			t.Fatal("incomplete author identity accepted", key)
		}
	}
	r.Services[0].Environment["LICENSE_ENABLED"] = "false"
	if validateRuntimeImages(r, []RuntimeImage{im}) == nil {
		t.Fatal("noncanonical owner recipe accepted")
	}
	old, _ := RuntimeRecipeFor("uptime-kuma", "")
	im.ServiceID = old.Services[0].ID
	if validateRuntimeImages(old, []RuntimeImage{im}) == nil {
		t.Fatal("config-only owner image accepted for other app")
	}
	oldPlan := runtimeTestPlan(t)
	if validateRuntimeImages(oldPlan.Recipe, oldPlan.Images) != nil {
		t.Fatal("old registry identity broken")
	}
	oldJSON, _ := json.Marshal(oldPlan.Images[0])
	for _, key := range []string{"configId", "archiveSha256", "archiveSizeBytes", "diffIds"} {
		if strings.Contains(string(oldJSON), key) {
			t.Fatal("legacy wire changed", key)
		}
	}
}
func TestOwnedNasReaderResolveLoadedOnly(t *testing.T) {
	r, ok := RuntimeRecipeFor("nasreader", "")
	if !ok {
		t.Fatal("nasReader installation recipe missing")
	}
	for _, mode := range []string{"local", "sshbind"} {
		e := &commandEngine{mode: mode, alias: "fixture"}
		calls := 0
		e.runner = func(_ context.Context, name string, args ...string) (string, string, error) {
			calls++
			payload, _ := json.Marshal([]RuntimeImage{ownedTestImage(t)})
			if mode == "local" {
				if name != "python3" || args[2] != "resolve-owner" {
					t.Fatal("owner image entered registry resolution")
				}
				return string(payload), "", nil
			}
			if name != "sshbind" || !strings.Contains(args[len(args)-1], "resolve-owner") {
				t.Fatal("owner image entered registry resolution")
			}
			out, _ := json.Marshal(map[string]any{"exit_code": 0, "stdout": string(payload)})
			return string(out), "", nil
		}
		ims, err := e.ResolveRuntimeImages(context.Background(), r, "linux/amd64")
		if err != nil || len(ims) != 1 || calls != 1 {
			t.Fatal("loaded author image unavailable", err)
		}
		e.runner = func(context.Context, string, ...string) (string, string, error) {
			return "", "", errors.New("private docker failure")
		}
		_, err = e.ResolveRuntimeImages(context.Background(), r, "linux/amd64")
		if err == nil || !strings.Contains(err.Error(), "owner_image_unavailable") || strings.Contains(err.Error(), "private") {
			t.Fatal("missing author software not explicit", err)
		}
	}
}

func TestOwnedNasReaderCatalogSeparatesDeliveryLicenseAndUpdates(t *testing.T) {
	r, _ := controllerRig(t)
	runtimePut(r.s.db, context.Background(), "runtime_catalog", "nasreader", runtimeCatalogEntry{LatestVersion: "0.1.1", Status: "ok"})
	runtimePut(r.s.db, context.Background(), "runtime_instances", "reader", runtimeInstance{ID: "reader", AppID: "nasreader", Version: "0.1.0", Health: "healthy", Initialization: "complete"})
	code, out := r.call("GET", "/api/store/v2/catalog", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code)
	}
	var found map[string]any
	for _, item := range out["data"].(map[string]any)["items"].([]any) {
		v := item.(map[string]any)
		if v["id"] == "nasreader" {
			found = v
		}
	}
	if found == nil || found["deliveryLabel"] != "licensed-amd64-20261010" || found["nativeLicense"] != "授权待应用内核验" || found["latestVersion"] != "0.1.0" || found["upgradeAllowed"] != false || found["deliverySource"] != "owner-archive" {
		t.Fatal("catalog conflates delivery/version/license", found)
	}
	code, out = r.call("GET", "/api/store/v2/instances", "", "127.0.0.1:1")
	if code != 200 {
		t.Fatal(code)
	}
	instance := out["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if instance["nativeLicense"] != "授权待应用内核验" || instance["updateAvailable"] != false || instance["initialization"] != "complete" || instance["health"] != "healthy" {
		t.Fatal("license or update inferred from setup/health", instance)
	}
}

func TestOwnedNasReaderEmbeddedHostDescriptorMatchesGo(t *testing.T) {
	recipe, _ := RuntimeRecipeFor("nasreader", "")
	request, _ := json.Marshal(map[string]any{"recipe": recipe, "images": []RuntimeImage{nasReaderImage()}})
	script := runtimeOwnerImageScript + "\n" + runtimeHostBody + `
import json,sys
request=json.loads(sys.argv[1])
im={'Id':OWNER_CONFIG,'Os':'linux','Architecture':'amd64','RootFS':{'Type':'layers','Layers':OWNER_DIFF_IDS}}
command=lambda *args,**kwargs:json.dumps([im])
assert resolve_owner(request['recipe'],request['images'])==[owner_descriptor()]
print('embedded descriptor/resolve parity verified')
`
	script = "__name__='fixture'\n" + script
	output, err := exec.Command("python3", "-c", script, string(request)).CombinedOutput()
	if err != nil {
		t.Fatalf("embedded host parity: %v %s", err, output)
	}
}
