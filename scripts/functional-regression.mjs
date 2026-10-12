/*
 * 功能回归（深色 / 浅色都跑）
 *
 *   node scripts/functional-regression.mjs                 # 当前主题
 *   node scripts/functional-regression.mjs --theme light   # 先切到浅色再跑
 *   node scripts/functional-regression.mjs --theme dark
 *
 * 覆盖：文件管理（列表/排序/预览）、相册（缩略图/查看器翻页）、影视（海报/播放）、
 * 音乐（播放/歌词/队列）、下载/商店/控制面板（网络+设置）/任务/存储/Docker/远程访问，
 * 并统计控制台异常。
 *
 * 两个已知坑（都会让结果失真，先在这里处理掉）：
 *   1. 后台标签页里 `loading="lazy"` 的图片永远不会加载（Chrome 行为），
 *      所以量图片前先把 window 拉到前台并把 loading 改成 eager。
 *   2. 账号菜单若开着会挡住后续点击，导致"所有窗口都打不开"。
 */
const args = process.argv.slice(2);
const wantTheme = args.includes("--theme") ? args[args.indexOf("--theme") + 1] : null;
const port = process.env.DSH_CDP_PORT || "9455";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("18436"));
if (!page) { console.log("找不到部署页面（18436）"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params.exceptionDetails?.exception?.description || "").slice(0, 70));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(String(m.params.args?.map((a) => a.value ?? a.description).join(" ")).slice(0, 70));
});
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable", {});
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closeAll = async () => { await ev(`(()=>{[...document.querySelectorAll('[aria-label^="关闭"]')].reverse().forEach(b=>b.click());return 1})()`); await sleep(1200); };
const openApp = async (name) => { await ev(`(()=>{const b=[...document.querySelectorAll('.desktop-app')].find(x=>(x.textContent||'').trim()==='${name}');if(b)b.click();return 1})()`); await sleep(name === "应用商店" ? 7000 : 5500); };
/** 图片计数前先解决懒加载：拉到前台 + 改 eager + 重置 src */
const images = async (selector) => {
  await send("Page.bringToFront");
  return ev(`(async()=>{const imgs=[...document.querySelectorAll('${selector}')];
    imgs.forEach(i=>{i.loading='eager';const s=i.getAttribute('src');i.setAttribute('src','');i.setAttribute('src',s)});
    await new Promise(r=>setTimeout(r,7000));
    return imgs.filter(i=>i.naturalWidth>0).length+'/'+imgs.length})()`);
};

await send("Page.bringToFront");
await ev(`(()=>{document.body.click();return 1})()`);   // 关掉可能开着的菜单
await sleep(800);
if (wantTheme) {
  const current = await ev(`document.documentElement.dataset.theme || "light"`);
  if (current !== wantTheme) {
    const label = wantTheme === "dark" ? "深色外观" : "浅色外观";
    await ev(`(()=>{document.querySelector('[aria-label="打开账号面板"]')?.click();return 1})()`); await sleep(700);
    await ev(`(()=>{[...document.querySelectorAll('.account-menu button')].find(x=>x.textContent.includes('${label}'))?.click();return 1})()`); await sleep(1200);
    await ev(`(()=>{document.body.click();return 1})()`); await sleep(800);
  }
}
const theme = await ev(`document.documentElement.dataset.theme || "light"`);
console.log("主题:", theme);

await openApp("文件管理");
await ev(`(()=>{[...document.querySelectorAll('.file-row')].find(x=>/M\\.2存储11/.test(x.textContent||''))?.click();return 1})()`); await sleep(6500);
await ev(`(()=>{[...document.querySelectorAll('.file-row')].find(r=>/\\.(png|jpg)/i.test(r.textContent||''))?.click();return 1})()`); await sleep(4000);
console.log("文件管理:", await ev(`(()=>JSON.stringify({rows:document.querySelectorAll('.file-row').length,sort:[...document.querySelectorAll('.file-sort button')].map(b=>b.textContent.trim()),preview:(()=>{const i=document.querySelector('.file-preview img');return i?i.naturalWidth>0:null})()}))()`));
await closeAll();

await openApp("相册");
console.log("相册缩略图:", await images(".media-module.photos .media-art img"));
await ev(`(()=>{document.querySelector('.media-module.photos .media-card')?.click();return 1})()`); await sleep(6000);
console.log("查看器:", await ev(`(()=>{const v=document.querySelector('.photo-viewer');if(!v)return 'none';const i=v.querySelector('img');return JSON.stringify({counter:v.querySelector('.photo-counter')?.textContent,imgOk:i?i.naturalWidth>0:null})})()`));
await ev(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return 1})()`); await sleep(3500);
await ev(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 1})()`); await sleep(1200);
await closeAll();

await openApp("影视中心");
await ev(`(()=>{[...document.querySelectorAll('.rail-list button')][0]?.click();return 1})()`); await sleep(6000);
console.log("影视海报:", await images(".media-module.video .media-art img"));
await ev(`(()=>{document.querySelector('.media-module.video .media-card')?.click();return 1})()`); await sleep(4500);
await ev(`(()=>{document.querySelector('.video-episode')?.click();return 1})()`); await sleep(14000);
/*
 * 播放检查要能区分"在放"和"真的出画面"：
 * readyState/currentTime 只能说明解码器在跑，**黑屏也可能满足**。
 * 所以额外看 videoWidth/videoHeight（有没有解出画面尺寸）与 paused。
 */
console.log("影视播放:", await ev(`(()=>{const v=document.querySelector('.video-stage video');
  if(!v) return 'no video';
  return JSON.stringify({
    rs:v.readyState,
    t:Number(v.currentTime.toFixed(1)),
    dur:isFinite(v.duration)?Number(v.duration.toFixed(0)):null,
    picture:v.videoWidth>0 && v.videoHeight>0,
    size:v.videoWidth+'x'+v.videoHeight,
    paused:v.paused,
    err:v.error?v.error.code:null,
  })})()`));
await ev(`(()=>{document.querySelector('[aria-label="关闭播放器"]')?.click();return 1})()`); await sleep(1500);
await closeAll();

await openApp("音乐");
await ev(`(()=>{document.querySelector('.media-module.music .song-list > *')?.click();return 1})()`); await sleep(9000);
console.log("音乐播放:", await ev(`(()=>{const a=document.querySelector('audio');
  if(!a) return 'no audio';
  return JSON.stringify({
    rs:a.readyState,
    t:Number(a.currentTime.toFixed(1)),
    dur:isFinite(a.duration)?Number(a.duration.toFixed(0)):null,
    paused:a.paused,
    err:a.error?a.error.code:null,
  })})()`));
await ev(`(()=>{document.querySelector('[aria-label="显示歌词"]')?.click();return 1})()`); await sleep(5000);
console.log("歌词:", await ev(`(()=>{const p=document.querySelector('.lyrics-panel');return p?p.querySelectorAll('.lyric-line').length+' 行':'none'})()`));
await ev(`(()=>{document.querySelector('[aria-label="关闭歌词"]')?.click();document.querySelector('[aria-label="播放队列"]')?.click();return 1})()`); await sleep(2500);
console.log("队列:", await ev(`(()=>{const p=document.querySelector('.queue-panel');return p?p.querySelectorAll('.queue-row').length+' 行':'none'})()`));
await closeAll();

for (const app of ["下载中心", "应用商店", "控制面板", "任务中心", "存储管理", "Docker", "远程访问"]) {
  await openApp(app);
  const info = await ev(`(()=>{const t=document.body.innerText.replace(/\\s+/g,' ');return t.length + ' 字符, 原始JSON=' + /\\{\\s*"/.test(t)})()`);
  let extra = "";
  if (app === "控制面板") {
    await ev(`(()=>{[...document.querySelectorAll('.module-sidebar button')].find(b=>/网络连接/.test(b.textContent||''))?.click();return 1})()`); await sleep(5000);
    extra += " 网卡=" + await ev(`document.querySelectorAll('.network-card').length`);
    await ev(`(()=>{[...document.querySelectorAll('.module-sidebar button')].find(b=>/系统设置/.test(b.textContent||''))?.click();return 1})()`); await sleep(5000);
    extra += " 设置分组=" + await ev(`document.querySelectorAll('.settings-split > nav button').length`);
  }
  console.log(app + ":", info + extra);
  await closeAll();
}
console.log("控制台异常:", errors.length, errors.slice(0, 3));
ws.close();
