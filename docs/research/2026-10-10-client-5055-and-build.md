# 5055 客户端协议与构建调研

日期：2026-10-10。仅读取公开主来源、官方前端静态资源和本机构建环境；未读取官方登录缓存、系统密码文件、用户资料或私钥内容。

## 实机静态来源

通过 sshbind 对 usable=true 的 zspace 读取官方首页和当前静态 JS。index.f6361495.js 的 SHA-256：61003b9452b584b5a30e0dd30631398a9650ea711d9a1d47669d8a8a4a81aff0。

模块 41718 有 /auth/login、/auth/uaparam、/auth/token 等候选；模块 89904 的请求层增加 plat、version、device_id、device、_l、token、nasid 并使用表单编码。当前源码的密码检查会获取公钥再加密用户名和密码，不能写死社区旧版密钥。

文件存在 /v2/file/list、/v2/file/sysdir、/v2/recent/list 等；应用清单由 /AppStore/v1/list 与 /zdocker/AppStore/v1/list 合并。所有这些只说明当前官方前端有相应调用，没有正常登录后的目标 NAS 行为验证。

## 公开项目

| 项目 | 固定版本 | 可借鉴与限制 |
| --- | --- | --- |
| [coracoo/zspace_skill](https://github.com/coracoo/zspace_skill/tree/70879056149548c02f5cf66e2feb0a5bb69d235e) | 70879056149548c02f5cf66e2feb0a5bb69d235e | MIT；LAN 登录及文件/媒体封装；公钥与版本固定，挑战与续期不完整 |
| [skyzhao1223/zspace-cli](https://github.com/skyzhao1223/zspace-cli/tree/d6f09775887eceae834de8e2d37d4b3037ba4635) | d6f09775887eceae834de8e2d37d4b3037ba4635 | MIT；文件传输；默认依赖电脑客户端代理和缓存，不作为独立认证基础 |
| [huhuanming/zspace-cli](https://github.com/huhuanming/zspace-cli/tree/7943d10222056d8d384f38ac6680a9461317fe77) | 7943d10222056d8d384f38ac6680a9461317fe77 | MIT；Node 传输与重试；同样有官方代理依赖 |
| [fand75076-collab/zspace-cli](https://github.com/fand75076-collab/zspace-cli/blob/4e3b7cf220c759678dfe5e4f5e34b7734ae8f30d/NOTICE.md) | 4e3b7cf220c759678dfe5e4f5e34b7734ae8f30d | 无直接复制授权，使用协议事实线索独立实现；认证不含完整密码/短信/MFA |

没有找到可原样接入当前固件全部模块及独立认证的完整 SDK。采用成熟 HTTP、密码学、媒体和平台库，按当前固件建立小型适配器；不执行社区工具提取登录态。

官方公开云端资源 [index.a785a6de.js](https://www.zconnect.cn/home/static/js/index.a785a6de.js) 的调研摘要为 51ac369cb2a4e88d247d5b0636f1417dc36ef8c7d382c6a019f72d197f337373；其中远程请求有 /zconn/http/5055/{nasid}/... 与 rtoken/rdeviceid/rdevice/ruser。局域网和远程中转必须分开验证。

相册、影视和音乐分页不同；不能把影视的 start/limit 和音乐的 page/page_size 互换。封面可读、媒体地址、实际播放、字幕与转码也分别验收。系统子路径按目标固件具体验证，不沿用旧资料“全部 /system/* 都是 404”的结论。

## 构建主来源

- [Tauri 跨端架构](https://v2.tauri.app/start/)：共享前端，平台能力独立。
- [Tauri 前置工具](https://v2.tauri.app/start/prerequisites/)：macOS 桌面 CLT 与手机工具链不是同一要求。
- [HTTP 客户端](https://v2.tauri.app/plugin/http-client/) 和 [capabilities](https://v2.tauri.app/security/capabilities/)：原生请求仍需要地址、端点与重定向约束。
- [Tauri Action](https://github.com/tauri-apps/tauri-action)：多端打包需平台 SDK；移动构建仍须独立签名和真机验收。
- [Node 发布表](https://nodejs.org/en/about/previous-releases)：后续采用 Node 24 LTS 作为长期基线。

本机工具已查询，未安装依赖或执行产品构建。当前为 arm64 Mac、Node 25.5.0、pnpm 11.25.0、Rust/Cargo 1.98.1 和 CLT；完整 Xcode、Android/Java 构建环境尚不齐备。桌面 Mac 的主要前置可用，不能据此宣称包已生成或 NAS 联调已完成。
