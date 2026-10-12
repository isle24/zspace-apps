package store

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

func RuntimeRecipes() []RuntimeRecipe {
	out := make([]RuntimeRecipe, 0, 6)
	for _, id := range []string{"uptime-kuma", "navidrome", "jellyfin", "immich", "syncthing", "nasreader"} {
		r, _ := RuntimeRecipeFor(id, "")
		out = append(out, r)
	}
	return out
}
func RuntimeRecipeFor(appID, version string) (RuntimeRecipe, bool) {
	if appID == "nasreader" {
		r, ok := nasReaderRecipe(version)
		return applyDisplay(r), ok
	}
	pairs := map[string][]string{"uptime-kuma": {"2.5.6", "2.5.5"}, "navidrome": {"0.64.2", "0.64.1"}, "jellyfin": {"12.2", "12.1"}, "immich": {"3.3.1", "3.3.0"}, "syncthing": {"2.1.6", "2.1.5"}}
	p, ok := pairs[appID]
	if !ok {
		return RuntimeRecipe{}, false
	}
	if version == "" {
		version = p[0]
	}
	if version != p[0] && version != p[1] {
		return RuntimeRecipe{}, false
	}
	r := RuntimeRecipe{AppID: appID, Version: version, Revision: "2026-10-11.2", SupportedPlatforms: []string{"linux/amd64"}, MigrationStrategy: "snapshot-copy-switch", Initialization: "administrator-setup", CompatibleFrom: []string{}, MinimumMemoryBytes: 256 * 1024 * 1024}
	if version == p[0] {
		r.CompatibleFrom = []string{p[1]}
	}
	svc := RuntimeService{ID: appID, Entry: true, UserMode: "host", Environment: map[string]string{}, HealthIntervalSeconds: 30, HealthTimeoutSeconds: 10, HealthRetries: 5}
	volume := func(n, t, role string) RuntimeVolume { return RuntimeVolume{Name: n, Target: t, Role: role} }
	switch appID {
	case "uptime-kuma":
		r.Name = "Uptime Kuma"
		r.License = "MIT"
		r.Category = "monitoring"
		r.Description = "Service uptime monitoring"
		r.SourceURL = "https://github.com/louislam/uptime-kuma"
		r.DefaultPort = 3001
		svc.ContainerPort = 3001
		svc.Image = "ghcr.io/louislam/uptime-kuma:" + version
		svc.HealthPath = "/"
		svc.UserMode = "host"
		svc.Environment = map[string]string{"UPTIME_KUMA_DB_TYPE": "sqlite", "UPTIME_KUMA_ENABLE_EMBEDDED_MARIADB": "0"}
		svc.Volumes = []RuntimeVolume{volume("data", "/app/data", "data")}
	case "navidrome":
		r.Name = "Navidrome"
		r.License = "GPL-3.0"
		r.Category = "music"
		r.Description = "Music library and streaming"
		r.SourceURL = "https://www.navidrome.org/docs/installation/docker/"
		r.DefaultPort = 4533
		r.RequiresMedia = true
		r.MediaTarget = "/music"
		svc.ContainerPort = 4533
		svc.Image = "ghcr.io/navidrome/navidrome:" + version
		svc.HealthPath = "/ping"
		svc.Volumes = []RuntimeVolume{volume("data", "/data", "data"), volume("media", "/music", "media-readonly")}
	case "jellyfin":
		r.Name = "Jellyfin"
		r.License = "GPL-2.0"
		r.Category = "video"
		r.Description = "Media library and streaming without GPU access"
		r.SourceURL = "https://jellyfin.org/docs/general/installation/container/"
		r.DefaultPort = 8096
		r.RequiresMedia = true
		r.MediaTarget = "/media"
		svc.ContainerPort = 8096
		svc.Image = "ghcr.io/jellyfin/jellyfin:" + version
		svc.HealthPath = "/health"
		svc.Volumes = []RuntimeVolume{volume("config", "/config", "config"), volume("cache", "/cache", "cache"), volume("media", "/media", "media-readonly")}
	case "syncthing":
		r.Name = "Syncthing"
		r.License = "MPL-2.0"
		r.Category = "sync"
		r.Description = "Dedicated folder synchronization"
		r.SourceURL = "https://github.com/syncthing/syncthing/blob/v" + version + "/README-Docker.md"
		r.DefaultPort = 8384
		svc.ContainerPort = 8384
		svc.Image = "ghcr.io/syncthing/syncthing:" + version
		svc.UserMode = "host-env"
		svc.HealthPath = "/rest/noauth/health"
		svc.Environment = map[string]string{"STGUIADDRESS": "0.0.0.0:8384"}
		svc.Volumes = []RuntimeVolume{volume("home", "/var/syncthing", "data"), volume("config", "/var/syncthing/config", "config"), volume("sync", "/var/syncthing/Sync", "sync-write")}
	case "immich":
		r.Name = "Immich"
		r.License = "AGPL-3.0"
		r.Category = "photos"
		r.Description = "Photo server with machine learning and private database/cache"
		r.SourceURL = "https://github.com/immich-app/immich/blob/v" + version + "/docker/docker-compose.yml"
		r.DefaultPort = 2283
		r.MinimumMemoryBytes = 6 * 1024 * 1024 * 1024
		env := map[string]string{"DB_HOSTNAME": "database", "DB_USERNAME": "postgres", "DB_DATABASE_NAME": "immich", "DB_PASSWORD": "$managed:database-password", "REDIS_HOSTNAME": "redis", "IMMICH_MACHINE_LEARNING_URL": "http://immich-machine-learning:3003"}
		r.Services = []RuntimeService{
			{ID: "redis", Image: "ghcr.io/valkey-io/valkey:9@sha256:c123e3715db63d06d4ad6964884037aa0d5d4d703939b9929954112889708e1d", UserMode: "image-default", Environment: map[string]string{}, HealthCommand: []string{"CMD-SHELL", "redis-cli ping | grep -q PONG || exit 1"}, HealthIntervalSeconds: 30, HealthTimeoutSeconds: 10, HealthRetries: 5},
			{ID: "database", Image: "ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23", UserMode: "image-default", SharedMemoryBytes: 128 * 1024 * 1024, Environment: map[string]string{"POSTGRES_PASSWORD": "$managed:database-password", "POSTGRES_USER": "postgres", "POSTGRES_DB": "immich", "POSTGRES_INITDB_ARGS": "--data-checksums"}, Volumes: []RuntimeVolume{volume("database", "/var/lib/postgresql/data", "data")}},
			{ID: "immich-machine-learning", Image: "ghcr.io/immich-app/immich-machine-learning:v" + version, UserMode: "image-default", Environment: map[string]string{}, Volumes: []RuntimeVolume{volume("model-cache", "/cache", "cache")}},
			{ID: "immich-server", Image: "ghcr.io/immich-app/immich-server:v" + version, UserMode: "image-default", Entry: true, ContainerPort: 2283, HealthPath: "/api/server/ping", Environment: env, DependsOn: []string{"redis", "database"}, Volumes: []RuntimeVolume{volume("uploads", "/data", "data")}},
		}
	}
	if appID != "immich" {
		r.Services = []RuntimeService{svc}
	}
	// Health commands match verified official image config or Compose override.
	for i := range r.Services {
		service := &r.Services[i]
		switch service.ID {
		case "uptime-kuma":
			service.HealthCommand = []string{"CMD-SHELL", "extra/healthcheck"}
			service.HealthIntervalSeconds = 60
			service.HealthTimeoutSeconds = 30
			service.HealthStartPeriodSeconds = 180
			service.HealthRetries = 5
		case "jellyfin":
			service.HealthCommand = []string{"CMD-SHELL", `curl --noproxy 'localhost' -Lk -fsS "${HEALTHCHECK_URL}" || exit 1`}
			service.HealthIntervalSeconds = 30
			service.HealthTimeoutSeconds = 30
			service.HealthStartPeriodSeconds = 10
			service.HealthRetries = 3
		case "syncthing":
			service.HealthCommand = []string{"CMD-SHELL", "curl -fkLsS -m 2 127.0.0.1:8384/rest/noauth/health | grep -o --color=never OK || exit 1"}
			service.HealthIntervalSeconds = 60
			service.HealthTimeoutSeconds = 10
			service.HealthRetries = 3
		case "database":
			service.HealthCommand = []string{"CMD-SHELL", "/usr/local/bin/healthcheck.sh"}
			service.HealthIntervalSeconds = 300
			service.HealthTimeoutSeconds = 30
			service.HealthStartPeriodSeconds = 300
			service.HealthStartIntervalSeconds = 5
			service.HealthRetries = 3
		case "immich-machine-learning":
			service.HealthCommand = []string{"CMD-SHELL", "python3 healthcheck.py"}
			service.HealthIntervalSeconds = 30
			service.HealthTimeoutSeconds = 30
			service.HealthRetries = 3
		case "immich-server":
			service.HealthCommand = []string{"CMD-SHELL", "immich-healthcheck"}
			service.HealthIntervalSeconds = 30
			service.HealthTimeoutSeconds = 30
			service.HealthRetries = 3
		}
	}
	r.Icon = "/app-icons/" + appID + ".svg"
	if appID == "navidrome" {
		r.Icon = "/app-icons/navidrome.png"
	}
	// A fresh deep value prevents callers from modifying approved recipe state.
	b, _ := json.Marshal(r)
	var copy RuntimeRecipe
	_ = json.Unmarshal(b, &copy)
	return applyDisplay(copy), true
}
func CompareRuntimeVersions(left, right string) (int, error) {
	parse := func(s string) ([3]uint64, error) {
		var v [3]uint64
		s = strings.TrimPrefix(s, "v")
		p := strings.Split(s, ".")
		if len(p) < 2 || len(p) > 3 {
			return v, errors.New("invalid runtime version")
		}
		for i, x := range p {
			if x == "" || (len(x) > 1 && x[0] == '0') {
				return v, errors.New("invalid runtime version")
			}
			for _, c := range x {
				if c < '0' || c > '9' {
					return v, errors.New("invalid runtime version")
				}
			}
			n, e := strconv.ParseUint(x, 10, 64)
			if e != nil {
				return v, errors.New("invalid runtime version")
			}
			v[i] = n
		}
		return v, nil
	}
	a, e := parse(left)
	if e != nil {
		return 0, e
	}
	b, e := parse(right)
	if e != nil {
		return 0, e
	}
	for i := range a {
		if a[i] < b[i] {
			return -1, nil
		}
		if a[i] > b[i] {
			return 1, nil
		}
	}
	return 0, nil
}
