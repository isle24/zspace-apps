<!-- docs-check: planned -->
> **说明（2026-10-12 补）**：下面这些 `docs/research/validation/*.md` 是当时的**计划产出**，
> 最终没有按这些文件名创建 —— 实际证据写进了
> `docs/research/2026-10-1*-*-evidence.md` 系列（连通性、文件读写、搜索、音乐播放等）。
> 计划文本保留原样，只在本行标注状态，避免读者按旧路径白找。

# 极空间原生集成能力验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对已确认的路线 A 建立可核验的原生集成能力结论，确定自动注册、官方页面接续和 Web 桌面的使用条件。

**Architecture:** 商店安装与极空间入口适配分离，官方适配按正常用户授权执行。缺少安全的注册协议时采用官方界面接续，独立 Web 桌面保持可用，并分别报告局域网和外网能力。先完成本验证阶段，再为商店 MVP、应用配方扩展和桌面客户端分别编制实施计划。

**Tech Stack:** 当前阶段使用 sshbind、Python 标准库、Docker/Compose 的只读查询及官方客户端；后续商店建议 Go + SQLite + React/TypeScript。

## Global Constraints

- 用户已经确认“官方集成优先，另做漂亮的 Web 应用桌面作为兜底（推荐）”。
- 第一版实机交付针对 linux/amd64。
- 商店和部署工具不提供删除数据操作，既有容器与目录不自动接管。
- 涉及向已有用户目录授予读写权限的配方，必须先讨论。
- sshbind 只使用 usable=true 的服务器；选项写在别名前；不使用 add、import、remove 或破坏性参数。
- 不读取系统密码文件、客户端登录缓存或数据库来获取凭据；正常授权通过官方登录/授权界面完成。
- 不执行 prune、down -v、递归删除或失败目录自动清理；测试产生的实例、镜像、配置和数据保留。
- 本轮只编写计划和更新设计；下列写入验证尚未执行。实际执行先形成具体的新实例部署计划，不通过未知参数试探写接口。

---

## 阶段边界与证据约定

本计划只验证商店原生集成，不能单独宣称商店或完整客户端已经交付。用户已将总范围扩展为全主要模块客户端，见 [完整客户端设计](../specs/2026-10-10-zspace-client-design.md)。商店源码组织与运行数据组织沿用 [商店设计稿](../specs/2026-10-10-zspace-app-store-design.md)。

所有能力结论使用四种状态：

- `supported`：在当前版本、当前授权范围下完成操作及实际结果核验。
- `handoff`：可打开并预填官方配置界面，需要用户在官方界面完成保存。
- `unavailable`：当前版本明确拒绝，或没有满足数据保护要求的实现方式。
- `unknown`：没有完成必要验证，不将静态源码发现或本地 200 作为通过证据。

每条证据记录日期、ZOS 版本、官方 Web 资源指纹、客户端平台、登录方式、测试实例稳定 ID、操作类型、结果和范围。账号标识脱敏；记录请求方法、路由和字段名，不保存密码、Cookie、Token、带签名 URL 或完整用户远程入口列表。

私有接口发现路径：index.f6361495.js、async/80306.41634c3e.js、async/95908.ec60d934.js，具体来源见 [调查记录](../../research/2026-10-10-reference-and-zos-evidence.md)。资源哈希改变时重新发现当前页面的资源路径，不能用旧哈希 404 推导整个平台不支持。

## Task 1：只读环境基线

**Files:**
- Create during execution: `docs/research/validation/01-environment.md`  <!-- docs-check: planned -->
- Reference: `docs/research/2026-10-10-reference-and-zos-evidence.md`

**Interfaces:**
- Consumes: sshbind JSON 中的 name、usable，以及当前设计的 linux/amd64 目标。
- Produces: NAS 架构、ZOS 版本、Docker/Compose 版本、只读 Docker 访问结果和普通用户权限结论。

- [ ] **Step 1：发现有效别名。**

```bash
sshbind list --json
```

预期：zspace 的 usable=true。否则执行 `sshbind test zspace` 区分连接和密钥问题；不添加、导入或改写 SSH 配置。

- [ ] **Step 2：一次连接收集基线。**

```bash
sshbind exec --json zspace 'id; uname -m; cat /etc/os-release; docker version --format "{{.Server.Version}}"; docker compose version; docker ps -a --format "{{.Names}}\t{{.Status}}"'
```

预期：架构与目标匹配，Docker 查询可用，Compose 返回版本。2026-10-10 调查为 x86_64、ZOS V1.0.0450046、Docker 27.3.1、Compose v2.29.7；新执行以当前结果为准。解析 stdout，各项失败分别记录，不用复合命令的最后退出码掩盖中间失败。

- [ ] **Step 3：保存脱敏基线。** 记录版本和权限结论；既有容器名称只在本地受控诊断中使用，公开报告不列完整清单。该任务不拉镜像、不创建容器。

验收：能够区分“Docker 可读”和“创建权限已验证”，当前任务只证明前者。

## Task 2：静态接口与并发机制核验

**Files:**
- Create during execution: `docs/research/validation/02-native-protocol.md`  <!-- docs-check: planned -->
- Reference: `docs/research/2026-10-10-reference-and-zos-evidence.md`

**Interfaces:**
- Consumes: Task 1 的当前系统版本与官方 Web 访问结果。
- Produces: 当前资源指纹、已发现字段、候选注册方式，以及 `nativeWriteMode`，其取值为 `item_api`、`conditional_list`、`official_ui` 或 `unknown`。

- [ ] **Step 1：从官方首页发现资源。**

```bash
sshbind exec --json zspace 'python3 -c "
import urllib.request,re,json
u=\"http://127.0.0.1:5055/\"
with urllib.request.urlopen(u,timeout=10) as r:
    b=r.read(262144).decode(\"utf-8\",\"replace\")
    scripts=re.findall(r\"<script[^>]+src=\\\"([^\\\"]+)\",b)
    print(json.dumps({\"status\":r.status,\"scripts\":scripts},ensure_ascii=False))
"'
```

预期：返回静态 JS 路径。此请求不需要获取用户登录态；失败记录 HTTP 状态或网络错误。

- [ ] **Step 2：核验候选机制。** 只读分析当前官方资源中 remoteAccess、desktopVisible、icon、/shortcut/adddockershortcut、/zrps/api/remoteaccess/add 和 configRemoteUrl/dockerId/ports 的字段、调用顺序与响应判定。保留最小源码摘录与资源指纹，不运行官方压缩 JS。

- [ ] **Step 3：判断并发写入方式。** 在源码、接口说明和正常官方界面请求中寻找按条目 CRUD、revision、ETag/If-Match 或其他服务端条件更新机制。没有证据时 `nativeWriteMode=official_ui`，后台自动整组 KV 写入关闭。

- [ ] **Step 4：定义禁止路径。** 不直接修改 /var/appstore 数据库、系统服务、官方客户端包或用户 remoteAccess 全量配置；不把一次读取后合并视为并发安全。

验收：每个候选机制明确标为静态发现或实际验证；没有服务端并发保证时不得安排自动整组 KV 更新。

## Task 3：正常授权与商店自身入口

**Files:**
- Create during execution: `docs/research/validation/03-auth-and-bootstrap.md`  <!-- docs-check: planned -->

**Interfaces:**
- Consumes: Task 2 的 nativeWriteMode 和当前官方配置接续参数。
- Produces: 官方客户端会话方式、后台适配授权的独立可用性、账户作用域、到期行为、商店自身的引导访问方式；不输出令牌。

- [ ] **Step 1：通过官方客户端正常登录。** 使用用户自行输入的账号、密码和必要验证；已登录时复用该正常会话，不要求再次登录。不能把 SSH 用户属于 docker 组当作官方接口授权。

- [ ] **Step 2：核验权限边界。** 检查当前身份能否进入远程访问和桌面配置，确认管理员与普通账号的差异。仅有一个账号时跨用户结果记 unknown，不冒充多用户验收完成。

- [ ] **Step 3：记录安全的授权接续方式。** 明确由官方页面保存还是可使用正式/正常授权的 API；令牌过期需重新授权。后台授权能力单独记录，不能因官方客户端登录成功就标成独立商店已经获得平台授权。禁止从系统文件、平台数据库或桌面缓存导出身份。

- [ ] **Step 4：确定首次打开商店的路径。** 新部署的商店先仅绑定 loopback，经 SSH 端口转发建立管理员；关闭首次设置入口后才启用局域网访问。商店自身的远程入口默认在已登录官方客户端里配置一次，自动注册已通过时才能改为自动路径。

验收：授权流程没有依赖凭据提取；商店首次访问不循环依赖尚未注册的自身远程入口。

## Task 4：全新隔离实例的桌面与远程验证

**Files:**
- Create before write validation: `docs/research/validation/04-isolated-instance-plan.md`  <!-- docs-check: planned -->
- Create during execution: `docs/research/validation/05-native-desktop-and-remote.md`  <!-- docs-check: planned -->

**Interfaces:**
- Consumes: Tasks 1–3 的权限、协议和正常授权；部署计划中已经确定的实例 ID、新目录、端口、镜像 digest 和操作清单。
- Produces: 官方快捷方式和远程注册的实际状态；幂等性与既有入口保持结果。

- [ ] **Step 1：形成具体部署计划。** 使用新的独立测试实例；建议先用 Uptime Kuma。填写现场发现且确认为新目录的存储位置、未占用端口、实际固定镜像 digest、容器名称、持久化挂载及将调用的接口。若参数或权限仍未知，不执行创建。

- [ ] **Step 2：建立测试基线。** 在自建测试数据目录写入标记文件，记录文件摘要；既有用户资料不参与试验。记录官方已有入口的数量和稳定身份摘要，原始内容不输出到日志。标记文件及实例均保留。

- [ ] **Step 3：安装并初始化。** 只创建计划中的新实例。先检查服务健康，再进入其首次设置页面；没有受支持初始化 API 时由应用自身界面完成首次管理员设置。记录健康与初始化各自的结果。

- [ ] **Step 4：按能力档位配置官方入口。** item_api 或 conditional_list 已经过实际协议验证时执行精确新增；official_ui 时打开预填官方配置页并由用户保存。未知接口不通过猜测 payload 反复提交。

- [ ] **Step 5：检查图标和用户作用域。** 验证真实应用图标显示、名称正确、刷新后仍在目标用户桌面；字段读回与桌面可见分别记录。内置图标和自定义图片分开验收；自定义图片不支持时原生入口采用经过验证的内置图标/颜色，Web 桌面显示实际应用图标，不将内置图标成功记成自定义图片成功。

- [ ] **Step 6：重复同一新增请求。** 可证明幂等且不会覆盖既有条目的机制才重复调用；否则只检查当前条目身份，并将自动幂等能力记 unknown。核对已有条目身份和未知字段保持，不以只比数量判定完整保存。

- [ ] **Step 7：重验测试数据。** 比较标记文件摘要和已创建应用数据；不运行卸载、清理、恢复覆盖或删后重建试验。

验收：记录真实结果，禁止把已安装、已初始化、已注册和已显示图标压缩为单一“成功”。如果注册受限，记录 handoff 并保留容器和全部数据。

## Task 5：外部网络与应用实际协议验收

**Files:**
- Create during execution: `docs/research/validation/06-external-network.md`  <!-- docs-check: planned -->

**Interfaces:**
- Consumes: Task 4 的已配置官方远程入口和当前正常会话。
- Produces: 已验证外网路径及应用需要的协议能力，未测试项为 unknown。

- [ ] **Step 1：从外部网络打开入口。** 使用手机移动网络或另一实际外网，通过官方客户端打开本测试实例；同一局域网中的本地浏览器检查不能满足该项。

- [ ] **Step 2：检查真实操作。** 验证首次配置后的登录、页面刷新、Cookie、重定向，以及应用实际使用的 WebSocket/SSE。未使用的协议标为不适用，不人为声称都已验证。

- [ ] **Step 3：检查访问策略。** 退出登录、重新授权及不同用户的可见性按可用测试账号验证；保留应用自身认证，不为了代理成功关闭它。

- [ ] **Step 4：记录入口失败行为。** 连接失败后应用仍运行，已有数据仍在；状态明确是“官方远程访问不可用”，提供官方配置接续和已经配置好的本地地址。

验收：远程能力基于外部网络实际打开的证据；未提供外部网络环境时结果保持 unknown。

## Task 6：能力结论与商店 MVP 交付边界

**Files:**
- Create during execution: `docs/research/validation/07-capability-result.md`  <!-- docs-check: planned -->
- Modify after evidence exists: `docs/superpowers/specs/2026-10-10-zspace-app-store-design.md`

**Interfaces:**
- Consumes: Tasks 1–5 的实际证据。
- Produces: 商店 MVP 使用的能力矩阵和下一阶段计划输入。

- [ ] **Step 1：逐项结论。** 分别列 Docker 创建、应用首次初始化、正常授权、按条目注册、图标、桌面可见、外网访问、多用户和并发保存；每项使用本计划规定的状态和证据路径。

- [ ] **Step 2：明确路线 A 的体验。** supported 时自动注册；handoff 时预填官方页面并提示用户完成最后一步；unavailable/unknown 时提供独立 Web 桌面和实际可用地址，不伪造官方集成。

- [ ] **Step 3：收敛 MVP 独立子项目。** 顺序为：商店身份与目录 → 安装计划与任务 → Uptime Kuma 完整流程 → Navidrome 只读资料挂载 → Web 桌面与实际能力对应的官方入口 → 扩展应用配方。每个子项目按验证结论编制自己的具体代码实施计划。

- [ ] **Step 4：记录本阶段限制。** Web 桌面不自带内网穿透；非网页端口不经官方网页远程入口转发；下载/双向同步涉及既有资料读写时先讨论。完整客户端按新增规格推进，本计划不能代替媒体、文件、系统设置及客户端独立远程的验收。

验收：设计与实施输入一致，所有未通过的能力均可见，不将脚本、概念图或静态源码发现作为产品交付证明。

## 执行后的交付清单

- 一份脱敏环境基线、当前官方资源指纹和协议结论。
- 一份具体的新实例部署计划与实际执行记录。
- 一份官方桌面图标和外部网络访问的验收结果。
- 一份包含 supported/handoff/unavailable/unknown 的能力矩阵。
- 保留全部测试实例和数据；未修改既有用户资料和已有应用。

本阶段完成后再进入商店 MVP。若出现需要系统特权、直接整组覆盖配置或向既有资料授予读写权限的要求，先拿具体证据和最小变更方案讨论，不能自动扩大权限范围。
