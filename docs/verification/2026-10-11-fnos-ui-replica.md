# 飞牛 fnOS 界面复刻验收记录

日期：2026-10-11（Asia/Shanghai）｜范围：客户端 UI 全套（桌面外壳 + 全部应用窗口）
分支：`feat/pc-store-h5`｜验收人：本次会话（Lead + 4 名协作 agent）

## 1. 目标与结论

用户确认的方向：**客户端仍连极空间 5055 官方接口，界面完全仿照飞牛 fnOS**，本轮先完成 UI 对齐，
再逐个补齐真实功能。参照物是用户本机 fnOS（`http://192.168.3.127:5666/`，本次使用用户提供的
账号登录后实测），素材也从该机导出。

**UI 部分结论：已完成并通过下述检查。** 真实数据态（登录后各窗口的列表/网格/播放）**尚未验收**，
需要极空间账号，见 §6。

## 2. 交付内容

| 区域 | 状态 | 证据 |
| --- | --- | --- |
| 桌面外壳 | 完成 | 真实壁纸、玻璃应用栏、真实图标、右上资源挂件 |
| 应用栏 | 完成 | 通高玻璃面板 + 三段式（桌面/全部应用 · 彩色图标 · 四个单色图形）；与飞牛并排对比 `04-rail-vs-fnos.png` |
| 启动台 | 完成 | 全屏磨砂 + 居中搜索胶囊 + 六列网格 `06-launchpad.png` |
| 应用窗口 | 完成 | 1100×640、圆角 16、透明标题栏 44px、右上角 − □ × 三个 46×44 按钮 |
| 登录页 | 完成 | NAS 同源时只有账号/密码/保持登录/登录（`00-login-production.png`）；本地开发保留地址与测试连接 |
| 文件管理 | 完成 | 220px 侧栏、49px 工具栏、真实空状态插画 |
| 相册 / 影视 / 音乐 | 完成 | 白色标题条 + 49px 工具栏 + 卡片/歌曲列表/详情 |
| 下载中心 / 控制面板 / 存储 / Docker / 远程 / 帮助 | 完成 | 统计卡、设置卡、数据表 |
| 应用商店 + 独立商店页 | 完成 | 应用中心同构：220px 分类栏 + 卡片网格 + 安装向导 |
| 资源挂件 | 完成 | 266×36 胶囊 + 四张展开卡；与飞牛并排对比 `05-widget-pill-vs-fnos.png` |
| 深色主题 | 完成 | `:root[data-theme="dark"]` 全套令牌 + 结构性覆盖 |
| 移动端 390px | 完成 | 自适应网格、玻璃底栏、无横向溢出；应用栏与挂件按设计隐藏 |

截图总览见 [复刻效果](../design-assets/fnos-replica/README.md)；设计令牌与几何实测见
[飞牛设计系统](../design-assets/2026-10-11-fnos-design-system.md)。

## 3. 素材来源（全部从用户本机 fnOS 导出）

| 素材 | 来源路径 | 落库位置 |
| --- | --- | --- |
| 壁纸 | `/usr/trim/www/static/bg/wallpaper-1.webp` | `public/wallpaper-fnos.webp` |
| 应用图标（10 个） | `/usr/trim/www/static/app/icons/<app>/icon.png` | `public/app-icons/*.png` |
| 应用栏图标 | `/usr/trim/www/assets/desktop-*.png`、`launchpad-*.png` | `public/app-icons/rail-*.png` |
| 空状态插画 | `/usr/trim/www/assets/No{Data,Device,Permission,SearchResult}{Light,Dark}*` | `public/state/` |
| 使用帮助图标 | `/usr/trim/www/assets/beginner-guide-icon-*.svg` | `public/app-icons/help.png` |
| 远程访问图标 | fnOS 未提供，按同规格绘制 | `public/app-icons/remote.{svg,png}` |

## 4. 自动化检查（本次真实执行）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端回归 | `cd apps/client && PATH=/opt/homebrew/bin:$PATH ./node_modules/.bin/vitest run` | **37 文件 / 1044 用例全部通过** |
| 类型检查 | `./node_modules/.bin/tsc -b --pretty false` | 通过（无输出） |
| 生产构建 | `./node_modules/.bin/vite build` | 通过 |
| 浏览器验收 | `node scripts/ui-capture.mjs …` | 各窗口 1600×1000 / 390×844 截图，`pageErrors: []` |
| 全窗口复查 | 11 个应用窗口逐一截图 | 全部渲染一致（白色标题条 + 应用名 + 白色内容窗格 + 飞牛空状态插画），汇总图 `07-all-windows-final.png` |
| 商店真实服务 | 见[独立商店对接真实 Go 服务](2026-10-11-store-live-service.md) | 目录/首次配置/会话/登记目录/诚实 503 全部实测；客户端商店窗口已渲染真实目录 |
| 深色逐窗口 | 11 个窗口在 `:root[data-theme="dark"]` 下逐一截图 | 内容窗格亮度实测 33.3–37.6（阈值 <110），无浅色残留；汇总图 `09-all-windows-dark.png` |
| 键盘与焦点 | 真实浏览器按键序列 + 3 条回归测试 | ⌘/Ctrl+K 打开启动台且焦点进搜索框；⌘K/Esc 关闭后焦点回到应用栏入口；关闭窗口后焦点回到对应应用栏项（`document.activeElement` 实测），3 个窗口/路径逐一验证 |
| 移动端逐窗口 | 相册 / 应用商店 / 控制面板 @390×844 | `scrollWidth === innerWidth === 390`（无横向溢出）；控制面板侧栏转横向 chip 行，实测 `overflow-x: auto`（scrollWidth 509 / clientWidth 378）可滚动 |
| Mac 原生包 | `bash scripts/build-mac.sh` | **重新构建通过**：`apps/client/src-tauri/target/release/bundle/macos/Space Desktop.app`（34.73 MiB，CFBundleShortVersionString 0.1.0，2026-10-11 20:23） |

原生包内容核验（方法已加强）：Tauri 会压缩内嵌资源，按文本 `strings` 搜索中文内容不可靠。
改用**内容哈希文件名比对**——构建后 `dist/assets/` 的文件名带哈希，逐一在可执行文件中查找：

```
client-5cxj1u0o.css   EMBEDDED      client-CecIt3xQ.js   EMBEDDED
core-Djq8_Zg8.js      EMBEDDED      dist-js-pn7FmJpO.js  EMBEDDED
event-DgOCphlC.js     EMBEDDED      fnos-store-C35bJufh.js EMBEDDED
```

哈希文件名一致即证明包内嵌的是**当前这次构建**的前端（若仍是旧包，会看到旧哈希）。
**未做**：启动应用后的界面人工确认。

后端契约检查（未登录、只读）：25 条 SDK 路径对本机 5055 实测，24 条存在，发现 `/system` 为 404
并改到 `/system/home`；新增官方挂件真正使用的 `/system/recent`、`/system/delay`。详见
[极空间接口连通性实测](../research/2026-10-11-zspace-endpoint-audit.md)。

## 4.1 已知的不稳定用例（与本次 UI 改动无关）

`src/api/official-nas.test.ts > session-owned upload source registry > requires current login and returns only safe opaque browser metadata`
在**全量运行中偶发失败**（错误为 `无法直接连接 NAS…`，即本该 `NO_SESSION` 却发起了请求），单独运行该文件 204 项全过。
本次会话观察到 2 次偶发失败，随后**连续 3 次全量运行均 1053/1053 通过**。该用例属于上传源注册表，与本次 UI
改动无交集；未在本轮修复，记录在此以免被误认为新回归。

## 4.2 真实数据态（2026-10-11 已验收）

在 `http://192.168.3.56:18436/` 上用**真实极空间账号**登录后逐窗口验收（截图见
[真实数据截图](../design-assets/fnos-replica/real/README.md)），全程只读：

| 窗口 | 真实读数 |
| --- | --- |
| 桌面 + 资源挂件 | R 0 B/s、W 0 B/s、↑587.9 KB/s、↓12.2 MB/s、CPU 10%、RAM 60%（与 `/system/recent` 实测报文一致） |
| 文件管理 | 进入存储池后列出真实文件与大小，`第 1 页 / 2 页 · 共 35 项` |
| 相册 | `第 1 页 / 1179 页 · 共 23564 项` |
| 影视中心 | 5 个真实媒体库（全部影片 / 电影 / 电视剧 / 河蟹 / 短剧 / 本地） |
| 音乐 | `第 1 页 / 3843 页 · 共 76858 项`，真实专辑与艺人 |
| 控制面板 | product z425、总容量 41901774630912、已使用 26141117722624、user_cnt 17 |
| 浏览器请求探针 | 整轮操作**零失败请求** |

支撑这一结果的两处修复：

1. **同源部署**：极空间 5055 的 `/v2/`、`/zspool/`、`/transcode/` 等路由由 nginx `auth.lua`
   按 **cookie** 鉴权，403 且不带 CORS 头；改为容器内同源反代后，浏览器把会话 cookie 发给容器，
   容器转发给 5055（详见 `deploy/nas-appstore/README.md`）。
2. **部署包与源码不一致**：第一次修复后登录仍失败，原因是**部署到 NAS 的前端包是在加 cookie
   代码之前构建的**（部署包 `SameSite` 出现 0 次，而源码与重新构建的包都有）。重新构建并核对
   线上包内容哈希后恢复正常。教训：部署必须走 `deploy/nas-appstore/build.sh`，不要手工拼产物。

### 仍未解决：相册缩略图

`/transcode/thumb` 由 `nas-transcode` 返回 **400**（空响应体，`X-Powered-By: nas-transcode`）。
直连 5055 与经同源反代结果完全一致，因此**不是** CORS、cookie 或代理问题；
逐一试过 `s`/`up`/`dest_fmt`/`request_purpose`/`device`/`webagent` 的组合与省略均为 400。
官方前端是把**整个相册条目对象**序列化后拼进 URL（`t.dest_fmt=e; t.request_purpose=5; t.device_type=...`），
客户端目前只拼了 `file_path`/`s`/`up`/`dest_fmt`/`request_purpose`，差异字段待定位。

## 5. 诚实边界（本次未验证的部分）

1. ~~真实数据态未验收~~ → **已验收**（见 §4.2）；但**相册缩略图仍不显示**（§4.2 末），
   媒体**播放**（点开影片/歌曲实际播放）也还没验。
2. ~~资源挂件数字未验证~~ → **已在真实设备上验证**：CPU/内存/网络来自 `/system/recent`
   （`cpu.used`、`memory.used` 为 0..1 比例），读写来自同响应 `disks[].rps/wps`；
   界面实测显示 `R 0 B/s W 0 B/s ↑587.9KB/s ↓12.2MB/s CPU 10% RAM 60%`。
   磁盘读写字段此前误以为只能用 `/manager/services` 求和，实测该响应的 `disks[]` 直接给了逐盘速率。
3. ~~深色主题抽检~~ → **已按窗口逐一验证**（见 §4），并记录了亮度测量方法，不只是肉眼判断。
4. **Tauri 原生包已重新构建**（见 §4），但**未启动验证界面**；实际打开应用后的外观与登录需人工确认。
5. **完整读屏（屏幕阅读器）验收仍未做**：本轮只验证了键盘操作与焦点归属，没有用 VoiceOver/NVDA 走一遍。
6. 与飞牛的非 1:1 差异：缺少飞牛专属插画（空状态用飞牛插画，但应用内图标沿用 Phosphor 回退）、
   窗口打开/最小化动画未复刻（飞牛本身未测得时长）。

## 6. 下一步（需要用户提供极空间账号）

拿到 5055 账号后按顺序执行：

1. 登录后确认 `/system/home`、`/system/recent`、`/system/delay` 的真实响应字段，补齐或修正 SDK 映射；
2. 定位并点亮磁盘读写速率字段；
3. 逐窗口替换为真实数据截图，并把本文 §5 的条目逐条改成「已验证」或「失败原因」；
4. 真实 NAS 上完成一次 390px 手机端验收。
