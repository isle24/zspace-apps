# 管理能力与部署交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 完成本轮全部明确需求并更新服务。
**Architecture:** 扩展现有 Go cloudService，管理员功能按 AI/Compose、安全、缓存独立模块；React 页面统一调用 Bearer 授权 API；构建及部署使用现有路径。
**Tech Stack:** Go、SQLite/PostgreSQL、React、Tauri、Docker Compose、GitHub Actions。

## Global Constraints
- 不删除用户数据、不更改 NAS 5055；远端只用已存在 usable sshbind 别名。
- 不泄露密码、AI Key、TOTP 秘钥、GitHub 凭据。
- AI 和 Compose 生成可编辑草稿，发布仍核验镜像与权限模板。
- 生产要求 2FA 绑定引导，本地不强制，扫码后提交正确验证码才绑定。
- 镜像缓存限制总大小，淘汰只操作本服务缓存，原始镜像兜底。

### Task 1: AI 与 Compose
- [ ] 创建 cloud_ai.go、cloud_compose.go 及回归，提供 ai-settings、ai-assist、import-compose 管理 API；密钥加密与脱敏。
- [ ] 依据镜像公开元信息提示模型；完整字段严格校验；Compose 转清单/草稿，禁止静默丢弃服务。
- [ ] `cd server && go test ./internal/store -run 'TestCloud(AI|Compose)' -count=1`。

### Task 2: 2FA
- [ ] 创建 cloud_totp.go、测试与独立 SecurityPanel，loginAccount 检查 TOTP，认证中加生产绑定引导限制。
- [ ] `cd server && go test ./internal/store -run 'TestCloud(TOTP|TwoFactor)' -count=1`，验证未校验不绑定、重放拒绝、普通用户隔离。

### Task 3: 镜像与图标缓存
- [ ] cloud_cache.go 用受限 registry SDK 下载完整镜像为缓存包，统计请求热度、按预算淘汰。
- [ ] 客户端/controller 对缓存校验与原始引用回退；图标使用后端缓存 URL 与 GitHub 兜底。
- [ ] Go 缓存回归及前端图标回归。

### Task 4: 页面、构建、部署
- [ ] 管理编辑器增加 AI、Compose 导入与图标预览，设置接入 AI、缓存、安全独立面板。
- [ ] 两个 Compose 部署方案、Dockerfile、配置样例、客户端 Actions 并提供部署说明。
- [ ] 前端 `pnpm --filter @space/client test`、`@space/store test`、`@space/catalog-admin test`，三个 typecheck/build。
- [ ] Go 全套测试；准备版本备份、更新 nj-game、健康与页面验收；Actions 推送并检查构建。
