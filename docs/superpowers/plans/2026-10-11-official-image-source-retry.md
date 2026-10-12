# Official image source retry implementation plan

> **For agentic workers:** Use subagent-driven-development for implementation and fresh scoped review before deployment.

**Goal:** Retry the approved failed Uptime Kuma installation with its official GHCR image while retaining the original instance, data, port and history.

**Architecture:** Extend the existing immutable retry plan with a server-controlled source choice. The reviewed plan records both previous and selected image; source migration is permitted only while no container was ever recorded or exists. Enqueue atomically retains instance/provenance and updates the intended image. Execution repeats source and absent-container checks before pulling/running. Existing same-image retries continue unchanged.

**Tech Stack:** Go/SQLite, controlled Docker engine, React/Vitest.

## Global constraints

- Never delete NAS files, application data, containers, previous jobs or plans.
- Do not change official 5055, global Docker settings, NAS credentials or unrelated services.
- The only new source is `ghcr.io/louislam/uptime-kuma:2.5.6`, equivalent to the existing `louislam/uptime-kuma:2.5.6` recipe version; other registry, tag, repository and arbitrary image inputs are rejected.
- Preserve instance ID, container name, directory, provenance, mounts, publish/access addresses and ports. Original plans/jobs remain immutable.
- Source changes require an explicit retry-plan choice and visibly reviewed previous/new source before install. Never silently fall back or upgrade.
- Reject source changes for any recorded or existing container, including owned stopped containers or uncertain creations. Never replace/adopt them.
- Check latest terminal job and active-job reservations, directory/volume identity and container absence at plan generation, enqueue and execution. Stable request IDs remain idempotent and atomic.
- All writes require authenticated shop administrator sessions. No credentials in logs/docs/commits.

## Task 1: Backend controlled source migration

**Files:** `server/internal/store/retry.go`, `types.go`, `service.go`, `engine.go`, relevant job runtime file; tests `retry_test.go`, engine tests as needed. A small focused image-source helper is allowed.

**Interfaces:** Existing `POST /api/store/instances/{id}/retry-plan` accepts optional `imageSource: "ghcr"`; `{}` retains the image. Returned Plan adds `previousImage` only for an explicit source change. Stored plan is authoritative; install accepts only planId/requestId. Catalog exposes a controlled retry source choice if needed, without making arbitrary image strings executable.

- [x] Write and run red regressions for original Hub pull failure -> GHCR reviewed retry -> original instance/provenance/port/data/history retained.
- [x] Cover default same-image behavior, malicious/unknown inputs, latest-job drift, duplicate submissions, old request ID, owned/foreign/uncertain container, missing/mismatched provenance, source change race before enqueue and execution.
- [x] Implement one central controlled source mapping/validation, immutable previous image linkage and transactional intended-image update.
- [x] Existing retained-container retry remains unchanged; source-change safety proves absence at every mutation boundary.
- [x] Run focused tests and Go full race/vet, self-review, commit scoped files, report `.superpowers/sdd/image-source-task-1-report.md` with exact red/green commands/results and concerns.

## Task 2: Visible source choice and retry review

**Files:** `apps/client/src/modules/Store.tsx`, `Store.test.tsx`, necessary focused styles/types.

**Interfaces:** Explicit source selection sends `imageSource: "ghcr"` only for supported Uptime Kuma same-version retry; default request stays `{}`. Review displays both previous and new image, original instance/data/port and uses existing confirmation guard.

- [x] Write/run red UI tests for default unchanged, explicit source choice -> visible review before install, denied unsupported versions, session/service changes, no silent retry.
- [x] Implement selection in the failed-instance retry flow and previous/new image review with existing plan confirmation component.
- [x] Run focused Store tests, full frontend suite/typecheck/build, self-review, commit scoped files and write `.superpowers/sdd/image-source-task-2-report.md`.

## Runtime acceptance

After both fresh source reviews, build linux/amd64 shop and updated frontend, deploy additively to the existing owned release root, preserving DB/admin/data and all releases. Stop only the recorded own service after exact PID/UID/executable/startTicks/active-job checks. Use normal authenticated UI to show GHCR retry plan for instance `748981f8a463762b328a80845e183da6d7df470a95bb8f6a`, data in the existing dedicated NVMe root, port 3001, then execute the human-approved source retry. Record actual image/container identity, terminal job, health and initialization separately. No success claim from registry metadata or source tests alone.


Source checkpoint: backend `08f6f3b` and frontend `271e9ca` scoped/final reviews pass. Root synthetic desktop and mobile confirmations preserve original instance/history; 614 frontend tests, Go race/vet and Mac local build pass. NAS additive release `20261011T050739Z-4de74490` is healthy and preserves the existing admin/job/instance/data/3001. Actual GHCR plan/pull/container/health/initialization remains pending normal standalone login. No full PC/shop completion claim.
