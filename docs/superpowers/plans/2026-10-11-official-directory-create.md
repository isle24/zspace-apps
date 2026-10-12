# Official Directory Creation Implementation Plan

> **For agentic workers:** Use subagent-driven-development sequentially, with a fresh scoped spec/quality review per task and a final checkpoint review. This is part of the already approved complete Files client scope; upload remains the next transport work, not replaced by this milestone.

**Goal:** Let the user request a new directory through the official NAS interface, preserve existing data, validate the returned directory, and report ambiguous outcomes honestly.

**Architecture:** An explicit OfficialNas/Gateway action validates the actual current-session parent using official file info, posts only parent/name/rename0 to the verified newdir route, retains the private outer timestamp, then reads back the returned directory. Files uses the existing desktop modal/action language and fences late completions by session and parent. Go stays the independent shop.

**Tech Stack:** Existing React/TypeScript/Vitest, native HTTP URL capabilities and fixed-target Vite transport; no new dependencies.

## Global Constraints

- No deletion, movement, replacement of existing data, automatic rename, permissions/global settings changes, rollback cleanup or automatic mutation retry. Production creation uses only exact POST `/v2/file/newdir` with `rename=0`; remove/modify/clean/recycle routes remain blocked.
- Client NAS actions use direct official APIs. Go remains the independent shop; no NAS REST service is added. Native HTTP plugin capabilities are exact URLs and do not independently enforce methods; SDK and development guard constrain POST.
- No real NAS writes or credentials/GUI/server access by agents. Runtime acceptance uses root-owned synthetic services first. The root may later validate only freshly named own test directories through normal authorized login; existing NAS data must never be an overwrite/delete experiment.
- Parent/path/name/kind come from actual returned official metadata or explicit new-name user intent. Do not use display labels to construct existing-file identity. Reject encrypted/unsupported parents instead of inventing an encrypted write endpoint.
- Current session/generation, cancellation and expiry fences survive every await. Logout/replacement aborts outstanding directory operations; old success/expiry cannot change a newer session. No Cookie/token/sign/raw body/error/credential URL escapes SDK private state.
- Before dispatching newdir, failure/cancellation cannot create a directory. After dispatch, network/abort/malformed/stale outcome may mean a directory was created; report `mayHaveCreated=true` and suggest reread, never report confirmed absence or silently retry/delete.
- Official success/timestamp is not an inode-creation proof: a recently existing directory may look fresh. Public outcome is `directory-ready`, and UI says the folder is ready, not that previously existing content was replaced. Explicit conflict or old/missing/unverified stamp cannot be promoted to success.
- Preserve prior packages, normal read/search/preview/download behavior, download window lifetime and independent shop behavior. Full upload/media/system/official integration/real installation/formal deployment objectives and physical NAS path/symlink/platform gates remain open.

## Shared contract

```ts
export type DirectoryCreation = {
  sessionId: string; // non-secret SDK session identity
  outcome: "directory-ready";
  item: Item; // actual read-back ordinary directory, no generated media URL
};
// OfficialNas and Gateway:
// createDirectory(parent:Item, name:string, options?:{signal?:AbortSignal}):Promise<DirectoryCreation>
// Static safe OfficialNasError-compatible errors may carry readonly mayHaveCreated:boolean.
```

Directory names preserve valid user text: a nonempty single component, not dot/dotdot, no slash/backslash/C0/C1/DEL/unpaired-surrogate, maximum255 UTF-8 bytes. Whitespace-only invalid; do not truncate or silently rename. Ordinary parent path absolute, bounded8192, not double-slash/control/E-encrypted; caller kind directory/folder/root and authoritative info `is_dir` verify it. A returned canonical path different from the requested parent is not silently assumed equivalent.

## Task 1: Direct directory action and exact transport scope

**Files:** `apps/client/src/api/official-nas.ts`, `client.ts`, focused `official-directories.test.ts` and Gateway tests; pure directory validation/types helper if useful; `apps/client/dev/nas-proxy.ts/tests`; `apps/client/src-tauri/capabilities/default.json`, `src/contracts.rs`. No Files UI, Go, upload/media transport or new library.

**Protocol:** `docs/research/2026-10-11-file-create-upload-evidence.md` provides the anonymous current official route, parent/name/rename and outer `ts`/data.modify_time duplicate check. `/v2/file/info` existing direct/info response is already implemented. Do not require invented fields on the newdir response: read back actual file info.

- [x] Add red normal synthetic login tests for valid Chinese/spaces/UTF-8 boundaries, invalid name/parent/no-session before writes, actual parent-info verification, exact newdir POST/form/rename0, read-back ordinary directory identity, safe public result and no native media registration.
- [x] Add red tests for explicit N001301/N001322 conflict, stale/missing/malformed timestamp and invalid returned path, wrong/missing read-back identity, business/HTTP/redirect failures, abort before and after dispatch, same-session duplicate prevention, logout/replacement during parent verification/create/readback, and old expiry preserving a newer session. Inspect actual request count/sequence and signals; don't echo synthetic secrets into product errors.
- [x] Implement a narrowly private request-context/envelope facility if needed; ordinary read decoder output stays unchanged. Keep only validated timestamp and decoded data private. Newdir-specific conflict classification must inspect only canonical known codes, not localized messages. Validate `abs(floor(ts/1000)-modify_time)<=2` as the official freshness requirement but do not call it proof of brand-new creation.
- [x] Validate parent through official info, check active authority before write, bound the result body, send only fixed rename0 and expected form fields, validate returned path is the intended single child of the actual parent, then read back path/name/is_dir. Build the public Item from verified known fields without auto media/credential URLs. In-flight locks include session identity; stale cleanup cannot unlock a new session's action.
- [x] Add exact native URL entries and development POST route only. Rename misleading read-only/no-mutations test labels if necessary; prove neighboring modify/delete/clean/child routes and GET remain blocked by applicable guards. No broad capability wildcard or business read-map mutation alias.
- [x] Run meaningful focused red→green, full frontend/typecheck/build, Rust38/fmt if capability/tests changed, diff check. Freeze/report unique `.superpowers/sdd/directory-sdk-report.md`; root owns commits, review artifacts and real runtime.

## Task 2: Files creation UI and honest result lifetime

**Files:** focused new `DirectoryCreate.tsx/tests` if useful; narrow `Files.tsx/tests` and styles. Existing modal patterns in Store/desktop may be reused without coupling NAS action to shop auth. No SDK/Go modifications after Task1 reviewed contract.

- [x] Add red integration tests for chosen current ordinary parent, root/recent/unsupported disable feedback, entered name, duplicate submission, ready/readback result, explicit conflict, ambiguous `mayHaveCreated`, safe error, cancellation, no automatic retry/rename/delete, and old session/parent/unmounted completion rejection.
- [x] Add “新建文件夹” to the existing compact Files action area. Use user-input name and actual current parent label; creation unavailable at virtual all-roots/recent without an opened parent. Existing downloads remain independently usable and continue after Files closure.
- [x] Modal shows pending state and clear errors; ready result says “文件夹已就绪” and refreshes only the same current session/parent. Unknown outcome says “请求已中断，文件夹可能已创建，请先刷新查看。” No fake success, destructive cleanup, silent changed-name creation or automatic second write. Explicit cancel aborts the operation; closing a Files window does not perform rollback or delete.
- [x] Use mounted/current-context guards for asynchronous completion; a completed operation after window close may leave the directory on NAS, which next normal listing can reveal. Current account/session switching clears old UI. Preserve selection/request fences and existing independent global transfer controller.
- [x] Run focused/full frontend/typecheck/build, fresh scoped review, root actual synthetic App form/conflict/uncertain/logout checks and final checkpoint review. Root builds a new Mac ZIP preserving all prior ones. Normal NAS write/readback, old-marker preservation, physical path/symlink and native/formal H5 are separate gates, never inferred from a fixture.

## Parent continuation

Next implement complete native/H5 upload with bounded chunks, whole-file integrity and global upload tasks using the verified public uploader headers/split/seek contract. No upload or media/system feature is declared complete by this directory checkpoint. Existing Mac unlock, current real H5/shop login and GHCR source-choice questions remain pending; do not repeat them or treat silence as approval.

## Checkpoint through ce8802a

Task1 SDK and Task2 UI source gates passed. Final combined review Approved, actual synthetic browser form/conflict/uncertain/cancel/expiry/native-modal-focus and351x760 layout passed; no realNAS write. Zero-header socket-drop fixture produced transport replay (cause unestablished); application has no automatic retry and rename0 retained existing data. Root preserved fixture metadata/scripts/screenshots and stopped only its owned process61294, exec1619exit0.

Mac build3312exit0; fresh arm64 ZIP20entries validated, all prior packages retained. Current NAS store deployment remains approved464b37c, while latest PC/H5 Files source includes ce8802a. Evidence: docs/verification/2026-10-11-directory-create-checkpoint.md. Real NAS/native/formal H5/physical-path and complete upload/media/system gates remain open.
