# 静态质量扫描（不需要登录）

界面验收需要登录态（而且上一轮我为了验会话过期把登录态弄掉了），
所以这轮做**纯代码侧**的检查：`scripts/static-audit.mjs`，扫 56 个源文件。

## 扫四类容易漏的东西

| 类别 | 判定 | 结果 |
| --- | --- | --- |
| 监听/定时器完全没清理 | `addEventListener` > 0 且 `removeEventListener` == 0；`setInterval` 同理 | **0** |
| `useEffect` 里注册监听却没有清理 | 块内出现 `addEventListener`/`setInterval`，但没有 `return () =>` 或对应 remove | **0** |
| `map()` 渲染缺 `key` | 回调返回 JSX 且 8 行窗口内没有 `key=` | **0** |
| 浮动 Promise | 调用 async 函数却没有 `await` / `void` / `return` / `.catch` | **0** |

## 这一版扫描自己踩了三次坑

写扫描器比写业务代码更容易骗自己，记下来：

1. **把 TS 接口声明当成调用**：`upload-hashing.ts` 里有
   `addEventListener(type: string, listener: (event: any) => void): void;` ——
   这是接口定义，不是调用。第一次统计成"5 次 add / 3 次 remove"，看着像泄漏。
   人工核对后确认**没有泄漏**（3 个 add 配一个循环里的 remove + `terminate()`）。
2. **按数量比大小本身就会误报**：一个 `removeEventListener` 写在循环/helper 里
   可以替多个 add 收尾。所以最终只报**「一次都没清理」**这种强信号 —— 宁可漏报，
   也不要制造噪音让人不再看这份报告。
3. **`grep` 全角括号**：`verify.sh` 里想用 `grep '\(0\)'` 判断"有没有非零项"，
   但输出里的括号是**全角**的 `（0）` → 每条都不匹配 → 判成失败。
   最后改成让扫描脚本**用退出码表达结果**，比 grep 中文标题可靠得多。

## 顺带补的前置检查

`verify.sh --live` 现在先问一句页面状态（`scripts/page-state.mjs`）：

```
真机巡检   SKIP   页面停在登录页 —— 先在浏览器里登录，再重跑 --live
```

在此之前，未登录会让每个脚本各报各的失败（找不到 `.file-row`、列表为空……），
看起来像一批功能坏了。**这正是不该让"假失败"混进报告的理由** —— 与前面六次
"尺子坏了"是同一类问题。

## 现在的 verify.sh

| 档位 | 覆盖 |
| --- | --- |
| 默认（离线） | 类型检查、单元测试（54 文件 / 1152 用例）、前端构建、**静态质量扫描** |
| `--live` | 上面 + 两种主题功能回归、深色对比度、窄窗口布局、可访问性、窗口交互 |
| `--all` | 上面 + WebKit（Mac 客户端同款引擎）渲染 |
