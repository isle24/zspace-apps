# 空间商店后台备份与迁移

商店云端使用 PostgreSQL 17。用户账号、应用资料、图标、发布版本、心愿单、安装历史及签名密钥在同一数据库内；NAS 本地应用运行状态仍使用独立 SQLite。应用自己的媒体和数据目录不上传到云端。

当前 nj-game 使用独立 `zstore-postgres` Docker 容器，无网络端口，通过 Unix socket 和操作系统账号校验连接。不会占用其他业务数据库。后台服务是 `zstore.service`，公开接口为 `https://zstore.2iwm.com/api/cloud/`，管理入口为 `/admin/`。

## 自动备份

每天北京时间 03:15，`zstore-backup.timer` 调用 `/opt/zspace-store/deploy/backup.sh`。备份保存在 `/var/backups/zspace-store/<UTC 时间>/`，目录权限 700，文件权限 600，包含：

- `zstore.dump`：PostgreSQL 自定义格式数据库备份。
- `legacy-store.sqlite`：通过 SQLite 一致性备份生成的本地兼容认证元数据。
- `SHA256SUMS`、版本说明及可恢复对象目录。

当前保留全部备份，不会自动删除。请定期将完整备份目录复制到另一台服务器或离线存储；同机备份不能应对整机损坏。备份含密码哈希和签名配置，不能上传公共 GitHub、商店素材目录或网站静态目录。

```bash
sudo systemctl start zstore-backup.service
sudo systemctl status zstore-backup.service --no-pager
sudo systemctl list-timers zstore-backup.timer --no-pager
```

## 在新服务器恢复

先部署同一版本或兼容的新 PostgreSQL 与商店后台，创建应用数据库角色 `zstore`。完整复制备份目录及服务部署配置。恢复脚本校验 SHA256，只允许新建 `zstore_restore_` 开头的数据库，拒绝覆盖现有数据库。

```bash
sudo /opt/zspace-store/deploy/restore.sh \
  /var/backups/zspace-store/20261012T122624Z \
  zstore_restore_migration_20261012
```

脚本使用事务恢复，并核验账号、管理员、应用和签名配置数量。检查结果后，暂停旧服务器写入，生成并恢复最后一次备份；把 `SPACE_CLOUD_DATABASE_URL` 的 `dbname` 改成已恢复的新数据库，再重启后台。最后将负载均衡反代切到新服务器并验证 HTTPS。保留旧服务器和备份直到确认迁移完成。

如果新服务器调整 `zstore` 的系统 UID，必须同步调整 PostgreSQL 镜像内的 `zstore` UID，使 peer 认证能正确识别后台账号。`/run/zstore-postgresql` 由 tmpfiles 配置创建，避免服务器重启后 socket 目录丢失。

已在 nj-game 实际完成一次数据库导出、校验与新数据库恢复演练；定时任务也已手动执行成功。恢复演练库为 `zstore_restore_acceptance_20261012`，没有替换在线数据库。

参考：[PostgreSQL 的一致性 SQL 备份](https://www.postgresql.org/docs/17/backup-dump.html)、[Unix socket peer 认证](https://www.postgresql.org/docs/17/auth-peer.html)。
