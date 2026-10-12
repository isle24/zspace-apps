package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

var errStoreMaintenance = errors.New("store is quiesced")
var errMaintenanceUnverified = errors.New("maintenance evidence cannot be verified")
var errMaintenanceBusy = errors.New("store maintenance conflicts with active operations or retained jobs")

const maintenanceSchemaKey = "store_maintenance_schema"
const maintenanceSchemaVersion = "v1"

// Absence is useful only to the startup migration. A present marker must be
// exactly one text v1 row; unreadable, NULL or unsupported values are evidence
// failures and must never be interpreted as an older store.
func maintenanceMarker(db runtimeQuerier) (bool, error) {
	rows, err := db.QueryContext(context.Background(), `SELECT key,value,typeof(value) FROM metadata WHERE key=?`, maintenanceSchemaKey)
	if err != nil {
		return false, errMaintenanceUnverified
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		var key, value, kind string
		if rows.Scan(&key, &value, &kind) != nil || found || key != maintenanceSchemaKey || value != maintenanceSchemaVersion || kind != "text" {
			return false, errMaintenanceUnverified
		}
		found = true
	}
	if rows.Err() != nil {
		return false, errMaintenanceUnverified
	}
	return found, nil
}

// The durable marker distinguishes a genuine legacy store from lost history.
// Create the table and marker in one transaction; never adopt an unmarked table
// or repair existing evidence. Validate before any workers or job recovery run.
func initMaintenanceSchema(db *sql.DB) error {
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return errMaintenanceUnverified
	}
	defer tx.Rollback()
	found, err := maintenanceMarker(tx)
	if err != nil {
		return err
	}
	if !found {
		var existing int
		if tx.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE name=? COLLATE NOCASE`, "store_maintenance").Scan(&existing) != nil || existing != 0 {
			return errMaintenanceUnverified
		}
		if _, err = tx.Exec(`CREATE TABLE store_maintenance(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,body TEXT NOT NULL)`); err != nil {
			return errMaintenanceUnverified
		}
		if _, err = tx.Exec(`INSERT INTO metadata(key,value) VALUES(?,?)`, maintenanceSchemaKey, maintenanceSchemaVersion); err != nil {
			return errMaintenanceUnverified
		}
	}
	if _, _, err = maintenanceRead(tx); err != nil {
		return err
	}
	if tx.Commit() != nil {
		return errMaintenanceUnverified
	}
	return nil
}

type maintenanceRecord struct {
	ID        string     `json:"id"`
	RequestID string     `json:"requestId"`
	Purpose   string     `json:"purpose"`
	Status    string     `json:"status"`
	CreatedAt time.Time  `json:"createdAt"`
	ResumedAt *time.Time `json:"resumedAt,omitempty"`
}
type maintenanceView struct {
	State   string             `json:"state"`
	Current *maintenanceRecord `json:"current,omitempty"`
}

func maintenanceID(id string) bool {
	b, e := hex.DecodeString(id)
	return e == nil && len(b) == 24 && len(id) == 48
}

// A pre-existing table with missing keys or changed column types is not the
// migration-created history table, even when it currently contains zero rows.
func maintenanceSchema(db runtimeQuerier) error {
	if found, err := maintenanceMarker(db); err != nil || !found {
		return errMaintenanceUnverified
	}
	rows, e := db.QueryContext(context.Background(), `PRAGMA table_info(store_maintenance)`)
	if e != nil {
		return errMaintenanceUnverified
	}
	expected := []string{"id", "request_id", "status", "body"}
	n := 0
	valid := true
	for rows.Next() {
		var cid, notnull, pk int
		var name, kind string
		var defaultValue sql.NullString
		if rows.Scan(&cid, &name, &kind, &notnull, &defaultValue, &pk) != nil || n >= len(expected) {
			valid = false
			break
		}
		wantPK, wantNotNull := 0, 1
		if n == 0 {
			wantPK, wantNotNull = 1, 0
		}
		if cid != n || name != expected[n] || kind != "TEXT" || notnull != wantNotNull || pk != wantPK || defaultValue.Valid {
			valid = false
			break
		}
		n++
	}
	if rows.Err() != nil {
		valid = false
	}
	rows.Close()
	if !valid || n != len(expected) {
		return errMaintenanceUnverified
	}
	var unique int
	e = db.QueryRowContext(context.Background(), `SELECT count(*) FROM pragma_index_list('store_maintenance') AS i WHERE i."unique"=1 AND i.partial=0 AND (SELECT count(*) FROM pragma_index_info(i.name))=1 AND (SELECT name FROM pragma_index_info(i.name) LIMIT 1)='request_id'`).Scan(&unique)
	if e != nil || unique < 1 {
		return errMaintenanceUnverified
	}
	return nil
}

// Every retained row is evidence. Never infer ready from an unreadable row or
// discard malformed history; column/body disagreement is an unsafe state too.
func maintenanceRead(db runtimeQuerier) ([]maintenanceRecord, maintenanceView, error) {
	view := maintenanceView{State: "ready"}
	if e := maintenanceSchema(db); e != nil {
		return nil, view, e
	}
	rows, e := db.QueryContext(context.Background(), `SELECT id,request_id,status,body FROM store_maintenance ORDER BY rowid`)
	if e != nil {
		return nil, view, errMaintenanceUnverified
	}
	defer rows.Close()
	records := []maintenanceRecord{}
	seenIDs, seenRequests := map[string]bool{}, map[string]bool{}
	for rows.Next() {
		var id, request, status, body string
		var record maintenanceRecord
		if rows.Scan(&id, &request, &status, &body) != nil {
			return nil, view, errMaintenanceUnverified
		}
		d := json.NewDecoder(bytes.NewBufferString(body))
		d.DisallowUnknownFields()
		if !uniqueNASJSON([]byte(body)) || d.Decode(&record) != nil || d.Decode(&struct{}{}) != io.EOF || !maintenanceID(id) || !segmentRE.MatchString(request) || id != record.ID || request != record.RequestID || status != record.Status || record.Purpose != "store-update" || record.CreatedAt.IsZero() {
			return nil, view, errMaintenanceUnverified
		}
		if seenIDs[id] || seenRequests[request] {
			return nil, view, errMaintenanceUnverified
		}
		seenIDs[id] = true
		seenRequests[request] = true
		switch status {
		case "quiesced":
			if record.ResumedAt != nil || view.Current != nil {
				return nil, view, errMaintenanceUnverified
			}
			copy := record
			view.State = "quiesced"
			view.Current = &copy
		case "resumed":
			if record.ResumedAt == nil || record.ResumedAt.IsZero() || record.ResumedAt.Before(record.CreatedAt) {
				return nil, view, errMaintenanceUnverified
			}
		default:
			return nil, view, errMaintenanceUnverified
		}
		records = append(records, record)
	}
	if rows.Err() != nil {
		return nil, view, errMaintenanceUnverified
	}
	return records, view, nil
}
func maintenanceReady(db runtimeQuerier) error {
	_, view, e := maintenanceRead(db)
	if e != nil {
		return e
	}
	if view.State != "ready" {
		return errStoreMaintenance
	}
	return nil
}
func maintenanceFailure(w http.ResponseWriter, e error) bool {
	switch {
	case errors.Is(e, errStoreMaintenance):
		fail(w, 423, "store_maintenance", "商店已暂停接收新操作；应用保持运行。")
	case errors.Is(e, errMaintenanceUnverified):
		fail(w, 503, "maintenance_unverified", "无法核验维护记录，拒绝接收操作。")
	case errors.Is(e, errStoreUpdateInProgress):
		fail(w, 409, "store_update_in_progress", "商店更新正在进行，请保留维护状态并稍后重试。")
	case errors.Is(e, errMaintenanceBusy):
		fail(w, 409, "maintenance_busy", "已有维护或任务尚未确认空闲，请保留记录并稍后核对。")
	default:
		return false
	}
	return true
}
func (s *Service) requestMaintenanceReady(w http.ResponseWriter, r *http.Request) bool {
	return s.runtimeMutation(w, r, func(*sql.Tx) error { return nil })
}
func (s *Service) maintenanceGet(w http.ResponseWriter, r *http.Request) {
	var view maintenanceView
	if s.runtimeAuthTransaction(w, r, func(tx *sql.Tx) error { var e error; _, view, e = maintenanceRead(tx); return e }) {
		s.runtimeRespond(w, r, 200, view)
	}
}

// Use a map to reject null and non-object bodies; the ordinary strict decoder
// rejects extra fields/trailing objects after these exact keys are checked.
func maintenanceBody(w http.ResponseWriter, r *http.Request, quiesce bool) (string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	body, e := io.ReadAll(r.Body)
	var object map[string]json.RawMessage
	if e != nil || !uniqueNASJSON(body) || json.Unmarshal(body, &object) != nil {
		fail(w, 400, "invalid_request", "请求格式无效或包含不允许的字段。")
		return "", false
	}
	var request string
	valid := object != nil
	if quiesce {
		valid = valid && len(object) == 1 && json.Unmarshal(object["requestId"], &request) == nil && segmentRE.MatchString(request)
	} else {
		valid = valid && len(object) == 0
	}
	if !valid {
		fail(w, 400, "invalid_request", "请提供明确的维护请求标识或空恢复对象。")
		return "", false
	}
	return request, true
}
func (s *Service) maintenanceLocks(w http.ResponseWriter, r *http.Request) bool {
	if !s.requestAuthorized(w, r) {
		return false
	}
	if !s.operation.TryLock() {
		maintenanceFailure(w, errMaintenanceBusy)
		return false
	}
	if !s.mu.TryLock() {
		s.operation.Unlock()
		maintenanceFailure(w, errMaintenanceBusy)
		return false
	}
	if !s.requestAuthorized(w, r) {
		s.mu.Unlock()
		s.operation.Unlock()
		return false
	}
	return true
}
func maintenanceIdle(db runtimeQuerier) error {
	for _, table := range []string{"jobs", "runtime_jobs"} {
		rows, e := db.QueryContext(context.Background(), "SELECT id,plan_id,request_id,status,body FROM "+table)
		if e != nil {
			return errMaintenanceBusy
		}
		idle := true
		for rows.Next() {
			var id, plan, request, status, body string
			var job Job
			if rows.Scan(&id, &plan, &request, &status, &body) != nil || !uniqueNASJSON([]byte(body)) || json.Unmarshal([]byte(body), &job) != nil || id != job.ID || plan != job.PlanID || request != job.RequestID || status != job.Status || !maintenanceID(id) || !maintenanceID(plan) || request == "" || !(status == "failed" || (table == "jobs" && status == "completed") || (table == "runtime_jobs" && status == "succeeded")) {
				idle = false
				break
			}
		}
		if rows.Err() != nil {
			idle = false
		}
		rows.Close()
		if !idle {
			return errMaintenanceBusy
		}
	}
	return nil
}
func (s *Service) maintenanceQuiesce(w http.ResponseWriter, r *http.Request) {
	request, ok := maintenanceBody(w, r, true)
	if !ok {
		return
	}
	// Historical replay is an authorized read, including while an unrelated
	// engine operation is in flight. Recheck again under locks for fresh writes.
	var replay *maintenanceRecord
	if !s.runtimeAuthTransaction(w, r, func(tx *sql.Tx) error {
		records, _, e := maintenanceRead(tx)
		if e != nil {
			return e
		}
		for _, old := range records {
			if old.RequestID == request {
				copy := old
				replay = &copy
				break
			}
		}
		return nil
	}) {
		return
	}
	if replay != nil {
		s.runtimeRespond(w, r, 200, *replay)
		return
	}
	if !s.requestAuthorized(w, r) {
		return
	}
	release, e := s.controllerLocks.MaintenanceChange()
	if e != nil {
		if s.requestAuthorized(w, r) {
			maintenanceFailure(w, e)
		}
		return
	}
	defer release()
	if !s.maintenanceLocks(w, r) {
		return
	}
	defer s.operation.Unlock()
	defer s.mu.Unlock()
	var record maintenanceRecord
	status := 201
	if s.runtimeAuthTransaction(w, r, func(tx *sql.Tx) error {
		records, view, e := maintenanceRead(tx)
		if e != nil {
			return e
		}
		for _, old := range records {
			if old.RequestID == request {
				record = old
				status = 200
				return nil
			}
		}
		if view.Current != nil {
			return errMaintenanceBusy
		}
		if e = maintenanceIdle(tx); e != nil {
			return e
		}
		record = maintenanceRecord{ID: randomID(), RequestID: request, Purpose: "store-update", Status: "quiesced", CreatedAt: time.Now().UTC()}
		b, e := json.Marshal(record)
		if e != nil {
			return e
		}
		_, e = tx.ExecContext(r.Context(), `INSERT INTO store_maintenance(id,request_id,status,body)VALUES(?,?,?,?)`, record.ID, record.RequestID, record.Status, string(b))
		return e
	}) {
		s.runtimeRespond(w, r, status, record)
	}
}
func (s *Service) maintenanceResume(w http.ResponseWriter, r *http.Request) {
	if _, ok := maintenanceBody(w, r, false); !ok {
		return
	}
	var replay *maintenanceRecord
	if !s.runtimeAuthTransaction(w, r, func(tx *sql.Tx) error {
		records, view, e := maintenanceRead(tx)
		if e != nil {
			return e
		}
		id := r.PathValue("id")
		if view.Current != nil {
			if view.Current.ID != id {
				return errMaintenanceBusy
			}
			return nil
		}
		for _, old := range records {
			if old.ID == id && old.Status == "resumed" {
				copy := old
				replay = &copy
				return nil
			}
		}
		return errMaintenanceBusy
	}) {
		return
	}
	if replay != nil {
		s.runtimeRespond(w, r, 200, *replay)
		return
	}
	if !s.requestAuthorized(w, r) {
		return
	}
	release, e := s.controllerLocks.MaintenanceChange()
	if e != nil {
		if s.requestAuthorized(w, r) {
			maintenanceFailure(w, e)
		}
		return
	}
	defer release()
	if !s.maintenanceLocks(w, r) {
		return
	}
	defer s.operation.Unlock()
	defer s.mu.Unlock()
	var record maintenanceRecord
	if s.runtimeAuthTransaction(w, r, func(tx *sql.Tx) error {
		records, view, e := maintenanceRead(tx)
		if e != nil {
			return e
		}
		id := r.PathValue("id")
		if view.Current != nil && view.Current.ID != id {
			return errMaintenanceBusy
		}
		for _, old := range records {
			if old.ID != id {
				continue
			}
			record = old
			if old.Status == "resumed" {
				return nil
			}
			now := time.Now().UTC()
			record.Status = "resumed"
			record.ResumedAt = &now
			b, e := json.Marshal(record)
			if e != nil {
				return e
			}
			_, e = tx.ExecContext(r.Context(), `UPDATE store_maintenance SET status=?,body=? WHERE id=? AND status='quiesced'`, record.Status, string(b), record.ID)
			return e
		}
		return errMaintenanceBusy
	}) {
		s.notify()
		s.runtimeRespond(w, r, 200, record)
	}
}
