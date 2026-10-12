# 极空间 5055 接口连通性实测（2026-10-11）

对 `http://192.168.3.56:5055` 逐个探测 SDk 当前使用的官方路径，未登录、只发一次请求，不修改任何数据。
判定标准：返回 `{"code":"N001208","msg":"token已失效"}` 表示**路径存在、需要会话**；HTTP 404 表示**该固件上没有这个路径**；
403 表示网关拒绝未签名请求（路径存在）。

| 路径 | 方法 | 判定 | 对应操作 |
| --- | --- | --- | --- |
| `/system/polling2` | POST | 存在（需会话） | `files.roots` |
| `/system/recent` | POST | 存在（需会话） | `system.monitor`（官方挂件 `ZP.monitor()`） |
| `/system/delay` | POST | 存在（需会话） | `system.monitorDelay` |
| `/system/home` | POST | 存在（需会话） | `system.overview` |
| `/setting/load` | POST | 存在（需会话） | `system.settings` |
| `/v2/file/list`、`/v2/file/info`、`/v2/recent/list` | POST | 存在 | 文件列表/详情/最近 |
| `/file_search/file_search` | POST | 存在 | 文件搜索 |
| `/v2/album/home`、`/v2/album/album/feeds` | POST | 存在 | 相册 |
| `/zvideo/classification/list`、`/zvideo/video/v2/list`、`/zvideo/collection/info`、`/zvideo/collection/video`、`/transcode/play` | POST/GET | 存在 | 影视 |
| `/zmusic/api/v2/song/list`、`album/list`、`playlist/list`、`song/info/lyrics`、`/transcode/audio/play` | POST/GET | 存在 | 音乐 |
| `/downloader/list` | POST | 存在 | 下载 |
| `/storagepool/info2` | POST | 存在 | 存储 |
| `/network-settings/v1/interface/list` | GET | 存在 | 网络 |
| `/AppStore/v1/list` | POST | 存在 | 应用清单 |
| `/manager/services` | POST | 存在（需管理员）→ `N001411 无权限进行此操作` | `system.services`（设备读写求和） |
| `/manager/v2/processes` | POST | 存在（需管理员）→ 同上 | `system.processes`（进程明细） |
| **`/system`** | POST | **不存在（404）** | 原先的 `system.overview` |

## 结论与修复

1. **`/system` 在本机固件上返回 404**。官方前端同一模块里对应的是 `home → /system/home`
   （与 `shutdown`、`reboot`、`systemPoll` 同级），实测该路径存在。已把 `system.overview`
   改到 `/system/home`，并加入开发期传输白名单。
2. 新增官方桌面挂件真正使用的监控接口：`system.monitor → /system/recent`、
   `system.monitorDelay → /system/delay`。
3. 官方挂件读取的字段（从打包代码确认）：`list[0].cpu.used`、`cpu.temp`、
   `memory.used`、`memory.total`、`cpu_fan.ctr/speed`、`net_speed.download1s/upload1s`、
   `speeds[]`（多网卡求和）。`cpu.used`/`memory.used` 是 0..1 比例，速率为字节/秒。
4. **磁盘读写速率**：官方监控页的算法是对 `/manager/services` 返回的每个服务
   `io.read_ps` / `io.write_ps` 求和（`serveList.reduce((sum, s) => sum + s.ior, 0)`，
   映射关系 `ior = io.read_ps`、`iow = io.write_ps`）。客户端按同一算法实现：5 秒轮询一次
   `system.services`，只对顶层服务求和（不重复累加内嵌 `processes`）；被拒绝或字段缺失时显示“—”。
   该接口需要管理员权限，实测未登录返回 `N001411 无权限进行此操作`。

复现命令（只读，不改数据）：

```sh
curl -s -o /tmp/r -w '%{http_code}\n' -X POST http://192.168.3.56:5055/system/recent \
  -H 'content-type: application/x-www-form-urlencoded' --data 'plat=web'
```

尚未验证：登录后的真实返回结构（需要极空间账号）。上表 403/需会话项均只证明路径存在，
不代表响应字段与客户端解析一致。
