# Real file interaction fixes implementation plan

> **For agentic workers:** Use subagent-driven-development and fresh scoped review.

**Goal:** Make real indexed file results usable for downloads and prevent duplicate current-directory breadcrumbs.

**Evidence:** Actual normal H5 login showed U+0001/U+0002 surrounding matched search text; selecting that real file disabled download name validation. The official public formatHighlight/file-kind code recognizes these markers. Entering a real storage root with the normal desktop double click also appended its breadcrumb twice.

## Global constraints

- No NAS writes/deletion/movement/overwrite, credentials/GUI/server access by agents, new backend/proxy/capability or dependencies.
- Remove only the two verified search protocol markers U+0001 and U+0002 from indexed-search display name fields. Do not strip paths, change IDs, infer identity from display text or loosen download validation; normal files.list/info behavior remains unchanged.
- Transformed names must pass the existing private-token cleanup again. Removing markers must not reconstruct a private token in public name/metadata/values. Keep recursive media omission and all expiry/generation/selection fences.
- Render plain escaped text, never upstream HTML. Preserve actual metadata used for encrypted download/preview, and require existing authoritative info when that operation already requires it.
- Repeated current-directory activation cannot append the same actual path twice. Normal child navigation, root/back, search-result navigation, session switching, paging and selection still behave as before.

## Task 1: Scoped SDK/UI fixes and regression evidence

**Files:** `apps/client/src/api/official-nas.ts`, focused search tests; `modules/Files.tsx`, `Files.test.tsx`; small helper only if needed.

- [x] Write/run observed red SDK tests for marked ASCII/Chinese names -> plain names with identical path/id and usable existing download preparation; encrypted metadata remains usable. Cover private token split by markers, other control characters unchanged/rejected by existing guards, escaped markup and ordinary non-search reads unchanged.
- [x] Write/run meaningful UI regression reproducing repeated activation of the actual current directory while navigation/readback is pending; verify one breadcrumb and correct current path, normal child/back behavior, and selected plain search file still invokes existing download action without a new unsafe identity path.
- [x] Implement narrowly scoped search-name normalization before public construction, then repeat privacy cleanup. Deduplicate current-directory navigation by actual returned path and safe state updates, preserving source request/context fences.
- [x] Focused SDK/Files tests, full frontend/typecheck/build once final, diff check, self-review/scoped commit and unique report `.superpowers/sdd/real-file-navigation-report.md`.

## Root acceptance

Synthetic App integration first; then normal actual NAS login, same storage root and indexed file query. Verify one breadcrumb, names without protocol markers, enabled existing download action and unchanged file info/path. Download byte/filename failure is a separate diagnosed transport issue; this fix must not claim it resolved or automatically retry it.


Source `cac5cde` and fresh scoped review passed; 210 focused / 629 frontend tests, typecheck/build passed. Root synthetic App search shows plain name, unchanged verified path, enabled existing actions and correct child/back trail; marker unchanged, no writes. Root double-click tool delivered only its first navigation before target removal; full timing regression is the source MutationObserver test. Real NAS acceptance and inclusion in a new Mac/NAS release remain pending.
