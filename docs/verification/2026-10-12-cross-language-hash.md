# 上传哈希：两端必须算出同一组数字

## 为什么这条值得单独查

上传分片哈希在**两端各有一份实现**：

| 环境 | 实现 |
| --- | --- |
| 网页版 | TypeScript（`src/api/upload-hashes.ts`，用 `@noble/hashes`） |
| Mac 客户端 | Rust（`src-tauri/src/upload_hash.rs`） |

两边算出来的值**必须完全一致** —— NAS 按这些值校验分片。一旦不一致，
同一份文件在浏览器里能传、在 Mac 客户端里就会失败，**而且只在一边坏**，
排查时最容易怀疑网络或权限，实际是算法对不上。

这正好接上前三轮的教训（白名单、菜单、网络权限都是"只有客户端坏"）。

## 核对方法：三份独立计算互相印证

1. **Rust 侧**本来就有一条测试 `independent_python_vectors_full_and_quick_boundaries`，
   覆盖 0 / 1 / 3 / 2048 / 2049 / 2097169 / 2097664 七个边界尺寸；
2. 我用 **Python 独立复算**了其中三个（0 / 3 / 2049），规则按文档写成"先塞入 size
   的十进制字符串，≤2048 全量、否则头尾各 1024"—— **与 Rust 向量逐字节一致**；
3. 把**同一组向量**加进 TS 测试（`src/api/upload-hashes.test.ts`），
   连 `lastModified = 1700000000123`、目标路径 `/新目录/资料.txt` 都对齐。

```
size=    0 ✓
size=    3 ✓
size= 2049 ✓
独立复算与 Rust 向量一致
```

顺带核对了 uuid 规则：TS 是 `sha1(String(lastModified + size) + path)`，
Rust 是 `sha1(format!("{}{}", last_modified + size, target))` —— **一致** ✓

## 结果

| 检查 | 结果 |
| --- | --- |
| Python 独立复算 vs Rust 向量 | 一致 ✓ |
| TS 实现 vs 同一组向量（新增 3 条用例） | 通过 ✓ |
| Rust 测试 | **90 passed** ✓ |
| JS 全套 | **56 文件 / 1166 用例** ✓ |

现在任何一边改了哈希规则，另一边立刻会红 —— 而不是等用户发现"客户端上传总是失败"。

## 这轮没找到问题的部分（也算结论）

顺便核对了原生与网页两条下载/上传链路的**接线**：
原生走 Rust 命令（`nas_download_*` / `nas_upload_*`），网页走浏览器下载与
`<input type=file>`；两条路都从 webview 拿同一个 NAS 会话，
错误信息也都由同一套 `message()` 转成中文。这一层没发现不一致。
