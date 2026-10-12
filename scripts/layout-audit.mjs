/*
 * 窄窗口 / 小屏布局巡检：把视口改成若干尺寸，逐个窗口打开，报出"装不下"的地方。
 * 判定三类问题（都要求能定位到具体元素）：
 *   1. 窗口内容横向溢出（子元素右边缘超出窗口右边缘 > 1px，且不是可滚动容器）
 *   2. 静默裁字：scrollWidth 明显大于 clientWidth，但既没有省略号也不是滚动容器
 *   3. 整页横向滚动（documentElement.scrollWidth > innerWidth）
 */
/*
 * 窄窗口 / 小屏布局巡检
 *
 *   node scripts/layout-audit.mjs              # 跑 880/760/640 三种视口
 *   node scripts/layout-audit.mjs --selftest   # 先验尺子：注入两个已知的坏元素，确认能被抓出来
 *
 * 报告三类问题：
 *   1. 越界：窗口内元素右边缘超出窗口右边缘（且不是横向滚动容器）
 *   2. 静默裁字：overflow-x:hidden 但内容更宽，且没有 text-overflow:ellipsis
 *   3. 整页横向滚动
 *
 * 先跑 --selftest 再信结果 —— 上一轮对比度巡检就是因为尺子坏了，
 * 报了 98 个不存在的问题（合成背景时把 alpha 强行置 1）。
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
  const win = document.querySelector(".app-window, .window");
  const overflow = [];
  const clipped = [];
  if (win) {
    const box = win.getBoundingClientRect();
    for (const node of win.querySelectorAll("*")) {
      const cs = getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = node.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      const scrollable = cs.overflowX === "auto" || cs.overflowX === "scroll";
      if (!scrollable && r.right > box.right + 1 && r.width < box.width * 3) {
        overflow.push({ cls: (node.className || node.tagName).toString().slice(0, 28), right: Math.round(r.right - box.right), text: (node.textContent || "").trim().slice(0, 18) });
      }
      const ellipsis = cs.textOverflow === "ellipsis";
      /*
       * 只把"真正装着文字的容器"算作静默裁字。
       *
       * 原来只要 scrollWidth > clientWidth 就报 —— 于是一个**纯布局/装饰容器**
       * （影视 hero：模糊底图层 + flex 子元素）也会被报，哪怕一行字都没被裁。
       * 实测就是这么报出 video-hero(40/25) 的：那是我这层自己写的装饰溢出。
       * 判据改为：元素的直接子节点里有**非空文本节点**，才可能发生"字被吃掉"。
       */
      const hasOwnText = [...node.childNodes].some(
        (child) => child.nodeType === 3 && (child.textContent || "").trim(),
      );
      if (!scrollable && !ellipsis && hasOwnText && node.scrollWidth > node.clientWidth + 2 && cs.overflowX === "hidden") {
        clipped.push({ cls: (node.className || node.tagName).toString().slice(0, 28), over: node.scrollWidth - node.clientWidth, text: (node.textContent || "").trim().slice(0, 18) });
      }
      if (overflow.length > 6 && clipped.length > 6) break;
    }
  }
  return JSON.stringify({
    viewport: window.innerWidth + "x" + window.innerHeight,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    window: win ? Math.round(win.getBoundingClientRect().width) + "x" + Math.round(win.getBoundingClientRect().height) : null,
    overflow: overflow.slice(0, 6),
    clipped: clipped.slice(0, 6),
  });
})()`;

// 自检：往窗口里塞一个 2000px 宽的块和一个静默裁字的块，确认两种都能报出来
if (process.argv.includes("--selftest")) {
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  await ev(`(()=>{const b=[...document.querySelectorAll('.desktop-app')].find(x=>/文件管理/.test(x.textContent||''));if(b)b.click();return 1})()`);
  await sleep(6000);
  await ev(`(()=>{const win=document.querySelector('.app-window, .window');
    const a=document.createElement('div');a.className='__ruler_overflow';a.style.cssText='width:2000px;height:20px';a.textContent='越界测试';win.appendChild(a);
    const b=document.createElement('div');b.className='__ruler_clip';b.style.cssText='width:60px;overflow-x:hidden;white-space:nowrap';b.textContent='这是一段很长很长会被静默裁掉的文字';win.appendChild(b);return 1})()`);
  const probe = JSON.parse(await ev(CHECK));
  const caught = probe.overflow.some((o) => o.cls.includes("__ruler_overflow")) && probe.clipped.some((c) => c.cls.includes("__ruler_clip"));
  console.log(caught ? "尺子自检通过：两类问题都能抓出来" : "尺子自检失败：" + JSON.stringify(probe));
  await ev(`(()=>{document.querySelectorAll('.__ruler_overflow,.__ruler_clip').forEach((n)=>n.remove());return 1})()`);
  await send("Emulation.clearDeviceMetricsOverride");
  ws.close();
  process.exit(caught ? 0 : 1);
}

/*
 * 先重载再跑。
 *
 * 这一项在 verify.sh 里排在别的脚本之后，而 `Emulation.setDeviceMetricsOverride`
 * 与已打开的窗口会**跨脚本残留**（只有整页重载才清得掉）——
 * 结果同一个巡检单跑全过、在套件里却红，看起来像应用坏了。
 * 所以自己先回到干净页面。
 */
await ev("location.reload()");
await sleep(9000);

/*
 * 记失败数：以前这个脚本只会**打印**问题却始终退出 0 ——
 * 一个"发现问题但不算失败"的检查，在套件里靠解析输出才发现，
 * 直接跑的时候完全看不出来。现在自己就返回非零。
 */
let failed = 0;
const sizes = [[880, 620], [760, 560], [640, 900]];
const apps = ["文件管理", "相册", "影视中心", "音乐", "下载中心", "应用商店", "控制面板", "任务中心", "存储管理", "Docker", "远程访问"];
for (const [w, h] of sizes) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  console.log(`\n=== 视口 ${w}x${h} ===`);
  for (const app of apps) {
    await ev(`(()=>{document.querySelectorAll('.account-menu').forEach(()=>document.body.click());const b=[...document.querySelectorAll('.desktop-app')].find(x=>(x.textContent||'').trim()==='${app}');if(b)b.click();return 1})()`);
    await sleep(app === "应用商店" ? 6500 : 5000);
    const result = JSON.parse(await ev(CHECK));
    const flags = [];
    // 窗口没打开不是 "ok"：以前这句只打印 win=null 就算过，等于没测
    if (result.window === null) flags.push("窗口没打开");
    if (result.pageOverflow > 0) flags.push("整页横向溢出 " + result.pageOverflow);
    if (result.overflow.length) flags.push("越界 " + result.overflow.length + " [" + result.overflow.map((o) => o.cls + "+" + o.right).join(", ") + "]");
    if (result.clipped.length) flags.push("静默裁字 " + result.clipped.length + " [" + result.clipped.map((c) => c.cls + "(" + c.over + ")").join(", ") + "]");
    if (flags.length) failed++;
    console.log(app.padEnd(6), "win=" + result.window, flags.length ? flags.join(" | ") : "ok");
    await ev(`(()=>{const b=[...document.querySelectorAll('[aria-label^="关闭"]')].pop();if(b)b.click();return 1})()`);
    await sleep(900);
  }
}
await send("Emulation.clearDeviceMetricsOverride");
ws.close();

console.log(failed ? `\n${failed} 项未通过` : "\n窄窗口布局通过");
process.exit(failed ? 1 : 0);
