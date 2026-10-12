package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

func (s *Service) runtimeSaveJob(j runtimeJob) error {
	b, e := json.Marshal(j)
	if e != nil {
		return e
	}
	_, e = s.db.Exec(`UPDATE runtime_jobs SET status=?,body=? WHERE id=?`, j.Status, string(b), j.ID)
	return e
}
func (s *Service) runtimeStage(j *runtimeJob, stage, status string) error {
	j.Stage = stage
	j.Status = status
	j.UpdatedAt = time.Now().UTC()
	j.Stages = append(j.Stages, Stage{Name: stage, Status: status, At: j.UpdatedAt})
	return s.runtimeSaveJob(*j)
}
func (s *Service) runtimeWorker() {
	defer s.wg.Done()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	checks := time.NewTicker(time.Minute)
	defer checks.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-checks.C:
			s.runtimeScheduledCheck()
		case <-ticker.C:
			jobs, e := runtimeRead[runtimeJob](s.db, "runtime_jobs")
			if e != nil {
				continue
			}
			for _, j := range jobs {
				if j.Status == "queued" {
					s.runtimeRun(j)
					if s.ctx.Err() != nil {
						return
					}
				}
			}
		}
	}
}
func (s *Service) runtimeCheckStorage(ctx context.Context, p RuntimePlan) error {
	inspector, ok := s.engine.(storageInspector)
	if !ok {
		return runtimeFailure
	}
	v, e := inspector.InspectStorage(ctx, p.RootPath)
	if e != nil || !safeDataStorage(v) || v.Identity != p.StorageIdentity || v.FreeBytes < 1<<30 {
		return runtimeFailure
	}
	d, e := inspector.DockerStorage(ctx)
	if e != nil || !safeDockerStorage(d) || d.Identity != p.DockerStorageIdentity || d.FreeBytes < 2<<30 {
		return runtimeFailure
	}
	if p.MediaPath != "" {
		v, e = inspector.InspectStorage(ctx, p.MediaRootPath)
		if e != nil || !safeMediaStorage(v) || v.Identity != p.MediaStorageIdentity {
			return runtimeFailure
		}
		if e = s.engine.ValidatePath(ctx, p.MediaRootPath, p.MediaPath, false); e != nil {
			return e
		}
	}
	return nil
}
func (s *Service) runtimeRun(j runtimeJob) {
	if !s.runtimeOperationLock() {
		return
	}
	defer s.operation.Unlock()
	if maintenanceReady(s.db) != nil {
		return
	}
	if s.ctx.Err() != nil {
		return
	}
	current, err := runtimeGet[runtimeJob](s.db, "runtime_jobs", j.ID)
	if err != nil || current.Status != "queued" {
		return
	}
	j = current
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Minute)
	defer cancel()
	p, e := runtimeGet[RuntimePlan](s.db, "runtime_plans", j.PlanID)
	if e != nil {
		s.runtimeFinishFailure(j, e)
		return
	}
	engine, ok := s.engine.(RuntimeEngine)
	if !ok {
		s.runtimeFinishFailure(j, runtimeFailure)
		return
	}
	if e = s.runtimeStage(&j, "validate", "running"); e != nil {
		return
	}
	var source, target RuntimeGeneration
	var snapshot RuntimeSnapshot
	var original runtimeInstance
	originalState := ""
	touchedSource := false
	targetSaved := false
	launchAttempted := false
	saveGeneration := func(g RuntimeGeneration) error {
		if g.ID == "" {
			return nil
		}
		return runtimePut(s.db, ctx, "runtime_generations", g.ID, g)
	}
	failJob := func(cause error) {
		unresolved := false
		rollbackCtx, done := context.WithTimeout(context.Background(), 3*time.Minute)
		defer done()
		if targetSaved {
			target.State = "needs_attention"
			_ = runtimePut(s.db, rollbackCtx, "runtime_generations", target.ID, target)
			if launchAttempted {
				quiet, err := s.runtimeQuiesceCandidate(rollbackCtx, engine, target, p)
				if err == nil {
					target = quiet
					err = runtimePut(s.db, rollbackCtx, "runtime_generations", target.ID, target)
				}
				if err != nil {
					cause = fmt.Errorf("%w; 新代停止与端口释放无法确认，原代未盲目重启", cause)
					touchedSource = false
					unresolved = true
				}
			}
		}
		if touchedSource && (originalState == "running" || originalState == "stopped") {
			action := "start"
			if originalState == "stopped" {
				action = "stop"
			}
			if err := engine.ControlGeneration(rollbackCtx, source, action); err != nil {
				unresolved = true
				cause = fmt.Errorf("%w; 原代恢复失败，需人工检查", cause)
			} else if g, err := engine.InspectGeneration(rollbackCtx, source); err != nil || g.State != originalState {
				unresolved = true
				cause = fmt.Errorf("%w; 原代运行状态无法确认", cause)
			} else {
				source = g
				_ = runtimePut(s.db, rollbackCtx, "runtime_generations", source.ID, source)
			}
		}
		if original.ID != "" {
			if p.Kind == "install" || unresolved {
				original.State = "needs_attention"
				if p.Kind == "install" && !unresolved && (target.State == "prepared" || target.State == "stopped") {
					original.State = target.State
				}
				original.Health = "unknown"
			} else if touchedSource {
				if checked, err := engine.InspectGeneration(rollbackCtx, source); err == nil && (checked.State == "running" || checked.State == "stopped") {
					original.State = checked.State
					_ = runtimePut(s.db, rollbackCtx, "runtime_generations", checked.ID, checked)
				} else {
					unresolved = true
					original.State = "needs_attention"
					original.Health = "unknown"
				}
			}
			_ = runtimePutObservedInstance(s.db, rollbackCtx, original)
		}
		if unresolved {
			j.Status = "needs_attention"
		}
		s.runtimeFinishFailure(j, cause)
	}
	if p.RetryOfJobID != "" || p.Kind == "restore" {
		if e = s.runtimeVerifyRetryPlan(ctx, p); e != nil {
			failJob(e)
			return
		}
	}
	if e = s.runtimeCheckStorage(ctx, p); e != nil {
		failJob(e)
		return
	}
	if p.SourceGenerationID != "" {
		original, e = runtimeGet[runtimeInstance](s.db, "runtime_instances", p.InstanceID)
		if e != nil || original.ActiveGenerationID != p.SourceGenerationID {
			failJob(errRuntimeConflict)
			return
		}
		source, e = runtimeGet[RuntimeGeneration](s.db, "runtime_generations", p.SourceGenerationID)
		if e != nil {
			failJob(e)
			return
		}
		source, e = engine.InspectGeneration(ctx, source)
		if e != nil || (source.State != "running" && source.State != "stopped") {
			failJob(runtimeFailure)
			return
		}
		originalState = source.State
		j.SourceState = source.State
		if e = s.runtimeSaveJob(j); e != nil {
			failJob(e)
			return
		}
		if e = saveGeneration(source); e != nil {
			failJob(e)
			return
		}
	}
	if p.Kind == "install" || p.Kind == "update" || p.Kind == "restore" {
		if e = s.engine.ValidatePath(ctx, p.RootPath, p.DataPath, true); e != nil {
			failJob(e)
			return
		}
		if p.Kind == "install" {
			for _, port := range runtimePorts(p) {
				if e = s.engine.PortAvailable(ctx, port); e != nil {
					failJob(e)
					return
				}
			}
		}
	}
	if p.SnapshotRequired {
		if e = s.runtimeStage(&j, "stop-source", "running"); e != nil {
			failJob(e)
			return
		}
		touchedSource = true
		if e = engine.ControlGeneration(ctx, source, "stop"); e != nil {
			failJob(e)
			return
		}
		source, e = engine.InspectGeneration(ctx, source)
		if e != nil || source.State != "stopped" {
			failJob(runtimeFailure)
			return
		}
		if e = saveGeneration(source); e != nil {
			failJob(e)
			return
		}
		if e = s.runtimeStage(&j, "snapshot", "running"); e != nil {
			failJob(e)
			return
		}
		snapshot, e = engine.SnapshotGeneration(ctx, source, p.SnapshotRootPath, p.SnapshotID)
		if snapshot.ID == p.SnapshotID && snapshot.InstanceID == p.InstanceID && snapshot.GenerationID == source.ID && snapshot.Path == filepath.Join(p.SnapshotRootPath, p.SnapshotID, "data.tar") && snapshot.Source.StoreID == s.storeID {
			if dbErr := runtimePut(s.db, ctx, "runtime_snapshots", snapshot.ID, snapshot); dbErr != nil {
				failJob(dbErr)
				return
			}
		}
		if e != nil {
			failJob(e)
			return
		}
		if snapshot.ID != p.SnapshotID || snapshot.InstanceID != p.InstanceID || snapshot.Source.StoreID != s.storeID || snapshot.GenerationID != source.ID || snapshot.SHA256 == "" || snapshot.SizeBytes <= 0 {
			failJob(runtimeFailure)
			return
		}
	}
	switch p.Kind {
	case "install", "update", "restore":
		if e = s.runtimeStage(&j, "prepare-copy", "running"); e != nil {
			failJob(e)
			return
		}
		internal := p
		if p.Kind == "install" {
			target, e = engine.PrepareGeneration(ctx, p)
		} else {
			if p.Kind == "restore" {
				snapshot, e = runtimeGet[RuntimeSnapshot](s.db, "runtime_snapshots", p.SourceSnapshotID)
				if e != nil {
					failJob(e)
					return
				}
			} else {
				internal.SourceSnapshotID = snapshot.ID
			}
			target, e = engine.RestoreGeneration(ctx, snapshot, internal)
		}
		if target.ID != "" && !runtimeGenerationMatchesPlan(target, p) {
			failJob(runtimeFailure)
			return
		}
		if target.ID != "" {
			targetSaved = true
			if dbErr := saveGeneration(target); dbErr != nil {
				failJob(dbErr)
				return
			}
		}
		if e != nil {
			failJob(e)
			return
		}
		if target.ID != p.GenerationID || target.InstanceID != p.InstanceID || target.StoreID != s.storeID {
			failJob(runtimeFailure)
			return
		}
		if p.Kind == "install" {
			original = runtimeInstance{ID: p.InstanceID, AppID: p.AppID, Name: p.Recipe.Name, ActiveGenerationID: target.ID, Version: p.TargetVersion, State: "prepared", Health: "unknown", Initialization: "required", DataPath: p.DataPath, HostPort: p.HostPort, AccessURL: p.AccessURL}
			if e = runtimePutObservedInstance(s.db, ctx, original); e != nil {
				failJob(e)
				return
			}
		}
		if e = s.runtimeStage(&j, "launch-verify", "running"); e != nil {
			failJob(e)
			return
		}
		if p.RetryOfJobID != "" || p.Kind == "restore" {
			if e = s.runtimeVerifyRetryPlan(ctx, p); e != nil {
				failJob(e)
				return
			}
		}
		if p.Kind == "install" && p.RetryOfJobID != "" {
			record, err := runtimeGet[runtimePlanRecord](s.db, "runtime_plans", p.ID)
			if err != nil || record.RetryBinding == nil {
				failJob(runtimeFailure)
				return
			}
			ctx = context.WithValue(ctx, runtimeRetryLaunchKey{}, *record.RetryBinding)
		}
		launchAttempted = true
		beforeLaunch := target
		target, e = engine.LaunchGeneration(ctx, internal, target)
		if !runtimeGenerationMatchesPlan(target, p) {
			target = beforeLaunch
			failJob(runtimeFailure)
			return
		}
		if target.ID != "" {
			_ = saveGeneration(target)
		}
		if e != nil {
			failJob(e)
			return
		}
		target, e = engine.InspectGeneration(ctx, target)
		if e != nil || target.State != "running" || !runtimeGenerationMatchesPlan(target, p) {
			failJob(runtimeFailure)
			return
		}
		if originalState == "stopped" {
			if e = engine.ControlGeneration(ctx, target, "stop"); e != nil {
				failJob(e)
				return
			}
			target, e = engine.InspectGeneration(ctx, target)
			if e != nil || target.State != "stopped" {
				failJob(runtimeFailure)
				return
			}
		}
		proposed := original
		proposed.ActiveGenerationID = target.ID
		proposed.Version = target.Version
		proposed.State = target.State
		proposed.Health = "unknown"
		if target.State == "running" {
			proposed.Health = "healthy"
		}
		proposed.Initialization = s.runtimeInitialization(ctx, target)
		proposed.DataPath = target.DataPath
		proposed.AccessURL = target.AccessURL
		proposed.HostPort = target.HostPort
		if e = s.runtimeStage(&j, "switch-generation", "running"); e != nil {
			failJob(e)
			return
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			failJob(err)
			return
		}
		if err = runtimePut(tx, ctx, "runtime_generations", target.ID, target); err == nil {
			err = runtimePutObservedInstance(tx, ctx, proposed)
		}
		if err == nil {
			err = tx.Commit()
		} else {
			tx.Rollback()
		}
		if err != nil {
			failJob(err)
			return
		}
		touchedSource = false
	case "backup":
		if originalState == "running" {
			if e = engine.ControlGeneration(ctx, source, "start"); e != nil {
				failJob(e)
				return
			}
			source, e = engine.InspectGeneration(ctx, source)
			if e != nil || source.State != "running" {
				failJob(runtimeFailure)
				return
			}
			if e = saveGeneration(source); e != nil {
				failJob(e)
				return
			}
		}
		touchedSource = false
	case "start", "stop", "restart", "archive", "reactivate":
		action := p.Kind
		if action == "archive" {
			action = "stop"
		}
		if action == "reactivate" {
			action = "start"
		}
		touchedSource = true
		if e = s.runtimeStage(&j, action, "running"); e != nil {
			failJob(e)
			return
		}
		if e = engine.ControlGeneration(ctx, source, action); e != nil {
			failJob(e)
			return
		}
		source, e = engine.InspectGeneration(ctx, source)
		if e != nil || (action == "stop" && source.State != "stopped") || (action != "stop" && source.State != "running") {
			failJob(runtimeFailure)
			return
		}
		if e = saveGeneration(source); e != nil {
			failJob(e)
			return
		}
		proposed := original
		proposed.State = source.State
		proposed.Health = "unknown"
		if source.State == "running" {
			proposed.Health = "healthy"
		}
		if p.Kind == "archive" {
			proposed.Archived = true
		}
		if p.Kind == "reactivate" {
			proposed.Archived = false
		}
		if e = runtimePutObservedInstance(s.db, ctx, proposed); e != nil {
			failJob(e)
			return
		}
		touchedSource = false
	default:
		failJob(runtimeFailure)
		return
	}
	if e = s.runtimeStage(&j, "complete", "succeeded"); e != nil {
		s.runtimeFinishFailure(j, e)
	}
}
func (s *Service) runtimeFinishFailure(j runtimeJob, e error) {
	j.Error = "执行失败，原数据、旧代、新代及快照全部保留。"
	if errors.Is(e, errRuntimeConflict) {
		j.Error += "计划源已变化，需重新核对。"
	} else if e != nil {
		j.Error += " " + e.Error()
	}
	status := "failed"
	if j.Status == "needs_attention" {
		status = "needs_attention"
	}
	_ = s.runtimeStage(&j, "needs-attention", status)
}
func (s *Service) runtimeReconcile(w http.ResponseWriter, r *http.Request) {
	if !s.requestLock(w, r, &s.operation) {
		return
	}
	defer s.operation.Unlock()
	if !s.requestMaintenanceReady(w, r) {
		return
	}
	engine, ok := s.engine.(RuntimeEngine)
	if !ok {
		fail(w, 503, "runtime_unavailable", "执行引擎不可用。")
		return
	}
	items, e := runtimeRead[runtimeInstance](s.db, "runtime_instances")
	if e != nil {
		fail(w, 500, "storage_failed", "无法读取实例。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	recovered := map[string]bool{}
	recoveredGenerations := []RuntimeGeneration{}
	quietInstalls := map[string]RuntimeGeneration{}
	quarantinedInstallJobs := map[string]bool{}
	quarantinedInstallInstances := map[string]bool{}
	attentionJobs, readErr := runtimeRead[runtimeJob](s.db, "runtime_jobs")
	if readErr != nil {
		fail(w, 500, "storage_failed", "无法读取中断任务。")
		return
	}
	latestJobIndex := map[string]int{}
	for index, job := range attentionJobs {
		latestJobIndex[job.InstanceID] = index
	}
	for index, job := range attentionJobs {
		if job.Status != "needs_attention" && !(job.Status == "failed" && job.Kind == "install") {
			continue
		}
		plan, e := runtimeGet[RuntimePlan](s.db, "runtime_plans", job.PlanID)
		if e == nil && plan.Kind == "install" {
			if job.Stage == "reconciled" || latestJobIndex[job.InstanceID] != index {
				continue
			}
			active, err := runtimeGet[runtimeInstance](s.db, "runtime_instances", job.InstanceID)
			if err != nil || active.ActiveGenerationID != plan.GenerationID {
				continue
			}
			quarantinedInstallJobs[job.ID] = true
			quarantinedInstallInstances[job.InstanceID] = true
			candidate, err := runtimeGet[RuntimeGeneration](s.db, "runtime_generations", plan.GenerationID)
			if err != nil || !s.runtimeAuthorized(r) {
				continue
			}
			candidate, err = s.runtimeQuiesceCandidate(ctx, engine, candidate, plan)
			if err == nil {
				recovered[job.ID] = true
				delete(quarantinedInstallJobs, job.ID)
				delete(quarantinedInstallInstances, job.InstanceID)
				quietInstalls[job.InstanceID] = candidate
				recoveredGenerations = append(recoveredGenerations, candidate)
			}
			continue
		}
		if e != nil || (plan.Kind != "update" && plan.Kind != "restore") {
			continue
		}
		active, e := runtimeGet[runtimeInstance](s.db, "runtime_instances", job.InstanceID)
		if e != nil || active.ActiveGenerationID != plan.SourceGenerationID {
			continue
		}
		source, candidate, err := s.runtimeRecoverInterrupted(ctx, r, engine, job, plan)
		if err == nil {
			recovered[job.ID] = true
			recoveredGenerations = append(recoveredGenerations, source)
			if candidate.ID != "" {
				recoveredGenerations = append(recoveredGenerations, candidate)
			}
		}
	}
	gens := recoveredGenerations
	for n := range items {
		if quarantinedInstallInstances[items[n].ID] {
			items[n].State = "needs_attention"
			items[n].Health = "unknown"
			continue
		}
		g, e := runtimeGet[RuntimeGeneration](s.db, "runtime_generations", items[n].ActiveGenerationID)
		if e != nil {
			items[n].State = "needs_attention"
			continue
		}
		if quiet, ok := quietInstalls[items[n].ID]; ok {
			g = quiet
			e = nil
		} else {
			g, e = engine.InspectGeneration(ctx, g)
		}
		if e != nil {
			items[n].State = "needs_attention"
			items[n].Health = "unknown"
		} else {
			items[n].State = g.State
			if g.State == "running" {
				items[n].Health = "healthy"
			} else {
				items[n].Health = "unknown"
			}
			if g.State == "running" {
				items[n].Initialization = s.runtimeInitialization(ctx, g)
			}
			gens = append(gens, g)
		}
	}
	if s.runtimeMutation(w, r, func(tx *sql.Tx) error {
		for _, g := range gens {
			if e := runtimePut(tx, ctx, "runtime_generations", g.ID, g); e != nil {
				return e
			}
		}
		for _, i := range items {
			current, e := runtimeGet[runtimeInstance](tx, "runtime_instances", i.ID)
			if e != nil || current.ID != i.ID || current.AppID != i.AppID || current.ActiveGenerationID != i.ActiveGenerationID {
				return errRuntimeConflict
			}
			current.State, current.Health, current.Initialization = i.State, i.Health, i.Initialization
			if e := runtimePut(tx, ctx, "runtime_instances", current.ID, current); e != nil {
				return e
			}
		}
		jobs, e := runtimeRead[runtimeJob](tx, "runtime_jobs")
		if e != nil {
			return e
		}
		for _, job := range jobs {
			if quarantinedInstallJobs[job.ID] {
				if job.Status != "needs_attention" || job.Stage != "needs-attention" {
					job.Status = "needs_attention"
					job.Stage = "needs-attention"
					job.UpdatedAt = time.Now().UTC()
					job.Error += " 资源静止证明失败，继续隔离该实例。"
					job.Stages = append(job.Stages, Stage{Name: "needs-attention", Status: "needs_attention", At: job.UpdatedAt})
					b, _ := json.Marshal(job)
					if _, e = tx.ExecContext(ctx, `UPDATE runtime_jobs SET status=?,body=? WHERE id=?`, job.Status, string(b), job.ID); e != nil {
						return e
					}
				}
				continue
			}
			if job.Kind == "install" && !recovered[job.ID] {
				continue
			}
			if job.Status != "needs_attention" && !(job.Status == "failed" && recovered[job.ID]) {
				continue
			}
			plan, e := runtimeGet[RuntimePlan](tx, "runtime_plans", job.PlanID)
			if e != nil {
				continue
			}
			for _, i := range items {
				if i.ID != job.InstanceID || (i.State != "running" && i.State != "stopped" && !(i.State == "prepared" && recovered[job.ID])) {
					continue
				}
				if (plan.Kind == "install" || plan.Kind == "update" || plan.Kind == "restore") && plan.GenerationID != i.ActiveGenerationID && !recovered[job.ID] {
					continue
				}
				job.Status = "failed"
				job.Stage = "reconciled"
				job.UpdatedAt = time.Now().UTC()
				job.Error += " 活动代归属和状态已显式核验；中断任务不自动重复执行。"
				job.Stages = append(job.Stages, Stage{Name: "reconciled", Status: "completed", At: job.UpdatedAt})
				b, _ := json.Marshal(job)
				if _, e = tx.ExecContext(ctx, `UPDATE runtime_jobs SET status=?,body=? WHERE id=?`, job.Status, string(b), job.ID); e != nil {
					return e
				}
			}
		}
		return nil
	}) {
		s.runtimeInstances(w, r)
	}
}
func (s *Service) runtimeEvents(w http.ResponseWriter, r *http.Request) {
	select {
	case s.runtimeStreams <- struct{}{}:
		defer func() { <-s.runtimeStreams }()
	default:
		fail(w, 429, "stream_limit", "任务流数量已达上限。")
		return
	}
	f, ok := w.(http.Flusher)
	if !ok {
		fail(w, 500, "stream_unavailable", "无法建立任务流。")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	controller := http.NewResponseController(w)
	limit := time.NewTimer(10 * time.Minute)
	defer limit.Stop()
	last := ""
	revalidateProvider := false
	for {
		valid := s.runtimeAuthorized(r)
		if valid && revalidateProvider {
			valid = s.runtimeStreamRole(r)
		}
		revalidateProvider = true
		_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if !valid {
			fmt.Fprint(w, "event: auth-expired\ndata: {}\n\n")
			f.Flush()
			return
		}
		readCtx, cancelRead := context.WithTimeout(r.Context(), time.Second)
		jobs, e := runtimeReadContext[runtimeJob](readCtx, s.db, "runtime_jobs")
		cancelRead()
		if e != nil {
			if !s.runtimeAuthorized(r) {
				fmt.Fprint(w, "event: auth-expired\ndata: {}\n\n")
				f.Flush()
			}
			return
		}
		b, _ := json.Marshal(map[string]any{"items": jobs})
		if string(b) != last {
			if !s.runtimeAuthorized(r) {
				continue
			}
			fmt.Fprintf(w, "event: jobs\ndata: %s\n\n", b)
			f.Flush()
			last = string(b)
		} else {
			fmt.Fprint(w, ": keepalive\n\n")
			f.Flush()
		}
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case <-limit.C:
			return
		case <-ticker.C:
		}
	}
}

// A long-lived stream must not retain upstream administrator rights solely
// because its in-memory store grant has not expired. Provider I/O happens
// outside every SQL transaction and NAS mutex, once per subsequent stream tick.
func (s *Service) runtimeStreamRole(r *http.Request) bool {
	grant, nas := r.Context().Value(nasGrantKey{}).(nasRequestGrant)
	if !nas {
		return s.runtimeAuthorized(r)
	}
	username, err := s.verifyNAS(r.Context(), grant.entry.credentials)
	if err != nil || username != grant.entry.username {
		s.revokeNAS(grant.hash, grant.entry)
		return false
	}
	return s.runtimeAuthorized(r)
}
func (s *Service) runtimeLogs(w http.ResponseWriter, r *http.Request) {
	engine, ok := s.engine.(RuntimeEngine)
	if !ok {
		fail(w, 503, "runtime_unavailable", "执行引擎不可用。")
		return
	}
	i, e := runtimeGet[runtimeInstance](s.db, "runtime_instances", r.PathValue("id"))
	if e != nil {
		fail(w, 404, "unknown_instance", "实例不存在。")
		return
	}
	g, e := runtimeGet[RuntimeGeneration](s.db, "runtime_generations", i.ActiveGenerationID)
	if e != nil {
		fail(w, 409, "generation_unavailable", "运行代不存在。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	service := r.URL.Query().Get("service")
	if service == "" {
		for _, svc := range g.Recipe.Services {
			if svc.Entry {
				service = svc.ID
				break
			}
		}
	}
	text, e := engine.RuntimeLogs(ctx, g, service, 200)
	if !s.runtimeAuthorized(r) {
		fail(w, 401, "store_auth_required", "会话已失效。")
		return
	}
	if e != nil {
		fail(w, 502, "logs_failed", "无法读取已核验服务日志。")
		return
	}
	if len(text) > 128<<10 {
		text = text[:128<<10]
	}
	s.runtimeRespond(w, r, 200, map[string]string{"text": text})
}
func (s *Service) runtimeDirectories(w http.ResponseWriter, r *http.Request) {
	engine, ok := s.engine.(RuntimeEngine)
	if !ok {
		fail(w, 503, "runtime_unavailable", "执行引擎不可用。")
		return
	}
	root, e := s.root(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "unknown_storage_root", "目录不存在。")
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		path = root.Path
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if _, e = s.inspectMediaRoot(ctx, root); e != nil {
		fail(w, 409, "unsafe_storage", "目录介质未核验。")
		return
	}
	dirs, e := engine.RuntimeDirectories(ctx, root.Path, path)
	if !s.runtimeAuthorized(r) {
		fail(w, 401, "store_auth_required", "会话已失效。")
		return
	}
	if e != nil {
		fail(w, 400, "unsafe_path", "无法读取安全目录。")
		return
	}
	for n, dir := range dirs {
		if dir == "" || dir == "." || dir == ".." || strings.ContainsAny(dir, "/\\\x00\r\n") {
			fail(w, 502, "directory_invalid", "目录名称未通过安全检查。")
			return
		}
		dirs[n] = filepath.Join(path, dir)
	}
	s.runtimeRespond(w, r, 200, map[string]any{"items": dirs})
}
func (s *Service) runtimeDownload(w http.ResponseWriter, r *http.Request) {
	if s.opts.EngineMode != "local" {
		fail(w, 501, "private_transport_unavailable", "远程快照下载需要私有受控传输；不会通过明文LAN暴露备份。")
		return
	}
	snapshot, e := runtimeGet[RuntimeSnapshot](s.db, "runtime_snapshots", r.PathValue("id"))
	if e != nil {
		fail(w, 404, "snapshot_unavailable", "快照不存在。")
		return
	}
	engine, ok := s.engine.(RuntimeEngine)
	if !ok || snapshot.Source.StoreID != s.storeID || snapshot.Path != filepath.Join(snapshot.RootPath, snapshot.ID, "data.tar") || snapshot.SizeBytes <= 0 || !runtimeDigestRE.MatchString("sha256:"+snapshot.SHA256) {
		fail(w, 409, "snapshot_unverified", "快照身份无效。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	if _, e = engine.InspectGeneration(ctx, snapshot.Source); e != nil {
		fail(w, 409, "ownership_unverified", "快照源归属核验失败。")
		return
	}
	if e = noSymlinkPath(snapshot.Path); e != nil {
		fail(w, 409, "unsafe_snapshot", "快照路径无效。")
		return
	}
	root, e := os.OpenRoot(snapshot.RootPath)
	if e != nil {
		fail(w, 409, "unsafe_snapshot", "快照根无法打开。")
		return
	}
	defer root.Close()
	manifestBytes, e := root.ReadFile(filepath.Join(snapshot.ID, "manifest.json"))
	var manifest RuntimeSnapshot
	if e != nil || json.Unmarshal(manifestBytes, &manifest) != nil || !reflect.DeepEqual(manifest, snapshot) {
		fail(w, 409, "snapshot_unverified", "快照清单与记录不一致。")
		return
	}
	f, e := nativeControllerSnapshotRead(root, filepath.Join(snapshot.ID, "data.tar"))
	if e != nil {
		fail(w, 404, "snapshot_unavailable", "无法读取快照。")
		return
	}
	defer f.Close()
	stat, e := f.Stat()
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() != snapshot.SizeBytes {
		fail(w, 409, "unsafe_snapshot", "快照文件权限或大小无效。")
		return
	}
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil || hex.EncodeToString(h.Sum(nil)) != snapshot.SHA256 {
		fail(w, 409, "snapshot_corrupt", "快照完整性验证失败。")
		return
	}
	if !s.runtimeAuthorized(r) {
		fail(w, 401, "store_auth_required", "会话已失效。")
		return
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		fail(w, 500, "snapshot_failed", "无法读取快照。")
		return
	}
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Length", fmt.Sprint(snapshot.SizeBytes))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", "attachment; filename="+snapshot.ID+".tar")
	// A private response cannot terminate as a clean successful EOF after
	// revocation or corruption. ErrAbortHandler closes HTTP/1 or resets HTTP/2.
	streamHash := sha256.New()
	sent := int64(0)
	buf := make([]byte, 64<<10)
	for sent < snapshot.SizeBytes {
		if ctx.Err() != nil || !s.runtimeAuthorized(r) {
			panic(http.ErrAbortHandler)
		}
		current, err := f.Stat()
		if err != nil || current.Size() != stat.Size() || !current.ModTime().Equal(stat.ModTime()) || current.Mode() != stat.Mode() {
			panic(http.ErrAbortHandler)
		}
		remaining := snapshot.SizeBytes - sent
		chunk := buf
		if remaining < int64(len(chunk)) {
			chunk = chunk[:int(remaining)]
		}
		n, err := f.Read(chunk)
		if err != nil || n == 0 {
			panic(http.ErrAbortHandler)
		}
		streamHash.Write(chunk[:n])
		// Check the streamed identity before sending the final frame, so even a
		// same-size rewrite cannot produce a fully framed, corrupt success body.
		if sent+int64(n) == snapshot.SizeBytes && hex.EncodeToString(streamHash.Sum(nil)) != snapshot.SHA256 {
			panic(http.ErrAbortHandler)
		}
		if ctx.Err() != nil || !s.runtimeAuthorized(r) {
			panic(http.ErrAbortHandler)
		}
		written, err := w.Write(chunk[:n])
		if err != nil || written != n {
			panic(http.ErrAbortHandler)
		}
		sent += int64(written)
	}

}

type runtimeCatalogEntry struct {
	LatestVersion string    `json:"latestVersion"`
	Status        string    `json:"status"`
	Error         string    `json:"error"`
	CheckedAt     time.Time `json:"checkedAt"`
}

func (s *Service) runtimeScheduledCheck() {
	if maintenanceReady(s.db) != nil {
		return
	}
	if s.opts.EngineMode == "disabled" {
		return
	}
	settings := s.runtimeSettingsValue()
	if !settings.UpdateCheckEnabled {
		return
	}
	entries, e := runtimeRead[runtimeCatalogEntry](s.db, "runtime_catalog")
	if e != nil {
		return
	}
	due := len(entries) == 0
	for _, entry := range entries {
		due = due || time.Since(entry.CheckedAt) >= time.Duration(settings.UpdateCheckHours)*time.Hour
	}
	if due {
		select {
		case s.runtimeRefreshWake <- struct{}{}:
		default:
		}
	}
}
func (s *Service) runtimeRefresh(w http.ResponseWriter, r *http.Request) {
	if !s.requestMaintenanceReady(w, r) {
		return
	}
	select {
	case s.runtimeRefreshWake <- struct{}{}:
	default:
	}
	s.runtimeRespond(w, r, 202, map[string]string{"status": "queued"})
}
func (s *Service) runtimeCatalogWorker() {
	defer s.wg.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.runtimeRefreshWake:
			s.runtimeFetchCatalog(s.ctx)
		}
	}
}
func (s *Service) runtimeFetchCatalog(parent context.Context) {
	if !s.runtimeCatalogMu.TryLock() {
		return
	}
	defer s.runtimeCatalogMu.Unlock()
	if maintenanceReady(s.db) != nil {
		return
	}
	repos := map[string]string{"uptime-kuma": "louislam/uptime-kuma", "navidrome": "navidrome/navidrome", "jellyfin": "jellyfin/jellyfin", "immich": "immich-app/immich", "syncthing": "syncthing/syncthing"}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect rejected") }}
	for _, a := range RuntimeRecipes() {
		if parent.Err() != nil {
			return
		}
		if a.AppID == "nasreader" {
			_ = runtimePut(s.db, parent, "runtime_catalog", a.AppID, runtimeCatalogEntry{LatestVersion: a.Version, Status: "fixed-author-delivery", CheckedAt: time.Now().UTC()})
			continue
		}
		ctx, cancel := context.WithTimeout(parent, 10*time.Second)
		req, e := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+repos[a.AppID]+"/releases/latest", nil)
		entry := runtimeCatalogEntry{LatestVersion: a.Version, Status: "error", Error: "官方版本源暂时不可用。", CheckedAt: time.Now().UTC()}
		if old, e := runtimeGet[runtimeCatalogEntry](s.db, "runtime_catalog", a.AppID); e == nil {
			entry.LatestVersion = old.LatestVersion
		}
		if e == nil {
			req.Header.Set("Accept", "application/vnd.github+json")
			res, err := client.Do(req)
			if err == nil {
				var release struct {
					Tag        string `json:"tag_name"`
					Draft      bool   `json:"draft"`
					Prerelease bool   `json:"prerelease"`
				}
				if res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&release) == nil && !release.Draft && !release.Prerelease {
					v := strings.TrimPrefix(release.Tag, "v")
					if _, err = CompareRuntimeVersions(v, v); err == nil {
						entry.LatestVersion = v
						entry.Status = "ok"
						entry.Error = ""
					}
				}
				res.Body.Close()
			}
		}
		cancel()
		_ = runtimePut(s.db, parent, "runtime_catalog", a.AppID, entry)
	}
}

func (s *Service) runtimeInitialization(ctx context.Context, g RuntimeGeneration) string {
	if engine, ok := s.engine.(interface {
		RuntimeInitialization(context.Context, RuntimeGeneration) (string, error)
	}); ok {
		state, e := engine.RuntimeInitialization(ctx, g)
		if e != nil {
			return "unknown"
		}
		switch state {
		case "complete", "completed":
			return "completed"
		case "pending":
			return "required"
		case "not_required":
			return "not_required"
		}
	}
	return "unknown"
}

func (s *Service) runtimeOperationLock() bool {
	for !s.operation.TryLock() {
		select {
		case <-s.ctx.Done():
			return false
		case <-time.After(10 * time.Millisecond):
		}
	}
	if s.ctx.Err() != nil {
		s.operation.Unlock()
		return false
	}
	return true
}

// Recovery executes only the rollback already reviewed by the original plan.
// Unknown partial resources are quarantined until the engine can prove them.
func (s *Service) runtimeRecoverInterrupted(ctx context.Context, r *http.Request, engine RuntimeEngine, job runtimeJob, p RuntimePlan) (RuntimeGeneration, RuntimeGeneration, error) {
	var source, candidate RuntimeGeneration
	if job.SourceState != "running" && job.SourceState != "stopped" {
		return source, candidate, runtimeFailure
	}
	source, e := runtimeGet[RuntimeGeneration](s.db, "runtime_generations", p.SourceGenerationID)
	if e != nil {
		return source, candidate, e
	}
	source, e = engine.InspectGeneration(ctx, source)
	if e != nil || (source.State != "running" && source.State != "stopped") {
		return source, candidate, runtimeFailure
	}
	candidate, e = runtimeGet[RuntimeGeneration](s.db, "runtime_generations", p.GenerationID)
	if errors.Is(e, sql.ErrNoRows) {
		beforeLaunch := job.Stage == "validate" || job.Stage == "stop-source" || job.Stage == "snapshot" || job.Stage == "prepare-copy"
		if !beforeLaunch || s.engine.ValidatePath(ctx, p.RootPath, p.DataPath, true) != nil {
			return source, candidate, runtimeFailure
		}
	}
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return source, candidate, e
	}
	if candidate.ID != "" {
		if !runtimeGenerationMatchesPlan(candidate, p) {
			return source, candidate, runtimeFailure
		}
		if !s.runtimeAuthorized(r) {
			return source, candidate, errRuntimeAuth
		}
		candidate, e = s.runtimeQuiesceCandidate(ctx, engine, candidate, p)
		if e != nil || (candidate.State != "stopped" && candidate.State != "prepared") {
			return source, candidate, runtimeFailure
		}
	}
	if !s.runtimeAuthorized(r) {
		return source, candidate, errRuntimeAuth
	}
	if source.State != job.SourceState {
		if e = engine.ControlGeneration(ctx, source, map[bool]string{true: "start", false: "stop"}[job.SourceState == "running"]); e != nil {
			return source, candidate, e
		}
		source, e = engine.InspectGeneration(ctx, source)
		if e != nil || source.State != job.SourceState {
			return source, candidate, runtimeFailure
		}
	}
	return source, candidate, nil
}
func runtimeGenerationMatchesPlan(g RuntimeGeneration, p RuntimePlan) bool {
	return g.SecretSetID == p.SecretSetID && g.ID == p.GenerationID && g.InstanceID == p.InstanceID && g.StoreID == p.StoreID && g.DataPath == p.DataPath && g.RootPath == p.RootPath && g.AppID == p.AppID && g.Version == p.TargetVersion && g.StorageIdentity == p.StorageIdentity && g.DockerStorageIdentity == p.DockerStorageIdentity && g.HostPort == p.HostPort && g.PeerPort == p.PeerPort && g.DiscoveryPort == p.DiscoveryPort && g.MediaPath == p.MediaPath && g.MediaRootPath == p.MediaRootPath && g.MediaStorageIdentity == p.MediaStorageIdentity && reflect.DeepEqual(g.Recipe, p.Recipe) && reflect.DeepEqual(g.Images, p.Images)
}

func (s *Service) runtimeQuiesceCandidate(ctx context.Context, engine RuntimeEngine, g RuntimeGeneration, p RuntimePlan) (RuntimeGeneration, error) {
	if !runtimeGenerationMatchesPlan(g, p) {
		return g, runtimeFailure
	}
	var e error
	if quiescer, ok := engine.(interface {
		RuntimeQuiesceGeneration(context.Context, RuntimeGeneration) (RuntimeGeneration, error)
	}); ok {
		g, e = quiescer.RuntimeQuiesceGeneration(ctx, g)
	} else {
		g, e = engine.InspectGeneration(ctx, g)
		if e == nil {
			e = engine.ControlGeneration(ctx, g, "stop")
		}
		if e == nil {
			g, e = engine.InspectGeneration(ctx, g)
		}
	}
	if e != nil || validateRuntimeGeneration(g) != nil || !runtimeGenerationMatchesPlan(g, p) || (g.State != "prepared" && g.State != "stopped") {
		return g, runtimeFailure
	}
	return g, nil
}
