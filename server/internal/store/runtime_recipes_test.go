package store

import (
	"reflect"
	"strings"
	"testing"
)

func TestRuntimeRecipeInventory(t *testing.T) {
	recipes := RuntimeRecipes()
	if len(recipes) != 6 {
		t.Fatalf("six applications required, got %d", len(recipes))
	}
	for _, r := range recipes {
		if r.AppID != "nasreader" && len(r.CompatibleFrom) != 1 {
			t.Fatalf("predecessor missing: %s", r.AppID)
		}
		for _, v := range append([]string{r.Version}, r.CompatibleFrom...) {
			got, ok := RuntimeRecipeFor(r.AppID, v)
			if !ok || got.Version != v {
				t.Fatalf("missing %s/%s", r.AppID, v)
			}
		}
		if _, ok := RuntimeRecipeFor(r.AppID, "999.1"); ok {
			t.Fatal("unreviewed version accepted")
		}
		ids := map[string]bool{}
		for _, s := range r.Services {
			ids[s.ID] = true
			for _, v := range s.Volumes {
				if v.Target == "/var/run/docker.sock" || v.Target == "/" || v.Role == "host" {
					t.Fatal("unsafe mount")
				}
			}
		}
		for _, s := range r.Services {
			for _, d := range s.DependsOn {
				if !ids[d] {
					t.Fatal("unknown dependency")
				}
			}
		}
	}
	r, _ := RuntimeRecipeFor("immich", "")
	if len(r.Services) != 4 {
		t.Fatal("incomplete Immich graph")
	}
	for _, s := range r.Services {
		if !s.Entry && s.ContainerPort != 0 {
			t.Fatal("dependency published")
		}
	}
	for _, id := range []string{"navidrome", "jellyfin"} {
		r, _ := RuntimeRecipeFor(id, "")
		found := false
		for _, v := range r.Services[0].Volumes {
			if v.Role == "media-readonly" {
				found = true
			}
		}
		if !r.RequiresMedia || !found {
			t.Fatal("media not read-only")
		}
	}
	r = recipes[0]
	r.Services[0].Environment["FORGED"] = "bad"
	fresh, _ := RuntimeRecipeFor(r.AppID, "")
	if fresh.Services[0].Environment["FORGED"] != "" {
		t.Fatal("mutable catalog")
	}
}
func TestRuntimeVersionComparison(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{{"12.2", "12.1", 1}, {"2.10.0", "2.9.99", 1}, {"v3.3.1", "3.3.1", 0}, {"1.0", "2.0", -1}} {
		got, err := CompareRuntimeVersions(c.a, c.b)
		if err != nil || got != c.want {
			t.Fatalf("%+v: %d %v", c, got, err)
		}
	}
	for _, v := range []string{"latest", "1..2", "1.2-beta", "-1.2", "1.2.3.4", "01.2"} {
		if _, err := CompareRuntimeVersions(v, "1.0"); err == nil {
			t.Fatalf("accepted malformed %s", v)
		}
	}
}

func TestRuntimeModelsUseCamelCaseJSON(t *testing.T) {
	types := []any{RuntimeRecipe{}, RuntimeImage{}, RuntimeContainer{}, RuntimeGeneration{}, RuntimeSnapshot{}, RuntimePlan{}, RuntimeFacts{}}
	for _, value := range types {
		typ := reflect.TypeOf(value)
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			tag := field.Tag.Get("json")
			if tag == "" || strings.Contains(tag, "ID") || strings.Contains(tag, "URL") {
				t.Fatalf("%s.%s JSON tag is not camelCase: %s", typ.Name(), field.Name, tag)
			}
		}
	}
}

func TestRuntimeKumaHostUserUsesSupportedSQLite(t *testing.T) {
	r, _ := RuntimeRecipeFor("uptime-kuma", "")
	s := r.Services[0]
	if s.UserMode != "host" || s.Environment["UPTIME_KUMA_DB_TYPE"] != "sqlite" || s.Environment["UPTIME_KUMA_ENABLE_EMBEDDED_MARIADB"] != "0" {
		t.Fatal("arbitrary host UID must not offer embedded MariaDB requiring node/root usernames")
	}
}

func TestRuntimeRecipesHaveExactReviewedSecurityScope(t *testing.T) {
	expected := map[string]bool{"uptime-kuma": true, "navidrome": true, "jellyfin": true, "immich": true, "syncthing": true, "nasreader": true}
	for _, r := range RuntimeRecipes() {
		if !expected[r.AppID] {
			t.Fatalf("unexpected app %s", r.AppID)
		}
		delete(expected, r.AppID)
		old := r
		ok := true
		if len(r.CompatibleFrom) > 0 {
			old, ok = RuntimeRecipeFor(r.AppID, r.CompatibleFrom[0])
		}
		if !ok || len(old.CompatibleFrom) != 0 {
			t.Fatal("predecessor allows downgrade")
		}
		for _, recipe := range []RuntimeRecipe{r, old} {
			if len(recipe.SupportedPlatforms) != 1 || recipe.SupportedPlatforms[0] != "linux/amd64" {
				t.Fatal("unreviewed architecture")
			}
			entry := 0
			for _, s := range recipe.Services {
				if s.Entry {
					entry++
					if s.ContainerPort < 1 {
						t.Fatal("entry port missing")
					}
				}
				for _, v := range s.Volumes {
					if v.Name == "" || strings.ContainsAny(v.Name, "/\\.") || v.Target == "/" || strings.HasPrefix(v.Target, "/dev") || strings.Contains(v.Target, "docker.sock") || strings.HasPrefix(v.Target, "/etc") {
						t.Fatalf("unsafe volume %+v", v)
					}
				}
				for k, v := range s.Environment {
					if strings.Contains(strings.ToLower(k), "password") && v != "$managed:database-password" {
						t.Fatal("plaintext password in recipe")
					}
				}
			}
			if entry != 1 {
				t.Fatal("one entry service required")
			}
		}
	}
	if len(expected) != 0 {
		t.Fatal("missing applications")
	}
	if _, ok := RuntimeRecipeFor("attacker", ""); ok {
		t.Fatal("unknown app accepted")
	}
}

func TestRuntimeSingleServicesPreferVerifiedOfficialGHCR(t *testing.T) {
	publishers := map[string]string{"uptime-kuma": "ghcr.io/louislam/uptime-kuma:", "navidrome": "ghcr.io/navidrome/navidrome:", "jellyfin": "ghcr.io/jellyfin/jellyfin:", "syncthing": "ghcr.io/syncthing/syncthing:"}
	for id, prefix := range publishers {
		latest, _ := RuntimeRecipeFor(id, "")
		for _, version := range append([]string{latest.Version}, latest.CompatibleFrom...) {
			r, _ := RuntimeRecipeFor(id, version)
			if r.Services[0].Image != prefix+version {
				t.Fatalf("%s/%s source not verified GHCR: %s", id, version, r.Services[0].Image)
			}
		}
	}
}

func TestRuntimeImmichValkeyOfficialGHCRPreservesComposeDigest(t *testing.T) {
	for _, version := range []string{"3.3.1", "3.3.0"} {
		r, _ := RuntimeRecipeFor("immich", version)
		want := "ghcr.io/valkey-io/valkey:9@sha256:c123e3715db63d06d4ad6964884037aa0d5d4d703939b9929954112889708e1d"
		if r.Services[0].Image != want {
			t.Fatalf("official pinned Valkey source mismatch: %s", r.Services[0].Image)
		}
	}
}
