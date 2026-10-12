# 参考项目与极空间能力证据

调查日期：2026-10-10。调查方式为公开主来源读取和 sshbind 只读检查；没有获取平台密码、令牌、私钥内容或修改 NAS 数据。

## 固定参考版本

- fnos-apps：895280cbcd4470a2f0357a06e812941379c97589。
- fnos-store：0cfc42e2e63daf49fa7433a7952460a4b5900da6。
- taste-skill：717446e07a78d4e6d7918b1fde1a263378eebac9。

## 公开源码

| 证据 | 来源与设计含义 |
| --- | --- |
| 应用目录 | [apps.json](https://github.com/conversun/fnos-apps/blob/895280cbcd4470a2f0357a06e812941379c97589/apps.json)：目录、分类、图标和版本可借鉴；需要筛选 Docker 应用并重新确认架构和配方 |
| 商店真实源码位置 | [build.sh](https://github.com/conversun/fnos-apps/blob/895280cbcd4470a2f0357a06e812941379c97589/scripts/apps/fnos-apps-store/build.sh)：下载独立 fnos-store 的二进制 |
| fnOS 平台依赖 | [appcenter_linux.go](https://github.com/conversun/fnos-store/blob/0cfc42e2e63daf49fa7433a7952460a4b5900da6/internal/platform/appcenter_linux.go)、[rpc.go](https://github.com/conversun/fnos-store/blob/0cfc42e2e63daf49fa7433a7952460a4b5900da6/internal/platform/rpc.go)：平台 CLI、Unix socket 和 RPC 不适用于极空间 |
| 向导参考 | [WizardDialog.tsx](https://github.com/conversun/fnos-store/blob/0cfc42e2e63daf49fa7433a7952460a4b5900da6/frontend/src/components/WizardDialog.tsx)：可借鉴配方驱动表单，需增强目录选择、步骤和初始化状态 |
| 更新边界 | [upgrade_linux.go](https://github.com/conversun/fnos-store/blob/0cfc42e2e63daf49fa7433a7952460a4b5900da6/internal/platform/upgrade_linux.go)：以实际平台升级能力决定能否保留数据，不用卸载重装冒充升级 |
| UI 范围 | [taste-skill/SKILL.md](https://github.com/Leonxlnx/taste-skill/blob/717446e07a78d4e6d7918b1fde1a263378eebac9/skills/taste-skill/SKILL.md)：视觉规范可按上下文应用；密集工具界面和多步向导属于其范围外 |

应用资产记录上游与授权来源。参考仓库不作为可直接复制全部应用代码、图标或原生包的授权结论；第一版架构按独立实现设计。

## 官方产品资料

- [T6 官方介绍](https://zspace.cn/t6/)：提及第三方应用、Docker、Compose 与手机/电脑远程使用；这是产品能力说明，不能代替第三方 SDK 或包格式。
- [官方软件介绍](https://www.zspace.cn/software/software_h5.html)：区分普通账号和本地离线账号，介绍桌面快捷入口；远程访问限定为 NAS 同局域网中的网页服务，不适用于所有非网页协议。

## 实机静态证据

SSH 入口为 sshbind exec --json zspace。Docker 版本、Compose 版本、容器列表和选定容器 inspect 成功。无免密 sudo。仅检测访问权限，不通过创建容器测试写权限。

官方 Web 静态资源版本：

- /home/static/js/index.f6361495.js：应用列表与 /zdocker/AppStore/v1/* 安装流程。
- /home/static/js/async/80306.41634c3e.js：RemoteAccessNas；remoteAccess KV、desktopVisible、icon、正常账号验证流程，以及官方配置接续参数。
- /home/static/js/async/95908.ec60d934.js：/shortcut/adddockershortcut、dockershortcuts、/apps/homeapps、savehomeapps 等声明。

这些名称来自运行中的官方前端代码，属于当前版本私有接口线索。未调用安装、注册、KV 写入或桌面修改接口；没有登录或注册成功证据。

特别关注：remoteAccess 在官方前端中按整组列表保存。不能遗漏既有元素和未知字段；没有并发安全机制时，单靠先读后写无法保证不覆盖官方客户端同时修改的内容。

## 尚未通过的能力验证

正常授权和令牌刷新；第三方自定义应用注册；官方图标格式；远程条目的用户作用域；并发无损保存；多端桌面刷新；外网官方客户端访问；首次初始化结果识别；对已有数据不产生写入和删除的部署行为。

本轮设计图由内置 imagegen 按“清爽工具界面、单一绿色强调、分类应用网格、访问初始化面板、真实状态表达”生成，是评审用视觉概念，不是前端截图或运行验证。
