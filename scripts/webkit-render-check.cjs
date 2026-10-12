/*
 * 用 WebKit（Mac 客户端同款引擎）渲染并截图
 *
 *   node scripts/webkit-render-check.cjs [URL]      # 默认 http://127.0.0.1:18999/
 *
 * 为什么需要它：Mac 客户端用的是 WKWebView，**不是 Chrome**。
 * 之前所有验收都在 Chrome 里做的，等于没验过目标引擎。
 *
 * 用法：先把构建产物用静态服务起在 127.0.0.1（例如
 *   python3 -m http.server 18999 --bind 127.0.0.1 --directory apps/client/dist）
 * 然后跑本脚本，截图落在 /tmp/webkit-login.png。
 *
 * 三个实测过的坑：
 *   1. Playwright 的 WebKit **连不上 192.168.3.56**（macOS 本地网络权限），
 *      但 127.0.0.1 和 192.168.3.1 都通 —— 所以本地起静态服务，别指 NAS。
 *   2. 这台机器上装的浏览器版本是 webkit-2359，而 playwright-core 1.60 想要 webkit-2287，
 *      必须显式传 executablePath，否则报"Executable doesn't exist"。
 *   3. 对比度检查器**看不见 background-image**（壁纸/渐变），
 *      所以它对登录页永远报 0 问题 —— 登录页的可读性只能看截图判断。
 */
const { webkit } = require("/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core");

const url = process.argv[2] || "http://127.0.0.1:18999/";
const executablePath = process.env.HOME + "/Library/Caches/ms-playwright/webkit-2359/pw_run.sh";

(async () => {
  const browser = await webkit.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 90)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 90)); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);
  console.log("UA:", (await page.evaluate(() => navigator.userAgent)).slice(0, 60));
  console.log("页面:", await page.evaluate(() => JSON.stringify({
    login: !!document.querySelector("[class*=login]"),
    desktop: !!document.querySelector(".desktop"),
    text: document.body.innerText.slice(0, 30).replace(/\s+/g, " "),
  })));
  console.log("引擎特性:", await page.evaluate(() => JSON.stringify({
    colorMix: CSS.supports("color", "color-mix(in srgb, red 50%, blue)"),
    has: CSS.supports("selector(:has(*))"),
    backdrop: CSS.supports("backdrop-filter", "blur(4px)"),
    webkitBackdrop: CSS.supports("-webkit-backdrop-filter", "blur(4px)"),
    dialog: typeof HTMLDialogElement !== "undefined",
  })));
  await page.screenshot({ path: "/tmp/webkit-login.png" });
  console.log("截图: /tmp/webkit-login.png");
  console.log("控制台异常:", errors.length, errors.slice(0, 3));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
