# 商店应用源协议 v1

这是设计契约，通用运行时 API 使用 `/api/store/v3`。现有 v2 实现保持兼容。本目录没有启用任何来源、签名钥匙、镜像加载或容器部署。

- `app-manifest.schema.json`：已锁定软件身份的可发布应用清单。
- `catalog.schema.json`：一个可信源的不可变版本目录。
- `catalog-envelope.schema.json`：最新目录的签名信封。
- `openapi.json`：27 个目标接口操作的请求、响应、鉴权与错误契约。
- `examples/datatotal.json`、`examples/nasreader.json`：基于已核查软件事实的未发布清单样例。
- `examples/catalog.json`：锁定上述样例原始字节的本地目录；路径相对于本目录作为示例源根，不相对于 examples/catalog.json。

上架只新增清单；自定义图标时再新增素材。清单也可以使用通用 monogram 图标，无需新增前端图标代码。发布工具自动生成版本目录、SHA256 和签名。本文不提供伪造签名样例；生产签名必须由发布者离线生成，私钥不进入 NAS/仓库/API。

JSON Schema 2020-12 负责字段结构；后端必须再进行以下语义检查，不能以 schema 通过替代执行许可：

1. 禁止 JSON 重复 key；保留原始字节并核对长度/SHA，先验信任和签名再接受来源；同序号不同内容与回退均拒绝。解析资源上限包括深度64、每数字 lexeme4096 bytes/绝对 exponent4096；先检查，再进入 Schema SDK，避免巨大指数分配。参数整数范围用精确数值比较，原始字节不因 DTO 数字表示调整而改变。
2. appId/releaseId 在各自作用域唯一；releaseNumber 严格递增；latestReleaseId 指向未 withdrawn 的真实交付；目录条目与实际清单身份一致。
3. 服务、卷、端口、参数 ID 唯一；总服务≤16、总卷≤32、总端口≤64、总参数≤64；依赖无环且引用存在。
4. 每服务镜像平台匹配 runtime.platforms。registry 的准确 manifest 与 platform/config 相符；归档实际长度、内容、config 和所有层身份都相符，不接受 tag 替代。
5. entry 指向一个公开 TCP 端口；health HTTP/probe 指向同一自有服务的 TCP 端口；只访问固定相对路径，拒绝外部 URL、query、fragment、路径穿越和重定向。
6. standard/restricted 只接受 container 端口；host-monitor 只接受 host 端口。portRef 引用同服务端口，bridge 输出 containerPort，host 输出计划选定 listener port；公开端口全部检查冲突，内部端口不对宿主开放。
7. environment 的 parameterRef/secretRef 类型正确；serviceRef 指向同 bundle 的依赖；runtimeRef 只返回 UID/GID/时区。literal 不允许发布秘密；参数 default 与声明类型/选项/范围一致；秘密没有默认值。字符串 pattern 用受限 RE2 语义，不执行代码。
8. mount 只能引用声明卷，容器 target 必须是规范化绝对路径，禁止相同目标和卷逃逸。嵌套目标必须在清单中分别声明，统一按父目标优先的确定顺序构建并逐项核对，支持已有应用的配置/数据子挂载。managed 只绑定新建自有路径；media-readonly 必须 RO；docker-socket 只能在批准 host-monitor profile 绑定准确 `/var/run/docker.sock`，不能改变目标或隐瞒其管理能力。
9. backup 必须包含全部 managed data/config/sync-data，可省略 cache；禁止备份已有媒体、socket 或运行进程环境。先反序停止全部服务并确认停止，再冷拷贝；恢复/更新只进入新副本。
10. 所需能力和权限模板/授予必须可用；软件未交付、未批准原生环境秘密持久化等情况返回明确 blockingReasons。新增 source 不授予 host-monitor 权限。
11. command/entrypoint/exec healthcheck 仅在已归属的应用容器中执行；不执行宿主 shell、构建/安装脚本或迁移 hook。服务 command/entrypoint 未提供时沿用镜像默认；明确提供字段（包括空数组）都要求 command.override，序列化后不能丢失“未提供”和“明确空数组”的区别。Docker 对最终 Cmd/Entrypoint 的镜像合并须由后续运行时按已核验镜像配置评估，不能把字段丢失当作默认行为。
12. 安装计划绑定原始清单 hash、软件、固定模板与策略、存储/Docker/网络/端口/自有资源身份。启动、检查、失败重试及恢复均比较同一描述，不按 appId 或名称猜测部署行为。

`POST /publication/validate?sourceId=...` 的 body 是完整清单原始 UTF-8 JSON；不是 `{manifest:...}` 包装。结果中的 manifestSha256 表示请求原始字节，normalizedManifest 是单独的结构结果，不混用其重序列化 hash。超过 1 MiB 返回413。完整清单语义错误统一以200/valid=false给出字段错误；无副作用。

普通成功响应沿用 `{ok:true,data:...}`；错误沿用 `{ok:false,error:{code,message,details}}`。接口中的“软件身份解析”只读访问允许 registry，不 pull/load/start；来源刷新只排队校验，不自动安装。所有接口使用正常商店管理员 Authorization header。

secret-sets 的请求上限 16 KiB、900 秒 TTL，绑定用户/会话/准确交付。句柄不可读回秘密；注销、重启或过期使它失效，队列转 needs_attention，不用空值执行。秘密不写入计划、商店 DB、日志、命令或 URL；daemon 原生环境存储边界按既有待答项处理。

datatotal 样例是 `2026.10.07-13` 固定平台 registry manifest，两个 host listener，APP_PORT/GO_COLLECTOR_PORT 的 portRef 和独立 secretRef。nasReader 样例是 `0.1.0` / `licensed-amd64-20261010` 历史归档，config/diffIDs 与 OCI manifest 分开，书库只读，正常 `/api/v1/setup` 探针和应用内授权。样例中的 archive path 尚未发布；新端口尚未在 NAS 预留或测试；契约目录 sourceId `contract-example` 没有生产信任或权限授予。
