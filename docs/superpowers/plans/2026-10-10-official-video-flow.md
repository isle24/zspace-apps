# Official Video Flow Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, task by task. Existing approved client design includes media libraries, collection details, episodes and playback; this implements that approved behavior.

**Goal:** Open collection details, select an actual NAS video file or episode, and request the current official playback descriptor instead of sending a collection ID to the obsolete wrapper.

**Architecture:** The existing direct OfficialNas SDK exposes `video.info`, `video.files` and `video.play`. A focused VideoDetails component loads current collection metadata and video files, while the shared Player receives actual selected files. Original official routes remain the only NAS APIs; Go remains an independent shop service.

**Tech Stack:** React, TypeScript, Vitest, Tauri HTTP/native media, existing Vite transparent development transport.

## Global Constraints

- No NAS file deletion, relocation, existing service changes or container cleanup.
- No real password/session export, browser credential extraction or Cookie cache use.
- Use authenticated SDK state only; stale responses and media references remain rejected.
- Retain library/collection/video identifiers and file paths from official responses; never infer a file identity from a collection ID.
- Static evidence confirms current calls; real NAS media decoding remains a separate acceptance item. HLS, tracks and subtitles remain full-goal requirements and are not declared complete by these tests.
- GitHub is only authorized as a fallback when local packaging fails; current local Mac packaging succeeds.

## Task 1: Current official read and playback contract

**Files:** `apps/client/src/api/official-nas.ts`, `official-nas.test.ts`, `operations.ts`, `operations.test.ts`.

**Evidence:** Public official `53914` API chunk declares POST `/zvideo/collection/info`, POST `/zvideo/collection/video`; `14318` detail chunk supplies `collection_id`, `classification_id`, `get_type=all` and consumes `video_list` / `file_list.list`; index module supplies GET `/transcode/play` with `file_path`, supported codec lists and `play_env`.

**Interfaces:** `api.read("video.info", {collection_id, classification_id})`; `api.read("video.files", {collection_id, classification_id, file_path?})`; `playRequest("video", item)` requires actual `item.path` and returns `video.play` with `file_path`. SDK normalizes video files with unique path/video identity, `file_name`, `file_size` and preserved version/episode metadata.

- [x] Add fixtures asserting exact current detail/file/play routes, selected file paths, same-ID file variants and missing-file rejection.
- [x] Run `pnpm --filter @space/client exec vitest run src/api/official-nas.test.ts src/api/operations.test.ts`; confirm failures occur at the obsolete route and collection-only playback.
- [x] Replace obsolete routes; set read-only default `get_type=all`, playback `from=zvideo` and actual browser codec capabilities; reject playback with no file path before any NAS request.
- [x] Normalize `video_list` and `file_list.list`, preserving official metadata and directories; request arguments never include unsupported mutation fields.
- [x] Repeat focused tests and typecheck. Add precise permissions only for the two new collection reads; API `/transcode/play` GET already exists as an allowed path.

Expected playback request example:

```ts
expect(playRequest("video", { id: "v1", name: "Episode", path: "/media/s01e01.mkv" })).toEqual({ operation: "video.play", params: { file_path: "/media/s01e01.mkv" } });
```

## Task 2: Collection details and episode selection

**Files:** Create `apps/client/src/modules/VideoDetails.tsx`, `VideoDetails.test.tsx`; modify `NasModule.tsx`, `Player.tsx`, `styles.css`.

**Interfaces:** `VideoDetails({collection:Item, classificationId?:string, connected:boolean, onClose:()=>void, onPlay:(selection:MediaSelection)=>void})`. It loads collection info once and file lists for selected directories; actual playable items form the shared queue. Media library selection retains its existing navigation behavior.

- [x] Add UI tests: collection click opens details without a playback request; selecting an actual episode passes its path/version to Player; directories are browsed instead of played; late results after a different collection are discarded.
- [x] Run focused tests and verify missing detail behavior fails.
- [x] Implement the detail panel using existing window bounds and H5 layout; show returned title/storyline and actual file/episode choices. Error/empty states use existing Status without demo content.
- [x] Make Player refresh for file/path changes, use video-specific previous/next labels, and consume only playback descriptors with valid media references.
- [x] Repeat UI/API tests and typecheck; rebuild Mac and record what still requires real login and media decode.

## Task 3: Guard and delivery verification

**Files:** `apps/client/dev/nas-proxy.ts` and tests; `apps/client/src-tauri/capabilities/default.json`, `src/contracts.rs`; client spec and verification record.

- [x] Extend current guard regressions with `/zvideo/collection/info`, `/zvideo/collection/video` positive reads and `/zvideo/collection/delete` negative case; watch red before permitting exact paths.
- [x] Run frontend suite, native permission regression and formatting checks; local Mac build verifies the changed native scopes and UI compile together.
- [x] Record the source improvement without claiming actual playback or full-goal completion. Continue runtime login, media, shop install and official entry acceptance when the required user/session state is available.

The active goal remains the complete PC client and independent shop. This plan is an implementation checkpoint, not a replacement completion definition.

## Checkpoint evidence

Source tasks and scoped review are complete. Final frontend: 230 tests; Rust: 18 tests plus fmt; Mac arm64 app: 31.71 MiB, built with the latest shop sidecar. New ZIP integrity and SHA256 verified. This does not complete real collection/stream acceptance or the full client/shop goal; current Mac is locked and fresh H5 sessions are pending. See `docs/verification/2026-10-11-pc-store-h5.md`.
