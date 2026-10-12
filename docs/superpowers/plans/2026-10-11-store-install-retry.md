# Store Install Retry Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the scoped backend and UI tasks, with task review before integration.

**Goal:** Recover a failed application installation using its original instance, directory and port, without deleting data, replacing containers or losing the failed task record.

**Architecture:** The authenticated shop creates a new immutable retry plan linked to the failed installation. Confirmation enqueues a new job, retaining instance identity and directory provenance. Runtime preflight verifies current volumes, paths and containers before resuming. The PC/H5 shop reuses its reviewed plan confirmation and initialization flow.

**Tech Stack:** Existing Go/SQLite shop, controlled Docker/sshbind engine, React/Vitest client.

## Global Constraints

- Never delete NAS files, application data, existing containers, prior jobs or prior plans.
- Preserve instance ID, data path, mounts, publish/access addresses, container name and recipe image on a retry; no silent recipe upgrade.
- Retry plans are server-created and immutable. Original accepted plans remain unchanged, including expiry timestamps.
- Authenticated shop administrators only; an old or foreign session cannot enqueue tasks.
- Active jobs are not restarted or duplicated; request IDs remain idempotent and atomic claims prevent double execution.
- Directory, media volume and Docker cache identities must still match the accepted scope. Existing directories require the recorded owned provenance.
- Never adopt or overwrite a foreign container. An uncertain created container must pass complete label/image/mount/port and directory ownership checks before recovery.
- A retained container is resumed via safe start/health handling, not recreated; unresolved ownership must return needs_attention.
- No changes to the official NAS 5055 service, global Docker configuration or credentials.

## Task 1: Backend retry plans, enqueue and recovery

**Files:** `server/internal/store/service.go`, `types.go`, new `retry_test.go`; runtime engine only where the existing provenance helpers need a narrow extension.

**Interfaces:** `POST /api/store/instances/{id}/retry-plan` returns a normal Plan with a server-owned retry linkage; `POST /api/store/install` with that reviewed plan and a fresh stable requestId returns Job. Existing schema's unique plan_id remains valid because each retry gets a new immutable plan ID. `Instance.ID` and ownership are retained.

- [x] Reproduce failed pull → retry with the same instance/data directory/port, preserving original plan/job records and sentinel application data.
- [x] Add concurrent duplicate submission, active-job rejection, expired original plan, changed volume/provenance, foreign container and uncertain owned creation regression cases; run them red before implementation.
- [x] Clone only the original accepted material scope into a fresh retry plan; store retry linkage server-side, not trusted frontend fields. Check failed/needs_attention state and original instance mapping before accepting.
- [x] Enqueue transactionally against the existing instance. Never insert a replacement instance or discard provenance; repeated request ID returns its existing job.
- [x] Make execution distinguish a fresh directory from verified owned retained data, and absent containers from fully verified owned recovery; rerun safety checks before any pull/start/run.
- [x] Run `go test -race ./internal/store -count=1` and `go vet ./internal/store`; perform scoped spec/quality review.

## Task 2: Reviewed retry UI and readable task progress

**Files:** `apps/client/src/modules/Store.tsx`, `Store.test.tsx`, necessary styles.

**Interfaces:** Existing failed/needs_attention instance exposes “生成重试计划”; UI displays the returned immutable material scope and explicitly confirms it before `confirmInstallation(api, plan, plan.id, requestId)`; returned Job participates in existing completed/running/healthy initialization tracking.

- [x] Test that retry never sends install before plan confirmation, uses the same instance, cancels stale service/session plans, and cannot submit an active task twice.
- [x] Display application name and Chinese stage/status labels instead of only opaque instance IDs. Retain raw identifiers only as optional task details.
- [x] Reuse the installation review component or extract a small shared review component; do not duplicate plan rendering/confirmation logic.
- [x] Run focused Store tests, frontend typecheck and full suite; review changes before rebuilding.

## Runtime acceptance

The real Uptime Kuma attempt failed during pull; anonymous registry probes from NAS and Mac currently time out. Diagnose available official image delivery without changing global Docker configuration. A retry is accepted only after authoritative task state is terminal, and only under the user's confirmed Uptime Kuma directory/3001 scope. Source tests alone do not prove actual installation, health or initialization.

Record image delivery provenance and real container identity separately. Do not mark the full PC/shop goal complete after this checkpoint; media decoding, official entry integration and the other client module requirements remain in the completion audit.

## Source and deployment checkpoint

Backend source and scoped review passed after repairing final guarded Resume checks for retained and ordinary Start. Retry UI and private request session guards passed review after fixing latest-job eligibility, deferred session swaps and stale logout cleanup. Frontend 230 tests, Go full race/vet, Rust 18/fmt and deployment 8 regressions passed. NAS shop updated additively to release `20261010T173524Z-92d4b3ab`, PID 868698; preserved DB still contains one failed original job and one original instance. Actual retry confirmation, source selection, image layers, container health and initialization remain pending; no installation success is claimed.
