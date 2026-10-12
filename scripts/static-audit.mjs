/*
 * 静态质量扫描（不需要登录、不需要浏览器）
 *
 *   node scripts/static-audit.mjs
 *
 * 扫四类容易漏的东西：
 *   1. 加了监听/定时器却没有对应清理（removeEventListener / clearInterval / clearTimeout）
 *   2. useEffect 里注册了监听却没有返回清理函数
 *   3. 在 map() 里渲染元素但没有 key
 *   4. 调用了 async 函数却没有 await / void / .catch（浮动 Promise）
 *
 * 说明：这是**启发式**扫描，报出来的是"候选"，需要人看一眼再决定。
 * 目的是不漏，而不是自动判定对错。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const srcDir = join(root, "apps/client/src");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(path) && !/\.test\./.test(path)) out.push(path);
  }
  return out;
}

const files = walk(srcDir);
const findings = { listeners: [], effects: [], keys: [], floating: [] };

for (const file of files) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  /*
   * 1) 监听 / 定时器是否有清理
   *
   * 只报「一次都没清理」这种强信号。数量不等是正常的：一个 removeEventListener
   * 可能写在循环或 helper 里替多个 add 收尾（upload-hashing.ts 就是 3 个 add
   * 配一个循环里的 remove，人工核对过没有泄漏），按数量比大小会误报 —— 第一版
   * 就是这么误报的，还把 TS 接口声明也算成了 add。
   */
  const adds = (text.match(/addEventListener\(/g) || []).length;
  const removes = (text.match(/removeEventListener\(/g) || []).length;
  const timers = (text.match(/setInterval\(/g) || []).length;
  const clears = (text.match(/clearInterval\(/g) || []).length;
  if (adds > 0 && removes === 0) findings.listeners.push({ rel, detail: `addEventListener ${adds} 次，完全没有 removeEventListener` });
  if (timers > 0 && clears === 0) findings.listeners.push({ rel, detail: `setInterval ${timers} 次，完全没有 clearInterval` });

  // 2) useEffect 里注册监听但没有 return 清理
  for (let i = 0; i < lines.length; i++) {
    if (!/useEffect\(\(\) => \{/.test(lines[i])) continue;
    let depth = 0, end = i, body = "";
    for (let j = i; j < lines.length; j++) {
      body += lines[j] + "\n";
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (j > i && depth <= 0) { end = j; break; }
    }
    if (/addEventListener\(|setInterval\(/.test(body) && !/return \(\) =>|removeEventListener\(|clearInterval\(/.test(body)) {
      findings.effects.push({ rel, line: i + 1 });
    }
    i = end;
  }

  // 3) map() 渲染没有 key —— 只认"回调直接返回 JSX"的 map，字符串/数组构造不算
  lines.forEach((line, index) => {
    if (!/\.map\(/.test(line)) return;
    const window = lines.slice(index, index + 8).join(" ");
    const returnsJsx = /\.map\([^)]*\)\s*=>\s*(\(\s*)?</.test(window) || /=>\s*\n?\s*</.test(window.slice(0, 400));
    if (!returnsJsx) return;
    if (/\bkey=/.test(window)) return;
    findings.keys.push({ rel, line: index + 1, code: line.trim().slice(0, 70) });
  });

  // 4) 浮动 Promise：调用 xxx( 之前没有 await/void/return，且后面没有 .catch
  // 只收集**真的是 async** 的函数名：`async function f(` 或 `const f = async (`
  const asyncNames = [
    ...[...text.matchAll(/async function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
    ...[...text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\(/g)].map((m) => m[1]),
    ...[...text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s+function/g)].map((m) => m[1]),
  ];
  if (asyncNames.length) {
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      // 跳过"声明本身"和"把函数当属性值赋出去"的行，它们不是调用
      if (/^\s*(export\s+)?(async\s+)?function\s/.test(line)) return;
      if (/=>\s*[A-Za-z_$][\w$]*\(/.test(line)) return;
      for (const name of new Set(asyncNames)) {
        const re = new RegExp(`(^|[^\\w.$])${name}\\(`);
        if (!re.test(line)) continue;
        if (/\b(await|void|return|\.catch)\b/.test(line)) continue;
        findings.floating.push({ rel, line: index + 1, code: line.trim().slice(0, 70) });
      }
    });
  }
}

/*
 * 5) macOS 打包集成（都是"漏了就会在真机上出丑"的地方）
 *
 * 这些没法在网页侧验证，但能在源码/配置里查。两条都是真踩过的：
 *   - 缺 NSLocalNetworkUsageDescription → 连不上局域网 NAS（本机 Playwright 被同一机制拦过）
 *   - 不自定义菜单 → Tauri 默认菜单的 File→Close Window(⌘W) 会抢走应用内快捷键，
 *     按下去关掉整个应用窗口
 */
const macChecks = [];
{
  const tauri = join(srcDir, "../src-tauri");
  const read = (name) => {
    try { return readFileSync(join(tauri, name), "utf8"); } catch { return ""; }
  };
  const lib = read("src/lib.rs");
  const plist = read("Info.plist");
  const conf = read("tauri.conf.json");

  if (!plist.includes("NSLocalNetworkUsageDescription")) macChecks.push("Info.plist 缺少 NSLocalNetworkUsageDescription（macOS 15+ 访问局域网需要）");
  if (!/\.menu\(/.test(lib)) macChecks.push("lib.rs 未自定义菜单：默认菜单的 ⌘W 会关掉整个应用窗口");
  if (/close_window/.test(lib)) macChecks.push("lib.rs 里出现 close_window：会与应用内 ⌘W 冲突");
  if (!/"minWidth"|"minHeight"/.test(conf)) macChecks.push("tauri.conf.json 未设置窗口最小尺寸");
  if (!/"NSLocalNetworkUsageDescription"/.test(plist) && plist === "") macChecks.push("缺少 src-tauri/Info.plist");

  /*
   * 原生 HTTP 白名单必须覆盖应用真正请求的路径。
   *
   * 这是真踩过的：白名单里缺了 `/splay/`、`/zvideo_static/`、`/system/recent`、
   * `/task/list`、`/downloader/*` 等 20 条 —— 结果这些东西**只在 Mac 客户端里坏掉**，
   * 网页版走 space-proxy（另一套白名单，早就补齐了）完全看不出来。
   */
  try {
    const ops = (() => { try { return readFileSync(join(srcDir, "api/official-nas.ts"), "utf8"); } catch { return ""; } })();
    const capRaw = read("capabilities/default.json");
    if (ops && capRaw) {
      const cap = JSON.parse(capRaw);
      const http = (cap.permissions || []).find((entry) => entry && entry.identifier === "http:default");
      const allowed = (http?.allow || []).map((a) => String(a.url).replace(/^https?:\/\/[^/]+/, "").split("?")[0]);
      const requested = new Set([
        ...[...ops.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1].split("?")[0]),
        ...[...ops.matchAll(/"(\/(?:splay|play|zvideo_static|zmusic_static|zrps|task|system|thumb|transcode|zvideo|zmusic)[A-Za-z0-9_/.*-]*)"/g)].map((m) => m[1]),
      ]);
      const covered = (path) => allowed.some((a) => a === path || (a.endsWith("/*") && path.startsWith(a.slice(0, -1))));
      const holes = [...requested].filter((path) => !covered(path));
      if (holes.length) macChecks.push(`原生 HTTP 白名单缺少 ${holes.length} 条路径（这些功能只在客户端里坏）：${holes.slice(0, 6).join(", ")}${holes.length > 6 ? " …" : ""}`);
    }
  } catch (error) {
    macChecks.push("无法核对原生 HTTP 白名单：" + String(error).slice(0, 60));
  }

  /*
   * 两端各有一份实现的地方，最容易"只在一边坏"。这里把能自动比的部分比掉：
   *   - 上传分片大小（TS 常量 vs Rust 常量）必须相同；
   *   - Rust 发出的事件名必须在 TS 里有人监听（否则客户端里进度条永远不动）。
   * 哈希向量由用例钉住（见 docs/verification/2026-10-12-cross-language-hash.md），
   * cookie 集合由 official-nas 的用例钉住，不在这里重复。
   */
  try {
    // TS 侧文件在 src/ 下，不能拿 tauri 目录去相对跳（上一版就是这么全读成 ENOENT 的）
    const readSrc = (name) => {
      try { return readFileSync(join(srcDir, name), "utf8"); } catch { return ""; }
    };
    const tsHashes = readSrc("api/upload-hashes.ts");
    const rsHash = read("src/upload_hash.rs");
    const rsSource = read("src/upload_source.rs");
    const tsChunk = Number(/UPLOAD_HASH_CHUNK_SIZE\s*=\s*([0-9*\s]+);/.exec(tsHashes)?.[1]?.replace(/\s/g, "").replace(/\*/g, "*"));
    const rustChunks = [...rsHash.matchAll(/const CHUNK: u64 = ([0-9*\s]+);/g), ...rsSource.matchAll(/const CHUNK: u64 = ([0-9*\s]+);/g)]
      .map((m) => m[1].replace(/\s/g, ""));
    const evaluate = (expr) => expr.split("*").reduce((a, b) => a * Number(b), 1);
    if (tsChunk && rustChunks.length) {
      const want = evaluate("2*1024*1024");
      if (Number.isNaN(tsChunk) || tsChunk !== want) macChecks.push(`TS 分片大小不是 2 MiB（${tsChunk}）`);
      for (const chunk of rustChunks) if (evaluate(chunk) !== want) macChecks.push(`Rust 分片大小不是 2 MiB（${chunk}）`);
    }
    const emitted = new Set();
    for (const file of ["src/lib.rs", "src/download.rs", "src/upload_hash.rs", "src/upload_source.rs", "src/media.rs"]) {
      for (const m of read(file).matchAll(/emit\(\s*"([a-z-]+)"/g)) emitted.add(m[1]);
    }
    const allTs = [
      readSrc("api/upload-sources.ts"), readSrc("api/official-nas.ts"),
      readSrc("api/browser-download.ts"), readSrc("modules/FileTransfers.tsx"),
    ].join("\n");
    // 注意别只找双引号：TS 里 listen('name') 用的是单引号，
    // 上一版就是这么误报"三个事件无人监听"的（事件名本身够独特，直接找名字即可）。
    const unlistened = [...emitted].filter((name) => !allTs.includes(name));
    if (unlistened.length) macChecks.push(`Rust 发出但 TS 无人监听的事件：${unlistened.join(", ")}`);
  } catch (error) {
    macChecks.push("无法核对两端常量/事件：" + String(error).slice(0, 60));
  }
}

const show = (title, list, fmt) => {
  console.log(`\n=== ${title}（${list.length}）===`);
  list.slice(0, 25).forEach((f) => console.log(" " + fmt(f)));
  if (list.length > 25) console.log(`  …还有 ${list.length - 25} 条`);
};
show("监听/定时器可能没清理", findings.listeners, (f) => `${f.rel}: ${f.detail}`);
show("useEffect 注册监听但没有清理", findings.effects, (f) => `${f.rel}:${f.line}`);
show("map() 里可能缺 key", findings.keys, (f) => `${f.rel}:${f.line}  ${f.code}`);
show("疑似浮动 Promise", findings.floating, (f) => `${f.rel}:${f.line}  ${f.code}`);
console.log(`\n=== macOS 打包集成（${macChecks.length}）===`);
macChecks.forEach((m) => console.log(" " + m));
console.log(`\n扫描 ${files.length} 个源文件`);

// 有发现就以非零码退出，方便 CI/verify.sh 直接用退出码判断，
// 而不是去 grep 中文标题（全角括号会让 ASCII 正则匹配不到）。
const total = findings.listeners.length + findings.effects.length + findings.keys.length + findings.floating.length + macChecks.length;
process.exit(total ? 1 : 0);
