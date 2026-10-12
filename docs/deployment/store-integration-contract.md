# 客户端 ↔ 空间商店：接入契约（给 Codex / 后续接手的人）

本文记录**我的客户端对商店服务的全部依赖**，以及接入完成时的判定标准。
商店实现本身由 Codex 负责，我只做接入 —— 所以这里写的是"客户端需要什么"，不是"商店该怎么做"。

代码位置：`apps/client/src/api/client.ts`（商店会话与信任）、
`apps/client/src/api/official-nas.ts`（NAS 侧换取商店会话）、
`apps/client/src/modules/StoreWindow.tsx`（两个来源的窗口）。

## 1. 传输与路径

- 网页版与容器部署：**同源** `/api/store/*`，由 `space-proxy` 转发到商店网关（默认 `127.0.0.1:18435`）。
- 原生客户端：直连 `runtime-config.json` 或用户填写的地址 + `/api/store/*`。
- 客户端只通过 **`/api/store/`** 前缀访问商店；其它 `/api/` 路径一律按 NAS 处理。

## 2. 客户端会调用的端点

| 端点 | 用途 | 客户端对响应的要求 |
| --- | --- | --- |
| `GET/POST /api/store/status` | 读商店配置 | `nasAuth = { enabled, origin, storeId }` |
| `POST /api/store/nas-session` | 用 NAS 会话换商店会话 | 见下方"换取会话" |
| `POST /api/store/install` | 触发安装（`{ planId, requestId }`） | 2xx；错误码按表处理 |
| `POST /api/store/logout` | 退出商店会话 | 2xx；失败不阻塞本地清理 |

商店自己的其它端点（目录、任务、维护等）由商店组件调用，不在本文范围内。

## 3. 三条硬性约束（客户端会强制校验）

| 项 | 要求 | 不满足时 |
| --- | --- | --- |
| `nasAuth.enabled` | 必须 **`true`** | `STORE_NAS_DISABLED`（403，界面显示"商店尚未启用 NAS 管理员登录"） |
| `nasAuth.storeId` | 必须是 **48 位小写十六进制** | `STORE_PROVIDER_MISMATCH`（403） |
| `nasAuth.origin` | 必须与当前 NAS 地址**完全一致**（客户端记录的 `baseUrl`，例如 `http://192.168.3.56:5055`） | `STORE_PROVIDER_MISMATCH`（403，"商店配置的 NAS 与当前设备不一致"） |

> 第三条最容易踩：客户端不会做等价归一（不认 `localhost` vs `127.0.0.1`、
> 不认多写一个 `/`、不认 http/https 互换）。**商店侧必须回填客户端登录时用的那个地址字符串。**

## 4. 换取会话（`POST /api/store/nas-session`）

请求体：

```json
{ "providerId": "http://<nas>:5055", "storeId": "<48 hex>", "token": "<NAS token>", "deviceId": "<设备 id>", "nasId": "<NAS id>" }
```

响应要求（客户端逐条校验，任一不满足即视为失败）：

```json
{ "sessionId": "<48 hex>", "username": "<非空，≤256 字符>", "expiresAt": "<ISO 时间>", "authSource": "nas" }
```

- `sessionId` 必须是 **48 位小写十六进制**，且**不能回显 NAS token**；
- `expiresAt` 必须在**未来**，且不超过**现在 + 20 分钟**（客户端按 5 秒超时发起请求）；
- 响应不得是重定向（`redirect: "error"`，且 URL 必须与请求一致）；
- 之后所有商店请求带 **`X-Store-Session: <sessionId>`**。

超时与失败语义：5 秒内没有合法响应 → `STORE_NAS_AUTH_TIMEOUT`（504）。
响应体 `ok !== true` 时：401/403 → `NAS_ADMIN_REQUIRED`；
其它 → `INVALID_RESPONSE`（502）。
客户端到点会**主动作废**本地商店会话并提示重试，不会静默继续。

## 5. 错误码 → 客户端行为

| 错误码 | 客户端行为 |
| --- | --- |
| `STORE_NAS_DISABLED` | 提示"商店尚未启用 NAS 管理员登录"，不重试 |
| `STORE_PROVIDER_MISMATCH` | 提示"商店配置的 NAS 与当前设备不一致"，不重试 |
| `INVALID_RESPONSE`（502） | **授权数据非法**：`sessionId` 不是 48 位小写十六进制、`username` 为空/超长/回显 NAS token、`expiresAt` 非法/已过期/**超过 20 分钟上限**、响应被重定向 |
| `NAS_ADMIN_REQUIRED`（401/403） | NAS 账号不是商店管理员：401 提示确认权限或重新登录，403 提示当前账号没有商店管理员权限 |
| `STORE_NAS_AUTH_FAILED` | 读取商店授权**配置**失败（不是授权数据非法，两者别混） |
| `STORE_TRUST_REQUIRED` | 显示授权目标确认（NAS 与商店地址），由用户确认后写入本地信任 |
| `STORE_SESSION_CHANGED` | 会话/地址/配置任一代次变化即作废，提示重新连接 |
| `STORE_SERVICE_CHANGED` | 同上（商店地址变更） |

**客户端不做自动重试、不缓存失败结果**：拿不到就如实显示，避免"假装能用"。

> 上表的错误码不是照文档写的，是**照着实现抄的** —— 写这三条契约用例时，
> 我原以为非法授权数据会报 `STORE_NAS_AUTH_FAILED`，实际是 `INVALID_RESPONSE`（502），
> 而 `STORE_NAS_AUTH_FAILED` 另有所指（读配置失败）。用例当场纠正了文档。

## 6. 接入完成的判定标准（客户端侧）

1. `bash scripts/verify.sh --live` 全绿（含 11 个窗口的功能回归）；
2. 应用商店窗口里 **两个来源**都能打开：
   - **极空间官方商店**（客户端直连 5055 的 `/AppStore/v1/list`，不依赖商店服务）
   - **空间商店**（Codex 的组件；未启用时如实显示"商店尚未启用 NAS 管理员登录"或"商店尚未启用"）
3. 若商店已启用：`/api/store/status` 返回上表的三个字段，且 `install` 能返回 2xx。

### 实测到的当前状态（2026-10-12 06:10）

```
$ curl -s http://192.168.3.56:18436/api/store/status
{"data":{"configured":false,
         "engineMessage":"执行引擎未配置；请登记本机Docker或可用sshbind别名。",
         "engineMode":"disabled","engineReady":false,
         "nasAuth":{"enabled":false,"origin":"","storeId":"a15b76644787485439c458f7a37752f6a83e18a3f2a1e526"},
         "nativeIntegration":"handoff","setupRequiresLoopback":true},
 "ok":true}
```

也就是说：**网关在跑、能应答、契约字段都在**，只是执行引擎没配（`engineMode: disabled`）。

- `nasAuth.enabled = false` → 客户端显示"商店尚未启用 NAS 管理员登录" ✓ 行为正确；
- `storeId` 已经是合法的 48 位十六进制 ✓；
- **`origin` 目前是空串** ✗ —— 启用时必须回填成客户端登录用的那个 NAS 地址
  （例如 `http://192.168.3.56:5055`），否则客户端会按第 3 节的第 3 条拒绝。

**当前状态**：客户端侧已就绪；商店执行引擎未启用时，窗口如实显示阻止原因
（见 `docs/verification/2026-10-12-store-two-sources.md` 与能力矩阵）。
Codex 侧最近在做目录扩展（datatotal / nasReader 的设计提案，待用户确认 A/B 方案），
其文档明确"不修改 dsh 客户端源码"，因此**接入动作在客户端侧不需要再改代码** ——
引擎就绪后只需确认上面第 6 节的三条。
