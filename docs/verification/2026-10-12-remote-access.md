# 远程访问窗口（zrps 中转服务）

## 端点确认

- nginx：`location /zrps/api/` → `http://127.0.0.1:22345/api/`（`auth_master.lua` 鉴权），
  配置文件 `5055.conf:22`；22345 **在监听**（`ss -ltnp`）。
- 路由来自服务二进制字符串：`/api/remoteaccess/add`、`/api/speed/{action,cancel,progress,query,report}`。
- 服务目录 `/zspace/applications/services/zrps/` 里有 `resolved.ip`（`180.119.170.156`）、
  `RemoteAccessWhiteList.json`、加密的 `api-conf.json`。

## 实测调用形态

| 调用 | 结果 |
| --- | --- |
| `GET /zrps/api/speed/query` | **200**，返回真实状态（见下） |
| `POST /zrps/api/speed/query`（form 或 JSON） | 200 但**空体** |
| `GET /zrps/api/speed/progress` | 200，body 为 `null` |
| `/zrps/api/remoteaccess/{list,info,status,whitelist}` | 200 空体（未命中路由） |

响应（真机）：

```json
{"code":"200","data":{"direction":"","finish":"true","id":"",
 "ip":"171.222.188.41","isp":"ctcc",
 "saddr":"180.119.170.156","snode":"yz-cu-dev"}}
```

## 界面

三张卡，全部来自上面的真实字段：

1. **设备公网地址** `180.119.170.156`（中转服务解析到的出口地址）
2. **当前访问者** `171.222.188.41` · 中国电信（`isp` 代码映射：ctcc/cucc/cmcc/cbn）
3. **最近一次中转测速** 已完成 · 节点：扬州 · 联通（`snode` 识别 `yz-cu-dev` 这种编码，
   不认识的名字原样显示，不编地区）

**不发起测速**：`/speed/action` 会占带宽，所以由官方 App 触发，窗口只展示最近一次结果并写明这一点。
设备没返回的字段显示 "—"，`finish` 按字符串判断（`"false"` 不会因为非空而被当成 true）。

## 其它

- 反代新增放行 `/zrps`（此前未放行，页面报 "Failed to fetch"，我们容器返回 301）。
- 测试 `modules/RemoteAccess.test.tsx`（5）：真实载荷解析、缺失字段、`finish` 字符串语义、
  运营商与节点标签映射。
- 全套 **49 文件 / 1123 用例全绿**。
