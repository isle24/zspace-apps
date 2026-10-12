# Complete File Downloads Implementation Plan

> **For agentic workers:** Use subagent-driven-development task by task, with a fresh scoped spec/quality review before the next implementation task. The full approved client spec includes file download and shared transfer tasks; this plan implements that scope without changing NAS business services.

**Goal:** Save complete NAS files to the user's device with progress, cancellation, authentication isolation and preservation of existing files.

**Architecture:** The direct SDK creates current-session opaque download capabilities from actual returned file identity. Native transport streams official download bytes into a new user-selected file using the system save dialog and pinned directory authority. H5 uses guarded SDK fetch and a same-origin streaming browser delivery path, with a bounded fallback where platform capabilities are missing. Transfer state lives outside application subwindows, separately from shop jobs.

**Tech Stack:** Existing React/TypeScript/Vitest, Tauri/reqwest, native Tauri Dialog, capability directory file access, browser streams/service worker.

## Global Constraints

- No NAS writes, file deletion, movement, existing service/configuration changes, new NAS listening ports, credential extraction or GitHub publication.
- No existing local file overwrite or truncation, including empty files and symlinks. Failed/cancelled newly created partial output is retained and explicitly reported incomplete; it must never be reported successfully saved.
- Native destination comes exclusively from a native save dialog, never a caller-supplied path. Pin chosen directory authority and create only a new single-component filename.
- Only the current NAS origin and verified single-file GET `/v2/file/download` or `/v2/file/decrypt/download`. Direct official requests only; Go remains the independent shop. ZIP directories are a separate future feature.
- Native/public task data and DOM URLs must contain no NAS URL, Cookie, token, sign or raw upstream body/error. Download capabilities are opaque, private-session bound, memory-only and invalidated by logout/replacement.
- Download is not renderer playback: legal JSON, SVG, HTML, text and large video files may be saved as files, but download references cannot be rendered as trusted media. No whole-video Blob shortcut in the native path.
- Reject redirects and wrong/partial response identity. Validate authoritative known size when available, declared response length and complete range semantics; a successful EOF alone does not override a mismatch.
- Closing a Files subwindow does not cancel a transfer. Explicit cancel/logout does. App exit and browser page unload behavior is reported truthfully.
- Preserve the complete PC/shop objective; this checkpoint does not replace upload/new folders/search, system writes, media streaming, official entries, real installation or formal H5 deployment.

## Shared contract

```ts
export type FileDownload = {
  id: string; // opaque 64-hex capability, never a URL
  name: string;
  size?: number;
  sessionId: string; // non-secret local SDK session identity
};
export type FileTransfer = {
  id: string;
  sessionId: string;
  name: string;
  received: number;
  total?: number;
  status: "choosing" | "running" | "completed" | "failed" | "cancelled";
  message?: string;
  retainedPartial?: boolean;
};
// SDK: prepareDownload(item:Item): Promise<FileDownload>
// Browser SDK: fetchDownload(id:string,{signal?:AbortSignal}): Promise<Response>
// Native commands: nas_download_register (private SDK only),
// nas_download_start(reference:string), nas_download_cancel(taskId:string),
// nas_download_tasks(sessionId:string).
// Native event: nas-download-progress with safe FileTransfer data only.
```

## Task 1: Native complete save transport and direct SDK capabilities

**Files:** new `apps/client/src-tauri/src/download.rs` and tests; narrow integration in `media.rs`, `lib.rs`, `Cargo.toml`/lock; `apps/client/src/api/official-nas.ts`, tests and `client.ts`, tests; exact proxy/guard updates where needed. No File/Store UI edits in this task.

**Evidence:** Public official download code in `docs/research/2026-10-11-file-transfer-evidence.md` uses the two exact single-file paths with path/encrypted_path/from, webagent=v2, request_purpose=5 and show_hidden. Normal file-info exposes real path/name/size/is_dir. Native dialog and cap-std APIs are mature components; plain File::create or generic upload plugin defaults cannot preserve existing output.

- [x] Add red SDK tests for exact normal/encrypted download source fields, opaque descriptor shape/no credentials, directory/missing identity rejection, unknown size omission, logout/replacement invalidation and stale registration/metadata response. Identity comes from actual item/returned file info, not a display title. Do not invent an unverified encrypted info endpoint.
- [x] Keep browser URLs in a private SDK capability map and native URLs in private Rust reference state. Share normal-session cancellation/expiry with existing media without exposing file capabilities to the renderer or adding NAS APIs. Provide `Gateway.prepareDownload/fetchDownload` with the established generation-fenced expiry handling.
- [x] Add red native transport tests using synthetic HTTP and owned temporary directories: complete >8 MiB bytes, empty file, JSON/SVG/text/video content, expected/declared size mismatch, incomplete range, redirect/auth expiry, cancellation and old session. Compare the actual saved bytes to the complete fixture.
- [x] Add red destination tests: an existing regular file, empty file and symlink remain byte-for-byte unchanged; duplicate start cannot open a second dialog/write; parent replacement cannot redirect a write; dialog cancellation makes no file; old authority after a delayed dialog is rejected. Use injectable test dialog selection without exposing a production path argument.
- [x] Implement streaming reqwest reads with bounded chunks, connect/inactivity timeout, current session/task cancellation, safe error messages and complete response checks. Require unambiguous official file response identity (attachment/filename or equivalent proven metadata), preserving legal non-media files; document any header assumption requiring live confirmation.
- [x] Native save uses Tauri Dialog in Rust and pinned directory/create-new semantics. Never call truncating File::create. Keep unsuccessful new partial output, flush/sync before completed, and show retainedPartial on interrupted tasks. No automatic opening/execution of saved files.
- [x] Publish safe scoped task progress and a session-filtered task snapshot. Start/register/list/cancel command inputs are bounded; no arbitrary URL/header/path operation is added.
- [x] Run focused SDK/Rust tests through red→green, full frontend/typecheck, Rust tests/fmt, production compile; report exact evidence and freeze for fresh review. Root owns local commits, packaging and real NAS acceptance.

## Task 2: H5 complete browser delivery

**Files:** new `apps/client/src/api/browser-download.ts` and tests, self-hosted browser delivery assets/service worker as needed; no server NAS business API.

- [x] Use the reviewed private SDK download capability/fetch flow. Begin download through user interaction, keep URLs containing authentication out of DOM/navigation/history and worker registrations, and preserve cancellation/session fences while streaming.
- [x] Prefer a same-origin self-hosted browser stream delivery. Mature StreamSaver was inspected; its default external MITM must never receive this application's data. If used, vendor/license/pin and self-host the required assets, with exact same-origin checks and no default GitHub/CDN fallback.
- [x] Add red tests for backpressure/complete large files, legal text/JSON/SVG, no third-party requests, stale worker/nonce/session, cancellation, partial bodies and capability expiry. Test service-worker unavailability and a bounded Blob fallback with clear size/platform feedback, never a silent truncated result.
- [x] Status distinguishes verified bytes handed to browser from confirmed native filesystem save; browser manager final disk outcome is not claimed without evidence. Page unload aborts and reports incomplete behavior; subwindow close keeps transfer state.
- [x] Run scoped/full checks and actual browser fixture download/hash comparison before review. Formal NAS/mobile deployment and browser/platform compatibility are separate acceptance gates.

## Task 3: File action, global transfer state and task view

**Files:** focused `FileTransfers.tsx` and state/tests; Files integration in `NasModule.tsx`; client task window/App and necessary styles.

- [x] Add red tests for user-selected file download, scoped progress, duplicate prevention, native save cancellation, window close/reopen, explicit cancel, old session/service data rejection and failed/retained partial output.
- [x] Connect “下载到本机” to the reviewed native/browser implementations; disable directories and missing identity with precise feedback. No popup passwords, unverified sample content or silent browser navigation to a raw NAS token URL.
- [x] Display filename, transferred bytes, known total/progress, Chinese status, cancellation and failure; do not fake totals. Separate these local transfers from NAS download-center tasks and independent shop installation jobs while keeping a usable task window.
- [x] Run full checks, fresh scoped review and local Mac build preserving existing ZIPs. Actual NAS normal sessions, real downloads/hash comparison, native save dialog and mobile H5 remain mandatory acceptance evidence.

## Checkpoint result

Source Tasks 1–3 complete through `2b11f6e`, including scoped and whole-checkpoint review. The checked source tasks record implementation and their available synthetic/source evidence; they do not close the following platform gates. The actual default worker download did not complete in the current IAB. Compatible downloads, integrity failures, logout, in-flight window close, cancellation and explicit retry passed using owned synthetic services. Latest local Mac package built successfully; native GUI and real NAS acceptance remain open. Details: `docs/verification/2026-10-11-file-downloads.md`.

## Runtime gate

Existing unlock/login/official GHCR source questions are pending. Do not repeat or infer answers. Synthetic servers and temporary local files may prove byte/flow behavior, never real NAS authorization or full completion. No real NAS write or local overwrite test is performed against user data.
