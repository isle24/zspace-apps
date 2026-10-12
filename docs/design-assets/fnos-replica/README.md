# 飞牛 fnOS 复刻效果（当前）

本目录是**当前实现**的实机截图（非设计稿）：第三方极空间客户端连接 5055，界面复刻飞牛 fnOS。

| 文件 | 内容 |
| --- | --- |
| `00-all-windows.png` | 全套窗口一览（桌面/登录/文件/相册/影视/音乐/商店/下载） |
| `00-login.png` | 登录页（本地开发来源：仍显示地址与「测试连接」） |
| `00-login-production.png` | 登录页（NAS 同源来源的正式形态：只有账号/密码/保持登录/登录） |
| `01-desktop.png` | 桌面：飞牛真实壁纸、左侧玻璃应用栏、真实应用图标 |
| `02-files.png` | 文件管理窗口 |
| `04-rail-vs-fnos.png` | 左侧应用栏与真实 fnOS 并排对比 |
| `05-widget-pill-vs-fnos.png` | 右上资源挂件与真实 fnOS 并排对比 |
| `05-resource-widget.png` | 资源挂件展开态（四张卡） |
| `05-widget-dark.png` | 资源挂件深色 |

素材来源（全部从用户本机 fnOS 导出，见 `docs/design-assets/2026-10-11-fnos-design-system.md`）：
- 壁纸 `/usr/trim/www/static/bg/wallpaper-1.webp`
- 应用图标 `/usr/trim/www/static/app/icons/<app>/icon.png`（23 个）
- 空状态插画 `/usr/trim/www/assets/No*{Light,Dark}*`
- 令牌与几何来自真实登录会话的 DOM/CSS 实测

重拍命令见 `docs/research/2026-10-11-ui-capture-harness.md`。
