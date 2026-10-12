# NasModule.tsx 拆分（延续 App.tsx 那一轮）

`NasModule.tsx` 原本 **712 行**，装着 11 个窗口里 6 个的实现。这轮拆成四个文件，
**只搬不改**。

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `modules/MediaWindow.tsx` | 359 | 相册 / 影视 / 音乐共用的媒体外壳（分类栏、网格、分页、查看器接线） |
| `modules/DownloadsWindow.tsx` | 166 | 下载中心（任务列表、批量开始/暂停、添加下载） |
| `modules/SystemWindow.tsx` | 178 | 控制面板 / 存储管理 / 远程访问 / Docker + 使用帮助 |
| `modules/NasModule.tsx` | **55** | 只剩按 id 选视图的分发器 |

`MediaSelection` 类型跟着 `MediaWindow` 走，`NasModule` 继续导出它（App.tsx 的导入不变）。

## 验证方式同上一轮

1. 每一步都跑 `tsc -b` + 全套用例：**55 文件 / 1158 用例全绿**；
2. 构建 0 错误；
3. 部署后**指纹核对**：线上与本地 `assets/client-*.js` 一致。

## 类型检查这一轮又拦下 5 次

拆文件时最容易漏的就是"这个组件还用到哪些导入"。这次漏过：
`DownloadSimple`、`formatBytes`、`Pagination`、`VideoDetails`、`Play`、
`useState`/`useResource`/`api`/`Status`/`ArrowClockwise`/`Item`，
外加**一次重复导入**（`MediaWindow` 引了两遍）。

全被 `tsc` 逐条列出来了，一条也没漏到运行时。

## 累积效果（近三轮重构）

| 文件 | 之前 | 现在 |
| --- | --- | --- |
| `App.tsx` | 1181 | **706** |
| `NasModule.tsx` | 712 | **55** |
| 新增 | — | `LoginScreen` 254、`WindowFrame` 183、`InstanceWindow` 101、`MediaWindow` 359、`DownloadsWindow` 166、`SystemWindow` 178、`values` 41 |

行为完全不变，全部用例与部署指纹都对齐。
