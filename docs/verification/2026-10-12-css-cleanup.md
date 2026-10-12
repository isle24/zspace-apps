# 死 CSS 清理（行为不变的重构）

前几轮为了修深色主题，往 `fnos-dark.css` 等文件里加了不少补丁式覆盖，
文件里也积了一些**早已不存在的类**。这轮做了一次定向清理。

## 怎么找"死类"（两道验证，缺一不可）

1. **源码扫描**：把全部 `.ts/.tsx` 里的标识符收成一个集合，CSS 里出现但源码里没有的类即为候选。
2. **实机 DOM 核对**：把桌面 + 11 个窗口 + 启动台 + 新建文件夹对话框都打开，
   收集真实 DOM 里出现过的所有类名 —— 因为类名可能是**动态拼出来的**。

第二步拦下了 5 个误判：
- `widget-label-primary/success/muted` —— 组件用模板字符串拼的，源码扫描看不到；
- `app-jellyfin`、`app-navidrome` —— 商店组件（Codex 范围）渲染的。

最终确证为死类并删除：`bar-button`、`bar-divider`、`dock-divider`、`device-menu`、
`system-module`、`empty-symbol`、`directory-feedback`、`dialog-backdrop`，
共 **45 条规则**（`styles.css` 39 行、`fnos-media.css` 97 行…）。

## 差点闯的祸（值得记）

用正则批量删规则时，**选择器列表跨行的规则**被删出了残缺：

```css
/* 删之前 */
.system-module .hint,
.system-module .eyebrow { color: …; }

/* 删之后 —— 剩下一个悬空的逗号列表，直接顶到 @media 前面 */
.system-module .hint,
.system-module .eyebrow,

@media (max-width: 700px) { … }
```

后果：`vite build` 直接失败（`[lightningcss minify] Invalid empty selector`）。
**不是**构建工具的问题，是我的删除方式太粗暴。同类问题排查了两轮才定位到，
因为我第一次的检测脚本只找 `,` 后面跟 `}` 的情况，漏了"后面跟 `@media`"。

修法：删掉那两行悬空选择器；并补了一个检测规则（`逗号结尾 + 下一段以 @ 开头`），
全库再扫一遍只剩这一处。

顺带发现的一个**流程漏洞**：那次的部署链最后**静默中止**了（`mv` 失败 + `&&` 串联），
现场看起来像部署成功。已改为用 `deploy/nas-appstore/{build,push}.sh`，
两者都是 `set -euo pipefail`，缺 `web/index.html` 直接报错退出。
详见 `deploy/nas-appstore/README.md`。

## 清理后的验证（三项全过）

| 检查 | 结果 |
| --- | --- |
| 单元测试 | 54 文件 / **1148 用例全绿** |
| 功能回归（浅色） | 文件 20 行 + 排序 + 预览、相册 20/20、海报 20/20、播放 `rs=4`、歌词 35 行、队列 20 行、网卡 5、设置 6 分组、**0 控制台异常** |
| 布局巡检 | **33/33** 组合 ok |
| 深色对比度 | 11 窗口 **10 个 0 问题**（剩 3 处在商店组件内） |
