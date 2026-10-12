package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

const maintenanceURL = "/api/store/v2/maintenance"

func TestMaintenanceEvidenceFailureAfterCancellationIsAuthenticationFailure(t *testing.T) {
	for _, cause := range []string{"evidence-read", "plan-conflict"} {
		t.Run(cause, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := httptest.NewRequest("GET", maintenanceURL, nil).WithContext(ctx)
			req.Header.Set("X-Store-Session", r.token)
			w := httptest.NewRecorder()
			r.s.auth(func(w http.ResponseWriter, req *http.Request) {
				r.s.runtimeAuthTransaction(w, req, func(tx *sql.Tx) error {
					cancel()
					if cause == "plan-conflict" {
						return errRuntimeConflict
					}
					_, _, err := maintenanceRead(tx)
					return err
				})
			})(w, req)
			if w.Code != 401 || !strings.Contains(w.Body.String(), `"code":"store_auth_required"`) {
				t.Fatalf("cancelled authorized transaction returned %d; want authentication failure", w.Code)
			}
		})
	}
}

// These damage fixtures use only newRig's private temporary SQLite database.
// They never touch a deployed database or engine.
func maintenanceFixtureExec(t *testing.T, db *sql.DB, query string) {
	t.Helper()
	if _, err := db.Exec(query); err != nil {
		t.Fatal(err)
	}
}

// Compare every schema entry and stored cell, including JSON whitespace and
// password hashes, without logging their contents on failure.
func maintenanceFixtureSnapshot(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	rows, err := db.Query(`SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	state := map[string]string{}
	tables := []string{}
	for rows.Next() {
		var name, kind string
		var ddl sql.NullString
		if err = rows.Scan(&name, &kind, &ddl); err != nil {
			t.Fatal(err)
		}
		state["schema/"+name] = kind + "/" + ddl.String
		if kind == "table" {
			tables = append(tables, name)
		}
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	for _, table := range tables {
		rows, err = db.Query(`SELECT * FROM "` + strings.ReplaceAll(table, `"`, `""`) + `" ORDER BY rowid`)
		if err != nil {
			t.Fatal(err)
		}
		columns, err := rows.Columns()
		if err != nil {
			t.Fatal(err)
		}
		var cells [][]any
		for rows.Next() {
			values := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err = rows.Scan(pointers...); err != nil {
				t.Fatal(err)
			}
			cells = append(cells, values)
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		encoded, err := json.Marshal(cells)
		if err != nil {
			t.Fatal(err)
		}
		state["rows/"+table] = string(encoded)
	}
	return state
}

func TestMaintenanceReviewMissingHistoryMustNotBecomeReady(t *testing.T) {
	r := newRig(t)
	r.setup()
	maintenancePause(t, r, "lost-history")
	if err := r.s.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := openTestDB(r.opts.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Seeding this evidence also makes the regression meaningful before the
	// marker exists in production code.
	maintenanceFixtureExec(t, db, `INSERT OR REPLACE INTO metadata(key,value) VALUES('store_maintenance_schema','v1')`)
	maintenanceFixtureExec(t, db, `DROP TABLE store_maintenance`)
	before := maintenanceFixtureSnapshot(t, db)
	s, err := New(r.opts)
	if err == nil {
		s.Close()
		t.Fatal("lost paused history was silently re-created as ready on restart")
	}
	if !errors.Is(err, errMaintenanceUnverified) || err.Error() != errMaintenanceUnverified.Error() {
		t.Fatal("startup did not return the fixed maintenance evidence error")
	}
	if !reflect.DeepEqual(before, maintenanceFixtureSnapshot(t, db)) {
		t.Fatal("failed startup modified retained data or rebuilt missing history")
	}
}

func TestMaintenanceStartupRejectsUnverifiableInitialization(t *testing.T) {
	for _, damage := range []string{"missing-marker", "unmarked-empty-table", "bad-marker", "disabled-marker", "missing-table", "schema", "null-body", "null-marker", "duplicate-marker", "blob-marker"} {
		t.Run(damage, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			maintenancePause(t, r, "retained")
			r.s.Close()
			db, err := openTestDB(r.opts.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			maintenanceFixtureExec(t, db, `INSERT OR REPLACE INTO metadata(key,value) VALUES('store_maintenance_schema','v1')`)
			switch damage {
			case "missing-marker":
				maintenanceFixtureExec(t, db, `DELETE FROM metadata WHERE key='store_maintenance_schema'`)
			case "unmarked-empty-table":
				maintenanceFixtureExec(t, db, `DELETE FROM metadata WHERE key='store_maintenance_schema'`)
				maintenanceFixtureExec(t, db, `DELETE FROM store_maintenance`)
			case "bad-marker":
				maintenanceFixtureExec(t, db, `UPDATE metadata SET value='synthetic-invalid-v2' WHERE key='store_maintenance_schema'`)
			case "disabled-marker":
				maintenanceFixtureExec(t, db, `UPDATE metadata SET value='disabled' WHERE key='store_maintenance_schema'`)
			case "missing-table":
				maintenanceFixtureExec(t, db, `DROP TABLE store_maintenance`)
			case "schema":
				maintenanceFixtureExec(t, db, `ALTER TABLE store_maintenance RENAME COLUMN status TO damaged`)
			case "null-body":
				maintenanceFixtureExec(t, db, `UPDATE store_maintenance SET body='null'`)
			case "null-marker":
				// Corrupt the fixture metadata definition so NULL is representable.
				maintenanceFixtureExec(t, db, `ALTER TABLE metadata RENAME TO retained_metadata`)
				maintenanceFixtureExec(t, db, `CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)`)
				maintenanceFixtureExec(t, db, `INSERT INTO metadata SELECT key,CASE WHEN key='store_maintenance_schema' THEN NULL ELSE value END FROM retained_metadata`)
			case "duplicate-marker":
				maintenanceFixtureExec(t, db, `ALTER TABLE metadata RENAME TO retained_metadata`)
				maintenanceFixtureExec(t, db, `CREATE TABLE metadata(key TEXT,value TEXT)`)
				maintenanceFixtureExec(t, db, `INSERT INTO metadata SELECT key,value FROM retained_metadata`)
				maintenanceFixtureExec(t, db, `INSERT INTO metadata(key,value) VALUES('store_maintenance_schema','v1')`)
			case "blob-marker":
				maintenanceFixtureExec(t, db, `UPDATE metadata SET value=CAST('v1' AS BLOB) WHERE key='store_maintenance_schema'`)
			}
			// Startup must refuse before its running-job recovery can rewrite
			// unrelated retained evidence.
			for _, table := range []string{"jobs", "runtime_jobs"} {
				j := Job{ID: randomID(), PlanID: randomID(), RequestID: "retained-" + table, Status: "running"}
				body, _ := json.Marshal(j)
				if _, err = db.Exec("INSERT INTO "+table+"(id,plan_id,request_id,status,body) VALUES(?,?,?,?,?)", j.ID, j.PlanID, j.RequestID, j.Status, string(body)); err != nil {
					t.Fatal(err)
				}
			}
			before := maintenanceFixtureSnapshot(t, db)
			s, err := New(r.opts)
			if err == nil {
				s.Close()
				t.Fatal("startup accepted unverified initialization")
			}
			if !errors.Is(err, errMaintenanceUnverified) || err.Error() != errMaintenanceUnverified.Error() {
				t.Fatal("startup exposed a nonfixed maintenance error")
			}
			if !reflect.DeepEqual(before, maintenanceFixtureSnapshot(t, db)) {
				t.Fatal("failed startup changed retained schema or cell contents")
			}
		})
	}
}

func TestMaintenanceMarkerIsRequiredAtRuntime(t *testing.T) {
	for _, value := range []string{"missing", "v2", "disabled", "V1", "v1 ", "null", "blob"} {
		t.Run(value, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			p := maintenancePause(t, r, "retain-marker")
			maintenanceFixtureExec(t, r.s.db, `INSERT OR REPLACE INTO metadata(key,value) VALUES('store_maintenance_schema','v1')`)
			if value == "missing" {
				maintenanceFixtureExec(t, r.s.db, `DELETE FROM metadata WHERE key='store_maintenance_schema'`)
			} else if value == "null" {
				maintenanceFixtureExec(t, r.s.db, `ALTER TABLE metadata RENAME TO retained_metadata`)
				maintenanceFixtureExec(t, r.s.db, `CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)`)
				maintenanceFixtureExec(t, r.s.db, `INSERT INTO metadata SELECT key,CASE WHEN key='store_maintenance_schema' THEN NULL ELSE value END FROM retained_metadata`)
			} else if value == "blob" {
				maintenanceFixtureExec(t, r.s.db, `UPDATE metadata SET value=CAST('v1' AS BLOB) WHERE key='store_maintenance_schema'`)
			} else if _, err := r.s.db.Exec(`UPDATE metadata SET value=? WHERE key='store_maintenance_schema'`, value); err != nil {
				t.Fatal(err)
			}
			before := maintenanceFixtureSnapshot(t, r.s.db)
			for _, pair := range [][3]string{{"GET", maintenanceURL, ""}, {"POST", maintenanceURL + "/quiesce", `{"requestId":"retain-marker"}`}, {"POST", maintenanceURL + "/" + p["id"].(string) + "/resume", `{}`}, {"POST", "/api/store/v2/settings", `{"theme":"dark","updateCheckHours":12,"updateCheckEnabled":false}`}} {
				out := maintenanceCall(t, r, pair[0], pair[1], pair[2], 503)
				if out["error"].(map[string]any)["code"] != "maintenance_unverified" {
					t.Fatal("runtime did not use the fixed maintenance error")
				}
			}
			if !reflect.DeepEqual(before, maintenanceFixtureSnapshot(t, r.s.db)) {
				t.Fatal("unverified runtime requests changed persisted evidence")
			}
		})
	}
}

func TestMaintenanceEmptyHistoryWithMissingMarkerCannotReportReady(t *testing.T) {
	r := newRig(t)
	r.setup()
	maintenanceFixtureExec(t, r.s.db, `DELETE FROM metadata WHERE key='store_maintenance_schema'`)
	maintenanceCall(t, r, "GET", maintenanceURL, "", 503)
	maintenanceCall(t, r, "POST", "/api/store/v2/settings", `{"theme":"dark","updateCheckHours":12,"updateCheckEnabled":false}`, 503)
}

func TestMaintenanceMigrationMarkerFailureRollsBackTable(t *testing.T) {
	r := newRig(t)
	r.setup()
	r.s.Close()
	db, err := openTestDB(r.opts.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	maintenanceFixtureExec(t, db, `DROP TABLE store_maintenance`)
	maintenanceFixtureExec(t, db, `DELETE FROM metadata WHERE key='store_maintenance_schema'`)
	maintenanceFixtureExec(t, db, `CREATE TRIGGER reject_maintenance_marker BEFORE INSERT ON metadata WHEN NEW.key='store_maintenance_schema' BEGIN SELECT RAISE(ABORT,'synthetic-marker-failure'); END`)
	before := maintenanceFixtureSnapshot(t, db)
	s, err := New(r.opts)
	if err == nil {
		s.Close()
		t.Fatal("startup ignored marker insertion failure")
	}
	if err.Error() != errMaintenanceUnverified.Error() {
		t.Fatal("migration leaked its raw failure")
	}
	if !reflect.DeepEqual(before, maintenanceFixtureSnapshot(t, db)) {
		t.Fatal("failed migration left a maintenance table without its marker")
	}
}

func TestMaintenanceMigrationValidationRollsBackTableAndMarker(t *testing.T) {
	r := newRig(t)
	r.setup()
	r.s.Close()
	db, err := openTestDB(r.opts.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	maintenanceFixtureExec(t, db, `DROP TABLE store_maintenance`)
	maintenanceFixtureExec(t, db, `DELETE FROM metadata WHERE key='store_maintenance_schema'`)
	// The marker INSERT succeeds, but an external fixture trigger introduces
	// invalid evidence before startup's final validation. Both new objects must
	// still roll back; the trigger and all earlier data must remain unchanged.
	maintenanceFixtureExec(t, db, `CREATE TRIGGER poison_maintenance_history AFTER INSERT ON metadata WHEN NEW.key='store_maintenance_schema' BEGIN INSERT INTO store_maintenance(id,request_id,status,body) VALUES('invalid','poison','quiesced','null'); END`)
	before := maintenanceFixtureSnapshot(t, db)
	s, err := New(r.opts)
	if err == nil {
		s.Close()
		t.Fatal("startup accepted invalid post-migration history")
	}
	if err.Error() != errMaintenanceUnverified.Error() {
		t.Fatal("migration validation leaked its raw failure")
	}
	if !reflect.DeepEqual(before, maintenanceFixtureSnapshot(t, db)) {
		t.Fatal("validation failure committed the history table or marker")
	}
}

func TestMaintenanceLegacyMigrationPreservesExistingData(t *testing.T) {
	r := newRig(t)
	r.setup()
	maintenanceCall(t, r, "POST", "/api/store/v2/settings", `{"theme":"dark","updateCheckHours":12,"updateCheckEnabled":false}`, 200)
	r.s.Close()
	db, err := openTestDB(r.opts.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, table := range []string{"jobs", "runtime_jobs"} {
		j := Job{ID: randomID(), PlanID: randomID(), RequestID: "old-" + table, Status: "failed"}
		body, _ := json.MarshalIndent(j, "", "  ")
		if _, err = db.Exec("INSERT INTO "+table+"(id,plan_id,request_id,status,body) VALUES(?,?,?,?,?)", j.ID, j.PlanID, j.RequestID, j.Status, string(body)); err != nil {
			t.Fatal(err)
		}
	}
	maintenanceFixtureExec(t, db, `INSERT OR REPLACE INTO metadata(key,value) VALUES('store_maintenance_schema','v1')`)
	expected := maintenanceFixtureSnapshot(t, db)
	// An actual legacy store has neither initialization marker nor history
	// table, while admin, sessions, settings and job evidence already exist.
	maintenanceFixtureExec(t, db, `DROP TABLE store_maintenance`)
	maintenanceFixtureExec(t, db, `DELETE FROM metadata WHERE key='store_maintenance_schema'`)
	s, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var version string
	if err = s.db.QueryRow(`SELECT value FROM metadata WHERE key='store_maintenance_schema'`).Scan(&version); err != nil || version != "v1" {
		t.Fatal("legacy migration did not initialize its durable v1 marker")
	}
	if !reflect.DeepEqual(expected, maintenanceFixtureSnapshot(t, s.db)) {
		t.Fatal("legacy migration changed pre-existing schema or stored cell contents")
	}
	r.s = s
	r.mux = http.NewServeMux()
	s.Register(r.mux)
	view := maintenanceCall(t, r, "GET", maintenanceURL, "", 200)["data"].(map[string]any)
	if view["state"] != "ready" {
		t.Fatal("valid legacy migration was not ready")
	}
	maintenancePause(t, r, "first-migrated-maintenance")
}

func maintenanceCall(t *testing.T, r *testRig, method, path, body string, want int) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Store-Session", r.token)
	r.mux.ServeHTTP(w, req)
	if w.Code != want {
		t.Fatalf("%s %s: got %d, want %d: %s", method, path, w.Code, want, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func maintenancePause(t *testing.T, r *testRig, request string) map[string]any {
	t.Helper()
	return maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"`+request+`"}`, 201)["data"].(map[string]any)
}
func TestMaintenanceIdleReplayResumeAndHistory(t *testing.T) {
	r := newRig(t)
	r.setup()
	maintenanceCall(t, r, "GET", maintenanceURL, "", 200)
	first := maintenancePause(t, r, "update-one")
	if first["purpose"] != "store-update" || first["status"] != "quiesced" {
		t.Fatal(first)
	}
	id := first["id"].(string)
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"update-one"}`, 200)
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"update-other"}`, 409)
	maintenanceCall(t, r, "POST", maintenanceURL+"/wrong/resume", `{}`, 409)
	maintenanceCall(t, r, "POST", maintenanceURL+"/"+id+"/resume", `{}`, 200)
	old := maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"update-one"}`, 200)["data"].(map[string]any)
	if old["status"] != "resumed" {
		t.Fatal(old)
	}
	view := maintenanceCall(t, r, "GET", maintenanceURL, "", 200)["data"].(map[string]any)
	if view["state"] != "ready" {
		t.Fatal(view)
	}
	second := maintenancePause(t, r, "update-two")
	maintenanceCall(t, r, "POST", maintenanceURL+"/"+id+"/resume", `{}`, 409)
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"update-one"}`, 200)
	view = maintenanceCall(t, r, "GET", maintenanceURL, "", 200)["data"].(map[string]any)
	if view["current"].(map[string]any)["id"] != second["id"] {
		t.Fatal(view)
	}
	var count int
	if err := r.s.db.QueryRow(`SELECT count(*) FROM store_maintenance`).Scan(&count); err != nil || count != 2 {
		t.Fatal(count, err)
	}
}
func TestMaintenanceAuthenticationAndStrictBodies(t *testing.T) {
	r := newRig(t)
	for _, pair := range [][3]string{{"GET", maintenanceURL, ""}, {"POST", maintenanceURL + "/quiesce", `{"requestId":"one"}`}, {"POST", maintenanceURL + "/one/resume", `{}`}} {
		maintenanceCall(t, r, pair[0], pair[1], pair[2], 401)
	}
	r.setup()
	for _, body := range []string{`null`, `[]`, `{}`, `{"requestId":""}`, `{"requestId":"../bad"}`, `{"requestId":12}`, `{"requestId":"ok","purpose":"other"}`, `{"requestId":"one"} {}`} {
		maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", body, 400)
	}
	p := maintenancePause(t, r, "valid")
	for _, body := range []string{`null`, `[]`, `{"confirm":true}`, `{} {}`} {
		maintenanceCall(t, r, "POST", maintenanceURL+"/"+p["id"].(string)+"/resume", body, 400)
	}
	if _, err := r.s.db.Exec(`UPDATE sessions SET expires_at=?`, time.Now().Unix()-1); err != nil {
		t.Fatal(err)
	}
	maintenanceCall(t, r, "GET", maintenanceURL, "", 401)
	maintenanceCall(t, r, "POST", maintenanceURL+"/"+p["id"].(string)+"/resume", `{}`, 401)
}
func TestMaintenanceBusyLocksDoNotWait(t *testing.T) {
	r := newRig(t)
	r.setup()
	r.s.operation.Lock()
	start := time.Now()
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"busy"}`, 409)
	r.s.operation.Unlock()
	if time.Since(start) > time.Second {
		t.Fatal("waited for operation")
	}
	r.s.mu.Lock()
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"busy"}`, 409)
	r.s.mu.Unlock()
}
func TestMaintenanceBlocksMutationsButReadsAndLoginRemain(t *testing.T) {
	r := newRig(t)
	r.setup()
	maintenancePause(t, r, "update")
	for _, pair := range [][3]string{{"POST", "/api/store/v2/settings", `{"theme":"dark","updateCheckHours":12,"updateCheckEnabled":false}`}, {"POST", "/api/store/v2/catalog/refresh", `{}`}, {"POST", "/api/store/v2/instances/reconcile", `{}`}, {"POST", "/api/store/instances/unknown/start", `{}`}, {"POST", "/api/store/instances/unknown/stop", `{}`}, {"POST", "/api/store/v2/execute", `{"planId":"unknown","requestId":"fresh"}`}, {"POST", "/api/store/v2/batches", `{"planIds":["unknown"],"requestId":"fresh"}`}} {
		out := maintenanceCall(t, r, pair[0], pair[1], pair[2], 423)
		if out["error"].(map[string]any)["code"] != "store_maintenance" {
			t.Fatal(out)
		}
	}
	for _, path := range []string{"/api/store/v2/settings", "/api/store/v2/catalog", "/api/store/jobs"} {
		maintenanceCall(t, r, "GET", path, "", 200)
	}
	maintenanceCall(t, r, "POST", "/api/store/login", `{"username":"synthetic-admin","password":"synthetic-pass-123"}`, 200)
}
func TestMaintenanceJobEvidenceMustBeExactlyTerminal(t *testing.T) {
	for _, table := range []string{"jobs", "runtime_jobs"} {
		for _, state := range []string{"queued", "running", "needs_attention", "unknown", "completed", "succeeded", "failed", "malformed", "status-drift", "id-drift", "plan-drift", "request-drift"} {
			t.Run(table+"/"+state, func(t *testing.T) {
				r := newRig(t)
				r.setup()
				r.s.cancel()
				r.s.wg.Wait()
				j := Job{ID: randomID(), PlanID: randomID(), RequestID: "prior", Status: state}
				terminal := state == "failed" || (table == "jobs" && state == "completed") || (table == "runtime_jobs" && state == "succeeded")
				columnState := state
				if strings.HasSuffix(state, "-drift") {
					j.Status = "failed"
					columnState = "failed"
				}
				if state == "status-drift" {
					j.Status = "running"
				}
				id, plan, request := j.ID, j.PlanID, j.RequestID
				if state == "id-drift" {
					j.ID = randomID()
				}
				if state == "plan-drift" {
					j.PlanID = randomID()
				}
				if state == "request-drift" {
					j.RequestID = "different"
				}
				b, _ := json.Marshal(j)
				if state == "malformed" {
					b = []byte(`{broken`)
				}
				if _, e := r.s.db.Exec("INSERT INTO "+table+"(id,plan_id,request_id,status,body) VALUES(?,?,?,?,?)", id, plan, request, columnState, string(b)); e != nil {
					t.Fatal(e)
				}
				want := 409
				if terminal {
					want = 201
				}
				maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"update"}`, want)
				var current string
				if e := r.s.db.QueryRow("SELECT body FROM "+table+" WHERE id=?", id).Scan(&current); e != nil || current != string(b) {
					t.Fatal("job changed", e)
				}
			})
		}
	}
}
func TestMaintenancePersistence(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := maintenancePause(t, r, "persist")
	r.s.Close()
	s, e := New(r.opts)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	r.s = s
	r.mux = http.NewServeMux()
	s.Register(r.mux)
	view := maintenanceCall(t, r, "GET", maintenanceURL, "", 200)["data"].(map[string]any)
	if view["state"] != "quiesced" || view["current"].(map[string]any)["id"] != p["id"] {
		t.Fatal(view)
	}
	maintenanceCall(t, r, "POST", maintenanceURL+"/"+p["id"].(string)+"/resume", `{}`, 200)
	var resumedBody string
	if e = s.db.QueryRow(`SELECT body FROM store_maintenance WHERE id=?`, p["id"]).Scan(&resumedBody); e != nil {
		t.Fatal(e)
	}
	s.Close()
	s, e = New(r.opts)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	r.s = s
	r.mux = http.NewServeMux()
	s.Register(r.mux)
	view = maintenanceCall(t, r, "GET", maintenanceURL, "", 200)["data"].(map[string]any)
	if view["state"] != "ready" {
		t.Fatal("resumed maintenance did not survive restart")
	}
	replay := maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"persist"}`, 200)["data"].(map[string]any)
	if replay["status"] != "resumed" || replay["id"] != p["id"] {
		t.Fatal("resumed history was not replayable after restart")
	}
	var after string
	if e = s.db.QueryRow(`SELECT body FROM store_maintenance WHERE id=?`, p["id"]).Scan(&after); e != nil || after != resumedBody {
		t.Fatal("restart modified resumed history contents")
	}
}

func TestMaintenanceCorruptEvidenceFailsClosed(t *testing.T) {
	for _, corruption := range []string{"body", "id", "request", "status", "purpose", "created", "resumed", "multiple", "schema"} {
		t.Run(corruption, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			p := maintenancePause(t, r, "update")
			id := p["id"].(string)
			switch corruption {
			case "schema":
				_, _ = r.s.db.Exec(`ALTER TABLE store_maintenance RENAME COLUMN status TO damaged`)
			case "multiple":
				p["id"] = randomID()
				p["requestId"] = "other"
				b, _ := json.Marshal(p)
				_, _ = r.s.db.Exec(`INSERT INTO store_maintenance(id,request_id,status,body)VALUES(?,?,'quiesced',?)`, p["id"], p["requestId"], string(b))
			case "body":
				_, _ = r.s.db.Exec(`UPDATE store_maintenance SET body='null'`)
			default:
				key := map[string]string{"id": "id", "request": "requestId", "status": "status", "purpose": "purpose", "created": "createdAt", "resumed": "resumedAt"}[corruption]
				p[key] = "invalid"
				b, _ := json.Marshal(p)
				_, _ = r.s.db.Exec(`UPDATE store_maintenance SET body=?`, string(b))
			}
			for _, pair := range [][3]string{{"GET", maintenanceURL, ""}, {"POST", maintenanceURL + "/quiesce", `{"requestId":"new"}`}, {"POST", maintenanceURL + "/" + id + "/resume", `{}`}, {"POST", "/api/store/v2/settings", `{"theme":"dark","updateCheckHours":12,"updateCheckEnabled":false}`}} {
				out := maintenanceCall(t, r, pair[0], pair[1], pair[2], 503)
				if out["error"].(map[string]any)["code"] != "maintenance_unverified" {
					t.Fatal(out)
				}
			}
		})
	}
}
func TestMaintenanceWorkersRetainQueuedAndReplayStillReadable(t *testing.T) {
	r := newRig(t)
	r.setup()
	r.s.cancel()
	r.s.wg.Wait()
	r.s.ctx = context.Background()
	maintenancePause(t, r, "update")
	for _, table := range []string{"jobs", "runtime_jobs"} {
		j := Job{ID: randomID(), PlanID: randomID(), RequestID: "retained-" + table, Status: "queued"}
		b, _ := json.Marshal(j)
		if _, e := r.s.db.Exec("INSERT INTO "+table+"(id,plan_id,request_id,status,body)VALUES(?,?,?,?,?)", j.ID, j.PlanID, j.RequestID, j.Status, string(b)); e != nil {
			t.Fatal(e)
		}
		if table == "jobs" {
			r.s.execute(j)
		} else {
			r.s.runtimeRun(runtimeJob{Job: j})
		}
		var after string
		if e := r.s.db.QueryRow("SELECT body FROM "+table+" WHERE id=?", j.ID).Scan(&after); e != nil || after != string(b) {
			t.Fatal("queued job mutated", e)
		}
		path := "/api/store/install"
		if table == "runtime_jobs" {
			path = "/api/store/v2/execute"
		}
		maintenanceCall(t, r, "POST", path, `{"planId":"`+j.PlanID+`","requestId":"`+j.RequestID+`"}`, 202)
	}
	r.s.runtimeScheduledCheck()
	select {
	case <-r.s.runtimeRefreshWake:
		t.Fatal("scheduled check bypassed maintenance")
	default:
	}
}

func TestMaintenanceRejectsAmbiguousRequestAndHistory(t *testing.T) {
	r := newRig(t)
	r.setup()
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"first","requestId":"second"}`, 400)
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"first","RequestId":"second"}`, 400)
	p := maintenancePause(t, r, "once")
	b, _ := json.Marshal(p)
	malformed := strings.Replace(string(b), `"purpose":"store-update"`, `"purpose":"store-update","purpose":"store-update"`, 1)
	if _, e := r.s.db.Exec(`UPDATE store_maintenance SET body=?`, malformed); e != nil {
		t.Fatal(e)
	}
	maintenanceCall(t, r, "GET", maintenanceURL, "", 503)
}

func TestMaintenanceQuiesceAndAdmissionAreSerialized(t *testing.T) {
	for _, kind := range []string{"legacy", "runtime"} {
		t.Run(kind, func(t *testing.T) {
			for n := 0; n < 12; n++ {
				t.Run(fmt.Sprint(n), func(t *testing.T) {
					r, _ := controllerRig(t)
					r.s.cancel()
					r.s.wg.Wait()
					path := "/api/store/install"
					var planID string
					if kind == "legacy" {
						planID = r.plan("uptime-kuma", "race", "")["id"].(string)
					} else {
						path = "/api/store/v2/execute"
						planID = controllerPlan(t, r, `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"race","hostPort":32301}`).ID
					}
					entered := make(chan struct{})
					type result struct {
						name string
						code int
						body string
					}
					out := make(chan result, 2)
					for _, input := range [][3]string{{"pause", maintenanceURL + "/quiesce", `{"requestId":"update"}`}, {"admit", path, `{"planId":"` + planID + `","requestId":"race"}`}} {
						go func(input [3]string) {
							<-entered
							w := httptest.NewRecorder()
							req := httptest.NewRequest("POST", input[1], strings.NewReader(input[2]))
							req.Header.Set("X-Store-Session", r.token)
							r.mux.ServeHTTP(w, req)
							out <- result{input[0], w.Code, w.Body.String()}
						}(input)
					}
					close(entered)
					results := map[string]result{}
					for i := 0; i < 2; i++ {
						select {
						case result := <-out:
							results[result.name] = result
						case <-time.After(3 * time.Second):
							t.Fatal("admission deadlocked")
						}
					}
					pause, admit := results["pause"], results["admit"]
					if !((pause.code == 201 && admit.code == 423) || (pause.code == 409 && admit.code == 202)) {
						t.Fatalf("pause/admit violated serialization: %v / %v", pause, admit)
					}
				})
			}
		})
	}
}

func TestMaintenanceRevocationDuringBodyCannotPauseOrResume(t *testing.T) {
	for _, source := range []string{"ordinary", "nas"} {
		for _, action := range []string{"quiesce", "resume"} {
			for _, cause := range []string{"logout", "expire", "cancel"} {
				t.Run(source+"/"+action+"/"+cause, func(t *testing.T) {
					var r *testRig
					if source == "ordinary" {
						r = newRig(t)
						r.setup()
					} else {
						r, _ = nasMutationRig(t)
					}
					path := maintenanceURL + "/quiesce"
					payload := `{"requestId":"delayed"}`
					if action == "resume" {
						p := maintenancePause(t, r, "before")
						path = maintenanceURL + "/" + p["id"].(string) + "/resume"
						payload = `{}`
					}
					body := &delayedNASBody{Reader: strings.NewReader(payload), entered: make(chan struct{}), release: make(chan struct{})}
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					req := httptest.NewRequest("POST", path, body).WithContext(ctx)
					req.Header.Set("X-Store-Session", r.token)
					w := httptest.NewRecorder()
					done := make(chan struct{})
					go func() { r.mux.ServeHTTP(w, req); close(done) }()
					select {
					case <-body.entered:
					case <-time.After(2 * time.Second):
						t.Fatal("body not reached")
					}
					switch cause {
					case "logout":
						maintenanceCall(t, r, "POST", "/api/store/logout", `{}`, 200)
					case "cancel":
						cancel()
					case "expire":
						if source == "ordinary" {
							if _, e := r.s.db.Exec(`UPDATE sessions SET expires_at=?`, time.Now().Unix()-1); e != nil {
								t.Fatal(e)
							}
						} else {
							r.s.nasMu.Lock()
							r.s.nasSessions[tokenHash(r.token)].expiresAt = time.Now().Add(-time.Second)
							r.s.nasMu.Unlock()
						}
					}
					close(body.release)
					select {
					case <-done:
					case <-time.After(3 * time.Second):
						t.Fatal("revoked request deadlocked")
					}
					if w.Code != 401 {
						t.Fatalf("revocation returned %d: %s", w.Code, w.Body.String())
					}
					var count int
					var status string
					if e := r.s.db.QueryRow(`SELECT count(*) FROM store_maintenance`).Scan(&count); e != nil {
						t.Fatal(e)
					}
					if action == "quiesce" && count != 0 {
						t.Fatal("unauthorized pause persisted")
					}
					if action == "resume" {
						if e := r.s.db.QueryRow(`SELECT status FROM store_maintenance`).Scan(&status); e != nil || status != "quiesced" {
							t.Fatal("unauthorized resume", e)
						}
					}
				})
			}
		}
	}
}

func TestMaintenanceSchemaCannotInferReady(t *testing.T) {
	for _, ddl := range []string{
		`CREATE TABLE store_maintenance(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL)`,
		`CREATE TABLE store_maintenance(id TEXT,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL)`,
		`CREATE TABLE store_maintenance(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,status INTEGER NOT NULL,body TEXT NOT NULL)`,
		`CREATE TABLE store_maintenance(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL)`,
	} {
		t.Run(ddl, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			if _, e := r.s.db.Exec(`ALTER TABLE store_maintenance RENAME TO retained_maintenance`); e != nil {
				t.Fatal(e)
			}
			if _, e := r.s.db.Exec(ddl); e != nil {
				t.Fatal(e)
			}
			maintenanceCall(t, r, "GET", maintenanceURL, "", 503)
			maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"unsafe"}`, 503)
		})
	}
}
func TestMaintenanceLegacyPlanAndRootsCannotWriteAheadOfGate(t *testing.T) {
	r := newRig(t)
	r.setup()
	maintenancePause(t, r, "update")
	var original string
	if e := r.s.db.QueryRow(`SELECT body FROM storage_roots WHERE id='storage'`).Scan(&original); e != nil {
		t.Fatal(e)
	}
	body, _ := json.Marshal(map[string]any{"path": r.root, "name": "new name"})
	maintenanceCall(t, r, "POST", "/api/store/roots", string(body), 423)
	body, _ = json.Marshal(map[string]any{"appId": "uptime-kuma", "rootId": "storage", "directory": "old-plan", "hostPort": 32123})
	maintenanceCall(t, r, "POST", "/api/store/plans", string(body), 423)
	var current string
	if e := r.s.db.QueryRow(`SELECT body FROM storage_roots WHERE id='storage'`).Scan(&current); e != nil || original != current {
		t.Fatal("root was updated before gate", e)
	}
	var plans int
	if e := r.s.db.QueryRow(`SELECT count(*) FROM plans`).Scan(&plans); e != nil || plans != 0 {
		t.Fatal("legacy plan created", e)
	}
}
func TestMaintenanceCatalogCannotStartBackgroundReadsWhilePaused(t *testing.T) {
	r := newRig(t)
	r.setup()
	r.s.cancel()
	r.s.wg.Wait()
	r.s.ctx = context.Background()
	maintenancePause(t, r, "update")
	started := time.Now()
	r.s.runtimeScheduledCheck()
	r.s.runtimeFetchCatalog(context.Background())
	if time.Since(started) > time.Second {
		t.Fatal("background catalog was not blocked before network")
	}
	var count int
	if e := r.s.db.QueryRow(`SELECT count(*) FROM runtime_catalog`).Scan(&count); e != nil || count != 0 {
		t.Fatal("catalog changed", e)
	}
}

func TestMaintenanceHistoricalReplayNeverWaitsForEngineLocks(t *testing.T) {
	r := newRig(t)
	r.setup()
	p := maintenancePause(t, r, "historical")
	id := p["id"].(string)
	maintenanceCall(t, r, "POST", maintenanceURL+"/"+id+"/resume", `{}`, 200)
	r.s.operation.Lock()
	r.s.mu.Lock()
	defer r.s.operation.Unlock()
	defer r.s.mu.Unlock()
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"historical"}`, 200)
	maintenanceCall(t, r, "POST", maintenanceURL+"/"+id+"/resume", `{}`, 200)
	maintenanceCall(t, r, "POST", maintenanceURL+"/quiesce", `{"requestId":"new"}`, 409)
}

func TestMaintenanceLegacyReadRetainsInstanceEvidence(t *testing.T) {
	for _, state := range []string{"quiesced", "unverified"} {
		t.Run(state, func(t *testing.T) {
			r := newRig(t)
			r.setup()
			i := Instance{ID: randomID(), DataPath: r.root + "/retained", HostPort: 32355, ContainerName: "retained", State: "running", Provenance: PathProvenance{Marker: "retained-proof"}}
			b, _ := json.Marshal(i)
			if _, e := r.s.db.Exec(`INSERT INTO instances(id,data_path,port,body)VALUES(?,?,?,?)`, i.ID, i.DataPath, i.HostPort, string(b)); e != nil {
				t.Fatal(e)
			}
			maintenancePause(t, r, "update")
			if state == "unverified" {
				if _, e := r.s.db.Exec(`UPDATE store_maintenance SET body='broken'`); e != nil {
					t.Fatal(e)
				}
			}
			maintenanceCall(t, r, "GET", "/api/store/instances", "", 200)
			var after string
			if e := r.s.db.QueryRow(`SELECT body FROM instances WHERE id=?`, i.ID).Scan(&after); e != nil || after != string(b) {
				t.Fatal("read changed retained instance", e)
			}
		})
	}
}

func TestMaintenanceFinalAuthorizationRollsBack(t *testing.T) {
	for _, source := range []string{"ordinary", "nas"} {
		t.Run(source, func(t *testing.T) {
			var r *testRig
			if source == "ordinary" {
				r = newRig(t)
				r.setup()
			} else {
				r, _ = nasMutationRig(t)
			}
			w := httptest.NewRecorder()
			req := httptest.NewRequest("POST", maintenanceURL+"/quiesce", nil)
			req.Header.Set("X-Store-Session", r.token)
			r.s.auth(func(w http.ResponseWriter, req *http.Request) {
				r.s.runtimeAuthTransaction(w, req, func(tx *sql.Tx) error {
					p := maintenanceRecord{ID: randomID(), RequestID: "final-fence", Purpose: "store-update", Status: "quiesced", CreatedAt: time.Now().UTC()}
					b, _ := json.Marshal(p)
					if _, e := tx.Exec(`INSERT INTO store_maintenance(id,request_id,status,body)VALUES(?,?,?,?)`, p.ID, p.RequestID, p.Status, string(b)); e != nil {
						return e
					}
					if source == "ordinary" {
						_, e := tx.Exec(`UPDATE sessions SET expires_at=0`)
						return e
					}
					grant := req.Context().Value(nasGrantKey{}).(nasRequestGrant)
					r.s.nasMu.Lock()
					delete(r.s.nasSessions, grant.hash)
					grant.entry.cancel()
					r.s.nasMu.Unlock()
					return nil
				})
			})(w, req)
			if w.Code != 401 {
				t.Fatalf("final fence returned %d: %s", w.Code, w.Body.String())
			}
			var count int
			if e := r.s.db.QueryRow(`SELECT count(*) FROM store_maintenance`).Scan(&count); e != nil || count != 0 {
				t.Fatal("unauthorized transaction committed", e)
			}
		})
	}
}

func TestMaintenanceNASVerificationRunsOutsideDatabaseAndGrantLocks(t *testing.T) {
	var rig *testRig
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if rig != nil {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			var value int
			if e := rig.s.db.QueryRowContext(ctx, `SELECT 1`).Scan(&value); e != nil {
				t.Error("provider called while SQL connection held", e)
			}
			if !rig.s.nasMu.TryLock() {
				t.Error("provider called with grant mutex held")
			} else {
				rig.s.nasMu.Unlock()
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"username": "u", "is_master": true}})
	}))
	defer up.Close()
	rig = nasRig(t, up.URL)
	code, out := exchange(rig, nil)
	if code != 200 {
		t.Fatal(code)
	}
	rig.token = out["data"].(map[string]any)["sessionId"].(string)
	p := maintenancePause(t, rig, "provider")
	maintenanceCall(t, rig, "GET", maintenanceURL, "", 200)
	maintenanceCall(t, rig, "POST", "/api/store/v2/instances/reconcile", `{}`, 423)
	maintenanceCall(t, rig, "POST", maintenanceURL+"/"+p["id"].(string)+"/resume", `{}`, 200)
}

func TestMaintenanceEngineProofRunsOutsideTransaction(t *testing.T) {
	r, e := controllerRig(t)
	e.resolveHook = func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		var value int
		if err := r.s.db.QueryRowContext(ctx, `SELECT 1`).Scan(&value); err != nil {
			t.Fatal("engine proof held SQL connection", err)
		}
		if !r.s.nasMu.TryLock() {
			t.Fatal("engine proof held grant mutex")
		}
		r.s.nasMu.Unlock()
		// Pause during an in-flight readonly engine proof. Its final admission must
		// refuse the plan instead of updating metadata after maintenance committed.
		maintenancePause(t, r, "while-proof")
	}
	maintenanceCall(t, r, "POST", "/api/store/v2/plans", `{"kind":"install","appId":"uptime-kuma","rootId":"storage","directory":"proof","hostPort":32301}`, 423)
	var count int
	if err := r.s.db.QueryRow(`SELECT count(*) FROM runtime_plans`).Scan(&count); err != nil || count != 0 {
		t.Fatal("plan survived maintenance", err)
	}
}
