# 全应用公开发布与自包含 Compose 验收

用户确认“全部公开展示，验证通过的可安装，其余标明待适配”。服务器已完成该范围。

- 公开目录 176 条、后台草稿 0；13 款有安装入口，163 条为明确的待适配资料。
- 保留原 7 条记录，本轮新增 6 个通过架构/镜像摘要与部署清单验证的云交付：Homarr、Homepage、Komari、Koodo Reader、Suwayomi、Wizarr。
- 待适配条目剥离镜像、端口、环境参数和发布清单字段，不生成签名安装版本，安装和恢复按钮禁用；服务端安装发布仍执行严格核验。
- 37 个新候选中的其余条目未通过本轮公开镜像/配置核验，保持资料发布；未执行这些应用的运行验收，也未将元资料状态称为应用健康。
- 当前签名目录 sequence 8，含 7 个云交付；Ed25519 签名实验证通过，签名身份保持原值。
- 原 7 行的 id/draft_json/published_json/revision 全列哈希与导入前一致。
- 生产一致性备份 `/var/backups/zspace-store/20261013T061747Z` 成功。升级和发布归档 `/opt/zspace-store/releases/publication-r3-20261013-142055-a4c172`，服务已恢复。

商店首页合并 NAS 已审查配方与匿名公开目录，不需要先登录云账号才能看到资料；安装继续使用原有账号与不可变计划流程。商店账号、心愿、历史、管理和 2FA 保持各自权限范围。

验证：Go 全套通过、发布相关 race 通过；商店 307 项、后台 15 项通过，类型检查和生产构建通过；实际公共 reader 读取 176 项。浏览器实机截图因 Mac 锁屏未进行，本轮没有声称新的浏览器视觉验收。

自包含 Compose 实机隔离验证：随机 0600 PG secret、目录正确归属、健康启动、隐藏交互管理员初始化、生产 2FA 要求、重复启动密码保持、已有数据缺 secret 拒绝初始化。测试使用应用 AMD64 镜像与工作站 ARM64 PostgreSQL；公开 YAML 两者均设置 linux/amd64。测试服务已停止，数据保留。

DockerHub r3/latest 均推送并通过匿名 registry manifest 验证：

| 项目 | OCI 索引摘要 |
| --- | --- |
| zspace-ui | sha256:190c27966a6234de75f4dc9219fdd2ffae67d6f4bf5a16d977de3f8dfa981d7a |
| zspace-store | sha256:a69471cc1a81636a50049b1f301916ddac8ee2f83f7c88aa78efe1b9865d06ef |

NAS UI release `client-review-20261013-143003-fc5876` 已更新；云公共 API 与 GitHub 静态兜底均有完整资料。两个 README 已以 GitHub blob SHA 核对，含完整可复制 YAML：

- isle24/zspace-apps：40d95d692090cee2836e7b4cbc69393df90cdaea
- isle24/nas-app-store-catalog：5f29cc8371df8eecb4a06e1482770298e86d0b4c

新源提交已触发 GitHub Actions；本轮 README/Compose 的完成不以尚在运行的客户端构建替代验证。
