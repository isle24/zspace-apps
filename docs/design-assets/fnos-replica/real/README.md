# 真实数据截图（2026-10-11，极空间 Z425 上的一次真实登录）

这些截图来自 `http://192.168.3.56:18436/` 上**真实登录后的会话**，不是合成数据，也不是空状态。
截图里含 NAS 上的真实文件名、相册命名与设备容量，仅保存在本仓库内。

| 文件 | 内容 | 真实读数 |
| --- | --- | --- |
| `desktop-live.png` | 桌面 + 资源挂件 | R 0 B/s、W 0 B/s、↑587.9 KB/s、↓12.2 MB/s、CPU 10%、RAM 60% |
| `files-live.png` | 文件管理（已进入 M.2存储11） | 真实文件与大小；`第 1 页 / 2 页 · 共 35 项` |
| `photos-live.png` | 相册时间线 | `第 1 页 / 1179 页 · 共 23564 项`（缩略图为已知缺陷，见下） |
| `video-live.png` | 影视中心媒体库 | 全部影片 / 电影 / 电视剧 / 河蟹 / 短剧 / 本地 |
| `music-live.png` | 音乐 | `第 1 页 / 3843 页 · 共 76858 项` |
| `system-live.png` | 控制面板 · 系统概览 | product z425、总容量 41901774630912、已使用 26141117722624、user_cnt 17 |
| `video-playing-live.png` | 影视中心正在播放（STRM） | `readyState=4`、时长 6368s、播放中；详情页 33 个可播放文件 |
| `photos-thumbs-live.png` | 相册缩略图 | 20/20 张缩略图加载成功（此前 400） |
| `music-playing-live.png` | 音乐正在播放 | `readyState=4`、当前 8.8s、时长 211s、未暂停；演示曲目有真实歌名与艺人 |

采集方式：通过 CDP 接管一个**带调试端口的真实 Chrome 窗口**（`--remote-debugging-port`），
用 `Emulation.setDeviceMetricsOverride` 固定 1600×1000 后逐个打开应用窗口截图；同时用 CDP 的
Network 域读取真实响应报文核对字段。全过程只读，未做任何写操作。

已解决（2026-10-11 深夜实测）：

- **相册缩略图 400**：根因是 `/transcode/*` 服务校验**客户端身份 cookie**（`token`/`device_id`/`device`/`version`/`plat`），
  我们只写了 `token`。登录时写全这一组后，缩略图 20/20 加载成功。
- **影视播不出来**：三个叠加原因 —— ①取错字段（官方读 `data.uri`，我们读 `stream`/`url`）；
  ②同一组身份 cookie；③STRM 影片**不是 HLS**：`/transcode/play` 返回 `/play/m3u8/strm/<hash>`，
  请求它会被 **302** 到 `.strm` 里写的真实地址（实测 `https://cms.2iwm.com/…mp4`），
  因此要交给浏览器直接跟随跳转，不能因为路径含 `m3u8` 就交给 hls.js；反代也必须放行 `/play/`。
