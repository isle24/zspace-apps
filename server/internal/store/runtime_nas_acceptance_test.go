package store

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// This opt-in is read-only. Every network operation on the real NAS goes
// through the registered sshbind alias; ordinary test runs never contact it.
func TestRuntimeNASOfficialRegistry(t *testing.T) {
	if os.Getenv("STORE_NAS_ACCEPTANCE") != "zspace" {
		t.Skip("set STORE_NAS_ACCEPTANCE=zspace for approved read-only NAS proof")
	}
	engine, err := newCommandEngine(Options{EngineMode: "sshbind", SSHAlias: "zspace"})
	if err != nil {
		t.Fatal(err)
	}
	runtime := engine.(RuntimeEngine)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	facts, err := runtime.RuntimeFacts(ctx)
	if err != nil || facts.Platform != "linux/amd64" {
		t.Fatalf("NAS runtime facts: %+v, %v", facts, err)
	}
	for _, latest := range RuntimeRecipes() {
		versions := append([]string{latest.Version}, latest.CompatibleFrom...)
		for _, version := range versions {
			recipe, ok := RuntimeRecipeFor(latest.AppID, version)
			if !ok {
				t.Fatalf("reviewed recipe missing: %s %s", latest.AppID, version)
			}
			images, err := runtime.ResolveRuntimeImages(ctx, recipe, facts.Platform)
			if err != nil || len(images) != len(recipe.Services) {
				t.Fatalf("NAS official proof %s %s: %v", latest.AppID, version, err)
			}
			proof, err := json.Marshal(struct {
				AppID   string         `json:"appId"`
				Version string         `json:"version"`
				Images  []RuntimeImage `json:"images"`
			}{latest.AppID, version, images})
			if err != nil {
				t.Fatal(err)
			}
			t.Log(string(proof))
		}
	}
}
