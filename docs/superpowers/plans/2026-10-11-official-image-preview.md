# Official Image Preview Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the scoped task and fresh task review. The approved full client design already requires file/image previews, direct official transport, meaningful failures and stale-session protection.

**Goal:** Show selected NAS images in file details and the photo viewer using the current official large-image preview, with truthful loading/failure states.

**Architecture:** Add one direct SDK media-reference method, `OfficialNas.imagePreview(item)`, delegated by `Gateway.imagePreview(item)`. A focused `ImagePreview` component uses this method for both file and album images. Ordinary URLs use `/transcode/thumb`; encrypted image references use the exact official `/transcode/decrypt/thumb` route, with the existing normal-session transport and opaque native references.

**Tech Stack:** Existing React/TypeScript/Vitest SDK, Tauri media renderer and Vite fixed-target development proxy.

## Global Constraints

- No NAS writes, file deletion, data movement, existing service/configuration changes, credential extraction, or new listening ports.
- Only the current selected NAS origin and exact verified read routes. No arbitrary external image requests or server URLs in native DOM.
- Native returns only an opaque registered `nas-media` reference; H5 uses the existing original-path transport. Sessions and late native registrations remain bound to the current login.
- Do not call the shop backend or invent NAS business APIs. Do not claim image decoding is fixed until real NAS acceptance succeeds.
- Reuse provided file identity/path; never infer a file path from a display name. Missing image size/time stays missing, including omission of unsupported query values.
- This is one implementation checkpoint in the full PC/shop goal. File download/upload, other document formats, streaming media, writes, official remote entries and formal H5 deployment remain required follow-up work.

## Task 1: Direct preview reference, shared viewer and transport guards

**Files:** `apps/client/src/api/official-nas.ts`, `official-nas.test.ts`, `client.ts`; new `apps/client/src/modules/ImagePreview.tsx`, `ImagePreview.test.tsx`; `NasModule.tsx`, `styles.css`; exact route updates/tests in `apps/client/dev/nas-proxy.ts`, `nas-proxy.test.ts`, `apps/client/src-tauri/src/media.rs` if necessary.

**Evidence:** Public current official index module 74922 defines getPreviewUrl(params, format="small"): adds dest_fmt and request_purpose=5; encrypted_path chooses GET `/transcode/decrypt/thumb`, normal file_path chooses GET `/transcode/thumb`. The current image viewer uses this function with `large` and actual file path/size; file and album thumbnail callers preserve supplied size `s` and update marker `up`. E-prefixed ordinary image references use encrypted_path/from=pub_album. Source snippets are from public frontend code, never authenticated account responses.

**Interface:**

```ts
imagePreview(item: Pick<Item, "path" | "name" | "size" | "metadata">): Promise<string>
// Current-session media reference; throws on missing identity, unsupported
// image type, failed registration, or session change.

<ImagePreview item={selected} />
// Shared image loading + explicit failed decode/retry state; no fake images.
```

- [x] Add SDK regressions before implementation: normal large route/path/size/update fields; encrypted route/from; only known image extensions; no missing path or unsupported directory preview; dev proxy binding; opaque native reference; old session registration rejection. Unknown size/time must not be invented.
- [x] Run focused tests and inspect the missing-feature failures.
- [x] Build original-route preview sources with URLSearchParams. Preserve provided thumbnail addresses; generated ordinary thumbnails include validated known size/update data. Only file/photo normalization may retain encrypted image identity; do not make video/audio falsely claim encrypted playback support.
- [x] Add shared viewer component tests: image success and failed decode, retry, unsupported item, switching files sharing one ID but different paths, and late response/session changes. Run red before implementation.
- [x] Integrate image previews into selected file details and photo viewer. Include selected path in file-detail effect identity and viewer remount key; retain detail/error/read states and responsive layout.
- [x] Add exact encrypted-thumb positive transport guards and negative mutation/outside-origin guards; run red before adding the read route, then green. Do not expand prefix or wildcard scopes.
- [x] Run focused SDK/viewer/proxy tests, full frontend/typecheck, Rust tests/fmt and scoped spec/quality review. Rebuild local Mac with the sidecar script after review; preserve the earlier ZIP.

## Runtime acceptance

Mac is currently locked and fresh H5/NAS store pages currently show login forms. Existing asynchronous unlock/login/source-choice questions remain pending; do not repeat or infer approval from elapsed time. After a normal new session exists, open a real image through both Files and Photos, verify decoding and retry, then check selection/session changes. Source tests alone do not prove thumbnails, image decoding, full media playback or full-goal completion.

## Source checkpoint

Source task and scoped review passed after repairing complete native image reads and Gateway/native authentication-expiry integration. Image transport uses a complete bounded 64 MiB response; generic video/audio ranges remain at 8 MiB. Root independently ran 278 frontend tests/typecheck and 24 Rust tests/fmt, rebuilt Mac with the sidecar, and verified the separately named image-preview ZIP. A labelled non-NAS loopback fixture proved real browser decoding of a 9 MiB PNG through Files and Photos and the 401-to-login transition. Real NAS acceptance and the full PC/shop objective remain incomplete.
