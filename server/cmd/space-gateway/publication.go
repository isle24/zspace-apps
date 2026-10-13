package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"spacedesktop/server/internal/store"
	"time"
)

func decodeCloudPublication(reader io.Reader) ([]store.CloudApp, error) {
	var input struct {
		Apps []store.CloudApp `json:"apps"`
	}
	decoder := json.NewDecoder(io.LimitReader(reader, 8<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || len(input.Apps) < 1 || len(input.Apps) > 1000 {
		return nil, errors.New("invalid publication input")
	}
	seen := map[string]bool{}
	idRE := regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	for _, app := range input.Apps {
		if !idRE.MatchString(app.ID) || seen[app.ID] {
			return nil, errors.New("invalid or duplicate application identity")
		}
		seen[app.ID] = true
	}
	return input.Apps, nil
}
func runCloudPublication(data, path string, engine string, catalogOnly, apiOnly bool) error {
	if !catalogOnly || !apiOnly || engine != "disabled" {
		return errors.New("publication operator requires catalog-only, api-only and disabled engine")
	}
	file, err := os.Open(path)
	if err != nil {
		return errors.New("publication input unavailable")
	}
	defer file.Close()
	apps, err := decodeCloudPublication(file)
	if err != nil {
		return err
	}
	s, err := store.New(store.Options{DataDir: filepath.Join(data, "store"), EngineMode: "disabled", CatalogOnly: true, CloudDatabaseURL: os.Getenv("SPACE_CLOUD_DATABASE_URL")})
	if err != nil {
		return errors.New("catalog metadata unavailable; stop its service before publishing")
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
	defer cancel()
	outcomes, err := s.PublishCloudApps(ctx, apps)
	counts := map[string]int{}
	for _, outcome := range outcomes {
		counts[outcome.Status]++
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"items": outcomes, "counts": counts})
	if err != nil {
		return errors.New("publication stopped; verify recorded outcomes before resuming")
	}
	return nil
}
