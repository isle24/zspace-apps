# 飞牛 fnOS 全套 UI 实施计划

日期：2026-10-11（Asia/Shanghai）
目标（用户确认）：客户端仍然连接**极空间 5055** 官方接口；界面**完全仿照飞牛 fnOS**；本轮先交付“UI 全套”（桌面外壳 + 全部应用窗口），随后再逐个补齐真实功能。用户原话：“接口连接极空间5055，ui完全仿照飞牛OS，主要是极空间的Ui太丑了，我想做一个自用”。

## 事实基线（已实测）

| 项目 | 事实 |
| --- | --- |
| 极空间 NAS | `http://192.168.3.56:5055`（sshbind 别名 `zspace`），官方接口照旧，SDK 不改协议 |
| 飞牛 fnOS 参照 | `http://192.168.3.127:5666/`（本机虚拟机，只读参照界面） |
| 现有前端 | Vite + React 19 + TS，`apps/client/src`，桌面外壳在 `App.tsx`，模块在 `modules/` |
| 现有测试 | 34 个文件 / 1018 个用例全绿（Node 25.5.0，`/opt/homebrew/bin` 必须在前） |
| 本地预览 | `http://127.0.0.1:5173/`；登录页 → “先体验桌面” 进入桌面（合成数据） |
| 皮肤接入 | `main.tsx` 依次导入 `styles.css` → `styles/fnos-theme.css` → `styles/fnos-shell.css` |
| 已完成 | 飞牛式外壳：紫→橙壁纸、左侧应用栏、右上资源挂件、飞牛式应用图标、窗口外壳 |

## 视觉契约（所有皮肤必须遵守）

1. **只用令牌**：颜色/圆角/阴影/字号一律使用 `styles/fnos-theme.css` 的 `--fn-*` 变量，禁止在组件皮肤里硬编码新颜色。需要新令牌时在主题文件里加，不要在皮肤里写死。
2. **浅色为默认**：深色只在 `:root[data-theme="dark"]` 下启用。`styles.css` 里原有的 `@media (prefers-color-scheme: dark)` 已改为显式属性，新皮肤不得再使用系统深色媒体查询，否则会出现“外壳浅色、窗口深色”。
3. **不破坏语义**：现有 `className`、`aria-label`、`role`、文案、测试所依赖的结构全部保留；允许**新增**包裹层或修饰类，不允许重命名既有类。皮肤走独立文件，避免多人同时改 `styles.css`。
4. **真实数据边界**：UI 皮肤只影响呈现，不得伪造容量、状态、缩略图或成功；未连接/空/错误/加载状态必须仍然真实可见。
5. **窗口几何**：窗口内边距由应用自己决定；外壳只保证窗口圆角、标题栏、右上角窗口按钮与阴影。应用内部**自带标题区**时必须留出右上角按钮区（约 96px）。

## 飞牛参照要点（来自真实界面与截图）

- 桌面：紫→橙极光壁纸；左侧 80px 应用栏（图标 40–52px、下方 11px 白色标签、运行中点）；顶左上 4 列桌面图标网格（96×104 单元、标签两行内）；右上角白色半透明资源挂件（R/W、CPU、RAM、折叠箭头）。
- 窗口：浅色外壳、约 10px 圆角、白色标题栏（高约 44px）＋右上角一组窗口按钮（最小化 − / 最大化 □ / 关闭 ×，26px 方形，hover 分别橙/蓝/红）；窗口可重叠、可最大化；内容面白色。
- 应用内部：约 230px 浅灰侧栏（`#f7f8fa`）+ 白色内容面；侧栏条目 40px 高、4–6px 圆角、选中为浅蓝底 + 蓝字；顶部工具栏紧凑（约 49px）。
- 控件：主按钮蓝底白字、圆角 4–6px、高 32–40px；输入框 1px 边框、聚焦蓝色描边；表格行高 40–46px、表头浅灰小字；空状态为浅灰插画 + 一行说明 + 一个主按钮。
- 字体：中文 `PingFang SC` 优先；正文 13px，次级 12px，小字 11px。

## 任务分解（每个任务一个写入者，范围互不重叠）

| # | 任务 | 写入范围 | 依赖 |
| --- | --- | --- | --- |
| 0 | 外壳与令牌（已完成） | `styles/fnos-theme.css`、`styles/fnos-shell.css`、`main.tsx`、`styles.css` 的深色块 | — |
| 1 | 文件管理窗口对齐飞牛 | `styles/fnos-files.css`、`modules/Files.tsx`、`modules/FilePoolSidebar.tsx`、`modules/DirectoryCreate.tsx`、`modules/FileInfo.tsx`、对应测试 | 0 |
| 2 | 相册/影视/音乐 | `styles/fnos-media.css`、`modules/NasModule.tsx`（Media 部分）、`modules/VideoDetails.tsx`、`modules/ImagePreview.tsx`、`modules/Player.tsx`、对应测试 | 0 |
| 3 | 下载中心、任务中心、系统/存储/网络/设备应用、帮助 | `styles/fnos-system.css`、`modules/NasModule.tsx`（Downloads/System/Help 部分）、`modules/FileTransfers.tsx`、`modules/StoragePicker.tsx`、`modules/MediaRootPicker.tsx`、对应测试 | 0 |
| 4 | 应用商店与独立商店页 | `styles/fnos-store.css`、`modules/Store.tsx`、`modules/StoreServiceSettings.tsx`、`modules/AppArtwork.tsx`、`StandaloneStore.tsx`、`store.html`、对应测试 | 0 |
| 5 | 窗口几何、启动器、登录页、窄屏 | `styles/fnos-shell.css`、`App.tsx`、`styles.css` 外壳段、`App.test.tsx` | 0 |

同一文件只能有一个写入者；`styles.css` 只保留任务 0/5 的改动。任务 2 与任务 3 都要改 `modules/NasModule.tsx`，因此**串行**执行（2 先 3 后），或由同一人完成。

## 验收门槛（每个任务都要过）

1. 该任务的现有测试全绿；新增/调整的测试必须至少证明“结构未被破坏”（关键 aria-label、按钮可点、状态可见）。
2 `pnpm typecheck`、`pnpm test`、`pnpm build` 全过；不得为了样式删除或跳过测试。
3. 用截图工具在 1600×1000 与 390×844 各出一张实机截图，人工与飞牛参照对比：圆角、间距、字号、选中态、空状态、窄屏不横向溢出。
4. 记录在 `.superpowers/sdd/fnos-ui-<task>-report.md`：改动文件、真实截图路径、未完成项与限制。
5. 不得改动 NAS 上任何数据、不得改动极空间协议层、不得宣称未验证的能力。

## 后续（本轮 UI 之后）

- 真实登录后的逐模块功能验收（文件读写、媒体播放、下载、系统信息）。
- 深色主题（`data-theme="dark"`）覆盖全部窗口。
- 商店独立部署页与客户端商店窗口统一视觉。
