# 用户反馈与交付能力核对清单

日期：2026-10-12（Asia/Shanghai）。核对对象为当前工作区源码、现有回归及会话内已确认的本轮结果。本文没有重新操作 NAS、没有重新执行整套测试，也没有用历史真机结果代替新版本部署验收。

范围来自：

- [11 条反馈及绿联影视参考](./2026-10-12-feedback-round-and-ugreen-replica.md)。沿用原文编号，不补造原文缺少的编号。
- [客户端验收修复设计](../superpowers/specs/2026-10-12-client-acceptance-repair-design.md)。包括其相册、音乐、挂件、Compose、普通用户安装补充。
- [媒体、Compose 与商店计划](../superpowers/plans/2026-10-12-client-media-compose-store.md)。计划中的旧复选框不作为当前实现状态。
- [本轮管理交付设计](../superpowers/specs/2026-10-12-admin-delivery-design.md)。包括 AI、Compose 导入、图标、镜像缓存、2FA 和部署。

不把旧 `STATUS.md` 中未经用户确认的待办扩为交付范围，例如不据此增加新的上传入口。

## 证据如何阅读

| 类型 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| 当前源码及回归存在 | 功能入口、权限与失败分支已实现，行为已有测试覆盖 | 不能单凭测试文件存在宣称本轮运行通过或真机通过 |
| 本轮已执行的本地检查 | 对应版本的测试、类型检查和构建结果 | 不能替代已部署版本或 NAS 实际动作结果 |
| 历史真机记录 | 记录当时的设备、固件与产物表现 | 后续源码变化后，不能直接复用为本轮验收结论 |
| 本轮服务器验收 | 需记录具体版本、健康、认证、持久数据及实际操作结果 | HTTP 200、静态页面可打开不等于安装、AI 或绑定全链路成功 |

本轮已确认的本地结果：AI/Compose 服务端 12 项回归通过，新增相关管理前端 9 项回归及类型检查通过。主任务随后确认 Go 全套通过、定向 race 检查通过（81 秒）、客户端 1286 项和管理前端全套 15 项通过；独立商店此前 300 项通过，回退修复后预计 302 项的最终结果仍待主任务确认。这些是对应执行时的结果，本文没有重新跑全套检查。

## 前面反馈逐条核对

下表的“已修”表示当前源码已有对应处理；“历史实测”来自原反馈记录，不表示本轮重新实测。

| 原编号 / 反馈 | 当前实现与回归位置 | 当前结论与证据边界 |
| --- | --- | --- |
| 1：相册部分图片不显示 | `apps/client/src/modules/PhotosWindow.tsx`：原图失败回退预览，预览失败显示图形占位；`PhotosOriginal.test.tsx`、`PhotosWindow.test.tsx` | 已修失败兜底。历史记录相册 22 张中 2 张失败，修后 `broken=0`；本轮没有重新统计真实图片成功率 |
| 1b：相册出现“音乐”文案 | `MediaWindow.tsx` 对相册路由到独立 `PhotosWindow`；`MediaSkin.test.tsx` 锁定相册入口和文案 | 已修媒体模块混用文案 |
| 1c：相册字体被遮挡 | 独立相册工作区、标题与工具栏分区；`fnos-media.css`；`MediaSkin.test.tsx` | 已修布局结构。历史标题条高度测量只属于当时版本，本轮仍需浏览器确认宽窄窗口 |
| 3：相册观感及文件名 | `PhotosWindow.tsx` 按 `cdate` / 真实时间分组，图块仅显示画面，文件名保留于提示及可访问名称 | 已修；缩略图大小和年份导航可操作，缺少真实日期时显示“日期未知” |
| 4：影视首页封面 | `MediaWindow.tsx` 用媒体库真实影片海报形成拼图，封面失败有回退；`MediaSkin.test.tsx`、`MediaHero.test.tsx` | 已修媒体库无封面字段时的展示。历史记录 4 个拼图、14 张封面成功，不等于当前数据数量 |
| 5：进度条被大边框遮挡 | `fnos-controls.css` 排除 range 的输入框样式；`fnos-player.css` 定义播放器进度 | 已修；历史实测 40px 框恢复为 16px 进度。本轮没有重新做像素测量 |
| 6：窗口不能下拖、顶部关闭按钮被挡 | `desktop/state.ts` 与 `WindowFrame.tsx`；`desktop/state.test.ts` 覆盖系统栏顶部 62px 和拖动边界 | 已修；历史记录拖动 300px 可实际移动 300px，本轮没有重新操作桌面窗口 |
| 7：1024G 以上显示 TB | `modules/common.tsx` 的 `formatBytes` 支持 TB/PB，资源挂件容量显示支持 TB | 已修；不再把 4TB 磁盘固定表示为 4096GB |
| 8：系统设置还是参数 | `SystemNetwork.tsx` 的 `SettingsView` 只渲染确认过含义的字段；`SettingsView.test.tsx`、`api/official-management.test.ts` | 已修中文开关/选项、保存回读和失败保留内容；未知字段不作为可编辑设置进入主界面 |
| 9：设备信息是原始 JSON | `common.tsx` 的 `DataValues` / `dataValueText`：布尔为开关，简单数组列值，对象为项数；系统概览使用专用卡片 | 已修；没有把设备 JSON 原样作为主界面内容 |
| 10：官方商店与空间商店独立 | `App.tsx` 分别挂载 `StoreWindow` 和 `SpaceStoreWindow`；`OfficialStore.tsx` 与独立 `apps/store` | 已修。旧 `store-two-sources.md` 描述同一窗口切换两来源，已经不是当前实现状态 |
| 11：远程访问独立 | `RemoteWindow.tsx` 只挂载 `OfficialRemoteEntries`，不再显示控制面板外壳；`RemoteAccess.test.tsx` | 已修独立窗口；仍只展示设备真实提供的远程入口 |

## 绿联影视参考的六块

| 块 | 当前实现 | 限制 / 历史差异 |
| --- | --- | --- |
| 侧栏 | `MediaWindow.tsx` 的影视导航和媒体库分组，CSS 定义选中胶囊 | 历史记录选中背景与 9px 圆角；本轮没有重新比对参考截图 |
| 首页 hero | 真实片名、元信息、播放、推荐切换；`MediaHero.test.tsx` 验证先读取实际文件再播放及旧会话丢弃 | 当前 `HeroBackdrop` 只接受设备返回的真实横版背景，并检查宽高比；没有背景时显示明确提示。旧文档中“模糊竖版海报代替 backdrop”不能作为当前行为说明 |
| 媒体库封面与评分 | 真实海报拼图、设备 `score` 评分角标 | 缺失评分不伪造；拼图数量由真实数据决定 |
| 工具条 | 当前页名称/评分/年份排序，网格/列表切换 | 源码注明设备忽略相关排序参数，采用本地排序；不能声称跨全部分页结果的服务端排序 |
| 详情页 | `VideoDetails.tsx` 展示真实元信息、播放、编号选集及演职姓名；`VideoDetails.test.tsx` | 没有演职头像时用姓名占位；已看/收藏仅显示设备只读状态 |
| 播放器 | `VideoChrome.tsx`：前后 15 秒、上下集、时间、倍速、音量、选集、PiP、全屏；`VideoChrome.test.tsx` | 不承诺设备未提供的画质档位或字幕轨；PiP/全屏还受浏览器和系统能力约束 |

没有最近播放缩略图、横版 backdrop、演职头像或字幕数据时，客户端如实显示缺失能力，不把假图片或不可操作按钮当作复刻完成。历史记录的离线 7/7、真机 14/14、Mac 重新打包与 sidecar 200 属于原反馈版本，不能直接用于本轮新增 AI/2FA/缓存后的发布结论。

## 已授权补充能力

| 能力 | 当前源码 / 回归 | 实际交付边界 |
| --- | --- | --- |
| 官方应用中文名称、分类、详情、安装与启停 | `OfficialStore.tsx`、`DockerAppInstall.tsx`、官方 NAS SDK；`OfficialStore.test.tsx`、`DockerAppInstall.test.tsx` | 两来源各读取一次；安装选择设备磁盘/目录、核对已验证依赖与协议并回读任务状态。只支持已验证安装协议，未验证模板明确显示限制；没有设备入口时不猜访问 URL |
| 系统设置保存 | `SystemNetwork.tsx`、`saveSetting` SDK、`SettingsView.test.tsx` | 只保存白名单字段，保存后设备回读；失败保留编辑内容 |
| Docker 实际操作 | `DockerView.tsx`、`DockerCreate.tsx`；`deploy/nas-appstore/proxy/docker*.go` 及回归 | 完整容器 ID、NAS 管理员、跨站防护、自身容器保护、读回实际状态；支持详情/日志/启动/停止/重启/暂停/恢复、受限创建。旧 `system-docker.md` 的“完全只读、无任何 start/create”属于早期状态 |
| 镜像可读命名 | `DockerView.tsx` 的仓库/标签映射及 `DockerView.test.tsx` | 无标签时解释并显示 digest，不假造仓库标签 |
| 相册工作区 | `PhotosWindow.tsx`、`PhotoAlbumCreate.tsx`、`api/photo-workspace.test.ts` | 包含普通/宝宝/共享/收藏/文件夹/智能分类、年份和网格尺寸；宝宝使用 type=60，并有成长记录。普通及宝宝创建使用官方字段及读取确认。当前固件缺少可信重复分组，重复照片区域明确说明限制 |
| 音乐布局及封面 | `MusicWindow.tsx`、`MusicArtwork.tsx`、官方 SDK 的 `musicArtwork` 与内嵌图片解析回归 | QQ 音乐式侧栏/专辑/曲目表和播放器；先设备封面，再有限大小的 MP3/FLAC 内嵌图片，失败保留占位。历史设备音乐封面 404 不等于当前内嵌封面分支未实现，也不能保证所有歌曲均有封面 |
| 资源挂件拖动 | `ResourceWidget.tsx` 与 `ResourceWidget.test.tsx` | 指针/触摸拖动、边界、位置保存、方向键/Home 移动，拖动把手与展开按钮分离；只渲染真实监控字段 |
| NAS Compose 创建 | `DockerComposeCreate.tsx`；`proxy/docker_compose.go`、`docker_compose_nas.go` 与回归 | YAML 编辑，本机/NAS YAML 与 .env 导入，选择 NAS 保存目录，验证预览后部署；保留多服务（最多 8）并状态回读。支持字段有限，未知/危险字段直接报错；挂载只支持受控数据卷，不接受任意宿主路径。官方任务尚未完成时显示 pending，不能当作运行成功 |
| 云目录与 NAS 本地运行分离 | `cloud_*`、`runtime_cloud*`、`CloudAccountPanel.tsx`、NAS 会话桥 | 云端账号用于目录/心愿/历史；NAS 授权用于本机安装；NAS 身份交换失败仍保留独立登录。不将 NAS 密码传给云目录 |
| 管理员 AI | `cloud_ai.go`、`AiSettingsPanel.tsx`、`AdminApp.delivery.test.tsx` | 配置密钥加密且不回显，公开 HTTPS/DNS 校验、超时/大小限制；先核验镜像，再产生全部资料草稿，秘密默认值移除，图标不可靠时生成缓存 PNG；必须核对、保存后才发布。真实服务调用还需要管理员配置可用模型/密钥 |
| 管理员 Compose 一键添加 | `cloud_compose.go`、`ComposeImport.tsx` 及回归 | 当前 CloudApp 发布模板仅支持单服务、一个 TCP 入口。多服务、UDP、只读挂载或无法保留的权限/命令等配置明确返回 422，输入保留；没有声称支持云后台多服务上架。此限制与上行 NAS Compose 的多服务能力不同 |
| 图标及镜像缓存池 | `cloud_artwork.go`、`cloud_icons.go`、`cloud_cache.go`、运行时镜像读取及回归、管理设置面板 | 受限图标目的地，后端缓存优先、GitHub 素材兜底；镜像 linux/amd64 内容身份校验、容量/热度淘汰、失败回退原始 digest。缓存不删除宿主 Docker 镜像或应用数据。首次读取设置完成前禁止保存，避免默认容量覆盖 |
| 管理员双重验证 | `cloud_totp.go`、`SecurityPanel.tsx`、登录与认证回归 | 扫码后正确六位码才能绑定；密码/动态码验证、重放防护；生产未绑定只进入引导，本地可不强制。不能把二维码显示当作绑定完成 |
| 两套 Compose、客户端 Actions | `deploy/compose/ui`、`deploy/compose/catalog`、Dockerfile、`.github/workflows/client-build.yml` | 源码入口已经提供；NAS UI 默认不等于完整安装引擎。Actions 文件存在不等于远端运行成功，实际运行结果应另外记录 |
| Linux amd64 普通用户安装器 | `deploy/docker-installer/build-package.py`、`install-docker.sh`、安装器回归 | NAS 端依赖 Docker 27.3+ 和常见 shell 工具，不依赖 sshbind/主机 Go/Node/Python；有校验和、专用目录与身份保护。源码 `BUILD_*` 是构建占位，必须使用实际生成并校验的发布安装器，不能直接将模板当成可下载发布产物 |
| 备份迁移、服务更新 | `docs/deployment/store-backup-migration.md`、`deploy/zstore` | 备份恢复演练文档已有历史证据；本轮更新仍需版本快照、服务健康及数据保留检查。新源码、构建成功不能单独证明 nj-game/NAS 已更新 |

## 本轮只读审查发现与跟进

以下问题已报告主任务。核对期间主任务已经修复了目录隔离和字段校验的源码，新增测试结果应由主任务最终运行记录补充。

| 问题 | 跟进状态 | 仍需确认 |
| --- | --- | --- |
| catalog/wishlist/history 使用 Promise.all，私人记录 503 会挡住已成功回退的目录 | 当前已经改为 Promise.allSettled，目录可单独显示；`CloudAccountPanel.test.tsx` 已新增备用目录/私人记录不可用回归 | 新增回归运行结果，以及账号在后台中断时仍保持 |
| 备用目录只检查 id/name/icon，environment 非数组可让安装组件异常 | 当前已经增加 environment 数组及条目字段检查 | 非数组及错误条目的拒绝回归 |
| NAS succeeded 后先等待云端 history，导致本机成功无法显示 | 当前成功分支已先标记本机完成；`trackCloudInstallHistory` 仍负责后台恢复后重试 | 历史请求失败的延迟回归；成功状态变化会触发 effect cleanup，失败提示须以当前账号/NAS scope 为准，不能被 cleanup 的 cancelled 标记吞掉。父面板也不能在历史 503 时显示“历史已同步” |

按本轮实际需求和当前 CloudApp 模板，云后台 `import-compose` 采用单服务草稿导入，对多服务明确报错、不丢弃服务；设计文档已经同步这个范围。NAS Compose 的最多 8 服务部署是另一入口。没有把云后台多服务上架列为本轮已完成能力，也没有据此扩大用户未特别要求的云端发布范围。

凭据和身份部分未发现明显泄露：前端 GitHub 请求没有 Authorization，使用 cookies omit、禁止重定向和无 referrer；备用响应返回前核对账号 generation 与有效会话。主服务明确 401 会清除失效会话，不以公开备用目录绕过拒绝。服务端 `runtimeCloudFallback` 同样新建不含 Bearer 的 GitHub 请求，且主服务 401 不触发回退；安装仍核验签名、manifest digest 和 NAS 本地权限。

## 本轮部署与外部构建快照

以下由主任务在本会话提供，本文没有另建远程连接重复操作。它们用于区分本轮部署与较早真机记录。

| 项目 | 本轮已确认 | 仍未替代的验收 |
| --- | --- | --- |
| nj-game 云商店后台 | 已更新服务；`/admin/`、`/api/health` 返回 200，匿名受保护管理请求返回 401 | 管理员真实验证器扫码绑定、配置实际 AI 服务并生成草稿仍需人工完成 |
| NAS 三方 UI / 代理 | 已更新为 `client-review-20261013-000606-366cc7`，更新检查通过 | 不把静态更新和健康检查当作当前 NAS 业务写操作全量复测 |
| 线上镜像缓存 | 默认 5 GiB，已开始预热 | 尚不能用“开始预热”宣称所有镜像完成缓存、安装或原始 digest 回退真机通过 |
| 源码与 Actions | 私有源码仓库 `isle24/zspace-apps` 已创建并推送；[Actions 38273294058](https://github.com/isle24/zspace-apps/actions/runs/38273294058) 已全部成功（4个平台客户端及NAS H5包） | 四个桌面目标和NAS H5均成功，已生成可下载的未签名原生产物 |

发布结论仍须准确区分：管理员扫码/真实 AI 配置的人工步骤，NAS Compose 专门验收容器的状态回读，镜像缓存/回退实际安装链路，以及 Actions 最终结果。原生 Mac/Windows/Linux 新包的实际产物或限制也应单独记录，不能复用历史 Mac 启动证明。

未执行、未登录、能力缺失、待人工配置以及后台任务 pending 应分别记录，不统计为通过。


2026-10-13 增量验收：后端图标改哈希路径，避免线上网关拦截外部URL参数；已打包七款内置图标作后端首选，GitHub地址在客户端兜底。云目录回退不会被心愿/历史请求失败丢弃，NAS安装成功先显示成功，云历史故障独立提示并保留后台重试。独立商店最终302用例、管理后台15用例通过；Go全套77.379秒通过，交付相关race81.042秒通过。NAS代理Go测试通过。

线上图标补充：2026-10-13，后端已实测返回 HTTP 200、image/png、13071 bytes（Navidrome内置图标），前端优先哈希路径，不将外部URL作为查询参数。GitHub Actions运行38273294058的H5、macOS ARM64、macOS Intel、Linux AMD64、Windows AMD64五个任务全部success。
