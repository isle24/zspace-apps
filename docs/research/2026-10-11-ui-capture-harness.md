# UI capture harness — headless Chrome screenshots + scripted interaction

Date: 2026-10-11 · Owner: teammate `ui-harness`
Script: [`scripts/ui-capture.mjs`](../../scripts/ui-capture.mjs) · Status: working, verified against the live dev server at `http://127.0.0.1:5173/`

This is the shared visual-verification tool for the fnOS re-skin work. It renders the real client in a
real Chrome, drives it (clicks, typing, keys, viewport changes), and writes PNGs — so restyling can be
checked against what the browser actually paints instead of what the JSX is expected to do.

Zero npm dependencies: Node built-ins plus Node's global `WebSocket` (Node ≥ 22). Nothing in
`package.json` was touched.

## 1. Requirements

| Need | Value used here |
| --- | --- |
| Node | `/opt/homebrew/bin/node` (v25.5.0). The bundled older Node cannot load the rolldown native binding. |
| Chrome | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (overridable with `--chrome` or `$UI_CAPTURE_CHROME`) |
| Dev server | `http://127.0.0.1:5173/` — must already be running; the harness never starts or stops it |

Sanity check that the page is up (read-only, always safe):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5173/   # expect 200
```

## 2. Invocation

```bash
export PATH=/opt/homebrew/bin:$PATH
cd /Volumes/jz1tb/website/zspache_apps
node scripts/ui-capture.mjs --url <url> --out <png path> [--width 1600] [--height 1000] \
     [--wait-ms 1500] [--steps <json>] [--full-page]
```

* **stdout is exactly one JSON summary object** — safe to pipe into `jq` / `python3 -c ...`, and it is
  still emitted (with `"ok": false`) when the run fails or the arguments are invalid.
* **stderr carries progress logs** (`[ui-capture] …`) and errors.
* Exit codes: `0` success, `1` a step or CDP command failed (the summary still prints, with
  `error.message`, the failing `step` index and a list of *visible candidates* that did exist),
  `2` bad usage.
* `node scripts/ui-capture.mjs --help` prints the full, authoritative flag/step reference.

Most useful flags: `--steps`, `--steps-file <path|->`, `--full-page`, `--device-scale-factor`,
`--net-idle-ms`, `--net-idle-timeout`, `--summary <path>`, `--connect <port|url>`, `--quiet`.
Isolation/safety flags for debugging: `--keep-temp`, `--keep-open`.

Chrome handling: the script launches its **own** headless Chrome with `--remote-debugging-port=0` and a
throwaway `--user-data-dir` under `/tmp` (`/tmp/ui-capture-chrome-XXXXXX`), talks CDP over
`ws://127.0.0.1:<port>/devtools/page/<id>`, then kills that one PID and deletes that one profile —
including on failure. It never touches a Chrome you already have open. `--connect <port>` attaches to an
existing DevTools endpoint and deliberately leaves that browser running.

## 3. Step DSL (`--steps`)

A JSON array; each element is one object with exactly one action key. `<target>` is either a CSS
selector string, `"text=<visible text>"`, or an object `{"selector": "...", "nth": 1}` /
`{"text": "…", "exact": true, "within": ".login-card"}`.

| Action | Shape | Notes |
| --- | --- | --- |
| click | `{"click": "<target>"}` | Real CDP mouse events at the element centre; falls back to `el.click()` and reports `"mode":"js-fallback"` if the hit test is covered or the element is invisible |
| type | `{"type": {"selector": "<css>", "value": "x", "mode": "set"\|"keys", "clear": true}}` | `<target>` may be a `selector` **or** `text`; if the match is a wrapping `<label>` the harness descends to its `input`/`textarea`/`select`. `set` (default) focuses and uses the native value setter + `input`/`change` events so React state updates; `keys` uses `Input.insertText` (real typing). `clear: false` appends instead of replacing |
| wait | `{"wait": 800}` | Sleep in ms |
| shot | `{"shot": "path.png"}` or `{"shot": {"path": "p.png", "fullPage": true}}` | Paths are cwd-relative |
| eval | `{"eval": "document.title"}` or `{"eval": "…", "as": "name"}` | Result is printed to stderr and recorded under `evals[]` |
| viewport | `{"viewport": {"width": 390, "height": 844, "mobile": true, "deviceScaleFactor": 2}}` | Mid-run resize; `mobile` defaults to `width <= 700`, matching the app's own breakpoint |
| waitFor | `{"waitFor": "<target>", "timeout": 8000}` | Polls until the target exists |
| press | `{"press": "Enter"}` / `{"press": "Meta+k"}` / `{"press": {"combo": "Escape", "selector": "input"}}` | Real key events; modifiers `Meta/Control/Alt/Shift` |
| scroll | `{"scroll": 600}` / `{"scroll": {"y": 400, "selector": ".module-sidebar"}}` | Dispatches a wheel event at the target (default point 100,100) |

Text matching is tried exact-first, then substring, preferring visible and then smallest/deepest
elements — so `"text=先体验桌面"` reliably hits the button and not its ancestors. `nth` (0-based)
disambiguates repeated labels.

## 4. The four required captures — exact commands

All commands assume `export PATH=/opt/homebrew/bin:$PATH` and cwd `/Volumes/jz1tb/website/zspache_apps`.
Every one of these was actually run; the files are listed with measured size and SHA-256 prefix in §7.

**(a) Login screen, 1600×1000**

```bash
node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
  --out output/verification/20261011-uiharness-login-1600x1000.png \
  --width 1600 --height 1000 --wait-ms 1500
```

**(b) Desktop shell, 1600×1000** (needs the interaction step; `--wait-ms` only settles the login page)

```bash
node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
  --out output/verification/20261011-uiharness-desktop-shell-1600x1000.png \
  --width 1600 --height 1000 --wait-ms 1000 \
  --steps '[{"click":"text=先体验桌面"},{"wait":1500}]'
```

**(c) 文件管理 window, 1600×1000**

```bash
node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
  --out output/verification/20261011-uiharness-files-window-1600x1000.png \
  --width 1600 --height 1000 --wait-ms 1000 \
  --steps '[{"click":"text=先体验桌面"},{"wait":1200},
            {"click":"[aria-label=\"打开文件管理\"]"},
            {"waitFor":".app-window","timeout":5000},{"wait":1500}]'
```

**(d) The same at 390×844** — append/change only the size:

```bash
node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
  --out output/verification/20261011-uiharness-login-390x844.png \
  --width 390 --height 844 --wait-ms 1500

node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
  --out output/verification/20261011-uiharness-desktop-shell-390x844.png \
  --width 390 --height 844 --wait-ms 1000 \
  --steps '[{"click":"text=先体验桌面"},{"wait":1500}]'

node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
  --out output/verification/20261011-uiharness-files-window-390x844.png \
  --width 390 --height 844 --wait-ms 1000 \
  --steps '[{"click":"text=先体验桌面"},{"wait":1200},
            {"click":"[aria-label=\"打开文件管理\"]"},
            {"waitFor":".app-window","timeout":5000},{"wait":1500}]'
```

At 390 px the app renders `main.desktop.mobile` (its own `window.innerWidth <= 700` rule) and swaps the
bottom dock for the mobile layout, so the mobile capture is a genuinely different layout, not a squashed
desktop.

**Multi-state / multi-window** (reaches a deeper state and proves windows coexist):

```bash
cat > /tmp/steps.json <<'JSON'
[{"click":"text=先体验桌面"},{"wait":1200},
 {"click":"[aria-label=\"打开文件管理\"]"},{"wait":1200},
 {"click":"[aria-label=\"打开音乐\"]"},{"wait":1200},
 {"click":"[aria-label=\"打开控制面板\"]"},
 {"waitFor":"[aria-label=\"控制面板窗口\"]","timeout":5000},{"wait":1500},
 {"eval":"[...document.querySelectorAll('.app-window')].map(w=>w.getAttribute('aria-label'))","as":"openWindows"}]
JSON
node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ --width 1600 --height 1000 --wait-ms 1000 \
  --steps-file /tmp/steps.json --summary /tmp/summary.json \
  --out output/verification/20261011-uiharness-three-windows-1600x1000.png
python3 -c "import json;print(json.load(open('/tmp/summary.json'))['evals'])"
```

## 5. How to view results

* Open a PNG directly on macOS: `open output/verification/20261011-uiharness-files-window-1600x1000.png`
* In the DSH Web GUI, reference the path (e.g. `output/verification/<file>.png`) to get an image card.
* Machine-readable recap: add `--summary output/verification/mysummary.json`, then
  `python3 -m json.tool output/verification/mysummary.json`. `screenshots[]` lists every written file
  with its intrinsic pixel size and byte count; `evals[]` holds each `eval` result; `console[]` and
  `pageErrors[]` hold browser console output for the run.
* For a diff-friendly workflow, capture `*--before.png` / `*--after.png` pairs and compare them
  side by side in the GUI.

## 6. DOM facts (verified in the live DOM via `eval` steps)

These are the real hooks to use in steps. Inline `eval` steps were used to read them, so they describe
the shipped DOM, not the source.

### 6.1 Login screen

| Fact | Value |
| --- | --- |
| Root | `main.login-screen` (sibling of the shell root; `#root > *` is `main.desktop ` once the desktop is open) |
| Card / title | `form.login-card`, `h2` = `本地账号登录` |
| Tabs | `.login-tabs` with `本地账号` (`.active`) and `官方远程` |
| 设备地址 field | `input[type="url"]`, placeholder `http://你的 NAS 地址:5055` — **no `name`/`id`, select by type** |
| 账号 field | `input[autocomplete="username"]`, placeholder `请输入 NAS 账号` |
| 密码 field | `input[type="password"]`, placeholder `请输入登录密码`; eye toggle `button[aria-label="显示密码"]` / `[aria-label="隐藏密码"]` |
| 保持登录 | `input[type="checkbox"]` inside `label.check-field` (disabled in browser builds) |
| Test connection | `button.connection-test` (text `测试连接`); result in `[role="status"].connection-result` |
| Submit | `button.primary.login-submit` (text `登录`) |
| Preview entry | `button.preview-button` — **two of them**; index 0 = `打开独立应用商店`, index 1 = `先体验桌面`. Use `"text=先体验桌面"` or `{"selector":".preview-button","nth":1}` |
| Error / status | `[role="alert"].inline-error`, `.login-status` |

Proven live: `{"type":{"selector":"input[type=\"url\"]","value":"http://192.168.3.56:5055"}}` →
`eval` returned `{"value":"http://192.168.3.56:5055","connectBtnDisabled":false}` — the React
`onChange` really fired (the button is disabled while the address is empty).

### 6.2 Desktop shell

| Fact | Value |
| --- | --- |
| Root | `main.desktop` (adds `.mobile` when `window.innerWidth <= 700`) |
| Top bar | `header.system-bar`; buttons `[aria-label="任务与通知"]`, `[aria-label="搜索应用"]`, `[aria-label="账号菜单"]`, plus the restyle's theme toggle `[aria-label="切换到深色主题"]` / `[aria-label="切换到浅色主题"]`; metrics `.system-metric`; account popover `.account-menu` |
| Desktop icons | `section.desktop-icons[aria-label="桌面应用"]`, one `button.desktop-app` per app: `span.app-icon.<color>` (gold/cyan/purple/pink/green/blue/silver/slate) + label `<span>`; 12 icons in order: 文件管理, 相册, 影视中心, 音乐, 下载中心, 应用商店, 控制面板, 任务中心, 存储管理, Docker, 远程访问, 使用帮助. The restyle lays them out as a left-aligned column instead of the old 4-wide grid |
| Caption | `.desktop-caption` (`桌面体验 · 未连接 NAS`), `.desktop-tip` |
| Window host | `div.window-area` (all `section.app-window` live here) |
| Dock / left rail | `nav.dock[aria-label="应用 Dock"]`, buttons `[aria-label="打开文件管理"]`, `打开相册`, `打开影视中心`, `打开音乐`, `打开应用商店`, `打开控制面板`, `显示全部应用`; a button gets class `running` while its app is open. After the restyle this dock renders as the small vertical icon stack in the top-left corner (measured 66×88 px at `x:0,y:0` in the captured state, with 文件管理 open), and the old bottom-dock layout is gone. Hovering shows a `打开<AppName>` tooltip |
| Mobile-only | `div.mobile-intro`, `div.mobile-bottom` |
| Direct shell children | `header.system-bar`, `div.mobile-intro`, `section.desktop-icons`, `div.desktop-caption`, `div.window-area`, `nav.dock`, `div.mobile-bottom` |

### 6.3 App window chrome

| Fact | Value |
| --- | --- |
| Container | `section.app-window[role="region"]`, class also carries `focused` / `maximized` / `window-hidden` |
| Window label | `aria-label="<AppName>窗口"` — verified `文件管理窗口`, `音乐窗口`, `控制面板窗口` |
| Title | `.window-titlebar strong` (`文件管理`), plus `.titlebar-hint` (`未连接 NAS`, or `我的 NAS` when connected) |
| Window buttons | `.window-titlebar button`: `[aria-label="返回桌面"]` (`.mobile-back`, mobile only), `[aria-label="最小化文件管理"]`, `[aria-label="最大化文件管理"]` / `还原文件管理`, `[aria-label="关闭文件管理"]`. **Select by aria-label, not by order** — the restyle reordered them to 返回桌面, 最小化, 最大化, 关闭 (macOS-style) |
| Body | `.window-content`, then the module root: `div.module-split.files-module` (文件管理), `div.media-module.music` (音乐), `div.module-split` (控制面板) |
| Resize | `.resize-handle[role="separator"][aria-label="调整文件管理窗口大小"]` |
| Placement | Desktop: inline `left/top/width/height/zIndex`; mobile: `zIndex` only, one visible window |

### 6.4 Left rails (two of them)

**Desktop rail** — the restyled dock above: `nav.dock[aria-label="应用 Dock"]` with
`button[aria-label="打开<AppName>"]` items. This is the left vertical rail visible in the desktop-shell
capture.

**In-window rail (文件管理)** — `nav.module-sidebar` inside `div.module-split.files-module`:

| Fact | Value |
| --- | --- |
| Rail | `nav.module-sidebar[aria-label="文件位置"]` inside `div.module-split.files-module` |
| ⚠ id unstable | Its `id` comes from React `useId` (`_r_0_`, `_r_1_`, …) — **never select by id**; select by `.module-sidebar` or the aria-label |
| Section label | `<p>个人空间</p>` |
| Entries | `button` elements `我的文件` (selected: class `selected` + `aria-current="page"`) and `最近访问`; clicking them requires a connected NAS session |
| Storage pools | nested `[role="group"][aria-label="存储池"]` (with `刷新存储池` button, `打开存储池：<name>` buttons) from `FilePoolSidebar` |
| Rail footer | `.sidebar-bottom` (`未连接设备` / `设备已连接`) |
| Rail toggle (mobile) | `button.file-locations-control[aria-label="文件位置"][aria-expanded]`, `aria-controls` = rail id |
| Toolbar in the pane | `[aria-label="返回上一级"]`, `[aria-label="刷新文件"]`, form `[aria-label="文件名称搜索"]`, `input[aria-label="搜索文件名称"]`, `select[aria-label="搜索范围"]`, `[aria-label="网格视图"]` / `[aria-label="列表视图"]` |

All of the above were re-verified **after** the restyle landed (2026-10-11 19:24) — the class names and
aria-labels survived the re-skin; only layout, ordering and colours changed.

### 6.5 Dark theme (added by the restyle)

Clicking `[aria-label="切换到深色主题"]` sets `<html data-theme="dark">`
(`document.documentElement.dataset.theme === "dark"`; the attribute is absent in light mode) and flips
the toggle's own aria-label to `切换到浅色主题`. Verified with
`{"click":"[aria-label=\"切换到深色主题\"]"}` followed by an `eval` of the two attributes. Capture dark
mode with:

```bash
node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
  --out output/verification/20261011-uiharness-desktop-shell-dark.png --width 1600 --height 1000 \
  --steps '[{"click":"text=先体验桌面"},{"wait":1200},
            {"click":"[aria-label=\"切换到深色主题\"]"},{"wait":1200}]'
```

## 7. Proof inventory

Every file below was produced by the commands in §4 with the shipped `scripts/ui-capture.mjs`
(Chrome 155 headless, viewport = PNG size, device scale factor 1). **Captured 2026-10-11 between
19:21 and 19:24**, from the live dev server while the fnOS restyle was being edited concurrently —
the checksums identify exactly these images, and the login screenshots show the pre-restyle light
login card, so re-run §4 if you need the current pixels.

| Screenshot | Pixels | Bytes | SHA-256 (first 12) |
| --- | --- | --- | --- |
| [login-1600x1000](../../output/verification/20261011-uiharness-login-1600x1000.png) | 1600×1000 | 519 153 | `adb0d8b0dcbb` |
| [login-390x844](../../output/verification/20261011-uiharness-login-390x844.png) | 390×844 | 92 626 | `7ac16d8541d8` |
| [desktop-shell-1600x1000](../../output/verification/20261011-uiharness-desktop-shell-1600x1000.png) | 1600×1000 | 1 143 968 | `81eee2ddd1df` |
| [desktop-shell-390x844](../../output/verification/20261011-uiharness-desktop-shell-390x844.png) | 390×844 | 287 117 | `31e1ac4ea28a` |
| [files-window-1600x1000](../../output/verification/20261011-uiharness-files-window-1600x1000.png) | 1600×1000 | 755 882 | `7822a50c6b35` |
| [files-window-390x844](../../output/verification/20261011-uiharness-files-window-390x844.png) | 390×844 | 47 567 | `320bdef85185` |
| [three-windows-1600x1000](../../output/verification/20261011-uiharness-three-windows-1600x1000.png) | 1600×1000 | 689 551 | `6d70accbbf77` |

Each run finished in ~3.4 s (static pages) to ~6.5 s (3 clicks + waitFor). Total footprint of all seven
PNGs: ~3.4 MB.

## 8. Behavior notes, gotchas, blockers

* **Clicks are real input events.** Plain `chrome --screenshot` cannot click, which is why the harness
  drives CDP: `Input.dispatchMouseEvent` sequences reach React's `onClick`/`onPointerDown`, and the
  `type` step fires `onChange` (verified by the 测试连接 enable check above). Typing was exercised in
  all three shapes on the login form — `set` on `input[type="url"]` (`http://192.168.3.56:5055`,
  and the 测试连接 button flipping to enabled), append with `"clear": false`
  (`http://192.168.3.56:5055-APPENDED`), and `mode: "keys"` on `input[type="password"]` (`secret`),
  plus text targets (`"text=账号"` → `demo`). `press` was exercised with `Meta+k` and
  `{"combo":"Enter","selector":"input[autocomplete=\"username\"]"}`.
* **NAS is not connected in these captures**, by design: the preview path never logs in, so windows
  show `未连接 NAS`, `0 个项目`, `连接 NAS，打开你的空间`. That is the correct target state for
  restyle verification and needs no credentials. Do not send real credentials to `192.168.3.56:5055`.
* **Store API not needed.** Nothing in §4 talks to `127.0.0.1:18435`; the preview shell renders from
  local state. If a teammate needs store data, mock it or run the local store service.
* Each run logs a harmless `Failed to load resource: 404` in `console[]` (dev-server favicon) and
  Vite's `[vite] connecting/connected` debug lines. `pageErrors[]` is empty on all healthy captures —
  use it as a regression signal.
* **Scrolling:** the app's own containers own the scroll (`.login-screen` has `overflow:auto`), so a
  wheel at the default point scrolls that container and `window.scrollY` stays `0`. Verified: after
  `{"scroll":500}` at 390×844 the login container had scrolled 160 px (its maximum). Use `--full-page`
  for whole-page images; content was 390×1004 at that size, i.e. taller than the viewport.
* `--full-page` and `{"shot": {..., "fullPage": true}}` both work and reported 390×1004 for the same
  page, while the viewport shot stayed 390×844.
* Running several instances concurrently is fine (each gets its own port, profile and PID); every
  process started by the harness is killed and every `/tmp/ui-capture-chrome-*` profile is removed on
  exit, including after a failed step (verified: no leftovers after a `not-found` click).
* **stdout is one JSON object even when the run never started.** A usage error (bad `--steps` JSON, no
  output target, …) prints `{"ok": false, "error": {"kind": "usage", …}}` on stdout and exits 2, so
  `... | jq` never sees an empty stream. `--help` is the only text-mode stdout.
* **Interrupting is safe.** `SIGINT`/`SIGTERM` run the same cleanup before exiting (130/143): verified
  by interrupting a run that was sleeping — all 9 Chrome processes for that profile were reaped, the
  temp profile was removed, and the user's own Chrome (started outside the harness) was untouched.
  A synchronous `SIGKILL` of the harness's own child is registered as a last resort on `exit`.
* **Beware Vite HMR while teammates are editing.** Every capture here hits the live dev server, and a
  full reload triggered by a saved module resets the app to the login screen mid-run — the observed
  symptom is a later step failing with `target not found` even though the selector is correct. The
  harness now records main-frame navigations in `summary.pageNavigations` and appends a hint to the
  error message when one happened. If you see that hint (or any odd failure) while others are saving
  files, just re-run; the 文件管理 captures above needed one retry for exactly this reason. To confirm
  the app itself is healthy, check that `pageErrors` is empty and use `waitFor` instead of a fixed
  `wait` before interacting.
* If `5173` were down, the harness reports it as a page/step failure — it never starts a server. It was
  up (HTTP 200) for all captures above.
* The **only** repo files written by this harness work are `scripts/ui-capture.mjs`, this document, and
  the `output/verification/20261011-uiharness-*.png` images (the PNGs live outside version control).
  No client source, config, lockfile or `package.json` was modified.

## 9. Copy-paste recipes for re-skin verification

Verify a scoped restyle at both sizes (replace the `--out` names and, if needed, the steps):

```bash
export PATH=/opt/homebrew/bin:$PATH
cd /Volumes/jz1tb/website/zspache_apps

# 1) login card restyle
node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
  --out output/verification/20261011-uiharness-login-after.png --width 1600 --height 1000

# 2) 文件管理 window restyle (desktop + mobile)
for size in "1600 1000" "390 844"; do set -- $size
  node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \
    --out output/verification/20261011-uiharness-files-after-$1.png --width $1 --height $2 --wait-ms 1000 \
    --steps '[{"click":"text=先体验桌面"},{"wait":1200},{"click":"[aria-label=\"打开文件管理\"]"},
              {"waitFor":".app-window","timeout":5000},{"wait":1500}]'
done

# 3) assert the DOM contract did not change while restyling: the eval throws, so the run exits 1
cat > /tmp/contract.steps.json <<'JSON'
[{"click":"text=先体验桌面"},{"wait":1200},
 {"click":"[aria-label=\"打开文件管理\"]"},{"waitFor":".app-window","timeout":5000},{"wait":1200},
 {"eval":"(() => { const c = { rail: !!document.querySelector('nav.module-sidebar[aria-label=\"文件位置\"]'), windows: [...document.querySelectorAll('.app-window')].map(w => w.getAttribute('aria-label')), dockButtons: document.querySelector('nav.dock[aria-label=\"应用 Dock\"]')?.children.length }; const bad = []; if (!c.rail) bad.push('left rail missing'); if (!c.windows.includes('文件管理窗口')) bad.push('文件管理窗口 missing'); if (c.dockButtons !== 8) bad.push('dock children=' + c.dockButtons); if (bad.length) throw new Error('DOM contract broken: ' + bad.join('; ')); return c; })()","as":"contract"}]
JSON
node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ --out /tmp/contract.png --quiet \
  --steps-file /tmp/contract.steps.json --summary /tmp/contract.json
python3 -c "import json;print(json.load(open('/tmp/contract.json'))['evals'][0]['value'])"
```

Verified: the happy path exits 0 with `{'rail': True, 'windows': ['文件管理窗口'], 'dockButtons': 8}`;
pointing the same guard at a label that does not exist exits **1** with
`error = "DOM contract broken: 文件管理窗口 missing", step = 5`.
