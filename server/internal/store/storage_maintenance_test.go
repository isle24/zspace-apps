package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCreateStorageDirectoryDoesNotWriteDuringMaintenance(t *testing.T) {
	for _, state := range []string{"quiesced", "unverified"} {
		t.Run(state, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			e := &creatingStorageEngine{fakeEngine: r.e}
			r.s.engine = e
			wantStatus := 423
			if state == "quiesced" {
				maintenancePause(t, r, "before-create")
			} else {
				maintenanceFixtureExec(t, r.s.db, `DELETE FROM metadata WHERE key='store_maintenance_schema'`)
				wantStatus = 503
			}
			path := filepath.Join(r.root, "must-remain-absent")
			body, _ := json.Marshal(map[string]any{"path": path, "create": true})
			status, _ := r.call("POST", "/api/store/roots", string(body), "127.0.0.1:1")
			if status != wantStatus {
				t.Fatalf("create returned HTTP %d; want %d", status, wantStatus)
			}
			if e.creates != 0 {
				t.Fatal("maintenance rejection happened after the filesystem mutation")
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("maintenance request created an unregistered directory")
			}
		})
	}
}

type maintenanceCreationEngine struct {
	*creatingStorageEngine
	beforeCreate func()
}

func (e *maintenanceCreationEngine) CreateStorageDirectory(ctx context.Context, path, parentIdentity string) (StorageCandidate, error) {
	e.beforeCreate()
	return e.creatingStorageEngine.CreateStorageDirectory(ctx, path, parentIdentity)
}

func TestStorageCreationKeepsMaintenanceOutUntilRegistration(t *testing.T) {
	r := newRig(t)
	r.setup()
	maintenanceStatus := 0
	r.s.engine = &maintenanceCreationEngine{
		creatingStorageEngine: &creatingStorageEngine{fakeEngine: r.e},
		beforeCreate: func() {
			maintenanceStatus, _ = r.call("POST", maintenanceURL+"/quiesce", `{"requestId":"during-create"}`, "127.0.0.1:1")
		},
	}
	path := filepath.Join(r.root, "complete-before-maintenance")
	body, _ := json.Marshal(map[string]any{"path": path, "create": true})
	status, _ := r.call("POST", "/api/store/roots", string(body), "127.0.0.1:1")
	if maintenanceStatus != 409 {
		t.Fatalf("maintenance accepted while filesystem mutation was in flight: HTTP %d", maintenanceStatus)
	}
	if status != 201 {
		t.Fatalf("directory creation did not finish registration: HTTP %d", status)
	}
	maintenancePause(t, r, "after-create")
}
