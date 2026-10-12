/*
 * 构建产物守卫：确保"按需加载"没有悄悄退回去
 *
 *   node scripts/bundle-guard.mjs        # 需要先跑一次 vite build
 *
 * 检查三件事：
 *   1. hls.js **必须**是独立块（不是打进主包）—— 否则首屏又要多背 500 多 KB；
 *   2. 入口**不能静态 import** hls 块（只能动态 import）—— 它是给"看视频"用的；
 *   3. 首屏（index.html 引用的资源）未压缩总量不超过预算。
 *
 * 为什么要有这个守卫：这类优化最容易在后续改动中无声回退 ——
 * 谁把 `import("hls.js")` 改回 `import Hls from "hls.js"`，用例全绿、界面正常，
 * 只有首屏体积悄悄涨回去。这里用构建产物本身把它钉住。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "apps/client/dist");
const assets = join(dist, "assets");

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(34)} ${detail}`);
  if (!ok) failed++;
};

const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith(".js"));
const hlsChunks = js.filter((f) => f.startsWith("hls-"));
const entryName = files.find((f) => /^client-.*\.js$/.test(f));
if (!entryName) {
  console.error("找不到入口 chunk（先跑 vite build）");
  process.exit(1);
}

// 1) hls 必须是独立块
check("hls.js 独立成块", hlsChunks.length === 1, hlsChunks[0] ?? "没找到 hls-*.js（可能被打进主包了）");

// 2) 入口不能静态 import hls
const entry = readFileSync(join(assets, entryName), "utf8");
const staticHls = new RegExp(`from"\\./${hlsChunks[0]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "hls-"}"`).test(entry);
check("入口未静态引入 hls", !staticHls, staticHls ? "入口里有静态 import，首屏会重新变大" : "只有动态 import");
// 打包器可能用反引号：实测生成的是 import(`./hls-XXXX.js`)
const dynamicHls = new RegExp("import\\([`\"']\\./" + (hlsChunks[0]?.slice(0, 4) ?? "hls-"));
check("入口里有动态 import", dynamicHls.test(entry), "存在 import(`./hls-…`)");

// 3) 首屏预算
const html = readFileSync(join(dist, "index.html"), "utf8");
const referenced = [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+\.(?:js|css))/g)].map((m) => m[1]);
const size = referenced.reduce((sum, name) => {
  try { return sum + readFileSync(join(assets, name)).length; } catch { return sum; }
}, 0);
// 预算按**未压缩**算（gzip 在部署时才生成）。当前 993 KB 未压缩 ≈ 255 KB gzip；
// 留一点余量，涨到 1.1 MB 未压缩（≈ 280 KB gzip）就说明又塞了东西进来。
const BUDGET = 1100 * 1024;
check("首屏资源在预算内", size <= BUDGET, `${(size / 1024).toFixed(0)} KB 未压缩（预算 ${BUDGET / 1024} KB），引用 ${referenced.length} 个资源`);
console.log(`  首屏未压缩合计 ${(size / 1024).toFixed(0)} KB；hls 块 ${hlsChunks.length ? (readFileSync(join(assets, hlsChunks[0])).length / 1024).toFixed(0) + " KB（按需）" : "—"}`);

process.exit(failed ? 1 : 0);
