# 独立商店对接真实 Go 服务验收

日期：2026-10-11（Asia/Shanghai）｜范围：独立商店（`store.html` + 客户端商店窗口）对**真实 Go 服务**的端到端验证
服务：`go run ./cmd/space-gateway --listen 127.0.0.1:18435 --data-dir .runtime/h5 --web-root apps/client/dist --engine disabled`

## 1. 为什么能做这次验收

商店不依赖极空间账号，可以完全在本机跑通，因此这一轮把商店从「mock 截图」升级为「真实服务截图」。
数据目录固定为 `.runtime/h5`（已 gitignore），管理员账号是本次会话创建的本地测试账号，不是任何真实凭据。

## 2. 实测通过的真实链路

| 步骤 | 请求 | 真实结果 |
| --- | --- | --- |
| 服务启动 | `bash scripts/dev-h5.sh` | `{"event":"ready","address":"http://127.0.0.1:18435"}` |
| 商店首页 | `GET /` | 200，真实目录已渲染 |
| 目录 | `GET /api/store/catalog` | 200：5 个分类、5 个应用（Uptime Kuma 2.5.6 / Navidrome 0.64.2 可安装；Jellyfin / Immich / Syncthing 为「配方待验证」） |
| 状态 | `GET /api/store/status` | 200：`configured:false` → 首次配置前 |
| 首次配置 | `POST /api/store/setup`（loopback） | **201** + 会话；密码长度校验 12–72 字节、用户名白名单均生效 |
| 管理员会话 | `X-Store-Session: <48 位>` | `GET /api/store/jobs` → 200 `{items:[]}`；无会话时 401 `store_auth_required` |
| 登记目录 | `GET /api/store/roots` | 200：返回初始登记目录与角色（`data` / `mediaReadOnly`） |
| 存储发现 | `GET /api/store/storage` | **503 `storage_discovery_unavailable`**：「执行引擎未配置，尚不能发现真实数据卷。」——未配置时不伪造容量 |

截图（真实服务，非 mock）：

- `20261011-store-live-standalone-1600x1000.png`：独立商店首页，真实目录 + 真实引擎未启用告警
- `20261011-store-live-admin-1600x1000.png`：界面内真实管理员登录后（「管理员已登录」）
- `20261011-store-live-storage-1600x1000.png`：执行设备配置区，说明 NAS 登录不会自动绑定安装目标

## 3. 本轮修掉的真实缺陷

| 缺陷 | 原因 | 修复 |
| --- | --- | --- |
| 商店卡片应用图标全部显示破图 | 我在换图标时删除了 `public/app-icons/navidrome.png`、`uptime-kuma.svg`，但 `AppArtwork` 仍引用它们 | 从 git 历史恢复两个文件；`AppArtwork` 增加 `onError` 回退到语义字形；新增 2 条测试（文件必须存在、加载失败必须回退） |

## 4. 与并行分支的关系（重要）

本仓库存在一个**链接工作树**在并行推进商店登录门：
`/Users/isle/.codex/worktrees/store-login-gate/zspache_apps`，分支 `codex/independent-store-login`
（提交 `a975478` → `ab08ce8` → `aaf4a1c`，基于本分支的 `706edaa`）。该分支的规格
`2026-10-11-independent-store-login-gate.md` 要求：**匿名访问商店目录必须返回 401
`store_auth_required`**，并规划了 `apps/store/*` 的迁出。

因此本节记录的两点需要按分支区分：

| 行为 | `feat/pc-store-h5`（本次验收） | `codex/independent-store-login`（并行分支） |
| --- | --- | --- |
| `GET /api/store/catalog` 匿名 | **200**（当前实现） | 规格要求 **401**（该分支实现中） |
| 商店前端位置 | `apps/client`（`store.html` 入口） | 迁往 `apps/store/*` |

本次**没有**改 `server/internal/store/service.go`，避免与并行分支冲突。合并时注意：
该分支基于 `706edaa`，之后本分支又落了 4 个提交（启动台、移动端修复、服务 IO 求和、商店 logo 修复），
需要一并合并过去。

## 5. 未验证 / 限制

1. **安装流程未走通**：`--engine disabled`，没有登记执行引擎（本机 Docker 或 `usable: true` 的 sshbind 别名），
   因此安装计划、任务执行、实例启动均未验证——这也是服务端如实返回 503 的原因。
2. ~~客户端商店窗口未验证~~ → **已验证**：经 Vite `/api` 代理连 18435，窗口内渲染出真实目录
   （5 个应用 + 真实 logo + 真实状态）、真实「执行引擎未配置」告警与管理员登录入口。
   截图 `20261011-store-live-window-1600x1000.png`（DOM 内 `.catalog-card` 计数 6，`pageErrors: []`）。
   窗口内的完整点击流（登录→安装向导逐步）仍未走。
3. ~~390px 未截图~~ → **已截图**：`20261011-store-live-standalone-390x844.png`，无横向溢出、无页面报错。
