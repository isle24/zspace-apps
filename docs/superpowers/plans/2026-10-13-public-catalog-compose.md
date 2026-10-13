# 全目录发布与可复制 Compose 实施计划

> **For agentic workers:** Use executing-plans to implement task-by-task.

**Goal:** 按用户确认，全部应用资料公开展示，只有通过现有镜像和清单验证的记录开放安装；提供自包含 Compose 并同步两处仓库说明。

**Architecture:** CloudApp 增加 `catalogOnly`、`compatibilityNote`、`sourceURL`，资料发布剥离部署字段并不产生签名安装版本。安装发布继续执行 AMD64 镜像摘要和权限结构核验。匿名 `public-catalog` 返回已发布资料，NAS 商店首页合并本地已审查配方与云目录。

**Tech Stack:** Go/SQLite/PostgreSQL、React/TypeScript、Docker Compose、GitHub CLI。

## Global Constraints

- 保留现有 7 条发布、版本和签名身份；新增原生/复杂配方资料不可生成安装计划。
- 管理 API 保留管理员认证与生产 2FA；离线发布仅在持有服务器管理权限并停止本服务后执行。
- 不打印/导出数据库密码、签名私钥、用户令牌，不把生产 DB 装入镜像。
- Compose 自己生成并持久化 PG secret；已有数据缺 secret 必须失败；初次管理员通过隐藏交互初始化。

## 1. 发布边界

新增 `cloud_listing.go` 和测试：资料发布、匿名仅已发布列表、不能安装/返回清单、既有发布不覆盖。抽出 `publishInstallable(ctx, app)` 复用正常安装发布流程；离线 `PublishCloudApps(ctx, []CloudApp)` 保留原发布并将核验失败的候选降为明确资料条目。

验证：`cd server && go test ./internal/store -run 'Cloud.*(Listing|Publish|Operator)'`；先观察 missing route/field 导致测试失败，再实现。

## 2. 发现与后台

更新 store API 类型及公共目录 reader（边界格式验证、凭据省略、GitHub 兜底）。更新 RuntimeStore 合并发现卡片与分类，并将云应用安装走既有登录/不可变计划。CloudAccountPanel 禁用资料条目安装/恢复，后台显示和编辑发布方式。

验证：`pnpm --filter @space/store test`、`pnpm --filter @space/catalog-admin test`、类型检查及构建；资料按钮不得触发 NAS 或云计划请求。

## 3. 自包含 Compose

`compose-standalone-ui.yaml` 配置 NAS 上游、公开来源与本地控制器；`compose-standalone-catalog.yaml` 使用 named secret volume 和一次性生成服务、PG17、中央目录与交互 setup profile。初次 `docker compose run --rm -it setup` 初始化管理员。

验证：Compose config、真实隔离启动、重复启动不改密码、已有数据缺密码拒绝、setup 隐藏输入及 2FA、健康检查；不修改生产业务数据。

## 4. 发布交付

构建 r3 两镜像、验证启动及远端摘要；备份后升级云后台、离线批量发布并核对公开记录/签名数；更新 NAS UI。公开 GitHub 素材仓库只接收公开 JSON/清单/图标来源和 docs，源代码用现有安全 snapshot 发布。两 README 含完整 YAML 和首次管理员命令。
