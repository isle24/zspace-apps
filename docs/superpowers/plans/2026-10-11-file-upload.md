# PC/H5 File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development task-by-task, one implementer at a time; scoped review after each task and most-capable final combination review.

**Goal:** Implement complete bounded PC/H5 upload through official NAS interfaces with source/byte integrity, honest task lifetime and preserved existing data.

**Architecture:** Shared bounded hash core plus browser Worker; native picker/pinned source reads and browser File adapter implement one source contract. OfficialNas owns private upload protocol/session boundaries; global controller owns upload lifetime and Files/tasks UI. Go remains independent shop only.

**Tech Stack:** Existing React/TS/Tauri/dialog/cap-std; pin @noble/hashes2.4.0 for incremental MD5/SHA1/SHA256. No Flutter or new NAS business service.

## Global constraints

- Existing user approval covers full client/file module and upload to new directories (`2026-10-10-zspace-client-design.md:97-110`); runtime real login is postponed. Source work continues without exporting another app/tab credentials.
- Never delete/overwrite/rename existing NAS/local files, partial data, containers, prior packages, jobs or releases; no rollback cleanup. Creation readiness is not inode ownership proof.
- Official origin/routes only, no 8050 direct port or redirect expansion without new evidence/discussion. Unknown NAS behavior fails honestly, never fabricated success.
- No raw credential/local-path/file-content/errors in product diagnostics, Worker messages, task snapshots, persistent queues or logs. Synthetic tests only for implementers; root owns GUI/SSH/NAS acceptance.
- Current source/session/parent/cancel generations around every await; stale results cannot progress, refresh newer views or restore authorization. Source selection explicitly grants local file reading; no arbitrary host path command.
- Read/hash/send sequential bounded chunks, no whole-file buffering or small-file-only substitute; native/H5 both remain required. Full MD5 and SHA256 cover all bytes; quick fingerprint is explicitly separate.
- Windows/File-dialog/source metadata policies and native pointer cleanup are real platform gates, not inferred from TS tests. H5 Worker and large-file/native/formalHTTPS runtime remain separate.

## Task 1: Shared bounded hashing and browser Worker

**Files:** new `apps/client/src/api/upload-hashes.ts`, `upload-hashes.test.ts`, `upload-hashing.ts`, `upload-hashing.test.ts`, `apps/client/src/workers/upload-hash.worker.ts`; narrow package.json and root pnpm-lock.yaml. No SDK/UI/Rust/Go/proxy changes.

**Contract:** `UploadHashSource = {size:number,lastModified:number,read(offset:number,length:number,signal:AbortSignal):Promise<Uint8Array>}`; immutable metadata snapshot. `hashUpload(source,targetPath,{signal?,onProgress?}) -> Promise<{size:number,uuid:string,quickHash:string,md5:string,sha256:string}>`. Constant chunk cap2MiB. Worker wrapper `hashBrowserUpload(file:File,targetPath:string,{signal?,onProgress?})` uses File slice and Worker; no NAS credentials. Export static typed UploadHashError codes, no raw underlying cause.

- [x] Write observed red behavioral tests with independent Node crypto known vectors for empty/Unicode/path UUID numeric addition, full MD5/SHA256, quickHash at0/1/2048/2049 boundaries; avoid checking library against itself.
- [x] Test exact sequential offsets/cap, short/long/wrong-type/source failures, invalid metadata/path/pre-abort, abort during read/hash/late response; progress monotonic bounded and terminal once, no secret/raw-error echo, no additional reads after cancellation. A source larger than chunk cap proves bounded full coverage.
- [x] Implement pinned mature incremental hashes; UUID SHA1 UTF8 of String(lastModified+size)+targetPath; empty quickSHA1 of String(size), <=2048 full once, >2048 first/last1024. Validate safe integer metadata and sum, actual absolute target single filename/path components/control/UTF8 limits, preserve valid text/spaces.
- [x] Browser Worker implementation reads bounded File slices, avoids main-thread full hashing, forwards only bounded safe metadata/progress/results. Wrapper verifies operation identity/results, cancellation at START/after awaits, terminates/reclaims owned worker and rejects static errors; no blob/file/payload logs. Worker-unavailable is explicit unsupported, no silent unbounded fallback.
- [x] Focused red→green, typecheck/build once, scoped commit/report `.superpowers/sdd/upload-hashing-task-1-report.md`; independent reviewer checks source, Worker protocol and cancellation. No claim of real upload.

## Task 2a: Native selected source capabilities

**Files:** new `apps/client/src-tauri/src/upload_source.rs` and tests; narrow lib state/command registration, native capability/command contract tests and lifecycle hook only if needed. No SDK/UI/Go/proxy/network upload/crypto additions in this subtask. Existing dialog2.7.3/cap-std4.0.3; narrow direct declarations cap-fs-ext=4.0.3 and already-locked same-file=1.0.6 are allowed for nofollow/nonblocking opens and cross-platform handle identity. Use mature abstractions rather than handwritten OS constants/FFI; do not upgrade unrelated dependency versions.

**Contract:** `NativeUploadSource = {id:string,name:string,size:number,lastModified:number,sessionId:string}`; opaque64lowerhexid, safe nonnegative JS-integer metadata, basename only. `nas_upload_pick(base,cookie,session_id) -> Result<Option<NativeUploadSource>,static error>`: normal system picker, private current SDK native NAS identity binds an existing media/file-session cancellation lease, no network call. `nas_upload_read(id,session_id,offset,length) -> bounded binary IPC` with length<=2MiB, exact result/range, no arbitrary path argument. `nas_upload_release(id,session_id)` only own source; revoked/session-cleared sources unreadable.

- [x] TDD using synthetic current media-session lease and tempfile-owned ordinary files: metadata/opaque IDs/no path in output, read exact/empty/offset/chunk bounds, source regularity/symlink/ref replacement/size-mtime change, old session/foreign ID/cancel/release/prune, read result races and no original file changes.
- [x] Capture readonly pinned file handle once after user picker; never reopen by renderer path. Check actual handle identity/metadata around every read and owner cancellation before acceptance. Do not hold global registry locks over picker/IO/await. Use async/blocking bridge so file IO doesn't block native UI; no raw OS errors, paths or cookies in output/logs.
- [x] Bound idle source entries64 with8-hour idle expiry, reclaim cancelled/released/expired handles and subscriptions. Source release must cancel only that source, leaving independent media/download authority intact. Native NAS clear/expiry/exit revoke old source reads/handles; in-flight cancelled IO cannot return bytes to later context. No source selected means None, not fake success.
- [x] Normal dialog command only; no arbitrary filesystem read API, credential export, shell or new NAS URL route. Preserve existing download/media file leases and closure semantics. Focused Rust red→green, full Rust/check/fmt if integration changed, scoped review/report `.superpowers/sdd/upload-native-source-task-2a-report.md`. GUI/system picker/native runtime remain root gates when SDK/UI consumes this source.

## Task 2b: Native bounded off-thread hashing

**Files:** new `src-tauri/src/upload_hash.rs`/tests, narrow crate-private SourceState helper/command registration and Cargo declarations/lock. No SDK/UI/proxy/NAS upload HTTP routes. Task2a reviewed source contract is authoritative.

**Dependencies:** pin mature RustCrypto md-5=0.10.6, sha1=0.10.6, alreadylocked sha2=0.10.9 to match existing digest0.10.7. No handwritten crypto or unrelated upgrades. Primary references: [MD5](https://docs.rs/md-5/0.10.6/md5/), [SHA1](https://docs.rs/sha1/0.10.6/sha1/), [SHA256](https://docs.rs/sha2/0.10.9/sha2/).

**Contract:** `nas_upload_hash(id,session_id,operation_id,target_path) -> {size,uuid,quickHash,md5,sha256}`; `nas_upload_hash_cancel(id,session_id,operation_id)` cancels exact hash job only, not selectedsource/NAS/media/downloads. operation_id32lowerhex, sourceid64lowerhex/publicsession; canonical actualpath<=8192 UTF8/components<=255. Progress `nas-upload-hash-progress:{operationId,sourceId,sessionId,processedBytes,totalBytes}` without path/name/cookie/source bytes.

- [x] Independent known vectors shared with TS/Python for empty/small/2048/2049/tail crossing2MiB, Unicode target, UUID numeric mtime+size addition and full-file MD5/SHA256; no self-library expected values.
- [x] Bounded native blocking worker uses reviewed source reads and before/after/join authority/TTL checks. At most4 active hash jobs, one per source, no global lock over IO/hash/emit. Observe cancellation beforestart/afterread/progress/digest/latejoin and sourcechange/release/sessionclear/expiry; cancelled old cleanup cannot clear newjob.
- [x] Static errors/no raw causes/credentials/absolutepaths, monotonic capped confirmedhashprogress one terminal including empty; synchronous emission is ordered with cancellation/source/session teardown, with exact job/source/session/generation checks on emission and finalaccept. Already dispatched webview frames need current-operation consumer filtering in Task2c1. Snapshot source metadata for whole pass, quick samples from that fullpass, never copy whole file. Source remains valid/readable for upload after hash-only cancellation.
- [x] TDD focused then necessary fullRust/check/fmt, freshscopedreview/report `.superpowers/sdd/upload-native-hash-task-2b-report.md`. No actualGUI/native performance/NAS/productionIPC claims from tests; Root later integrates normalUI and bytes.

## Task 2c: Official upload transport and source adapters

**Files:** new SDK upload helper/tests integrated narrowly into OfficialNas/Gateway; adapters consume reviewedNative2a/2b and BrowserTask1; exact native/proxy upload/tmpinfo routes/tests. Do not grow broad NAS business read map or add Go endpoints; no main-thread whole-file hashing or whole-source File construction.

- [ ] Pin user-selected normal files as opaque memory refs, bounded binary IPC reads with exact source identity/size/mtime and current owner/session; symlink/path replacement and revoked/closed refs cannot read other files. No absolute paths or raw filesystem errors exported.
- [ ] Source/browser adapters consume Task1 hashes; authoritative parent/new-directory/target absence checks and exact path/name. Existing/uncertain file or partial task is preserved, not overwritten/reused automatically.
- [ ] Direct official POST `/v2/file/upload?remote_port=8050`, octet-stream and verified headers; split1, confirmed seek, fixed non-overwrite mode, full MD5/complete on final chunk. No source-selected URL/cookie, redirects, stale session, credential echo or arbitrary header transport. Empty file sends an explicit terminal request.
- [ ] Progress only on validated official success; explicit conflict, corruption, source change, partial/query mismatch, timeout/cancel/expiry and actual readback checked. Ambiguous dispatch retains mayHavePartial. Pause/resume only current retained source/hash/UUID/target confirmed partial, never old unknown data.
- [ ] TDD adversarial sequences/byte content plus native selection/read/identity and exact allow/deny scope, focused/full appropriate TS/Rust checks, independent scoped review. Real route/fields cannot be widened based only on synthetic fixtures.

### Task 2c1: Session-owned PC/H5 source adapters

**Files:** new `apps/client/src/api/upload-sources.ts` and focused tests, narrow integration and tests in `official-nas.ts` and `client.ts`. Consume the reviewed Task1/2a/2b contracts unchanged; no proxy, HTTP upload, Go or UI changes in this subtask.

**Interfaces:** SDK exposes `selectBrowserUploadSource(file: File)`, `pickUploadSource()`, and `releaseUploadSource(sourceId: string)` returning only opaque source IDs, safe basename, size, lastModified and public sessionId. SDK-private source records hold the actual File/native ID and the captured Active/generation; later transport accesses the adapter inside the SDK. Each adapter supplies bounded `read(offset,length,signal)`, `hash(targetPath,{signal,onProgress})`, and idempotent `release()`. UI must not receive an adapter, File, native path, credentials, arbitrary endpoint or header map.

- [x] Write focused failing tests for File/native selection, actual binary read shapes and exact lengths, empty reads, safe metadata/name, bounded sequential reads and captured-owner checks. Include a late native picker result after logout/new login that is released using the old public session ID.
- [x] Implement H5 File.slice reads at most2MiB and Task1 Worker hashes. Implement native commands through existing dynamic imports; register the Task2b progress listener before invoking hash, match operation/source/session, strictly validate monotonic bounded progress and terminal digest shape/expectedUUID, and unregister on every terminal/cancel/import/listen/invoke failure.
- [x] Test and implement current-session/abort checks before and after each asynchronous step, callback reentry, source release, and stale native event/result rejection. Exact native hash cancel retains the selected source; release drops only that source. Never expose native raw errors or serialize whole file bytes.
- [x] Keep at most64 source records; release/cancel old records on logout, new login and native expiry. Resource cleanup captures the old owner and cannot delete a new record or affect unrelated media/downloads. Run focused red/green tests, relevant frontend suite/typecheck/build and scoped review; report source-only evidence and open GUI/platform gates.

### Task 2c2: Fixed official wire protocol and retained upload state

**Files:** new `apps/client/src/api/official-upload.ts` and tests, narrow OfficialNas/Gateway integration, `apps/client/dev/nas-proxy.ts`/tests and exact native capability/contracts updates. Consume Task2c1 opaque source registry and Task1/2b hashes.

- [ ] Implement a credential-free sequential state machine with private SDK callbacks for target preparation, partial query, bounded chunk send and final info. Capture immutable target/source/session and a run epoch; keep locks through pause. Confirm bytes only after bounded validated official success; preserve mayHavePartial immediately after dispatch, and never auto retry/reset/adopt unknown partial.
- [ ] Use fixed POST `/v2/file/upload?remote_port=8050`, raw0..2MiB, split1, rename0, confirmed seek, original metadata and SDK-owned encoded token/device headers. Terminal chunk sends full MD5 as fileHash and `fileHashCheckOption:complete`; no independent complete=1. Empty files send one zero-byte terminal request. tmpinfo is fixed GET with query onlypath/uuid and auth in headers, rather than the generic GET helper that adds token to URL.
- [ ] Implement strict exists/absent/unknown preparation from raw bounded official envelopes. Do not treat N001320, HTTP404, permissions, missing shape/total or normalized empty arrays as absence. Preserve unknown exact missing responses as a real-NAS evidence gate; synthetic fixtures may exercise a supplied evidence policy but cannot install an invented official absence code. Use raw complete list/ordinary info only with explicitly checked shape and honestly documented server-semantics limits.
- [ ] Pause after a currently dispatched chunk has validated success; cancel/session loss aborts immediately. Resume only the same retained source and all hashes, current target and strict tmpinfo size equal to retained confirmedBytes and less than full size. Final info must explicitly match path/name, ordinary file type and exact size, includingzero; confirmed full bytes alone is not completed.
- [ ] Add route-specific binary proxy buffering and encoded header-to-Cookie bridge with exact query/method/header validation, duplicate/control/encoding/size rejection and explicit request header budget; retain other64KiB form behavior. Add only exact upload/tmpinfo native path scopes, without claiming ACL enforces method/query/selected origin.
- [ ] Run adversarial byte concatenation/empty/finalMD5/conflict/partial/callback/session/timeout/readback tests and exact proxy native scope tests, then scoped review. Normal NAS login, actual missing/hidden/partial semantics, rename0 atomic behavior, 5055 route acceptance, native picker/IPC and formal H5/HTTPS remain root runtime gates.

## Task 3: Global upload tasks and Files UI

**Files:** upload controller/adapter and tests, narrow Files action/modal and tests, App/task center composition, local styles. SDK/Rust contracts frozen/reviewed.

- [ ] User picks source and confirms actual new destination; hash/upload queue survives Files closure, distinguishes upload/download/installation, verifies current NAS/source/parent before start. Start/duplicate/cancel/pause/resume/failed/uncertain/real-completed state tests with real contracts.
- [ ] Safe display names/counts, explicit conflict/new-name choice retaining old content, no overwrite/delete/automatic retry controls. Native picker and H5 File input accessible; modal focus and mobile actions remain usable.
- [ ] Account/logout/unmount/task return race tests preserve global lifetime without stale authority; old parent refreshes cannot affect new UI. Bounded queue/resource ownership, no persistent private payload or token.
- [ ] Scoped then whole-checkpoint review; root actual synthetic browser/native byte flows/large/empty/conflict/partial/cancel/source replacement/old marker, updated Mac ZIP preserving old packages. Real NAS own-new-directory SHA256/marker, native/formalH5/HTTPS gates separate; remaining media/system/official integration/autostart/global goal remain active.

## Task 1 gate evidence

Sourceabfa1e0 approved independently:101focused,806fullfrontend/typecheck/build. Root real same-origin IAB/production Worker selected actual9MiB file and all hashes matched independentPython,128MiB cancellation was timely and a new emptyFile operation succeeded; original source unchanged. No NAS request/upload. Followupfa7f19a aligns full targetlimit8192 with existing directory policy,4observedred->109focusedgreen/typecheck; final minor re-review Approved with no open findings. Production UI/native/upload transport remain later tasks, not proven by this hash gate.

Task2a sourcegate approved through6cd876c: TTL P2 pendingfinish/afterIO/postjoin fixed after observed3red;31focused/69fullRust/check/fmt/sourcegate andfreshre-review passed. RealGUI/platform stillpending. Task2b usesnativeoffthread hashing, Task2c retains completeofficialupload/partial/empty/conflict/newdirectory transport, Task3 retainsglobalUI/rootliveverification. No narrowingofPC/store/fullgoal.

Task2b sourcegate approved through1c02820: initial644e1eb85Rust tests/check/fmt; review found one P2 lifecycle/output ordering gap. Four actual blocked-emitter regressions observed red→green, final52 relevant hash/source tests/check/fmt/diff/sourcegate passed, fresh scoped re-review Spec/QualityApproved with no open findings. Metadata is verified at the final blocking verification point, followed by current authority checks; mutable external files are not atomic through IPC receipt. Task2c1 must reject stale dispatched frames and verify the same selected source around every read; actual native GUI/platform and NAS upload remain pending.

Task2c1 sourcegate approved through5dd34d1: initialf1ec023391focused/877fullfrontend/typecheck/build and emitted productionWorker. Review P2 pending picker setup/cleanup cancellation closed after6observedred→green regressions; final397covering/typecheck/build/diff scopedgate, fresh re-review Spec/QualityApproved/noopenfindings. Shared SDKlistener survives old-source cancellation, captured oldnative cleanup is handled without holding the revoked caller. Browser/native source descriptors and private adapters are wired; actual UI/picker/binaryIPC/eventdelivery/platform/NAS/formalHTTPS remain futuregates. Task2c2 consumes #uploadSources privately, thenTask3 integrates globaltasks/UI.
