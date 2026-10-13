# fnOS 目录导入

导入来源为 [conversun/fnos-apps](https://github.com/conversun/fnos-apps)，固定提交 `d297f9ac155b15a26b92632ee045ff4d530e2571`。本次目录包含 175 个应用：107 个 Docker 应用、68 个原生 FPK。新增条目导入为后台草稿，已有条目保留原状态；客户端公开目录只读取已发布记录。

| 来源分类 | 数量 | 草稿状态 |
| --- | ---: | --- |
| 可表达为现有单服务字段的 Docker 候选 | 38 | 保留真实镜像、入口端口、受管数据目标和环境参数；发布前仍需验证镜像架构、宿主账号及权限 |
| 尚需完整模板适配的 Docker 应用 | 69 | 保留来源及阻塞说明，镜像和入口留空；多服务、特权、外部目录等不会缩减成可安装的单容器 |
| 原生 FPK | 68 | 明确标注原生待适配，镜像和入口留空 |

本次只补齐后台目录。镜像或端口留空的草稿可以查看来源资料；当前后台保存校验要求完整 Docker 配置，需完成平台适配后才能保存、发布。原生 FPK 不能通过填一个虚构镜像变成可安装应用。

`provenance.json` 保留固定来源、原始应用标识、版本、平台、完整服务数量、经敏感值处理的 Compose 结构及阻塞原因。此旁路文件用于归档，避免后台保存时丢弃未知 JSON 字段；草稿描述也保留简短来源和适配状态。秘密环境参数不复制来源默认值。

## 生成交付包

生成只在构建工作站运行，需要 Python 3 和 PyYAML。已取得固定提交的 `apps.json`、完整 Git tree 响应及源码目录后运行：

```bash
python3 scripts/import-fnos-catalog.py \
  --catalog .runtime/fnos-apps.json \
  --source-root .runtime/fnos-apps-d297f9ac \
  --source-tree .runtime/fnos-source-tree.json \
  --output .runtime/fnos-import-d297f9ac-final
```

生成器核对完整 tree 的固定 SHA，校验目录 JSON、README、LICENSE、175 个 manifest 和 107 个 Compose 的 Git blob SHA；不接受已有输出目录，保留之前的证据。输出 `import.sql`、`drafts.json`、`provenance.json`、`report.json`、README、完整上游许可证及 `SHA256SUMS`。

来源目录 JSON 的 SHA-256 为 `0cef24db52d4d01f357164c17429531ee02c21013e685a4a30230af9e89c085d`。执行前在交付目录校验：

```bash
sha256sum -c SHA256SUMS
```

macOS 可用 `shasum -a 256 -c SHA256SUMS`。源代码及生成器保留在仓库，交付包中的 SQL/JSON 可独立归档。

## 数据库执行

先按 [商店备份与迁移](store-backup-migration.md) 完成 PostgreSQL 备份。由已有权限的数据库管理员使用其现有连接方式执行；密码通过既有 secret 或交互输入读取，避免加入命令行：

```bash
psql --no-psqlrc --file=import.sql
```

SQL 使用 `ON_ERROR_STOP` 和单事务，锁定 `cloud_apps` 后计算全部已有行四列的哈希；以 `ON CONFLICT (id) DO NOTHING` 插入，并在提交前核对已有行完全不变。新记录的 `published_json` 是 SQL `NULL`，不是空字符串，`dataTargets` 和 `environment` 是数组。未改管理员、认证、发布状态或历史版本。

现有 `immich`、`jellyfin`、`memos`、`nasreader`、`navidrome`、`syncthing`、`uptime-kuma` 七个标识必须存在，否则整次导入失败。来源中六个同名标识直接跳过，`nasreader` 保留；来源中的数字开头标识 `1panel` 转为 `fnos-1panel`，符合现有应用 ID 规则。SQL 打印七行导入前后哈希及总数，用于核验。

当前七行数据库的预期结果：首次新增 169 条，总数 176 条，其中已发布 7 条、草稿 169 条；重复运行新增 0 条。上线后应核对后台总数和来源说明，并核对公开目录仍只包含原有发布记录。适配和发布按普通后台审核流程逐项进行。

## 来源与许可证

来源 [README](https://github.com/conversun/fnos-apps/blob/d297f9ac155b15a26b92632ee045ff4d530e2571/README.md) 和 [GNU GPLv3 许可证](https://github.com/conversun/fnos-apps/blob/d297f9ac155b15a26b92632ee045ff4d530e2571/LICENSE) 随交付保留；描述和经处理的 Compose 结构来自该仓库。各应用软件、镜像和原生 FPK 的许可与再分发要求仍由各自来源决定。

本地 PostgreSQL 17 已验证首次导入、重复导入、七条原记录四列哈希、发布数量及数组形状；本地结果与最终文件哈希一同归档。生产执行与后台验收由实际部署环节记录。

## 2026-10-13 服务器执行结果

生产备份 `/var/backups/zspace-store/20261013T013358Z` 成功后，使用最终 v3 SQL 在 `nj-game` 的 `zstore` PostgreSQL 数据库内执行，事务已提交。

- 新增 169，后台总数 176；175 个来源标识全部存在。
- 7 条原有记录四列哈希在事务前后完全一致，仍发布 7 条；新增 169 条均未发布。
- 新草稿的 `dataTargets`、`environment` 数组格式全部有效。
- 新导入 Actual Budget 的后端图标代理返回 HTTP 200、PNG，15,351 字节。
- 服务器归档：`/opt/zspace-store/imports/fnos-20261013-d297f9ac`，含 SQL、来源 JSON、许可证、哈希清单和执行日志。
- 实际 SQL SHA-256：`158888b40e9e4c83f379d7d796c8e82ebb5b5412dfe7d3f6cbbe6061fd7e3958`。
