# 文件预览与传输协议证据

日期：2026-10-11。此文件只记录公开源码与既有客户端架构，不含真实用户文件、认证头或会话。

## 当前官方前端

当前公开 index 的模块 74922 定义 `getPreviewUrl(params, format="small")`，设置 `dest_fmt` 与 `request_purpose=5`。普通图片走 `/transcode/thumb` 的 `file_path`，加密图片走 `/transcode/decrypt/thumb` 的 `encrypted_path`。图片查看器使用 `large`，并传递实际路径与大小 `s`；提供更新标记的缩略图调用保留 `up`。E 前缀路径的通用图片场景使用 `from=pub_album`。这些是协议来源，不证明当前账户解码成功。

公开文件模块 73512 读取 `/v2/file/info` 的 `path`、`name`、`fid`、`is_dir`、`size`、时间与图片属性。目录导航消费返回的真实目录路径；不能把集合名称或显示标题当成文件路径。相对文件名必须以官方列表协议及已请求的父目录为依据，不能为“更安全”的表象移除真实 NAS 所需的身份构造。

当前官方下载器采用 GET `/v2/file/download`，表单中有 `path`、`webagent=v2`、`request_purpose=5`、`show_hidden`，加密下载使用 `/v2/file/decrypt/download` 的 `encrypted_path/from`。ZIP 目录下载是独立的 `/v2/file/zipstream`；不能把单文件下载当目录打包，亦不能因静态路径存在就宣称传输通过。

## 成熟组件检查

[Tauri Dialog 官方文档](https://v2.tauri.app/plugin/dialog/)提供系统保存位置选择，可在 Rust 侧选择路径；文件传输应由用户选定目的地，避免开放任意前端路径写入能力。

[Tauri Upload 官方文档](https://v2.tauri.app/plugin/upload/)支持 HTTP 上传/下载，已检查其[公开实现](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/upload/src/lib.rs)。当前 v2 分支的 `download` 使用 `reqwest::Client::new()`，并通过 `File::create` 创建目标；后者会截断已有文件。错误序列化还会返回底层请求错误或响应体。本项目不能直接照搬这些默认行为：用户禁止删除/覆盖既有资料，当前认证传输要求不跟随重定向且不泄露 URL、认证头或响应秘密。

因此后续文件保存应继续使用成熟 reqwest 和系统文件对话框，补上当前会话绑定、精确官方下载路径、禁止重定向、仅新文件创建、流式写入、完整性/中断状态和经过清理的错误。这是组件适配需求，不是另建 NAS REST API。

## H5 交付边界

[MDN Service Worker 文档](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)说明服务工作线程需要 HTTPS；本地开发的 localhost 可作为安全来源。普通局域网 HTTP 地址不能据此宣称具备大文件流式下载能力，正式部署仍需独立验收。

已查询成熟组件 StreamSaver 2.0.6 的包版本和完整性值，未安装或执行其外部中转。[官方说明](https://github.com/jimmywarting/StreamSaver.js/blob/master/README.md)及[中转实现](https://github.com/jimmywarting/StreamSaver.js/blob/master/mitm.html)包含跨窗口消息、工作线程注册和下载流。若采用此组件，必须固定版本、保留许可并把所需页面及工作线程放在本项目同源地址，禁止使用默认外部中转或 CDN。也可使用范围更小的本地工作线程实现同一交付用途。

页面只向本地交付组件传递不透明的一次性引用和文件字节；NAS 认证地址、Cookie 和 token 不进入下载链接、页面历史或工作线程注册参数。浏览器流需要背压、完整大小校验、注销及页面关闭取消；不支持流式交付时仅允许明确提示大小限制的有界 Blob 回退。浏览器接收完字节与系统文件已经可靠保存是不同证据，任务界面必须如实区分。

## 后续验收条件

- 当前正常登录会话中确认单文件下载响应头、完整大小、实际加密路径与权限错误；不能从网页脚本推断响应头。
- 以合成 HTTP 服务验证超过 8 MiB 的完整流式保存、重定向拒绝、注销取消、既有目标文件与符号链接不受改动；原生媒体分块不能直接作为全文件下载结果。
- 文件内容是用户数据。JSON、SVG、文本等合法文件的下载与把 HTML/JSON 描述符放进媒体播放器是不同用途，应通过下载专用引用、响应身份和大小校验区分，不能用渲染器格式限制冒充完整文件功能。
- 真实下载/上传、目录新建与搜索仍属于完整客户端目标；本次图片预览实现不替代这些功能。
