# 官方音乐播放调用来源

2026-10-11，读取当前官方前端公开静态模块 `44038`，未读取真实音乐文件或认证会话。

官方音乐包装函数 `getAudioPlayUrlNew` 请求 GET `/transcode/audio/play`；存在 `encrypted_path` 时改为 `/transcode/decrypt/audio/play`，并补充 `app=music`。旧地址函数分别使用 `/transcode/playaddr` 与 `/transcode/decrypt/playaddr`。旧地址回退在当前代码中针对新地址返回 404，不应把任意权限或业务错误当成可回退信号。

音乐播放器以返回的真实 `fileInfo.path` 或 `song_path` 为依据，向地址函数传入 `file_path/from/encrypted_path/dest_fmt`。格式列表包含 `HQ/SQ/OP`；源代码的格式尝试与播放错误切换具有不同分支，后续实现需分别验证边界和最终失败状态，不能照抄一个未经检查的循环。

地址成功后的官方界面消费 `data.uri`，相对路径在官方同源环境下解析为当前来源。网页播放器检测到 `.m3u8` 时启用其 HLS 插件。这证明 HLS 是当前官方播放路径的一种形态，不证明现有新客户端已具备 HLS、真实音频解码或官方地址所需权限。

现有 SDK 已使用 `HQ` 默认值、`app=music` 并识别 `uri`。加密音频、`from` 来源、格式切换、HLS、进度与歌词仍需完整协议及正常账号运行验收。带认证的地址只可留在 SDK 私有状态和必要传输中，不能将官方源码的日志方式复制到本客户端。

原生 HLS 后续应采用成熟播放器/加载组件，继续遵守当前来源、精确资源路径、会话隔离和有界缓冲；不能以整个音频或视频下载为 Blob 冒充流式播放。本次没有改变播放器、接口权限或 NAS 转码配置。

## 成熟 HLS 组件预查

2026-10-11通过npm注册表只读元数据与[官方release v1.7.3](https://github.com/video-dev/hls.js/releases/tag/v1.7.3)核对Hls.js当前版本1.7.3，包完整性为 `sha512-MsPlx6yVW4Qv4C7mEVou4/gk/5cN2dVxOTnrNjPSmyH2f0Ln+/UkG10Ax1PE6OvrmTVPKgQYozTtBaPOuCzq7A==`。没有安装或执行新依赖。

[官方API文档](https://github.com/video-dev/hls.js/blob/v1.7.3/docs/API.md)提供自定义loader；播放列表、媒体片段与其他HLS请求需要覆盖完整加载路径。后续不能只替换片段请求而让密钥、附加播放列表等回到不受限默认加载器。当前客户端Player直接使用媒体元素，Rust现有媒体通道明确拒绝m3u8/mpegurl；成熟播放器组件尚未接入。

后续方案应沿用私有会话与不透明资源引用，逐项验证播放列表子资源来源、路径、取消/过期、缓冲界限和浏览器MSE能力。组件源码与版本证据不代表NAS实际转码或HLS播放已成功。
