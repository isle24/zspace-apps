# Official File Search Implementation Plan

> **For agentic workers:** Use subagent-driven-development sequentially with a fresh scoped spec/quality review per task and a final checkpoint review. This implements the already approved Files search scope in `docs/superpowers/specs/2026-10-10-zspace-client-design.md`, not a new product architecture.

**Goal:** Search official indexed file names across the user's accessible files or within an actual selected directory, with real pagination and truthful scope.

**Architecture:** A new direct SDK read operation maps bounded high-level search input to the public official `POST /file_search/file_search` contract. Files offers explicit user-submitted search and scope, while recent-file local filtering stays labelled. Current session and request scope fence late results. The Go service stays the independent application shop.

**Tech Stack:** Existing React/TypeScript/Vitest, direct OfficialNas SDK, existing Tauri HTTP and Vite fixed-target transport; no new dependencies.

## Global Constraints

- No NAS writes, reindex/settings/history changes, slow-search task creation, deletion, movement, service/global configuration changes, new NAS ports, credential extraction or GitHub publication.
- Only exact `/file_search/file_search` URL entries are added to native HTTP plugin capabilities; the SDK method map and development guard allow only POST for this operation. Native plugin URL capabilities do not independently restrict methods. Direct official requests only; Go remains the independent shop.
- Names, paths, IDs, directory markers and sizes come from actual returned official metadata. Never use display labels to construct an identity or guessed path.
- Current-session cancellation, stale-response rejection, expiry and redaction remain enforced. No Cookie, token, sign, raw upstream body/error or private capability is exposed in public results, DOM or logs.
- NAS indexed search is distinct from filtering one loaded page. Show the chosen scope; do not claim external devices, recycle/snapshot slow-search coverage. No sample results replace failures.
- Page changes trigger actual server requests. Scope/query/directory/session changes reset page and selection; late responses cannot replace newer results. Closing Files does not change active download lifetime.
- Existing local/NAS files and previously built packages are preserved. Real NAS search, native UI and formal H5 acceptance remain separate from source/fixture checks.

## Task 1: Direct indexed search SDK and transport

**Files:** `apps/client/src/api/official-nas.ts` and tests; exact HTTP URL entries in `apps/client/src-tauri/capabilities/default.json` and tests in `apps/client/src-tauri/src/contracts.rs`; `apps/client/dev/nas-proxy.ts` and tests. No UI/Go changes.

**Input:** `Gateway.read("files.search", { name:string, path?:string, page?:number, pageSize?:number })`. Name trimmed, non-empty and bounded to 256 characters, controls rejected. Path if supplied is a non-empty returned directory path, bounded to 8192 characters and controls rejected. No path guesses or aliases. Page 1..10000, size1..200 with existing defaults20.

**Output:** Existing Collection with real search list items and server total; file path supplies identity and is_dir supplies kind. Missing/malformed list or total is a safe INVALID_RESPONSE instead of an invented empty successful result.

**Official contract:** See `docs/research/2026-10-11-file-search-evidence.md`. POST fields `name`, `file_path`, `start=(page-1)*pageSize`, `num=pageSize`, `order_by=0`, `ftype=""`, `is_dir=""`, `min_size=0`, `max_size=0`, `shared_only=0` with directory path or `2` without path, `show_hidden=0`; normal common official auth fields stay private. SDK accepts only the high-level inputs, not caller overrides of shared_only or arbitrary index options. Do not invent a remote endpoint or encrypted info route.

- [x] Add red tests for exact method/path/defaults, scoped/global requests, Chinese query/form encoding, real page2, true returned identity and totals, unknown parameters and invalid bounds before content request, malformed response rejection, old-session response drop and safe expiry/redaction. Use existing normal synthetic login fixtures.
- [x] Implement operation mapping and exact allowlists, preserving all existing safety and normalization behavior.
- [x] Prove the SDK native request is exact POST, native URL capabilities exclude nearby write/slow routes, and the development guard rejects GET and nearby routes. Do not add a new native transport architecture merely to make URL capabilities enforce methods. Run focused red→green plus frontend/typecheck, Rust tests/fmt if native changes, and production compile. Freeze source/report; root owns commit.

## Task 2: Files search interface and carried presentation fixes

**Files:** Extract a focused `apps/client/src/modules/Files.tsx` if useful, `FileSearch`/tests if needed; narrow `NasModule.tsx`, `Pagination.tsx`, styles, and existing App expiry display. Preserve unrelated media/system/store behavior.

- [x] Add red integration tests exercising submit-only indexed search, current/global scope, server page2, clear/return-to-directory, folder result navigation using returned path, selection/download action, session/query/directory stale results and recent-only local filtering. Do not fire a request per keystroke.
- [x] Connect explicit file-name search, scope choice and clear action to reviewed `files.search`. Root search defaults to all accessible indexed files; an opened directory permits current-directory search. Clearly distinguish index results from unsupported external/recycle/snapshot slow searches. Preserve current directory when clearing search; entering a returned result directory exits search and resets pagination.
- [x] Use server total and real pagination for search even at Files root. Clear selection on query/scope/page/session changes. Keep file preview/download through actual returned Item and global transfer provider.
- [x] Carry forward final-download P3 fixes: known file kind Chinese presentation; context-specific known file-info labels instead of device-name/raw labels; display one fixed safe NAS expiry sentence. Preserve device contexts and authority/cleanup ordering. Do not expand or redesign system settings here.
- [x] Run focused/full frontend/typecheck/build, fresh scoped review, root actual synthetic App search acceptance, and final checkpoint review. Root builds latest Mac afterward and preserves prior ZIPs. Real NAS search/native runtime/formal deployment gates remain open until actually tested.

## Checkpoint result

Source Tasks 1–2 complete through `295323f`; fresh scoped and final checkpoint reviews passed with no remaining Critical/Important/Minor findings. Final checks:458 frontend tests in24 files, typecheck/build; unchanged native38-test evidence, exact native URL contract and actual SDKPOST. Root actual synthetic App acceptance covers submitted/global/current search, real3-page offsets, selection, directory trail,20second out-of-order response rejection,390-pixel responsive layout and401cleanup. Latest local Mac package build and ZIP integrity passed; this does not close the following real NAS/platform gates. Details: `docs/verification/2026-10-11-file-search.md`.

## Runtime gates

The Mac unlock and current real H5/shop login questions and GHCR source choice remain pending; do not repeat them or infer an answer. Use owned loopback fixtures for integration evidence, label them synthetic and never treat them as real NAS permissions. Do not trigger a real installation retry/source switch without the already pending decision.
