# 用 WebKit（Mac 客户端的同款引擎）渲染并验收

Mac 客户端用的是 **WKWebView**，不是 Chrome。此前所有验收都在 Chrome 里做，
等于**从没验过目标引擎**。这轮补上，并且立刻抓到三个真问题。

## 怎么做的

`scripts/webkit-render-check.cjs` —— 用 Playwright 的 WebKit（这台机器上是 `webkit-2359`）
打开构建产物，截图 + 探特性 + 收控制台异常。

三个坑（都写进脚本注释了）：

1. Playwright 的 WebKit **连不上 192.168.3.56**（macOS 本地网络权限拦的），
   但 `127.0.0.1` 与 `192.168.3.1` 都通 → 改成**本地起静态服务**再指过去；
2. 装的浏览器是 `webkit-2359`，`playwright-core` 1.60 找的是 `webkit-2287` →
   必须显式传 `executablePath`；
3. **对比度检查器看不见 `background-image`**（壁纸/渐变），
   所以它对登录页永远报 0 问题 —— 登录页的可读性只能靠截图肉眼判断。

## 引擎兼容性：全部通过

| 特性 | WebKit |
| --- | --- |
| `color-mix()`（深色修复里大量使用） | ✅ |
| `:has()` | ✅ |
| `backdrop-filter` / `-webkit-backdrop-filter` | ✅ / ✅ |
| `<dialog>` | ✅ |
| 控制台异常 | **0** |

## 抓到的三个真问题

### 1. 登录页白字读不出来（WebKit 截图直接看出来）

登录页底色是一整块彩色渐变，中间偏右是橙/粉/亮蓝，而卡片是 **20% 白 + 白字** ——
在那个区域基本看不清。改成 **52% 深色玻璃**（保留 `blur(30px) saturate(140%)` 的玻璃感），
副标题从 72% 白提到 86% 白。修后截图：`docs/design-assets/fnos-reference/our-login-webkit.png`。

> 注意：这个 bug 在我自己的对比度巡检里永远是 0 问题，因为**检查器看不到渐变背景**。
> 是"换个引擎截图看一眼"抓到的。

### 2. Mac 客户端一直让用户手填 NAS 地址（用户的原始抱怨，根因在此）

`deploy/mac/build.sh` 原本是：**先**写 `dist/runtime-config.json`（填 NAS 地址）→ 再 `tauri build`。
但 `tauri build` 内部会先跑一次前端构建，而 **vite 会清空 dist** 并把
`public/runtime-config.json`（默认 `nasOrigin: ""`）拷回去 —— 刚写好的地址被覆盖。
所以 Mac 客户端启动时地址是空的，只能手填；网页版是同源部署，完全看不出这个问题。

修法：**构建之后**再写配置，并用
`tauri build --config '{"build":{"beforeBuildCommand":""}}'` 禁止二次构建；
打包结束**核对配置仍在**（`grep -q "$NAS_ORIGIN"`），丢了就报错退出。
现在构建日志里有 `配置核对通过："nasOrigin": "http://192.168.3.56:5055"`。

### 3. 部署脚本静默失败：线上一直是旧文件

`push.sh` 里解包用的是 `docker run -d`（后台）+ 不等退出码 → 解包失败也照样往下走，
线上一直是旧构建。同一类问题这天出现了两次，所以现在：
- 解包改成**前台**跑（`--rm`，不用 `-d`），检查输出里有 `EXTRACTED`，没有就退出；
- 部署末尾做**指纹核对**：线上 `index.html` 引用的 `assets/client-*.js` 必须与本地一致，
  不一致就非零退出；并重试 6 次（容器重启时端口可能还短暂由旧容器服务）。

顺带一个 bash 坑：`echo "一致：$local_hash（第 $attempt 次）"` 里变量后面紧跟**全角括号**，
bash 会把这些字节当成变量名的一部分 → `unbound variable`。中文文案里的变量一律写成 `${var}`。

## 修完之后的验证

| 检查 | 结果 |
| --- | --- |
| 单元测试 | 54 文件 / **1148 用例全绿** |
| 功能回归（浅色） | 全部通过，**0 控制台异常** |
| 部署指纹核对 | 本地与线上一致（`assets/client-B7RRngxY.js`） |
| Mac 客户端 | 按最新代码重新打包、签名校验通过、启动成功、sidecar `/health` 200、**配置核对通过** |
| WebKit 渲染 | 登录页正常、引擎特性全支持、0 异常 |
