/*
 * 深色主题对比度巡检
 *
 *   node scripts/dark-contrast-audit.mjs        # 需要先有一个开着远程调试的浏览器窗口
 *
 * 做法：切到深色主题，逐个打开每个应用窗口，对每个"直接含文字"的元素计算
 * 文字色与其**实际背景**（沿祖先链合成半透明背景）的对比度，低于 WCAG AA
 * （正文 4.5:1、大字 3:1）就报出来。并把每个窗口的截图存到 /tmp/dark-<应用>.png。
 *
 * 踩过的坑（都写在这里，免得下次重犯）：
 *   1. 合成半透明背景时必须保留 alpha，否则 4% 白 + 深色底会被算成纯白，
 *      Docker 窗口会凭空出现 60 多个"问题"。
 *   2. 窗口的类名是 .app-window，不是 .window；选错就会去量整个桌面。
 *   3. 账号菜单要先关掉，否则它会挡住后面的点击，所有窗口都打不开。
 */
import { writeFileSync } from "node:fs";
const list = await (await fetch("http://127.0.0.1:9455/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("18436"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
await new Promise((r) => ws.addEventListener("open", r));
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHECK = `(() => {
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value || "");
    if (!m) return null;
    const parts = m[1].split(",").map((x) => parseFloat(x));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // 合成必须保留 alpha：把 a 强行置 1 会让半透明填充叠成纯白（第一版就是栽在这）
  const blend = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };
  const bgOf = (node) => {
    let current = node, acc = null;
    while (current) {
      const bg = parse(getComputedStyle(current).backgroundColor);
      if (bg && bg.a > 0) {
        acc = acc ? blend(acc, bg) : bg;
        if (bg.a === 1) return acc;
      }
      current = current.parentElement;
    }
    return acc && acc.a > 0 ? acc : { r: 255, g: 255, b: 255, a: 1 };
  };
  const root = document.querySelector(".app-window [role=region], .app-window, .window") || document.body;
  const bad = [];
  for (const node of root.querySelectorAll("*")) {
    const text = [...node.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
    if (!text) continue;
    const cs = getComputedStyle(node);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.15) continue;
    const box = node.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(node);
    const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    const size = parseFloat(cs.fontSize);
    const large = size >= 18.66 || (size >= 14 && parseInt(cs.fontWeight, 10) >= 700);
    const limit = large ? 3 : 4.5;
    if (ratio < limit) bad.push({ cls: (node.className || node.tagName).toString().slice(0, 30), text: text.slice(0, 22), ratio: Number(ratio.toFixed(2)), size, color: cs.color, bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(",") + ")" });
  }
  return JSON.stringify({ theme: document.documentElement.dataset.theme || "light", issues: bad.slice(0, 8), count: bad.length });
})()`;

// 确保是深色：已经是深色就别再点，并且无论如何都要把菜单关掉（否则它会挡住后面的点击）
let theme = await ev(`document.documentElement.dataset.theme || "light"`);
if (theme !== "dark") {
  await ev(`(()=>{const b=document.querySelector('[aria-label="打开账号面板"]');if(b)b.click();return 1})()`);
  await sleep(800);
  await ev(`(()=>{const b=[...document.querySelectorAll('.account-menu button')].find(x=>/深色外观/.test(x.textContent||''));if(b)b.click();return 1})()`);
  await sleep(1200);
  await ev(`(()=>{const m=document.querySelector('.account-menu');if(m)document.body.click();return 1})()`);
  await sleep(600);
}
theme = await ev(`document.documentElement.dataset.theme || "light"`);
console.log("theme now:", theme);

const apps = ["文件管理", "相册", "影视中心", "音乐", "下载中心", "应用商店", "控制面板", "任务中心", "存储管理", "Docker", "远程访问"];
for (const app of apps) {
  await ev(`(()=>{const b=[...document.querySelectorAll('.desktop-app')].find(x=>(x.textContent||'').trim()==='${app}');if(b)b.click();return 1})()`);
  await sleep(app === "应用商店" ? 8000 : 6000);
  const opened = await ev(`!!document.querySelector('.app-window, .window')`);
  const result = await ev(CHECK);
  const parsed = JSON.parse(result);
  console.log(app.padEnd(6), "opened=" + opened, "count=" + parsed.count, JSON.stringify(parsed.issues.slice(0, 2)));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`/tmp/dark-${app}.png`, Buffer.from(shot.data, "base64"));
  await ev(`(()=>{const b=[...document.querySelectorAll('[aria-label^="关闭"]')].pop();if(b)b.click();return 1})()`);
  await sleep(1200);
}
ws.close();
