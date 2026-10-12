/*
 * 可访问性巡检：可聚焦元素有没有"名字"、聚焦时看不看得见
 *
 *   node scripts/a11y-audit.mjs
 *
 * 两类问题：
 *   1. 无名称 —— 图标按钮/输入框没有可读名字（屏幕阅读器只会念"按钮"）
 *   2. 无焦点样式 —— 键盘 Tab 过去看不到自己在哪
 *
 * 关于第 2 类**为什么用静态检查**：
 *   应用用的是 `:focus-visible`（15 处），而这个伪类只在"键盘交互"后成立。
 *   程序化 `el.focus()` 不会触发它，`focus({ focusVisible: true })` 实测也无效；
 *   真按 Tab 又需要页面可见（本环境页面在后台）。所以改成**查样式表**：
 *   把所有含 `:focus-visible` / `:focus` 的规则收集起来，用去掉伪类后的选择器
 *   去 `matches()` 每个可聚焦元素 —— 能客观回答"这个元素到底有没有焦点样式"。
 *
 * 只做能客观判定的检查，主观项（顺序是否合理）不猜。
 */
const port = process.env.DSH_CDP_PORT || "9455";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("18436"));
if (!page) { console.log("找不到部署页面"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
await new Promise((r) => ws.addEventListener("open", r));
const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面执行出错: " + String(r.exceptionDetails.exception?.description || "").slice(0, 140));
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHECK = `(() => {
  const name = (el) => {
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (text) return text;
    }
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const text = (el.textContent || "").trim();
    if (text) return text;
    const title = (el.getAttribute("title") || "").trim();
    if (title) return title;
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
      const id = el.id;
      const label = id ? document.querySelector('label[for="' + id + '"]') : null;
      const wrapped = el.closest("label");
      const placeholder = (el.getAttribute("placeholder") || "").trim();
      if (label?.textContent?.trim()) return label.textContent.trim();
      if (wrapped?.textContent?.trim()) return wrapped.textContent.trim();
      if (el.getAttribute("aria-label")?.trim()) return el.getAttribute("aria-label").trim();
      if (placeholder) return placeholder + "（仅 placeholder）";
    }
    const img = el.querySelector("img[alt]");
    if (img && img.getAttribute("alt").trim()) return img.getAttribute("alt").trim();
    return "";
  };
  const focusable = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled;
    });
  // 收集所有焦点相关规则，去掉伪类后留作"是否覆盖该元素"的判断依据
  const focusSelectors = [];
  /*
   * 必须用 Array.from：实测这个 Chrome 里对 CSSRuleList 直接 for...of
   * 只会枚举出 3 条规则（2005 条里），于是误判成"全站没有焦点样式"。
   */
  const walk = (rules) => {
    for (const rule of Array.from(rules || [])) {
      if (rule.cssRules && rule.cssRules.length) { walk(rule.cssRules); continue; }
      const sel = rule.selectorText || "";
      if (!/:focus(-visible)?/.test(sel)) continue;
      for (const part of sel.split(",")) {
        if (!/:focus(-visible)?/.test(part)) continue;
        const base = part.replace(/:focus(-visible)?/g, "").trim();
        if (base) focusSelectors.push(base);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch { /* 跨域样式表读不到，跳过 */ }
  }
  const unnamed = [];
  const invisibleFocus = [];
  const describe = (el) => (el.getAttribute("aria-label") || el.className || el.tagName).toString().slice(0, 34);
  for (const el of focusable) {
    if (!name(el)) unnamed.push({ el: describe(el), tag: el.tagName });
    const covered = focusSelectors.some((sel) => {
      try { return el.matches(sel); } catch { return false; }
    });
    if (!covered) invisibleFocus.push({ el: describe(el) });
  }
  const imgsNoAlt = [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length;
  return JSON.stringify({ total: focusable.length, unnamed, invisibleFocus, imgsNoAlt, rules: focusSelectors.length });
})()`;

const apps = ["文件管理", "相册", "影视中心", "音乐", "下载中心", "应用商店", "控制面板", "任务中心", "存储管理", "Docker", "远程访问"];
let unnamedTotal = 0, invisibleTotal = 0;
const seenUnnamed = new Set();
for (const app of apps) {
  await ev(`(()=>{[...document.querySelectorAll('[aria-label^="关闭"]')].reverse().forEach(b=>b.click());return 1})()`);
  await sleep(900);
  await ev(`(()=>{const b=[...document.querySelectorAll('.desktop-app')].find(x=>(x.textContent||'').trim()==='${app}');if(b)b.click();return 1})()`);
  await sleep(app === "应用商店" ? 6500 : 5000);
  const r = JSON.parse(await ev(CHECK));
  const freshUnnamed = r.unnamed.filter((u) => !seenUnnamed.has(u.el));
  freshUnnamed.forEach((u) => seenUnnamed.add(u.el));
  unnamedTotal += freshUnnamed.length;
  invisibleTotal += r.invisibleFocus.length;
  console.log(`${app.padEnd(6)} 可聚焦 ${String(r.total).padStart(3)} | 无名称 ${freshUnnamed.length}${freshUnnamed.length ? " -> " + freshUnnamed.map((u) => u.el).join(", ") : ""} | 无焦点样式 ${r.invisibleFocus.length} | 无 alt 图 ${r.imgsNoAlt} | 焦点规则 ${r.rules}`);
}
console.log(`\n合计：无名称 ${unnamedTotal}，无可见焦点 ${invisibleTotal}`);
ws.close();
process.exit(unnamedTotal + invisibleTotal ? 1 : 0);
