# 原生端媒体请求只带了 2 个 cookie（网页版要 5 个）

## 怎么发现的

继续查"只有客户端会坏"的地方。这轮看**原生媒体链路**：

- 网页版：`<img>` / `<video>` 直接请求 NAS，靠 `document.cookie` 带凭据；
- 原生端：走 Rust 注册的 `nas-media://` 代理，Cookie 头由 **SDK 自己拼**。

于是对比两条路发出去的 Cookie：

| | 网页版 | 原生端（改动前） |
| --- | --- | --- |
| cookie | `token`、`device_id`、`device`、`version`、`plat` | `device_id`、`zenithtoken` |

**差三个。** 而早先排查浏览器播放时已经实测确认：转码服务 `/transcode/*`
除了 `token`/`device_id`，**还额外校验 `device`/`version`/`plat`**，少一个就返回
`T000001 参数错误` —— 当时浏览器端就是这么卡住的。

代码里那句注释也说明了原因：

> 转码服务还额外校验 device_id/device/version/plat。**跨源或原生端不写（发了也没用）**

"发了也没用"对 `document.cookie` 成立，但**对 Rust 代理不成立** —— 它的 Cookie 头是
SDK 自己拼的，想发什么就发什么。于是这里留下了一个"只在 Mac 客户端里发作"的坑：
**同一部影片浏览器能播、客户端播不了**。

## 修法

原生端的 Cookie 头补齐成与网页版同一组（并保留官方客户端的 `zenithtoken` 叫法）：

```
token=…; device_id=…; device=SpaceDesktop; version=…; plat=web; zenithtoken=…
```

`token` 只在**已登录**的请求上出现（`key/pub`、`auth/login` 这些还不该有），
用例按"请求里带不带 token 参数"判断，比按路径列白名单稳。

## 顺带核对过、**没有**问题的部分

- `nas-media://` 自定义协议在 CSP 里已放行（`img-src` / `media-src` 都含 `nas-media:`）；
- Rust 侧对媒体地址做了**同源校验**（换主机/换端口/带账号密码一律拒绝），
  且**没有**像 HTTP 插件那样的路径白名单 —— 所以不存在上一轮那种"路径缺失"问题；
- 媒体引用 TTL 是 **8 小时**，长片不会播到一半失效。

## 验证

| 检查 | 结果 |
| --- | --- |
| 新增断言（五件套 cookie + 分阶段 token） | 通过 |
| JS 全套 | **56 文件 / 1166 用例** |
| Mac 重新打包 | 配置核对、签名校验通过，启动成功，sidecar 200 |

**仍未验证**：真实播放（需要登录）。但"客户端里媒体请求少了三个 cookie"这个
已知原因已经排除。
