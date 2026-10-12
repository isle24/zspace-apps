# 控制面板 / 网络 / 系统设置 / Docker 真实数据适配

日期：2026-10-12。

## Docker：官方那条路走不通，改成只读引擎视图

**实测结论**：极空间前端调 `/docker/api/*`，nginx `proxy_pass http://127.0.0.1:9123/api/`
（`/usr/openresty/nginx/conf/vhost/5055.conf:163`），但这台 NAS 上 **9123 没有监听**
（`ss -ltnp` 无输出；官方 Docker 应用未运行，`dockerd` 本身是好的）→ 所有调用 502。

**我们的做法**（`deploy/nas-appstore/proxy/docker.go`）：

| 端点 | 内容 |
| --- | --- |
| `GET /api/docker/containers` | 容器：名称、镜像、状态、状态描述、端口映射、创建时间 |
| `GET /api/docker/images` | 镜像：repo、tag、大小、创建时间 |
| `GET /api/docker/logs/{id}?tail=N` | 容器日志（还原 Docker 复用流、去掉 ANSI 转义，最多 2000 行） |

**只读**：代理与界面里**没有任何** create / start / stop / restart / remove / exec。
挂 docker socket 等于宿主 root 权限，这个窗口刻意只做观察。
`docker-compose.yml` 里以 `:ro` 挂载，并注明不需要时删掉那一行（界面会如实显示"未启用"）。

**实测**：46 个容器（真实名称/状态/镜像/端口）、202 个镜像、日志面板拉到 300 行。

## 网络连接

`GET /network-settings/v1/interface/list` → 5 张网卡卡。实测：

```
kvmbr0  网桥  已连接  速率 10 Gbps  MAC f6:14:ae:83:ab:dc  MTU 1500
IPv4 192.168.3.56 / 255.255.255.0 · 获取方式：静态 · 网关 192.168.3.1
DNS 114.114.114.114 / 223.5.5.5 · IPv6 240e:39a:cbc:ae0:…
```

设备没返回的字段（例如没有 IPv4 的 eth0）就不显示成行，不填空值。

## 系统设置

`POST /setting/load` → 6 个真实分组：文件服务、启动与开机、桌面与显示、文件变更监控、壁纸、磁盘统计频率。
右侧把嵌套结构**拍平**成 `share.number 20`、`share.expire 259200` 这样一行一个键；
超过 3 层如实写「层级过深，未展开」，不编造含义。

## 测试

新增 `modules/SystemNetwork.test.tsx`（5）与 `modules/DockerView.test.tsx`（5）：
真实响应解析、速率换算、缺失字段、空载荷、设置拍平与深度上限、
容器状态映射、镜像名/标签拆分、无标签镜像回落 digest、时间戳缺失显示"—"。
全套 **48 文件 / 1118 用例全绿**。
