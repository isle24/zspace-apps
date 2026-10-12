# 受管 NAS 控制器版本更新

`scripts/update-store-controller.py` 只更新已经有完整受管 receipt 的控制器。SQLite 始终留在原路径，应用数据目录、StoreID、存储映射、UID/GID、端口和 Docker 限制保持一致。每次更新使用新的 release、镜像和容器；原容器、镜像、receipt 与备份全部保留，不执行删除。

默认命令只做只读 review。真正切换必须明确传入 `--apply`。目标镜像必须是在现有 immutable 镜像之上只更新网关的兼容 overlay；脚本验证 Linux AMD64、原始 RootFS layers 前缀、环境、入口、标签、工作目录与默认用户。构建 overlay 时不修改旧镜像 tag，先核对旧 tag 仍指向 receipt 里的 image ID；新 tag 已存在时改用新的 release，不覆盖它。

## 准备镜像

编译当前 `server/cmd/space-gateway` 为 `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` 的 `space-store`。在新的专用 staging 目录放入二进制与 Dockerfile：

```dockerfile
FROM space-store-owned:原受管版本
COPY --chmod=0555 space-store /opt/space-store/space-store
```

记录二进制和传输包的 SHA256。在服务器校验后构建新的 `space-store-owned:新版本`，记录其完整 `sha256:` image ID。此过程可以在旧控制器运行时完成。保留 staging 目录作为版本证据。

## 只读审核与切换

有 NAS 管理员会话时，先在“商店维护”暂停新操作。SSH/Docker 管理员执行本轮已授权的服务器升级时，也可以明确使用 `--offline-maintenance`：它不使用、创建或伪造 NAS 登录会话；它在真实 native update lease 内，对专用 SQLite 执行 `BEGIN IMMEDIATE`，核验所有任务均为明确终态后写标准 `store-update` 维护记录，`requestId` 以 `offline-update-` 开头。

维护暂停在停止容器之前提交，阻止 idle 检查与停止之间新任务入队；Go 的任务准入在事务内检查同一维护状态。停止确切旧 container ID 后，还会持 controller lease 再次检查任务并备份数据库。如果发现 queued、running、needs_attention、未知状态或损坏证据，更新拒绝继续。

```bash
python3 scripts/update-store-controller.py \
  --alias zspace \
  --receipt /data_数据盘/服务/releases/原版本/receipt.json \
  --image-id sha256:新镜像完整ID \
  --release 新版本 \
  --offline-maintenance --resume-offline
```

审核输出会列出确切来源、目标、StoreID、目录和端口。核对后给同一命令加 `--apply`。备份保存在 `服务/releases/新版本/backup/`，包括停止后完整 SQLite、原 self record、原 receipt 和数据库摘要。程序创建新受管容器，原子切换 self record，验证协议健康、StoreID、数据库结构与存储映射，再写 `switch-result.json`。

`--resume-offline` 明确要求健康验证通过后，通过标准 resumed 维护记录恢复 ready。省略它就保持 paused，等待管理员使用页面恢复。离线操作的 UID/GID、维护 ID 和选项同时保存在 `update.json`。数据库里的账号、会话和应用状态不由更新脚本重新创建或重置。

兼容校验保持原有全部 `sqlite_schema` 对象逐项相同，仅允许当前网关声明的两个新增空表：`runtime_secret_sets(id TEXT PRIMARY KEY,scope TEXT NOT NULL,ciphertext BLOB NOT NULL)` 与 `runtime_cloud_recipes(id TEXT PRIMARY KEY,body TEXT NOT NULL)`，以及各自的 SQLite 主键索引。它不执行这些迁移、不删除数据，也不接受其他表、索引、列或非空新增表。

如果新容器已经健康运行、receipt 和备份已建立，但最终校验尚未完成，不能重复 `--apply` 覆盖版本目录。使用完成入口核验现有运行候选、停止的旧容器、原维护 ID、任务状态、备份和兼容结构，再恢复 ready 并写 `switch-result.json`：

```bash
python3 scripts/update-store-controller.py \
  --alias zspace \
  --complete-update /data_数据盘/服务/releases/新版本/update.json \
  --offline-maintenance --resume-offline
```

完成入口不创建、停止或启动容器，不替换备份。已有匹配的成功结果时返回该结果，不重复切换。

## 回滚

旧容器必须仍然停止，并保留原 receipt 与镜像。回滚先暂停新任务、确认没有活动或不确定任务，验证当前结构和存储映射与版本备份一致，备份失败版本的当前 SQLite，然后停止新容器、恢复原 self record 并启动旧 container ID：

```bash
python3 scripts/update-store-controller.py \
  --alias zspace \
  --rollback-update /data_数据盘/服务/releases/新版本/update.json \
  --offline-maintenance --resume-offline
```

回滚同样不覆盖 SQLite，不删除新容器或任何应用数据。除上述两条经过核验的空表新增外，结构或存储映射已变化时会拒绝回滚，保留当前元数据与全部备份供检查。中途失败时，先查看相应版本目录及确切容器状态，不能用清空目录、删除卷或重装来处理。新 receipt 已建立后可走上述回滚；候选尚未建立时，核对原 receipt/self record 和数据库仍匹配，再恢复原容器。
