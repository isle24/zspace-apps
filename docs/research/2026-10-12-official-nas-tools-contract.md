# 官方 NAS 工具协议核对与实现

2026-10-12。静态证据来自运行中的官方 Web 前端：通过 `sshbind exec --json zspace`，只读取 `127.0.0.1:5055/home/static/js/async/…` 公开脚本。没有使用官方客户端缓存会话，没有修改真实应用、便签、下载引擎或回收站项目。登录后的实际页面验收由主任务另行记录。

| 能力 | 官方契约与本次实现 |
| --- | --- |
| 下载引擎 | async 26357：`get/setting` 的 `bt_engine_type`、`bt_engine_type_list[]` (`type/name/version`)，`POST /downloader/engin/switch/exec` 的 `bt_engine_type`；切换前读 list.taskStatus，之后读 `/engin/switch/status`，终态 3/4/5 由用户点击 `/engin/switch/confirm`。不发送 `force`。页面按设备提供的引擎列表选择，轮询迁移状态。 |
| 远程入口 | async 80306：`POST /kv/load`，`k=remoteAccess`，`data.value` 是 JSON 列表；真实字段 `remarks/url/https/proxy/desktopVisible/color`。页面读取当前账号 NAS 配置，取消本地磁贴编辑；URL 仅允许无凭据的 HTTP(S)，NAS loopback 映射当前 NAS 主机名。外网代理打开仍需官方客户端。没有写 KV 全量列表，避免覆盖其他客户端修改。 |
| 便签 | async 62114/42303：`POST /v2/file/notepad/{list,info,new,modify}`，普通笔记 `location=2`，列表 `classify_id=0/start/num/label_id/sortby`。新建 Markdown `note_type=2`；修改 `id/title/body/in_brief/location`。列表只保留标题等摘要身份，不携带正文。只有用户打开项目才读内容。保存前检查当前 title/body 与编辑基线一致，保存后读取确认；未知创建结果阻止盲目重复提交。每个写入阶段都核对当前 NAS 会话与代次，登出或切换 NAS 后不会继续发送后续写入，也不会返回旧账号的入口/便签。富文本正文保留，支持读取和改标题，正文格式/附件编辑仍需官方编辑器。 |
| 回收站 | async 49535：个人聚合根 `/.recycle/my` 通过 `POST /v2/file/nb/list`，公共聚合根 `/.public_recycle` 通过 `/v2/file/list`；个人恢复 `/v2/file/mrestore`，公共恢复 `/v2/public/recycle/restore`，单项永久删除 `/v2/file/remove`。官方 HTTP 数组编码为 `paths[]`。操作前重读所选分页并核对路径，支持 `/<pool>/.recycle/my/…` 物理回收站身份。只对所选项目操作，没有全站清空按钮。设备接受请求与最终文件状态分开表述。 |
| 商店卸载/禁用 | async 36831、module 39950：removable 控制卸载，卸载前 `/AppStore/v1/pkg/depend/by` 检查 `app_name/version_int`；原生 `/AppStore/v1/pkg/remove`，Docker `/zdocker/AppStore/v1/pkg/remove`，`with_data=0` 保留数据。toggleable 应用停止即官方禁用操作。原生安装仍保留版本/依赖/磁盘核对与安装磁盘选择。Docker 厂商应用已按当前 14 个官方初始化模板接入目录、端口、凭据等字段，见后文。 |
| 原图/影视横图 | 官方 viewer.viewOrigin 使用普通 `/v2/file/download?path=…&remote_port=8050`、加密 `/v2/file/decrypt/download?encrypted_path=…&from=…&remote_port=8050`。适配器不创建不存在的 original 转码格式，沿用当前会话安全媒体注册。影视 backdrop 与海报单独验证，并在原生端登记安全 URI。 |

公开脚本 SHA-256：

- 80306：`b8c4307f91027276ced864b9b87e1c1903a7769f71d69b54e27718c9ce2e1e96`
- 26357：`75a4f9cee67c4255f616bfac4f1e35e62f3af4ac9d00e6198b52c794f9d5b4fa`
- 62114：`a257a0920b885770e1598120f4721dbaa4917415a9bac7f02ee0681812cb59af`
- 42303：`a000fee51fbc99f2a928dd544ddf2166a413d15f67fdf49f0d42ca4948dedcac`
- 49535：`cc44bea9d9b528d48783ecdba3b9b7191ab87d4b713bd1f05d36722267cc35da`
- 36831：`be9e55dfee2d375ca07a333186f01f0c8f1db56166c398a8de3886e4f31468ec`

验证：新增 `official-tools.test.ts` 经红绿循环；UI 的 `NasTools.test.tsx` 和 `NotesRecycle.test.tsx` 覆盖选择、确认和真实 API 适配。相关 10 个测试文件合计 259 项通过，`pnpm --filter @space/client typecheck` 通过。此记录不代表已对真实 NAS 执行上述写操作。

## 官方 Docker 应用安装补充

本轮完成当前目录中 14 个可安装厂商应用的真实初始化表单：OpenWebUI、EasyNVR、Halo、HermesAgent、Jellyfin、ddnsgo、dockercopilot、komga、lobechat、moltbot、octop、ollama、openlist、siyuan。内置 Docker 服务和 browser 项没有可安装厂商包，不套用厂商向导。

来源是正常登录后的官方目录公有版本信息与相应官方 ZIP 内的初始化 JS。归档解密字段只通过主任务的内存和本地 helper stdin 使用，没有保存或输出；仅将 JS 静态源码放入 ignored `.runtime` 做只读分析，未执行这些 JS，也未读取厂商 runtime params.json、私有配置或业务数据。提交源码只保留独立实现的字段契约和校验，不包含厂商 JS 或归档材料。

向导从 `/system/polling2` 的实际 mounted 文件池选择数据磁盘，通过官方文件列表选择或新建专用目录。Jellyfin 的配置/媒体目录与 Komga 的配置/漫画目录分别选择，可位于不同磁盘。SDK 重新核对版本、Docker 运行状态、依赖、每个目录身份和所有端口。目录按官方模板映射到 `/tmp/zfsv3` 下，不发送原生安装的 `mp` 字段，也不改变 Docker 全局镜像存储盘。端口范围 50000–65535，多服务端口禁止重复，并逐个调用 `GET /zdocker/app_check_port`；之后才调用 `/zdocker/AppStore/v1/pkg/preinstall`、`/pkg/install` 并回读应用状态。每个异步阶段核对会话代次，未知安装结果阻止直接重发。

| 应用 | 真实主目录字段 | 其他必填/选项 |
| --- | --- | --- |
| OpenWebUI | docker_openwebui_data | appstore_port、启动策略 |
| EasyNVR | docker_easynvr_data | appstore_port、官方确认项 |
| Halo | docker_halo_data | 数据库密码至少12位，含大小写字母和数字 |
| HermesAgent | docker_hermesagent_data | 控制台用户名/密码、docker_apiserver_port、docker_apiserver_key至少16位 |
| Jellyfin | docker_jellyfin_config | 独立 docker_jellyfin_media |
| ddnsgo | docker_ddns-go_data | appstore_port |
| dockercopilot | docker_dc_data | docker_dc_auth至少8位，不能纯数字 |
| komga | docker_komga_config | 独立 docker_komga_data、官方确认项 |
| lobechat | docker_lobechat_data | 独立 rustfs_port |
| moltbot | docker_moltbot_data | 独立 openclaw_bridge_port / openclaw_msteams_port |
| octop | appstore_vol_0 | appstore_username、appstore_password至少8位且含字母和数字 |
| ollama | docker_ollama_data | 主端口使用 docker_ollama_port，上下文4096/8192/16384/32768，核显0/1 |
| openlist | docker_openlist_data | 初次安装 docker_openlist_password |
| siyuan | docker_siyuan_data | docker_siyuan_auth |

密码和密钥只在表单中输入及向当前 NAS 提交，计划页面显示“已填写”，不展示值。自动启动默认值、口令约束、必选确认项均按各应用的当前初始化源设置。安装状态确认与仍在处理分开显示。新版本若改变初始化协议，仍需要重新核对静态模板；本次未对真实业务应用执行预安装或安装。

当前初始化脚本 SHA-256：

- EasyNVR / 598.4ffec2ef.js：`0d726d5e8090302ae25e074c509ef94ad89a02eb4d80434fbc5abb6372af87fc`
- Halo / 8166.f785506d.js：`13ebb6bb7dd7207419342d1903b5e84f6f722c29d96c68e75d7c9cd377580364`
- HermesAgent / 4233.694479c9.js：`185aea3b74c0dcc7c77d1a36b2a2c2876e2b8336f95f75e285c857bc854ab032`
- Jellyfin / 3336.50fbdd39.js：`1e322f58efefb7b2460e728ecd11ce688810fb4052177fb5595582969409822f`
- OpenWebUI / 1827.1cdd8fd7.js：`dd05c437e18d56edb87657def84082ac5503cafebf8215eba4192fdabdce792b`
- ddnsgo / 3588.918cf231.js：`94873a595075c88327aa45bf9d44a563d06593d3d755e10e6444eaf1329ea7e5`
- dockercopilot / 2028.42160893.js：`829a7c68bc1495b0e670f73d1011d23d880eff9049a08be8d4d257a8e3e0748a`
- komga / 6716.ed6baa69.js：`84e67ffbb3ce6a1fff7c41d262e7c75f35925633de5928140e7fce07dbe88de5`
- lobechat / 8944.6c7a20c7.js：`5e855f17c07d79da35a8b42b4dc39ffcb493aa20e715057766b4bc9f01e51f23`
- moltbot / 5368.c9e51992.js：`6cfd432318a1331798068183366e84c53c1582313c86a88660e3ba8473d8ba3b`
- octop / 2561.c719ba2c.js：`a49cb7422518ffcc6223e8ef9467709a85994b70989f8aef831ef1d4136e4528`
- ollama / 3393.530f59e5.js：`451d640e371f2e7b582f903de137d7b46089ed9792ff024e07e77861200d98eb`
- openlist / 5946.b30125fb.js：`c1d5ad367cd64cfa4c2d4508e3dad6c904b46ad0d89cd4602d1d7d668c992ca1`
- siyuan / 2901.dc60d2ae.js：`c0012c71bf9c2e4f1a5d0fac2ae08b2a56229634f2a943625382f1d7952942d8`

新增 SDK 20 项与 UI 4 项回归覆盖各应用准确字段、目录、端口、口令约束、未核对应用拒绝、会话切换隔离与计划隐藏凭据；相关应用商店测试合计30项通过，类型检查通过。真实 NAS 安装仍由主任务另行验收。
