# Shop Usability Repair Implementation Plan

> **For agentic workers:** Use executing-plans with scoped parallel investigation and implementation.

**Goal:** NAS users can select/create installation directories in the page, reach the public HTTPS catalog, and update latest while retaining their account and data.

**Architecture:** Keep the attested local engine and central catalog; repair root verification and directory registration, restore the actual domain route, and coordinate immutable runtime image replacement with durable state and rollback.

**Tech Stack:** Go/SQLite, React, Python, Docker Compose, Nginx.

## Global Constraints

- Preserve all user accounts, data, installed apps, 2FA and existing controllers.
- Use only usable sshbind aliases; no secrets in commands or reports.
- Keep AMD64 target and exact container/storage identity checks.

### Task 1: Installation directory flow

- [x] Add failing Go tests for fresh default-root verification and identity mismatch; creation requires auth, verified parent and fresh child.
- [x] Add failing frontend tests for direct candidate selection, explicit manual directory input, creation and resolved detection errors.
- [x] Implement root response verification and guarded directory creation; update StoragePicker and RuntimeInstall selection.
- [x] Run focused Go and frontend tests, then full affected suites/typecheck/build.

### Task 2: Domain and public catalog

- [x] Read-only PostgreSQL and anonymous fallback counts:176 published,163 pending,13 install entries.
- [x] Audit source Nginx and reproduce the reported HTTPS issue; current public/admin/icon requests pass from NAS, workstation and real Chrome. Historical intermittent trigger remains unconfirmed; do not claim a proven routing fix.
- [x] Verify actual shop displays all 176 entries with explicit adaptation status.

### Task 3: latest lifecycle

- [x] Test current r1 receipt upgraded to new image, retaining root/account/StoreID; unknown resources and drift remain rejected.
- [x] Implement journaled candidate switch, exact self receipt replacement, restart recovery and rollback; retain old stopped containers.
- [x] Tag and push version plus latest, anonymously verify equal AMD64 digests.
- [x] Upgrade isolated r1 QA and real NAS deployment; verify UI install flow without API-only registration.
- [x] Update all Compose examples/README files and source repository.
