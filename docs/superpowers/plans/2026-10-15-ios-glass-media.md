# iPhone 玻璃风格影视与音乐 Implementation Plan

> **For agentic workers:** Use executing-plans to implement this approved plan task-by-task in the isolated workspace.

**Goal:** 让影视与音乐拥有一致的 iPhone 玻璃质感，并修复可见的时长、播放范围与对比问题。

**Architecture:** 以单独的 ios-media.css 承载限定在媒体窗口的材质和响应式规则，保留现有模块结构。音乐元数据呈现使用纯函数，播放器继续复用当前播放状态与 NAS 请求。

**Tech Stack:** React 19、TypeScript、CSS backdrop-filter、Vitest、现有 NAS SDK。

## Global Constraints

- 用户已确认完整 Apple TV + Apple Music 方向；不改变 NAS 权限和接口。
- 保留现有分页、播放队列和会话隔离；不一次加载全部音乐库。
- 不编造媒体数量或图片，不引入远程字体与新的运行时库。
- 为深浅色、窄窗口、减少动态、高对比和不支持模糊提供回退。
- 安装包构建可在 GitHub 后台完成；先完成 UI、NAS 和 Docker。

### Task 1: 音乐真实数据与播放范围

**Files:** 新增 modules/music-presentation.ts、modules/MusicWindow.test.tsx；修改 modules/MusicWindow.tsx。

**Interfaces:** 消费 Item.metadata；输出 formatMusicDuration(item: Item): string 与音乐页面，播放仍传原 Item[]。

- [x] 写回归：`expect(formatMusicDuration({metadata:{song_duration:211173}} as Item)).toBe('3:31')`；长时长和缺少值分别显示 `1:01:01`、`—`。
- [x] 确认当前真实官方格式单位；运行回归观察失败。
- [x] 实现明确的毫秒换算，不以数值大小猜测单位。
- [x] 页面显示真实歌手/专辑字段；海报与曲库用统一紧凑结构。
- [x] 76858 总数、20 条当前页时按钮为“播放本页”，回调仅包含这 20 条；完整集合才标“播放全部”。过滤结果标“播放结果”。
- [x] 运行 `pnpm --filter @space/client exec vitest run src/modules/MusicWindow.test.tsx src/modules/MediaSkin.test.tsx --maxWorkers=2`，然后提交。

### Task 2: 统一影视/音乐/播放器材质

**Files:** 新增 styles/ios-media.css；修改 main.tsx、desktop/WindowFrame.tsx；必要时调整 MediaWindow.tsx/Player.tsx 的语义结构。

**Interfaces:** 窗口输出 `data-window-app={w.appId}`，CSS 只消费 video/music 属性与现有播放器 class；保留所有现有操作和 aria。

- [x] 添加窗口属性和播放范围的行为回归，确认失败。
- [x] 在既有样式最后导入 `./styles/ios-media.css`；限定 `.app-window[data-window-app="video"]`、music 和 `.global-player.music`。
- [x] 影视采用全局深色背景与更强的顶部/文字遮罩，玻璃侧栏与工具组；保留所有影片、库导航、排序和翻页。
- [x] 音乐采用封面、玫红强调、紧凑列表及悬浮播放条；移动窗口避免横向溢出，队列/歌词不遮挡关闭按钮。
- [x] `@media (prefers-reduced-motion: reduce)` 关闭装饰动效；`@supports not (backdrop-filter: blur(1px))` 使用不透明回退；深色与高对比使用独立材质值。
- [x] 播放器出现时为音乐列表保留底部空间，保留焦点与触摸控件尺寸。
- [x] 运行媒体/窗口/播放器已有定向测试、typecheck、生产构建，审查差异后提交。

### Task 3: 真实验收与发布

**Files:** docs/verification/2026-10-15-ios-glass-media.md、README 版本记录；仅同步本次已提交修改到发布克隆和原工作区。

- [x] 使用真实 NAS 页面检查影视首页与详情、音乐曲库与专辑、封面失败与播放条；检查深浅色和窄窗口。
- [x] 修复确认问题，再运行最终客户端测试与构建。
- [x] 备份 NAS 原静态资源，生成完整带 gzip 的客户端/商店合并包；最小 helper 同步源目录，不改端点与用户数据。
- [x] 更新 UI Docker 版本和 latest，匿名核验摘要与架构；部署到 NAS 并核对页面资源 SHA 与健康。
- [x] 将修复、视觉与真实验收证据写入文档并推送 Github，客户端安装包后台构建。

执行结果：1320 项客户端测试、typecheck、生产构建和真实 NAS 明暗/窄窗口验收通过，正式静态热更新与 Docker r4/latest 发布完成；见对应 verification 文档。
