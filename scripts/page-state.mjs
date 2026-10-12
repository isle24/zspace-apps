/*
 * 打印部署页面当前处于什么状态，给 verify.sh 之类调用
 *
 *   node scripts/page-state.mjs        # -> desktop | login | unreachable
 *
 * 为什么要它：真机巡检需要页面**已登录**。被登出时那批脚本会各报各的失败
 * （找不到 .file-row、列表为空……），看起来像一堆功能坏了，实际只是没登录。
 * 上一轮我为了验会话过期把登录态弄掉了，正好说明这个提示有必要。
 */
const port = process.env.DSH_CDP_PORT || "9455";
const url = process.env.VERIFY_URL || "http://192.168.3.56:18436/";
try {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("18436"));
  if (!page) { console.log("unreachable"); process.exit(0); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const r = await send("Runtime.evaluate", {
    expression: `JSON.stringify({ desktop: !!document.querySelector('.desktop'), login: !!document.querySelector('.login-screen'), hidden: document.hidden })`,
    returnByValue: true,
  });
  const state = JSON.parse(r.result.value);
  if (state.login) { console.log("login"); process.exit(0); }
  if (state.desktop) { console.log(state.hidden ? "desktop-hidden" : "desktop"); process.exit(0); }
  console.log("unknown");
} catch {
  console.log("unreachable");
}
