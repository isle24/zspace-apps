# 验收索引

> **只想看结论？** 看 [一页状态 STATUS.md](STATUS.md)：能做什么、不能做什么、等谁。

这个目录是「空间桌面」（极空间第三方客户端，连 5055）的**验收证据库**。
每份文档都对应真机（192.168.3.56）上跑过的一次检查，写清楚**做了什么、看到什么、还有什么做不到**。

> 先看 **[capability-matrix.md](capability-matrix.md)** —— 一页表格列出全部能力及其状态，
> 本文件是它的展开目录。

## 三条纪律

1. **没在真机上跑过的不算数**：只写单测、没在设备上走通成功路径的，一律标 ⏳。
2. **做不到就写在界面上**：能力不可用时，界面要说明原因与替代方案，而不是留一个永远不生效的开关
   （剪切板监听就是这么被抓出来的，见下）。
3. **先验尺子再信数字**：巡检脚本自带自检（`--selftest`）。已经栽过三次：
   1. 对比度合成时把 alpha 强行置 1 → 凭空报 98 个问题（`2026-10-12-dark-mode.md`）
   2. 窗口类名写错（`.window` vs 实际 `.app-window`）→ 选择器落空后量了整个桌面
   3. 自动化窗口在后台 + `loading="lazy"` → 图片永远量到 0，看起来像深色模式把图弄坏了
      （实为 Chrome 对后台页面的懒加载无限期推迟；`2026-10-12-dark-functional-regression.md`）

## 界面与交互

| 文档 | 证明了什么 |
| --- | --- |
| [fnos-ui-replica](2026-10-11-fnos-ui-replica.md) | 桌面外壳、Dock、资源挂件按飞牛复刻；相册缩略图 20/20 |
| [media-redesign](2026-10-12-media-redesign.md) | taste-skill 审计：海报墙、强调色、骨架屏、圆角规则 |
| [video-player](2026-10-12-video-player.md) | 自绘播放器：进度/±10s/倍速/续播/选集/键盘/双击全屏 |
| [music-lyrics](2026-10-12-music-lyrics.md) | 歌词面板：LRC 解析、跟随高亮、点行跳转（35 行实测） |
| [music-queue-codec](2026-10-12-music-queue-codec.md) | 播放队列；解不了的编码如何如实说明 + 跳过这一首 |
| [photo-viewer](2026-10-12-photo-viewer.md) | 相册大图：翻页/缩放/拖动/键盘 |
| [file-multiselect](2026-10-12-file-multiselect.md) | 文件多选（⌘/Ctrl、Shift、Esc）与批量下载 |
| [file-sort](2026-10-12-file-sort.md) | 文件排序（本页），含"设备不排序"的实测结论 |
| [store-two-sources](2026-10-12-store-two-sources.md) | 应用商店＝官方（74+16）+ 空间商店（Codex 组件，未改动） |

## 真实数据适配

| 文档 | 证明了什么 |
| --- | --- |
| [system-docker](2026-10-12-system-docker.md) | 网络 5 张网卡、系统设置 6 分组、Docker 46 容器/202 镜像/日志（只读） |
| [remote-access](2026-10-12-remote-access.md) | 远程访问中转状态：公网地址、访问者、节点 |
| [download-bulk](2026-10-12-download-bulk.md) | 全部开始/全部暂停（实测 200）；单任务操作为何**不做** |
| [file-search](2026-10-11-file-search.md) / [file-downloads](2026-10-11-file-downloads.md) | 官方文件搜索与下载管线 |

## 质量巡检

| 文档 | 证明了什么 |
| --- | --- |
| [capability-matrix](capability-matrix.md) | **能力总表**：真机验证 / 已知不可用 / 待验证 |
| [window-sweep](2026-10-12-window-sweep.md) | 11 个窗口逐个打开：0 控制台异常、0 原始 JSON 倾倒 |
| [dark-functional-regression](2026-10-12-dark-functional-regression.md) | 深色下的**功能**回归：播放/歌词/队列/查看器/图片 20-20 全部通过 |
| [theme-parity](2026-10-12-theme-parity.md) | 浅色/深色同一支脚本各跑一遍，**行为完全一致**，0 控制台异常 |
| [webkit-render](2026-10-12-webkit-render.md) | 用 Mac 客户端的同款引擎（WebKit）渲染：修好登录页可读性、抓出 Mac 包地址丢失、部署脚本静默失败 |
| [native-login](2026-10-12-native-login.md) | 原生客户端登录页只剩账号密码（已知地址就不再问），并在 WebKit 里伪装原生做了验证 |
| [window-interaction](2026-10-12-window-interaction.md) | 窗口交互：修挂件挡住标题栏、补 ⌘W/⌘M；拖动/缩放/最大化/层叠/夹取 6 项全过（处理器级）；附测具自身 4 个 bug |
| [accessibility](2026-10-12-accessibility.md) | 可访问性：11 窗口 496 个可聚焦元素，**无名称 0 / 无焦点样式 0 / 无 alt 图 0** |
| [hostile-input](2026-10-12-hostile-input.md) | 异常输入与压力：7 种坏数据全部安全降级、401 优雅登出、连点与开满 11 窗口稳定 |
| [payload](2026-10-12-payload.md) | 产物与传输：首屏 1602 KB → **255 KB**（预压缩 + 壁纸瘦身 + hls.js 按需加载） |
| [error-handling](2026-10-12-error-handling.md) | 错误处理：137 个 catch 全部分类，**"只打日志假装成功"为 0**；补上媒体库部分失败的提示 |
| [app-refactor](2026-10-12-app-refactor.md) | App.tsx 1181 → 706 行（登录页/窗口外壳/实例窗口各自成文件），行为不变并逐项复核 |
| [dedupe](2026-10-12-dedupe.md) | 重复实现收敛到 `modules/values.ts`；并记录"看着像重复、其实差一行"被单测抓住的一次 |
| [nasmodule-split](2026-10-12-nasmodule-split.md) | `NasModule.tsx` 712 → **55** 行（媒体/下载/系统三个窗口各自成文件） |
| [lazy-hls-tests](2026-10-12-lazy-hls-tests.md) | 按需加载的两条路径有用例钉住 + 产物守卫防止无声回退 |
| [local-network-permission](2026-10-12-local-network-permission.md) | Mac 客户端补上「本地网络」权限声明（本机 Playwright 被同一条机制拦住过） |
| [macos-integration](2026-10-12-macos-integration.md) | macOS 集成点：默认菜单会抢走 ⌘W（已自定义菜单），并把两项配置纳入自动检查 |
| [native-http-allowlist](2026-10-12-native-http-allowlist.md) | 原生白名单缺 20 条路径（音乐/海报/挂件/任务/下载只在客户端里会坏），补齐并加护栏 |
| [cross-language-hash](2026-10-12-cross-language-hash.md) | 上传哈希两端（TS / Rust）用同一组独立向量钉住，避免"只在客户端里传不上去" |
| [native-media-cookies](2026-10-12-native-media-cookies.md) | 原生媒体请求只带 2 个 cookie（网页版 5 个）→ 客户端里播不了；已补齐 |
| [upload-no-entry](2026-10-12-upload-no-entry.md) | 上传链路完整实现却**没有界面入口**（不是 bug，是范围）：如实记入能力矩阵 |
| [docs-check](2026-10-12-docs-check.md) | 106 篇文档的引用检查，修掉 11 处烂链并接入离线验收 |
| [feedback-round-ugreen](2026-10-12-feedback-round-and-ugreen-replica.md) | 用户 11 条反馈的根因与证据 + 绿联影视复刻 6 块 + 做不到 1:1 的部分 |
| [stacking-check-ruler](2026-10-12-stacking-check-ruler.md) | 「层叠聚焦」失败是**检查取点错了**（点到了被上层窗口盖住的位置）；补上命中诊断 |
| [watch-pass](2026-10-12-watch-pass.md) | 值守巡检：线上部署落后于仓库、20 MB 构建产物入库、lockfile 缺 hls.js |
| [ui-flows](2026-10-12-ui-flows.md) | 登录失败路径与独立商店页在真实引擎里跑通（都不需要登录） |
| [keyboard-and-theme](2026-10-12-keyboard-and-theme.md) | 三件易误判的事查清：Tab 跳按钮是 macOS 约定、置灰选项已补说明、主题不跟随系统是刻意 |
| [store-readiness-watch](2026-10-12-store-readiness-watch.md) | 商店引擎启用时会强制校验 origin/storeId，并每 30 分钟自动检查一次 |
| [dark-mode](2026-10-12-dark-mode.md) | 深色主题对比度：11 个窗口 10 个达 AA（剩 3 处属商店组件） |
| [layout-audit](2026-10-12-layout-audit.md) | 880/760/640 三种视口 × 11 窗口：33/33 无越界无裁字 |
| [audio-format-scan](2026-10-12-audio-format-scan.md) | 音乐库 76,914 首的构成；约 3.5% 浏览器注定放不了 |

## 已知限制（验证过、结论是做不到）

| 能力 | 原因 | 界面表现 |
| --- | --- | --- |
| 剪切板读取 / 自动监听 | 部署是 http://，非安全上下文，`navigator.clipboard` 不存在 | 控件置灰 + 说明改用 ⌘V |
| 约 3.5% 音乐（WMA/APE/DSD、40 个改名 mp3） | 浏览器无解码器，设备音乐不做转码 | 说明原因 + 「跳过这一首」 |
| 音乐封面 | 设备 `/zmusic_static/…` 对它自己返回的地址回 404 | 降级为音符图标，不伪造 |
| 官方 Docker API | 本机 9123 未监听 | 改走本机 Docker Engine（只读） |
| 服务端排序 | `/v2/file/list` 十种排序写法顺序全不变 | 改为"本页排序"并注明 |
| 单任务下载操作 | 参数名无法确定（`N202003`），设备上 0 个任务无从反推 | 不提供按钮 |
| 清空已完成任务 | 无法确认是否连带删除已下载文件 | 不提供按钮 |

## 脚本与产物

| 位置 | 用途 |
| --- | --- |
| `scripts/dark-contrast-audit.mjs` | 深色对比度巡检（脚本头部记着"尺子坏了"的三个教训） |
| `scripts/layout-audit.mjs` | 窄窗口布局巡检，带 `--selftest` 自检 |
| `scripts/ui-capture.mjs` | 分步截图/取值的浏览器巡检 |
| `scripts/functional-regression.mjs` | 功能回归（`--theme light\|dark`），已固化两个测具陷阱 |
| `scripts/webkit-render-check.cjs` | 用 WebKit 渲染并截图（Mac 客户端同款引擎） |
| `scripts/window-interaction.mjs` | 窗口拖动/缩放/最大化/层叠/⌘W 巡检（页面不可见时改用合成事件并标注结论等级） |
| `scripts/a11y-audit.mjs` | 可访问性：可聚焦元素的名称与焦点样式 |
| `scripts/static-audit.mjs` | 静态质量扫描：监听/定时器泄漏、effect 清理、缺 key、浮动 Promise |
| `scripts/bundle-guard.mjs` | 产物守卫：hls 必须独立成块、入口不得静态引入、首屏体积预算 |
| `scripts/docs-check.mjs` | 文档引用检查：Markdown 链接与文内仓库路径必须存在 |
| `scripts/deploy-smoke.mjs` | 线上冒烟：指纹、gzip、runtime-config、健康检查、Docker 接口、商店网关（不需要登录） |
| `scripts/ui-flows-check.cjs` | 界面流程：登录失败路径 + 独立商店页（WebKit，不需要登录） |
| `scripts/page-state.mjs` | 打印页面状态（desktop / login / unreachable），供巡检前置判断 |
| `docs/design-assets/fnos-reference/` | 飞牛真机截图 + 我们自己各窗口的截图 |
| `docs/verification/data/` | 大体量数据产物（如 2,665 行不可播放清单） |
| `deploy/nas-appstore/` | NAS 上的 Docker 部署（同源反代 + 商店网关） |
| `deploy/mac/build.sh` | macOS 客户端打包（写配置 → tauri build → ad-hoc 签名） |

## 部署与回归

**一条命令重跑全部验收**：

```bash
bash scripts/verify.sh          # 离线：类型检查 + 单元测试 + 构建 + 静态质量扫描
bash scripts/verify.sh --live   # 再加：两种主题回归 + 深色对比度 + 窄窗口布局 + 可访问性 + 窗口交互
bash scripts/verify.sh --all    # 再加：WebKit（Mac 客户端同款引擎）渲染检查
```

最新一次（2026-10-12 04:05）：**8 项全 PASS** —— 类型检查、单元测试
（54 文件 / 1150 用例）、前端构建、功能回归(light)、功能回归(dark)、深色对比度、
窄窗口布局、WebKit 渲染。

真机部分需要一个开着远程调试端口的浏览器（默认 `9455`）且页面已登录 NAS；
可用 `DSH_CDP_PORT` / `VERIFY_URL` 覆盖。单项失败时会打印最后十几行日志，
最后给出汇总表并以非零码退出。

单独部署与打包：

```bash
bash deploy/nas-appstore/build.sh   # 前端 + 交叉编译网关 + 组装产物
bash deploy/nas-appstore/push.sh    # 上传 → 解包 → 重启 → 健康检查 → 指纹核对
bash deploy/mac/build.sh [NAS地址]  # macOS 客户端（构建 → 写配置 → 打包 → 签名 → 配置核对）
```

## 还剩什么

| 项 | 谁 | 说明 |
| --- | --- | --- |
| 空间商店执行引擎 | Codex | 目录与登录界面已接入；引擎未配置，界面如实显示。**客户端侧契约已写成文档**：[store-integration-contract](../deployment/store-integration-contract.md) |
| Mac 客户端实际使用 | 用户 | 包已按最新代码重新打包（03:12）、签名、启动、sidecar 200；**界面仍没人看过**（截图需屏幕录制权限） |
| 「新建文件夹出现两次」现象 | 用户 | 已加同路径去重兜底；现象本身尚未复现 |
| Mac 客户端界面观感 | 用户 | 登录页已在 WebKit 里验证过（见 native-login）；**桌面与各窗口的观感仍无人看过** |
| 单任务下载操作 / 清空已完成 | 待授权 | 需要设备上有真实任务，且删除语义需确认 |
