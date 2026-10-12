# fnOS Reference File Navigation Implementation Plan

> For agentic workers: use subagent-driven-development, one implementer at a time, scoped source review then root actual browser acceptance.

**Goal:** Put real accessible NAS pools in the Files sidebar and apply the user-selected fnOS file-window layout without changing NAS data or protocol.

**Architecture:** Files consumes the existing authenticated files.roots collection independently from current directory/search/recent content. Sidebar uses real Item identities/paths, current directory component boundaries and session-scoped resource lifetime. Existing content actions remain intact.

**Tech stack:** Current React/TS/sharedCSS/Phosphor/Gateway; no new packages or NAS/backend/native routes.

## Global constraints

- User selected fnOS reference and storage pools in left menu; apply the concrete design in2026-10-11-fnos-ui-design.md. No additional visual alternative or approval flow required for this requested layout.
- Existing user/local/NAS files, pools, mounts, permissions, containers, partials and prior artifacts are preserved. Source implementer uses only synthetic data, no GUI/SSH/NAS or credentials.
- Consume current official roots Item{id,name,path,kind,metadata}; never derive paths from labels or reuse fnOS business APIs. Current SDK validates mounted pools and official personal namespaces.
- Session/directory/search/request identity remains current around async reads; stale responses/selection cannot render old account data or navigate a new context. Do not cancel global downloads/uploads when changing Files windows.
- Preserve current search scope/index coverage, actual pagination, details/preview/download/newdir, accessible labels/focus, light/dark and mobile usability. No invented capacity/usage/drive type or unsupported actions.

## Task 1: Persistent pool sidebar and fnOS file-window layout

**Files:** Files.tsx/Files.test.tsx plus focused file-pool-sidebar helper/component/tests if necessary, narrow client styles. Read-only dependencies official-nas.ts files.roots conversion and shareduseResource; no source changes to SDK/App/store/Rust/Go/proxy/hash/upload.

**Interfaces:** existing api.read('files.roots') -> Collection of validatedItems. Existing navigate(Item[]) and fileRequest choose the actual current Item. Source may use a focused pure path-membership helper; no public root API or filesystem path command.

- [ ] Add observed failing behavior tests for two/three real-shaped pools, visible in sidebar while browsing nested folders and searching/recent; switching pool sends its exact returnedpath, resets selection/page/query as existing navigation, and distinguishes same-prefix paths. Check old-session/deferred roots/refresh/removal/errors/empty/unconnected states.
- [ ] Implement one session-scoped roots resource/cache separate from content. Reuse it as root overview when appropriate to avoid duplicate root requests. Capture current root/name/path references, verify valid items, keep roots shown while current content changes and discard stale loads. Sidebar has accessible nav/group labels and unique button accessible names distinguishable from overview file rows; no capacities unless already real supported fields.
- [ ] Style only the Files layout: shallow gray sidebar/window surface, white content pane, compact path/search/content headings, blue selected row/text and comfortable file rows inspired by the actualreference. Keep current search semantics/forms, readable small help text or accessible disclosure, current pagination/actions/preview and native dialog controls. No fake forward/shared/recycle/administrator controls.
- [ ] At390px, make sidebar available via an explicit locations control/drawer or concise adaptive area; keep pool navigation accessible and avoid document horizontaloverflow. Handle long pool/file names and light/dark via currentCSSvariables. Scope style changes to Files so other modules do not regress before their own redesign stage.
- [ ] Run covering file/pagination/directory/download tests, then necessary fullfrontend/typecheck/build/diff; meaningful tests only, no unchanged Rust/Go/wholehash suites. Scoped commit and `.superpowers/sdd/fnos-file-navigation-task-1-report.md` with actual components/resources/public labels/TDD results/limitations.
- [ ] Root scoped review and actualsynthetic browser desktop/mobile navigation/layout/focus acceptance; normal realNAS and updatedMac package stay separate. Upload UI Task3 resumes after this user-priority file navigation gate; fullPC+independentstore goal remains active.
