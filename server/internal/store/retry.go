package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"time"
)

type retryReader interface{ QueryRow(string, ...any) *sql.Row }

// Retry intent comes from a persisted terminal job, never from request fields or
// a guessed instance ID. Queued/running reservations are checked in the enqueue transaction.
func retrySource(db retryReader, instanceID string) (Job, error) {
	var active int
	if err := db.QueryRow(`SELECT count(*) FROM jobs WHERE json_extract(body,'$.instanceId')=? AND status IN ('queued','running')`, instanceID).Scan(&active); err != nil {
		return Job{}, err
	}
	if active != 0 {
		return Job{}, errors.New("实例已有活动任务。")
	}
	var body string
	var j Job
	if err := db.QueryRow(`SELECT body FROM jobs WHERE json_extract(body,'$.instanceId')=? ORDER BY rowid DESC LIMIT 1`, instanceID).Scan(&body); err != nil {
		return j, err
	}
	if err := json.Unmarshal([]byte(body), &j); err != nil {
		return j, err
	}
	if j.Status != "failed" && j.Status != "needs_attention" {
		return j, errors.New("只有失败或需要检查的安装任务可以重试。")
	}
	return j, nil
}
func sameRetryMaterial(p Plan, i Instance) bool {
	return p.InstanceID == i.ID && p.AppID == i.AppID && p.RootPath == i.RootPath && p.DataPath == i.DataPath && p.ContainerName == i.ContainerName && p.Image == i.Image && p.HostPort == i.HostPort && p.ContainerPort == i.ContainerPort && p.PublishHost == i.PublishHost && p.AccessURL == i.AccessURL && p.MediaRootPath == i.MediaRootPath && p.MediaStorageIdentity == i.MediaStorageIdentity && reflect.DeepEqual(p.Mounts, i.Mounts) && p.NativeIntegration == i.NativeIntegration
}

// This is read-only: no Prepare, pin replacement, pull, start or container adoption.
func (s *Service) checkRetrySafety(ctx context.Context, p Plan, i Instance) (Container, bool, error) {
	db := s.db
	if err := validateRetryImage(p); err != nil {
		return Container{}, false, err
	}
	if p.PreviousImage != "" && i.ContainerID != "" {
		return Container{}, false, errors.New("曾登记容器的实例禁止切换镜像源。")
	}
	if err := s.engine.Probe(ctx); err != nil {
		return Container{}, false, err
	}
	var root StorageRoot
	var rootBody string
	err := db.QueryRow(`SELECT body FROM storage_roots WHERE id=?`, p.RootID).Scan(&rootBody)
	if err == nil {
		err = json.Unmarshal([]byte(rootBody), &root)
	}
	if err != nil || root.Path != p.RootPath {
		return Container{}, false, errors.New("重试数据根登记已改变。")
	}
	volume, docker, err := s.checkStorage(ctx, root)
	if err != nil {
		return Container{}, false, err
	}
	if p.StorageIdentity == "" || p.DockerStorageIdentity == "" || volume.Identity != p.StorageIdentity || docker.Identity != p.DockerStorageIdentity {
		return Container{}, false, errors.New("数据卷或Docker缓存身份与已确认计划不一致。")
	}
	if i.Provenance.Marker != s.storeID+":"+i.ID {
		return Container{}, false, errors.New("保留数据缺少有效的实例所有权记录，拒绝接管。")
	}
	if err = s.verifyDirectory(ctx, p.RootPath, p.DataPath, i.Provenance); err != nil {
		return Container{}, false, err
	}
	if err = s.checkMediaPlan(ctx, p); err != nil {
		return Container{}, false, err
	}
	c, err := s.engine.Inspect(ctx, p.ContainerName)
	if errors.Is(err, ErrNotFound) {
		if i.ContainerID != "" {
			return Container{}, false, errors.New("已登记容器丢失，拒绝自动创建替代容器。")
		}
		if err = s.engine.PortAvailable(ctx, p.HostPort); err != nil {
			return Container{}, false, err
		}
		if p.PreviousImage != "" {
			// Inspection/port checks can take time: repeat the volume and final
			// directory proof at the source-change mutation boundary.
			volume, docker, err = s.checkStorage(ctx, root)
			if err != nil {
				return Container{}, false, err
			}
			if volume.Identity != p.StorageIdentity || docker.Identity != p.DockerStorageIdentity {
				return Container{}, false, errors.New("镜像源切换前卷或Docker缓存身份已改变。")
			}
			if err = s.verifyDirectory(ctx, p.RootPath, p.DataPath, i.Provenance); err != nil {
				return Container{}, false, err
			}
			if _, err = s.engine.Inspect(ctx, p.ContainerName); !errors.Is(err, ErrNotFound) {
				return Container{}, false, errors.New("镜像源切换前容器名已存在或无法确认不存在。")
			}
		}
		return Container{}, false, nil
	}
	if err != nil {
		return Container{}, false, errors.New("无法确认保留容器身份。")
	}
	if p.PreviousImage != "" {
		return Container{}, false, errors.New("镜像源切换要求容器名不存在，拒绝接管或替换已有容器。")
	}
	candidate := i
	if candidate.ContainerID == "" {
		candidate.ContainerID = c.ID
	}
	if c.ID == "" || !s.owns(c, candidate) {
		return Container{}, false, errors.New("容器身份、所有权标签、镜像、挂载或端口不匹配，拒绝接管。")
	}
	return c, true, nil
}

// Slow engine/storage proofs run before reserving a SQLite connection. Their
// SQL inputs are captured first, then bound again in the admission transaction.
type legacySourceRetryProof struct {
	Job       Job
	Root      StorageRoot
	MediaRoot StorageRoot
}

func (s *Service) proveLegacySourceRetry(ctx context.Context, p Plan, i Instance) (legacySourceRetryProof, error) {
	var proof legacySourceRetryProof
	var err error
	if proof.Job, err = retrySource(s.db, i.ID); err != nil || proof.Job.ID != p.RetryOfJobID || proof.Job.PlanID != p.RetryOfPlanID {
		return proof, errors.New("镜像源切换的失败任务来源已改变。")
	}
	if proof.Root, err = s.root(p.RootID); err != nil {
		return proof, err
	}
	if p.MediaRootID != "" {
		if proof.MediaRoot, err = s.root(p.MediaRootID); err != nil {
			return proof, err
		}
	}
	if err = sourcePlanLink(s.db, p); err == nil {
		err = sourceHistorySafe(s.db, i.ID, "")
	}
	if err == nil {
		_, _, err = s.checkRetrySafety(ctx, p, i)
	}
	return proof, err
}

func (proof legacySourceRetryProof) verifySQL(tx *sql.Tx, p Plan, prior Job) error {
	currentPlan, err := runtimeGet[Plan](tx, "plans", p.ID)
	if err != nil || !reflect.DeepEqual(currentPlan, p) || !reflect.DeepEqual(prior, proof.Job) {
		return errors.New("镜像源切换计划或失败任务在检查期间已改变。")
	}
	root, err := runtimeGet[StorageRoot](tx, "storage_roots", p.RootID)
	if err != nil || !reflect.DeepEqual(root, proof.Root) {
		return errors.New("镜像源切换数据根在检查期间已改变。")
	}
	if p.MediaRootID != "" {
		media, err := runtimeGet[StorageRoot](tx, "storage_roots", p.MediaRootID)
		if err != nil || !reflect.DeepEqual(media, proof.MediaRoot) {
			return errors.New("镜像源切换媒体根在检查期间已改变。")
		}
	}
	if err = sourcePlanLink(tx, p); err == nil {
		err = sourceHistorySafe(tx, p.InstanceID, "")
	}
	return err
}

func (s *Service) retryPlan(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ImageSource string `json:"imageSource"`
	}
	if !decode(w, r, &input) {
		return
	}
	if !s.requestAuthorized(w, r) {
		return
	}
	if input.ImageSource != "" && input.ImageSource != "ghcr" {
		fail(w, 400, "invalid_image_source", "只允许受控的官方GHCR镜像源。")
		return
	}
	if !s.requestLock(w, r, &s.mu) {
		return
	}
	defer s.mu.Unlock()
	i, err := s.readInstance(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "instance_not_found", "实例不存在。")
		return
	}
	j, err := retrySource(s.db, i.ID)
	if err != nil {
		fail(w, 409, "retry_unavailable", "实例已有活动任务或没有可重试的失败安装。")
		return
	}
	p, err := s.readPlan(j.PlanID)
	if err != nil || !sameRetryMaterial(p, i) {
		fail(w, 409, "retry_scope_mismatch", "原安装计划与保留实例不一致，拒绝重试。")
		return
	}
	p.PreviousImage = ""
	if input.ImageSource != "" {
		image, e := retryImage(p.AppID, p.Image, input.ImageSource)
		if e != nil {
			fail(w, 409, "image_source_unavailable", e.Error())
			return
		}
		p.PreviousImage, p.Image = p.Image, image
		if e = sourceHistorySafe(s.db, p.InstanceID, ""); e != nil {
			fail(w, 409, "retry_unsafe", e.Error())
			return
		}
	}
	p.RetryOfPlanID = p.ID
	p.RetryOfJobID = j.ID
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, err = s.checkRetrySafety(ctx, p, i); err != nil {
		fail(w, 409, "retry_unsafe", err.Error())
		return
	}
	if p.PreviousImage != "" {
		latest, e := retrySource(s.db, i.ID)
		if e != nil || latest.ID != j.ID || latest.PlanID != p.RetryOfPlanID {
			fail(w, 409, "retry_unavailable", "镜像源切换来源在检查期间已改变。")
			return
		}
		if e = sourcePlanLink(s.db, p); e == nil {
			e = sourceHistorySafe(s.db, i.ID, "")
		}
		if e != nil {
			fail(w, 409, "retry_unsafe", e.Error())
			return
		}
	}
	p.ID = randomID()
	p.ExpiresAt = time.Now().UTC().Add(30 * time.Minute)
	body, err := json.Marshal(p)
	if err == nil {
		var authorized bool
		err, authorized = s.requestDBMutation(w, r, `INSERT INTO plans(id,body) VALUES(?,?)`, p.ID, string(body))
		if !authorized {
			return
		}
	}
	if err != nil {
		fail(w, 500, "storage_failed", "无法保存重试计划。")
		return
	}
	s.requestRespond(w, r, 201, p)
}

// A failed creation without a recorded ID is uncertain, not proof of absence.
func sourceHistorySafe(db retryReader, instanceID, currentJobID string) error {
	var attempted int
	err := db.QueryRow(`SELECT count(*) FROM jobs WHERE json_extract(body,'$.instanceId')=? AND id<>? AND (json_extract(body,'$.stage')='start' OR EXISTS (SELECT 1 FROM json_each(json_extract(jobs.body,'$.stages')) WHERE json_extract(value,'$.name')='start'))`, instanceID, currentJobID).Scan(&attempted)
	if err != nil {
		return err
	}
	if attempted != 0 {
		return errors.New("实例曾尝试创建容器，无法证明未创建，禁止切换镜像源。")
	}
	return nil
}

func sourcePlanLink(db retryReader, p Plan) error {
	if err := validateRetryImage(p); err != nil {
		return err
	}
	if p.PreviousImage == "" {
		return nil
	}
	var body string
	var original Plan
	if err := db.QueryRow(`SELECT body FROM plans WHERE id=?`, p.RetryOfPlanID).Scan(&body); err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(body), &original); err != nil {
		return err
	}
	linked := p
	linked.Image = p.PreviousImage
	linked.PreviousImage = original.PreviousImage
	linked.ID, linked.ExpiresAt = original.ID, original.ExpiresAt
	linked.RetryOfJobID, linked.RetryOfPlanID = original.RetryOfJobID, original.RetryOfPlanID
	if !reflect.DeepEqual(linked, original) {
		return errors.New("镜像源切换与原安装计划的不可变范围不一致。")
	}
	return nil
}

func sameRetryBeforeEnqueue(p Plan, i Instance) bool {
	if p.PreviousImage != "" {
		p.Image = p.PreviousImage
	}
	return sameRetryMaterial(p, i)
}

func (s *Service) checkSourceExecution(ctx context.Context, p Plan, i Instance, j Job) error {
	if p.PreviousImage == "" {
		return nil
	}
	live, err := s.readInstance(i.ID)
	if err != nil {
		return err
	}
	if !sameRetryMaterial(p, live) || !reflect.DeepEqual(live, i) || live.ContainerID != "" {
		return errors.New("镜像源切换的实例身份已改变。")
	}
	if _, _, err = s.checkRetrySafety(ctx, p, live); err != nil {
		return err
	}
	// Docker/storage proofs may be slow. Check persisted intent and reservations
	// after those proofs, immediately before the caller's Pull or Run mutation.
	if err := sourcePlanLink(s.db, p); err != nil {
		return err
	}
	if err := sourceHistorySafe(s.db, i.ID, j.ID); err != nil {
		return err
	}
	if j.PlanID != p.ID || j.InstanceID != i.ID || p.InstanceID != i.ID {
		return errors.New("执行任务不属于当前镜像源切换计划与实例。")
	}
	var latest, active int
	var latestID string
	if err := s.db.QueryRow(`SELECT id FROM jobs WHERE json_extract(body,'$.instanceId')=? ORDER BY rowid DESC LIMIT 1`, i.ID).Scan(&latestID); err != nil {
		return err
	}
	if err := s.db.QueryRow(`SELECT count(*) FROM jobs WHERE json_extract(body,'$.instanceId')=? AND status IN ('queued','running')`, i.ID).Scan(&active); err != nil {
		return err
	}
	if err := s.db.QueryRow(`SELECT count(*) FROM jobs WHERE id=? AND plan_id=? AND status IN ('failed','needs_attention')`, p.RetryOfJobID, p.RetryOfPlanID).Scan(&latest); err != nil {
		return err
	}
	live, err = s.readInstance(i.ID)
	if err != nil {
		return err
	}
	if latestID != j.ID || active != 1 || latest != 1 || !sameRetryMaterial(p, live) || !reflect.DeepEqual(live, i) || live.ContainerID != "" {
		return errors.New("镜像源切换的实例、任务来源或活动预约已改变。")
	}
	return sourceReservationCurrent(s.db, j)
}

// Compare the entire serialized reservation as well as its indexed ownership.
// Stage/error/status evidence changed by another actor must never be resurrected.
func sourceReservationCurrent(db retryReader, j Job) error {
	body, err := json.Marshal(j)
	if err != nil {
		return err
	}
	var matches int
	if err = db.QueryRow(`SELECT count(*) FROM jobs WHERE id=? AND plan_id=? AND request_id=? AND status='running' AND body=?`, j.ID, j.PlanID, j.RequestID, string(body)).Scan(&matches); err != nil {
		return err
	}
	if j.Status != "running" || matches != 1 {
		return errors.New("当前镜像源切换任务的完整执行预约已改变。")
	}
	return nil
}

func (s *Service) saveSourceJob(j Job, expectedBody, expectedStatus string) error {
	body, err := json.Marshal(j)
	if err != nil {
		return err
	}
	result, err := s.db.Exec(`UPDATE jobs SET status=?,body=? WHERE id=? AND plan_id=? AND request_id=? AND status=? AND body=?`, j.Status, string(body), j.ID, j.PlanID, j.RequestID, expectedStatus, expectedBody)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errors.New("执行预约已改变，拒绝覆盖任务记录。")
	}
	return nil
}

func (s *Service) saveSourceInstance(i Instance, expectedBody string, j Job, jobBody, jobStatus string) error {
	body, err := json.Marshal(i)
	if err != nil {
		return err
	}
	// The instance snapshot and current reservation are fenced in one SQL write.
	result, err := s.db.Exec(`UPDATE instances SET body=? WHERE id=? AND body=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND plan_id=? AND request_id=? AND status=? AND body=?)`, string(body), i.ID, expectedBody, j.ID, j.PlanID, j.RequestID, jobStatus, jobBody)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errors.New("实例证据或执行预约已改变，拒绝覆盖实例记录。")
	}
	return nil
}
