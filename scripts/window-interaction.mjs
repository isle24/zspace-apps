/*
 * 窗口管理交互巡检：拖动、缩放、双击最大化/还原、层叠聚焦、⌘W 关闭、越界拖动
 *
 *   node scripts/window-interaction.mjs
 *
 * **前置条件：浏览器窗口必须可见。** 页面处于后台时（document.hidden === true），
 * Chrome 会把 CDP 派发的鼠标/键盘事件直接丢掉 —— 事件一个都不到页面，
 * 于是每一项都会"失败"，看起来像功能坏了，其实什么都没测到。
 * 所以脚本先检查可见性，不满足就 SKIP 退出（而不是给出假的失败结论）。
 *
 * 这个坑是实测踩出来的：第一次跑，拖动/缩放/最大化/⌘W 全部报 ✗，
 * 查下去发现 document.hidden=true、连 document 级捕获监听都收不到 pointerdown。
 *
 * 页面不可见时脚本**不会直接放弃**：改用页内合成 PointerEvent 继续验证**应用自身的
 * 事件处理逻辑**（拖动状态机、缩放、双击最大化、⌘W、夹取），结果标注为"处理器级"。
 * 合成事件走不到"真实输入 → 浏览器 → 页面"这条链路，所以不能替代真机验证：
 * 输出里会明确写出哪一部分未验证（指针捕获、系统级输入路径）。
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
/** 注意：这里对页面异常**抛出**而不是返回 undefined —— 静默吞掉异常会伪装成"功能没反应"。 */
const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error("页面执行出错: " + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 160));
  }
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/*
 * 合成模式有个坑：真实指针有 pointer capture，拖出元素也照样收事件；
 * 合成事件没有 capture，如果每次都按坐标 elementFromPoint 找目标，
 * 窗口一移动就会"跟丢"——表现成"只移动了一小段"。所以按下时**记住元素**，后续都发给它。
 */
let syntheticTarget = null;
const mouse = (type, x, y, extra = {}) => {
  if (MODE === "real")
    return send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  const remember = type === "mousePressed";
  const pageType = { mousePressed: "pointerdown", mouseMoved: "pointermove", mouseReleased: "pointerup" }[type];
  // 合成事件是同步派发的，React 的重渲染是异步的：这里必须等一拍再读 DOM，
  // 否则会读到"没动"的旧布局（第一版就是这么误判的）。
  const settled = ev(`(()=>{
    ${remember ? "" : "if (!window.__dragTarget) window.__dragTarget = null;"}
    const el = ${remember
      ? `(document.elementFromPoint(${x}, ${y}) || document.body).closest('.window-titlebar, .resize-handle, .app-window') || document.body`
      : `window.__dragTarget || document.elementFromPoint(${x}, ${y}) || document.body`};
    ${remember ? "window.__dragTarget = el;" : ""}
    ${type === "mouseReleased" ? "window.__dragTarget = null;" : ""}
    window.__fire(el, "${pageType}", ${x}, ${y}, { buttons: ${type === "mouseReleased" ? 0 : 1}, button: ${type === "mouseReleased" ? -1 : 0} });
    return 1;
  })()`).then(() => sleep(120));
  return settled;
};

/*
 * 前置条件自己保证，别依赖脚本执行顺序：
 * 布局巡检会 setDeviceMetricsOverride 把视口缩小，如果它没有清掉（脚本被中断等），
 * 后面的窗口交互就会在一个 880×620 的"假视口"里跑 —— 夹取边界全变，断言随机失败。
 * 这里先清掉任何遗留的覆盖，再读真实视口。
 */
await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
await send("Page.bringToFront");
await sleep(1500);
/*
 * 只 clear 还不够：Emulation 的视口覆盖是**跟着 target 走的**，
 * 别的会话（例如布局巡检）设下的覆盖，从这里清不掉；实测**刷新页面**能清。
 * 所以带 --reset 时先刷新一次，拿到真实视口再测。
 */
if (process.argv.includes("--reset")) {
  await send("Page.reload", { ignoreCache: false });
  await sleep(13000);
  await ev(`(()=>{[...document.querySelectorAll('.account-menu')].forEach(()=>document.body.click());return 1})()`);
  await sleep(600);
}
console.log("视口:", await ev(`innerWidth + "x" + innerHeight`));
const hidden = await ev(`document.hidden`);
const MODE = hidden ? "synthetic" : "real";
if (hidden) {
  console.log("注意：页面处于后台（document.hidden=true），CDP 输入不会送达 —— 改用页内合成事件。");
  console.log("      本轮结论为【处理器级】：验证应用自己的事件处理逻辑，不代表系统输入路径。");
  // 合成 pointerId 不是真实指针，setPointerCapture 会抛 NotFoundError；真实指针不会。
  // 这里把它吞掉，避免误判成应用问题（拖动状态在调用 capture 之前就已写入）。
  await ev(`(()=>{
    const proto = Element.prototype;
    for (const name of ["setPointerCapture", "releasePointerCapture"]) {
      const orig = proto[name];
      proto[name] = function (id) { try { return orig.call(this, id); } catch { /* 合成指针没有真实 pointerId */ } };
    }
    window.__fire = (el, type, x, y, extra) => el.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
      pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
    }, extra || {})));
    return 1;
  })()`);
}

const rect = () => ev(`(()=>{const w=document.querySelector('.app-window.focused')||document.querySelector('.app-window');if(!w)return null;const r=w.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),max:w.classList.contains('maximized')})})()`);
/** 标题栏上避开资源挂件的抓取点：取左侧 70px 处 */
const grab = () => ev(`(()=>{const t=document.querySelector('.app-window.focused .window-titlebar').getBoundingClientRect();return JSON.stringify({x:Math.round(t.x+70),y:Math.round(t.y+t.height/2),cls:(document.elementFromPoint(Math.round(t.x+70),Math.round(t.y+t.height/2)).className||'').toString().slice(0,20)})})()`);

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "✓" : "✗"} ${name.padEnd(12)} ${detail}`); if (!ok) failures++; };

await ev(`(()=>{[...document.querySelectorAll('[aria-label^="关闭"]')].reverse().forEach(b=>b.click());return 1})()`);
await sleep(1200);
await ev(`(()=>{const b=[...document.querySelectorAll('.desktop-app')].find(x=>/文件管理/.test(x.textContent||''));if(b)b.click();return 1})()`);
await sleep(6000);

const before = JSON.parse(await rect());
const g = JSON.parse(await grab());
if (process.env.WI_DEBUG) {
  console.log("  debug: 窗口数=" + (await ev(`document.querySelectorAll('.app-window').length`)) +
    " 抓取点=" + JSON.stringify(g) + " 命中=" + (await ev(`(()=>{const el=document.elementFromPoint(${g.x},${g.y});return el.tagName+'.'+(el.className||'').toString().slice(0,18)+' -> '+(el.closest('.window-titlebar')?'titlebar':'其他')})()`)));
  console.log("  debug: __fire 存在=" + (await ev(`typeof window.__fire`)) + " 模式=" + MODE);
}
if (g.cls !== "window-titlebar") console.log(`（提示）抓取点命中的是 ${g.cls}，可能被浮层挡住`);
/*
 * 位移要选**不会被夹取**的方向和幅度。应用把可用区域算成
 *   height = innerHeight - 132（底部预留），x 夹在 [0, innerWidth - width]
 * 所以"向下拖"很容易立刻撞到边界 —— 第一版按 (+120,+72) 拖，x 准、y 只走了 28，
 * 看起来像 bug，其实是夹取生效。这里改成小幅右下，两个轴都在范围内。
 */
const DX = 100, DY = 20;
await mouse("mousePressed", g.x, g.y);
for (let i = 1; i <= 5; i++) { await mouse("mouseMoved", g.x + (DX / 5) * i, g.y + (DY / 5) * i); await sleep(70); }
await mouse("mouseReleased", g.x + DX, g.y + DY);
await sleep(700);
const after = JSON.parse(await rect());
if (process.env.WI_DEBUG) console.log("  debug: 拖动后 style=" + (await ev(`(()=>{const w=document.querySelector('.app-window.focused');return w.style.left+','+w.style.top})()`)));
check("拖动", Math.abs(after.x - before.x - DX) <= 4 && Math.abs(after.y - before.y - DY) <= 4,
  `(${before.x},${before.y}) -> (${after.x},${after.y})，期望位移 ${DX},${DY}`);

const handle = await ev(`(()=>{const h=document.querySelector('.app-window.focused .resize-handle');if(!h)return null;const r=h.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
if (!handle) check("缩放", false, "没找到 .resize-handle");
else {
  const h = JSON.parse(handle); const b = JSON.parse(await rect());
  await mouse("mousePressed", h.x, h.y);
  for (let i = 1; i <= 5; i++) { await mouse("mouseMoved", h.x + i * 20, h.y + i * 12); await sleep(60); }
  await mouse("mouseReleased", h.x + 100, h.y + 60);
  await sleep(700);
  const a = JSON.parse(await rect());
  check("缩放", a.w > b.w && a.h > b.h, `${b.w}x${b.h} -> ${a.w}x${a.h}`);
}

const g2 = JSON.parse(await grab());
const dblclick = async (x, y) => {
  if (MODE === "real") {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 2 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 2 });
  } else {
    await ev(`(()=>{const el=document.elementFromPoint(${x}, ${y});el.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true,clientX:${x},clientY:${y},detail:2}));return 1})()`);
  }
};
await dblclick(g2.x, g2.y);
await sleep(900);
const vp = JSON.parse(await ev(`JSON.stringify({w:innerWidth,h:innerHeight})`));
const maxed = JSON.parse(await rect());
check("双击最大化", maxed.max === true && maxed.w >= vp.w - 80, `${maxed.w}x${maxed.h}（视口 ${vp.w}x${vp.h}）`);
const g3 = JSON.parse(await grab());
await dblclick(g3.x, g3.y);
await sleep(900);
const restored = JSON.parse(await rect());
check("还原", restored.max === false, `${restored.w}x${restored.h}`);

// 层叠聚焦
await ev(`(()=>{const b=[...document.querySelectorAll('.desktop-app')].find(x=>/相册/.test(x.textContent||''));if(b)b.click();return 1})()`);
await sleep(6000);
/*
 * 选一个**确实属于最底层窗口**的点再点。
 *
 * 以前直接取"窗口左上角 + (40,8)"，假定那个点属于它 —— 但前面的步骤把窗口拖过，
 * 两个窗口会重叠，那个点可能落在**上层窗口**的标题栏上，于是点了个寂寞：
 * 层叠聚焦永远失败，看起来像功能坏了，其实是测试点错了地方（实测诊断：
 * 点击(495,90) 命中 window-titlebar，但那是相册的）。
 *
 * 这里改用 elementFromPoint 逐个候选点验证，命中目标窗口才用。
 */
const first = JSON.parse(await ev(`(()=>{
  const w=[...document.querySelectorAll('.app-window')][0];
  const r=w.getBoundingClientRect();
  const cands=[[40,8],[60,22],[r.width-40,22],[40,r.height-30]];
  for(const [dx,dy] of cands){
    const x=Math.round(r.x+dx), y=Math.round(r.y+dy);
    const el=document.elementFromPoint(x,y);
    if(el && w.contains(el)) return JSON.stringify({x,y,ok:true});
  }
  return JSON.stringify({x:Math.round(r.x+40),y:Math.round(r.y+8),ok:false});
})()`));
if (!first.ok) console.log("  （提示：找不到只属于最底层窗口的点，可能它被完全盖住了）");
await mouse("mousePressed", first.x, first.y);
await mouse("mouseReleased", first.x, first.y, { buttons: 0 });
await sleep(600);
/*
 * 诊断信息要够定位：窗口顺序、各自位置、以及**点击点实际命中的元素**。
 * 只报 z-index 不够 —— 曾经因为"点到了被上层窗口盖住的位置"而查了很久。
 */
const stack = await ev(`JSON.stringify({
  probe: (()=>{const el=document.elementFromPoint(${first.x},${first.y});return el?(el.className||el.tagName).toString().slice(0,30):null})(),
  probeInFirst: (()=>{const el=document.elementFromPoint(${first.x},${first.y});return el?document.querySelectorAll('.app-window')[0].contains(el):null})(),
  windows: [...document.querySelectorAll('.app-window')].map(w=>{const r=w.getBoundingClientRect();
    return w.getAttribute('aria-label')+':'+getComputedStyle(w).zIndex+(w.classList.contains('focused')?':focused':'')+
      '@'+Math.round(r.x)+','+Math.round(r.y)})})`);
check("层叠聚焦", (await ev(`document.querySelectorAll('.app-window')[0].classList.contains('focused')`)) === true,
  `点击(${first.x},${first.y}) 命中 ${JSON.parse(stack).probe} | ${JSON.parse(stack).windows.join(' | ')}`);

// ⌘W
const n0 = await ev(`document.querySelectorAll('.app-window').length`);
if (MODE === "real") {
  await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "w", code: "KeyW", windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "w", code: "KeyW", windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
} else {
  await ev(`(()=>{const init={key:"w",code:"KeyW",metaKey:true,bubbles:true,cancelable:true};document.dispatchEvent(new KeyboardEvent("keydown",init));document.dispatchEvent(new KeyboardEvent("keyup",init));window.dispatchEvent(new KeyboardEvent("keydown",init));return 1})()`);
}
await sleep(900);
const n1 = await ev(`document.querySelectorAll('.app-window').length`);
check("⌘W 关闭", n1 === n0 - 1, `${n0} -> ${n1}`);

// 越界拖动应被夹住，不能把窗口拖没
const gClamp = JSON.parse(await grab());
await mouse("mousePressed", gClamp.x, gClamp.y);
for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", Math.max(1, gClamp.x - i * 200), Math.max(1, gClamp.y - i * 150)); await sleep(50); }
await mouse("mouseReleased", 1, 1);
await sleep(600);
const clamped = JSON.parse(await rect());
const bounds = JSON.parse(await ev(`JSON.stringify({maxX: innerWidth - ${clamped.w}, maxY: innerHeight - 132 - ${clamped.h}})`));
check("越界夹取", clamped.x >= -2 && clamped.y >= -2 && clamped.x <= bounds.maxX + 2 && clamped.y <= bounds.maxY + 2,
  `落点 (${clamped.x},${clamped.y})，允许范围 x≤${bounds.maxX} y≤${bounds.maxY}`);

console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
if (MODE === "synthetic") {
  console.log("【处理器级结论】以上验证的是应用自身的 pointer/键盘处理逻辑；");
  console.log("实测未覆盖：真实指针捕获（setPointerCapture）、系统级输入路径。");
  console.log("页面切到前台后重跑，可升级为真机结论。");
}
ws.close();
process.exit(failures ? 1 : 0);
