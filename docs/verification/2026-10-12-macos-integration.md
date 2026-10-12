# macOS 打包集成点核对

延续上一轮的思路：**"我不能登录验证" ≠ "没办法减少风险"**。
打包配置、plist、菜单这些都能离线核对，而漏了就会在真机上出丑。

## 1. 默认菜单会抢走 ⌘W（这轮新发现）

Tauri 在 macOS 上会创建**默认菜单**，其中 `File → Close Window` 带 **⌘W** 快捷键
（查了 `tauri-2.11.5/src/menu/menu.rs`，确认默认项里就有 `close_window`）。
而 macOS 上**菜单快捷键优先于网页里的 keydown** —— 结果是：

- 应用内的「⌘W 关闭最前窗口」**永远不会触发**；
- 按下去直接关掉**整个应用窗口**，桌面连同会话一起消失。

默认的 Window 菜单里还有 Minimize(⌘M)，同样会抢走应用内的最小化。

**修法**：在 `src-tauri/src/lib.rs` 里自定义菜单，只保留三样：

| 菜单 | 内容 | 为什么保留 |
| --- | --- | --- |
| 空间桌面 | 关于 / 服务 / 隐藏 / 隐藏其他 / 全部显示 / **退出 ⌘Q** | 标准应用菜单 |
| 编辑 | 撤销 / 重做 / 剪切 / **复制 / 粘贴** / 全选 | macOS 上**文本框的 ⌘C/⌘V 依赖菜单项存在**，删了就不能复制粘贴 |
| 显示 | 全屏 ⌃⌘F | 保留系统习惯 |

去掉 File 与 Window 菜单后，⌘W/⌘M 落到网页里，由应用自己管（关闭/最小化最前窗口）。

## 2. 本地网络权限（上一轮修的，这轮纳入自动检查）

`Info.plist` 必须有 `NSLocalNetworkUsageDescription`，否则连不上局域网 NAS。
打包产物里已核对（`plutil -p` 能看到该键）。

## 3. 窗口尺寸

`tauri.conf.json`：1440×920 默认，`minWidth: 880 / minHeight: 620` ✓
（窄窗口布局巡检就是在 880×620 这个下界跑的，见 `2026-10-12-layout-audit.md`。）

## 试过但做不到的：给菜单写单元测试

想用 `tauri::test::mock_app()` 断言"菜单里没有 Close Window"，实测失败：

```
muda::PlatformMenuItem can only be created on the main thread
```

macOS 要求菜单在主线程创建，而 Rust 测试默认跑在工作线程 —— 没有稳定的办法在单测里构造它。
于是撤掉那两条测试，改成**静态检查**（下节）。这是一次"想验但验不了"的诚实记录，
而不是删掉测试假装通过。

## 纳入自动检查

`scripts/static-audit.mjs` 新增「macOS 打包集成」一类，检查：

- `Info.plist` 是否声明 `NSLocalNetworkUsageDescription`；
- `lib.rs` 是否**自定义了菜单**（`.menu(...)`），且**没有** `close_window`；
- `tauri.conf.json` 是否设置了窗口最小尺寸。

```
=== macOS 打包集成（0）===
```

四个检查都过。这类"漏了才会发现"的配置项，以后有人改动打包设置时会被立刻拦下。

## 现在的 Mac 产物

重新打包后：配置核对通过（`nasOrigin` 仍是 NAS 地址）、
`codesign --verify --deep --strict` 通过、`Info.plist` 含网络权限说明、
应用启动成功、内置 sidecar `/health` 200 ✓

**仍然只能靠你确认的**：菜单栏实际长什么样、⌘W 是否按预期关闭"窗口里的窗口"而不是整个应用。
