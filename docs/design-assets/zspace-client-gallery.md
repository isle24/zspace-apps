# 空间客户端：桌面与移动界面画廊

2026-10-10。完整客户端设计，调用极空间现有 5055，保留官方网页。以下均为内置 imagegen 生成的视觉稿，所有文件、照片、曲目、媒体和状态为示例；没有真实 NAS 数据或运行验收结论。每张新图均保留同名 .prompt.md 的完整提示词。

[完整功能与架构](../superpowers/specs/2026-10-10-zspace-client-design.md) · [本地 Mac 与后续多端构建](../superpowers/plans/2026-10-10-zspace-client-build-and-release.md)

## 当前采用的系统桌面 v2

PC 为 Tauri + React；手机当前为 H5，原生包后置。以下是视觉稿，运行源码另见 [实施计划](../superpowers/plans/2026-10-10-pc-store-h5-implementation.md)。v1 侧栏页只作为应用窗口内部内容参考。

![桌面外壳](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-shell-v2.png)

![独立应用窗口](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-windows-v2.png)

![登录](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-login-v2.png)

![手机 Launcher](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-mobile-launcher-v2.png)

## 桌面

### 空间首页

![空间首页](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-home-v1.png)

### 文件与预览

![文件与预览](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-files-v1.png)

### 相册与查看器

![相册与查看器](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-photos-v1.png)

### 影视库

![影视库](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-video-v1.png)

### 音乐与播放器

![音乐与播放器](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-music-v1.png)

### 下载任务

![下载任务](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-downloads-v1.png)

### 设备与设置

![设备与设置](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-desktop-settings-v1.png)

## 移动端

### 首页、文件、应用

![移动核心界面](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-mobile-core-v1.png)

### 相册、影视、音乐

![移动媒体界面](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-mobile-media-v1.png)

### 下载、我的与系统设置

![移动下载与设置](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-client-mobile-settings-downloads-v1.png)

## 应用商店与安装

商店复用用户已认可的 v2 视觉，成为完整客户端应用中心的子模块。客户端原生导航统一后嵌入应用页面。

![应用商店](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-store-concept-v2-macos.png)

![安装向导](/Volumes/jz1tb/website/zspache_apps/docs/design-assets/zspace-install-wizard-v2-1-macos.png)

## 视觉实现约定

正式组件统一字体、系统蓝、圆角、图标家族与品牌标识。不同图片的立方体颜色、手机外壳和少量导航间距属于生成图差异，不作为逐页更换主题的要求。手机外壳和 Mac 窗口边框仅用于展示场景，Web UI 不重复绘制系统控件。

相册、影视、音乐和 NAS 系统设置均属于新界面完整实现目标，官方网页只保留兼容入口。图中示例音乐/继续观看的进度只表达播放器布局，不能当作已连接或已播放的证明。真实模式下没有数据时显示对应空/未连接状态。
