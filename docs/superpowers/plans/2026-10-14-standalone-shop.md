# Standalone NAS Shop Implementation Plan

> **For agentic workers:** Use executing-plans and subagent-driven-development for scoped implementation and independent review. Steps use checkbox syntax for tracking.

**Goal:** A NAS player deploys only the shop, creates a local account in its web page, and installs applications without third-party desktop login.

**Architecture:** Package the existing installer engine and storefront in a dedicated image. A Docker bootstrap service creates and attests a non-root managed runtime with existing storage and ownership rules, retaining its receipt and all data. Opt-in LAN setup opens only the first independent administrator creation.

**Tech Stack:** Go, React, Python 3.13, Docker CLI 27.3.1, Compose 2.32.4, SQLite.

## Global Constraints

- Preserve current NAS UI, managed controller, cloud accounts, signing keys and database.
- Use only usable sshbind aliases; no credentials in commands, files or reports.
- New DockerHub image supports linux/amd64; do not claim other architectures.
- Do not weaken existing runtime ownership, storage, provenance or manifest validation.

### Task 1: Independent browser account setup

- [x] Add failing Go tests for explicit LAN setup, denied public/proxied/foreign requests, repeat setup, password login, and unchanged default loopback policy.
- [x] Add `SetupMode` to `store.Options` and `--setup-mode` to the gateway, validated for independent storefronts.
- [x] Expose `setupRequiresLoopback` accurately and pass it into `StoreAuth` for the creation instructions.
- [x] Run focused Go auth tests and storefront tests/typecheck.

### Task 2: Docker bootstrap and lifecycle

- [x] Add Python tests for dedicated storage choice, unsafe paths, exact receipt validation, first deployment, restart and exact service stop.
- [x] Add `docker/shop/bootstrap.py` with fixed bounded Docker commands, metadata-only discovery, fresh-directory initialization, existing helper-generated managed runtime shape, durable receipts and signal handling.
- [x] Build `docker/shop/Dockerfile` from the current shop, gateway and pinned tooling; add `deploy/dockerhub/compose-standalone-shop.yaml` with no external files or third-party UI dependency.
- [x] Test refusal to adopt unrelated containers or an existing data directory.

### Task 3: Runtime acceptance and publication

- [x] Run the new image on a clean NAS port and new dedicated directories.
- [x] Verify web setup/login/logout/restart, engine readiness and storage identity; perform a real application install and HTTP health check.
- [x] Publish versioned and latest `isle204/zspace-shop` images, verify anonymous AMD64 registry manifests.
- [x] Update deployment docs and both GitHub README files; preserve sanitized source publishing workflow.
- [x] Deliver a concise pasteable Compose and browser address with exact verified limits.
