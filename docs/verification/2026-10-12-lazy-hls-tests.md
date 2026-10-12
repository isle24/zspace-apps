# 把"按需加载"钉住（离线能验的部分）

上一轮把 `hls.js` 改成按需加载（主包 942 KB → 381 KB），但**没有任何用例覆盖这条路径** ——
真实播放又要登录才能验。这轮先把离线能验的部分补齐。

## 两条用例：`modules/Player.hls-lazy.test.tsx`

| 用例 | 断言 |
| --- | --- |
| HLS 地址走到 hls.js | 模块被 import、`attachMedia`/`loadSource` 被调用、**`video.src` 必须为空**（否则 Chrome 会先报一次解码错误） |
| hls.js 加载失败 | **回落成原生 `src`**，不是黑屏 |

第二条尤其重要：`import()` 失败是这条新路径特有的失败模式（以前静态 import 不会失败）。

写的时候踩了个坑，记下来：一开始把用例放在 `Player.test.tsx` 里，用
`vi.resetModules()` + 动态 `import("./Player")` 来让 `vi.doMock("hls.js")` 生效 ——
结果 `api` 也被换成了新实例，**前面 spy 的 `api.read` 失效**，用例报"ctor 没被调用"，
看起来像功能坏了。改成独立文件 + 文件顶部的 `vi.mock`（会被提升）就正常了。

## 产物的守卫：`scripts/bundle-guard.mjs`

性能优化最容易**无声回退**：谁把 `import("hls.js")` 改回 `import Hls from "hls.js"`，
用例全绿、界面正常，只有首屏体积悄悄涨回去。所以直接查构建产物：

```
✓ hls.js 独立成块             hls-BMtioDMk.js
✓ 入口未静态引入 hls           只有动态 import
✓ 入口里有动态 import         import(`./hls-…`)
✓ 首屏资源在预算内            993 KB 未压缩（预算 1100 KB），引用 4 个资源
```

已接入 `verify.sh`（离线档），跟着构建一起跑。

> 顺带记两个"又量错了"：
> ① 动态 import 的引号是**反引号**（`` import(`./hls-…`) ``），我按双引号写所以没匹配上；
> ② 首屏预算我按 gzip 估的 900 KB 填，但量的是**未压缩**（gzip 在部署时才生成），
> 于是当场误判超预算。预算改成 1100 KB 未压缩 ≈ 255 KB gzip。

## verify.sh 现状

| 档位 | 项 |
| --- | --- |
| 默认（离线） | 类型检查、单元测试（**56 文件 / 1163 用例**）、前端构建、**产物守卫**、静态质量扫描 |
| `--live` | 再加：两主题功能回归、深色对比度、窄窗口布局、可访问性、窗口交互 |
| `--all` | 再加：WebKit 渲染 |
