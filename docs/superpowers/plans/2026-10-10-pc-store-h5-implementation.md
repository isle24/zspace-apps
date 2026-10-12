# PC 系统桌面、商店与 H5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement the independent tasks below and review each deliverable.

**Goal:** 交付本地可构建的 Tauri Mac 系统桌面客户端、可用应用商店服务和同源移动 H5，调用现有 5055，不删除 NAS 数据。

**Architecture:** React/TypeScript 共享 PC/H5 UI；PC 外壳为 Tauri 2。客户端的 OfficialNas SDK 调用官方 5055 原路径，Tauri 提供本地 HTTP 与媒体传输。Go 只负责独立商店身份、目录、配方、任务和 Docker/sshbind 执行；商店可独立部署。H5 开发使用固定目标透明代理，正式环境须另做同源验收。NAS 5055 原服务保留。

**Tech Stack:** React 19、TypeScript、Vite、Tauri 2、Go 1.26、SQLite、标准 HTTP/RSA 与受限 Docker 命令。

## Global Constraints

- 当前只开发 PC 客户端、商店、移动 H5；iOS/Android/HarmonyOS 原生包后置。
- NAS 5055 和原网页保留，不删除用户资料，不提供删除/格式化/清空/清理接口。
- 保留所有设计资源；本地 Git 可以记录开发，GitHub 仓库/Actions/发布等待用户验收。
- 测试凭据必须为人工合成；真实用户名密码只正常登录时在内存使用，不进入 CLI、普通文件或日志。
- 关闭应用窗口只改变 UI；安装/下载任务与数据保留；图标整理不移动 NAS 文件。
- unknown 能力显示真实待验证/不支持状态，不返回示例数据冒充 NAS 成功。
- 分工按目录隔离，各实现者仅修改自己拥有的目录，依赖文件由 root 协调。

## 现行契约（用户纠正优先）

原计划中的 `/api/nas/*` 自建 NAS REST 契约已作废，Go main 不注册该路由，实际返回 404。`server/internal/nas` 仅保留协议研究与回归，不能作为生产接入层。后文 Task 1 的 Go NAS 工作记录属于历史实现，后续执行以本节为准。

当前客户端以 `apps/client/src/api/official-nas.ts` 直接请求官方 `/key/pub`、`/auth/login` 及受控读取路径。正常会话 token 仅在内存；Tauri 可按用户选择把登录凭据保存至系统钥匙串。原生媒体通过客户端 `nas-media` URI 读取，不新增 NAS REST 服务。H5 开发代理 `/__nas` 仅透明转发已准许的原路径与响应，无业务封装；不支持未知写操作。

独立网页入口为 `store.html`，Go 默认首页为商店；客户端另有可选商店地址。商店状态、安装与会话不依赖 NAS 登录。实际验收记录见 [本轮验收](../../verification/2026-10-10-pc-store-h5.md)。

## 原始接口记录（NAS 部分已作废）

后端 JSON：成功 `{ "ok": true, "data": ... }`；失败 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。

NAS：`POST /api/nas/login` 接收 baseUrl、username、password；返回 sessionId（本 gateway 的不透明会话）、user、baseUrl，原 NAS Token 不出后端。`POST /api/nas/read` 接收 operation、params，使用 `X-NAS-Session`；`GET /api/nas/session`、`POST /api/nas/logout` 同样校验会话。

读取 operation：files.roots/list/info/recent；photos.albums/timeline/feeds；video.libraries/list/info/play；music.songs/albums/playlists/lyrics/play；downloads.list；system.overview/storage/network/settings；apps.list。结果优先归一为 `{items:[{id,name,kind,path,thumbnail,stream,size,metadata}],total,values}`，保留未知状态但不能输出秘密。

商店：`GET /api/store/status/catalog/roots/instances/jobs`；`POST /api/store/setup/login/plans/install`；`POST /api/store/instances/{id}/start|stop`。安装、计划、根目录、实例、任务查询使用 `X-Store-Session`；catalog/status 可只读公开。商店会话独立于 NAS 会话。

商店安装请求 `{planId,requestId}`，计划由服务端生成并不可由前端修改；重复 requestId 返回同一任务。所有路径属于明确登记的根，媒体只读，数据只写全新实例目录。nativeIntegration 返回 auto/handoff/unknown，与容器健康分开。

## Task 1：Go NAS 协议与会话（历史任务，已由直连 SDK 取代）

**Files:** server/internal/nas/*.go，server/internal/nas/*_test.go。

**Interfaces:** `New(Options) (*Service,error)`；`Options{DataDir string}`；`Register(*http.ServeMux)`；`DecodeResponse([]byte) (any,error)` 解码业务响应。

- [ ] 编写 httptest：HTTP200业务失败、错误会话、带凭据URL、跨主机媒体重定向、秘密字段泄漏被拒绝。
- [ ] 运行 `cd server && go test ./internal/nas -count=1`，记录预期失败。
- [ ] 从当前官方静态资源和用户授权的已登录页面核实协议；新鲜公钥、正常挑战、表单公共字段由适配器处理。
- [ ] 实现冻结的 NAS 路由、归一字段、鉴权图片/媒体代理、会话过期与错误；未知写操作拒绝，不猜测删除 API。
- [ ] 重跑目标测试、go vet；报告覆盖、未知协议与可验证证据，进行独立审阅。

示例契约测试意图：

```go
func TestBusinessFailureIsNotSuccess(t *testing.T) {
    _, err := DecodeResponse([]byte(`{"success":false,"code":"N001208","msg":"expired"}`))
    if err == nil { t.Fatal("HTTP 200 business failure must not be success") }
}
```

## Task 2：商店目录、计划与非删除执行

**Files:** server/internal/store/*.go，server/internal/store/*_test.go，server/internal/store/catalog.json。

**Interfaces:** `New(Options) (*Service,error)`；`Options{DataDir string,StorageRoot string,EngineMode string,SSHAlias string}`；`Register(*http.ServeMux)`。

- [ ] 写真实仓库/计划 tests：路径逃逸/符号链接、重复安装、外来容器、安装失败保留目录、stop不删除、未登录拒绝。
- [ ] 运行目标 go test，确认失败后实现。
- [ ] SQLite 保存管理员哈希、计划、实例和任务；不保存原始密码。首次 setup 只允许 loopback，后续需正常商店登录。
- [ ] 上架 Uptime Kuma、Navidrome 两份受控配方，其他发现目录保持待适配；图片/版本/来源数据明确。
- [ ] 执行层仅接受结构化参数；直连 docker 或 usable sshbind 别名；不用 sudo、rm、prune、down -v，不重建既有容器。
- [ ] 图片拉取/启动/健康/初始化/原生入口分阶段记录，失败保留数据；原生无并发安全机制时返回官方配置 handoff。
- [ ] 目标 tests/vet 与独立审阅；实际 NAS 创建在具体新实例计划形成后进行。

## Task 3：系统桌面与移动 H5

**Files:** apps/client/src/desktop/*，apps/client/src/modules/*，apps/client/src/api/*，对应 *.test.ts(x)，apps/client/src/styles.css。

**Interfaces:** API 使用冻结路径；桌面模块由 appId 打开，各窗口关联 deviceId/userId。root 提供项目构建配置、主入口与 Tauri native 集成。

- [ ] 写窗口 tests：最小化恢复、最大化还原、边界找回、设备切换隔离、关闭窗口不发 stop/delete 请求。
- [ ] 写流程 tests：NAS失败不回退示例；未授权安装无请求；确认页显示计划后才执行安装。
- [ ] 实现壁纸/图标/状态栏/Dock/窗口管理；手机 Launcher→全页应用→返回，媒体/任务状态共享。
- [ ] 实现文件、相册、影视、音乐、下载、应用商店、控制面板的真实读取与动作状态，登录/离线/权限/能力状态准确。
- [ ] 运行 `pnpm --filter @space/client test`、typecheck、build；真实浏览器检查桌面与手机布局。
- [ ] 独立审阅与修正，不用设计截图代替组件。

## Task 4：Tauri、独立商店服务、构建与验收

**Files:** apps/client/src-tauri/*，server/cmd/space-gateway/main.go，scripts/*，README.md。

- [ ] root 编写 gateway 集成/sidecar启动失败与进程身份 tests，确认 red。
- [ ] 配置 Tauri restricted sidecar；Go监听本进程启动的随机loopback端口，不能复用不明已有服务；Rust不开放任意shell。
- [ ] native 登录凭据仅按用户选择保存在系统钥匙串；NAS token 与 H5会话仅留内存，不用localStorage存Token，不持久化 HTTP Cookie jar。
- [ ] Go仅服务独立商店Web产物，移动客户端H5通过官方同源或透明开发代理验收；GitHub workflow不创建。
- [ ] 运行整套类型、单元、Go race/vet、Rust检查、Web构建、Mac本地包构建。
- [ ] 从新包启动并验收桌面/窗口/登录/商店/H5；用户授权的网页登录用于接口采集，密码不导出。
- [ ] 记录本轮已通过与未通过实机项目，最终代码审阅并修复；不把需要真实账号/外网验证的项宣称通过。

## 当前执行账本

开始于只有设计文件、没有产品代码的工作区。Xcode27.0已定位，用户已确认完成许可；PC技术栈确定为Tauri。实际实现、测试与审阅结果记录在 .superpowers/sdd/progress.md，不能重复分派已完成任务。
