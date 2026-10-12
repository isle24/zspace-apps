# Client Acceptance Repair Implementation Plan

**Goal:** 将官方应用商店、控制面板和 Docker 从字段查看器修复为用户可以操作的界面。

**Architecture:** 保留 OfficialNas 私有会话和正常登录。React 模块只调用受限 SDK；NAS 部署 proxy 通过固定 NAS 的身份验证保护 Docker 适配器；独立空间商店保持其现有工作树和协议。

**Tech Stack:** React 19、TypeScript、Vitest/Testing Library、Go net/http、Playwright、Tauri 2。

## 约束

- 工作目录 `/Volumes/jz1tb/website/zspache_apps`，当前功能分支原地修复；不覆盖独立空间商店工作树。
- 极空间仅用 sshbind 别名 zspace；不得删除 NAS 数据，验收仅写可还原设置与专用测试容器。
- 不显示凭证、包密钥、环境变量；所有成功必须读取状态确认。

## 任务

- [ ] 商店：在 OfficialStore.test.tsx 增加原生/容器唯一列表、中文图标/分类/搜索/详情、启停回读回归；在 api/official-management.test.ts 增加验证协议/拒绝非法动作测试。运行 `./node_modules/.bin/vitest run src/modules/OfficialStore.test.tsx src/api/official-management.test.ts` 验证失败，再实现受限操作及界面，重跑通过。
- [ ] 控制面板：在 SystemWindow.test.tsx 与 SettingsView.test.tsx 覆盖模块导航、有效中文表单、保存回读及失败保留。先运行失败，再修改 SystemWindow.tsx/SystemNetwork.tsx 和 SDK 设置方法，重跑通过。
- [ ] Docker：在 proxy/docker_test.go 覆盖真实 PrivatePort/PublicPort、无会话/普通账号/跨站拒绝、容器控制身份及回读、保护自身；在 DockerView.test.tsx 覆盖启停确认、异常日志、晚到响应。先运行失败，再实现 proxy 及 api/docker.ts、React 表单。执行 `go test ./...` 和对应 Vitest。
- [ ] 验收脚本：用独立脚本测试模拟单测/构建命令退出 1，确认 verify.sh 退出非零；修复 pipefail 与真假成功判定，重跑。
- [ ] 完整验证：前端 Vitest、tsc/vite、Go 测试、静态检查；构建专用修复产物，备份现有客户端静态文件和 proxy 后更新现有测试实例。Playwright 复查真实 58+16 条目录、设置保存还原、专用 Docker 测试容器控制回读及窄窗。记录证据和未验收项。
