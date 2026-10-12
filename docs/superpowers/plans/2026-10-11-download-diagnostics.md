# Protected download diagnostics implementation plan

> **For agentic workers:** Use subagent-driven-development and fresh scoped review.

**Goal:** Identify why real authenticated NAS file downloads fail without exposing headers, URLs, body, credentials or weakening validation.

**Evidence:** Normal H5 login, five actual file roots, real 640-byte `11.txt` info, compatible download -> task failed with zero received and generic error. No download event. Synthetic downloads previously passed. Actual missing/mismatched disposition, compression, lengths, status or transport must be distinguished before any behavioral fix.

## Global constraints

- Diagnostic instrumentation only. Preserve every existing download authorization, origin/redirect/filename/encoding/range/size/integrity/session/cancellation check and native behavior.
- No token/Cookie/URL/header/body/raw error or arbitrary diagnostic string in UI, events, logs, returned values or tests output. Use a finite static allowlist and fixed Chinese labels; unknown errors retain the generic message.
- No real NAS/GUI/SSH/network/deployment or user data operations by implementer/reviewer. Root reproduces via normal UI after source review.
- Preserve error code compatibility, partial-file truthfulness, downloads lifetime and other API operations. No broad dependency, auth, proxy or capability changes.

## Task 1: Safe failure classification through download task UI

**Files:** `apps/client/src/api/official-nas.ts`, focused API tests; `browser-download.ts/tests`; `modules/file-transfers.ts/tests`; narrow `FileTransfers.tsx/tests` only if needed. A focused shared diagnostic helper is permitted.

- [ ] Add/run red tests proving static classification for missing/malformed Content-Disposition, valid different filename, content encoding, invalid length, range/size mismatch, HTTP/transport/empty body; arbitrary upstream text/diagnostic and non-download errors stay generic with no private data.
- [ ] Add optional allowlisted diagnostic to OfficialNasError only where the existing download guards fail. Keep existing code/message contracts; no raw response field included. Response cancellation and body settlement behavior remain intact.
- [ ] Browser delivery observes only this recognized classification and preserves existing cancellation/session outcomes. Global transfer controller produces fixed human-readable failure text from the allowlist and records no raw exception. Existing worker safe diagnostics keep their established behavior.
- [ ] Verify static Chinese text at rendered task row and unknown-value privacy, context/expiry/cancel fences; run relevant SDK/browser/controller tests, full frontend/typecheck/build, diff check.
- [ ] Self-review, scoped commit and exact red/green report `.superpowers/sdd/download-diagnostics-report.md`; root owns review, actual repro and any subsequent protocol fix.

## Root acceptance

Use normal current H5 session and retry the same selected real small file once. Read the resulting static UI diagnostic; do not extract credentials, fetch through hidden SDK state, inspect raw authenticated requests or alter NAS files. If the classified failure requires a protocol change, first gather official implementation evidence and a focused red reproducer before a separate fix/review.
