/*
 * 两条"不用登录也能验"的真实界面流程（WebKit，Mac 客户端同款引擎）
 *
 *   node scripts/ui-flows-check.cjs
 *
 * 1. **登录失败路径**：填一个连不上的地址 → 必须留在登录页、给出中文原因、
 *    按钮恢复可用、页面没有 undefined/NaN —— 这条路径以前只有单测覆盖。
 * 2. **独立商店页**：Codex 的组件要能在 Mac 引擎里渲染出来；
 *    网关不在时显示如实的错误态（不是空白、不是原始 JSON）。
 *
 * 自给自足：自己把 apps/client/dist 拷到临时目录、写一份测试用 runtime-config、
 * 起一个本地静态服务（WebKit 连不上 NAS，也不需要连）跑完就关。
 *
 * 两个坑记在这：
 *   - 原始 dist 里的商店页叫 `store.html`，只有部署时才改名成 `shop.html`；
 *   - 本地服务要带 `runtime-config.json`（nasOrigin 留空 → 登录页显示地址栏）。
 */
const { createServer } = require("node:http");
const { readFileSync, existsSync, mkdtempSync, cpSync, writeFileSync } = require("node:fs");
const { join, extname } = require("node:path");
const { tmpdir } = require("node:os");
const { webkit } = require("/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core");

const root = join(__dirname, "..");
const dist = join(root, "apps/client/dist");
const exec = process.env.HOME + "/Library/Caches/ms-playwright/webkit-2359/pw_run.sh";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".woff2": "font/woff2" };

if (!existsSync(join(dist, "index.html"))) {
  console.error("先跑 vite build（找不到 dist/index.html）");
  process.exit(1);
}

// 测试用产物：保留 dist，换掉 runtime-config 让登录页显示地址栏
const dir = mkdtempSync(join(tmpdir(), "ui-flows-"));
cpSync(dist, dir, { recursive: true });
writeFileSync(join(dir, "runtime-config.json"), JSON.stringify({ _comment: "测试用", nasOrigin: "" }), "utf8");

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = join(dir, path === "/" ? "index.html" : path);
  if (!file.startsWith(dir) || !existsSync(file)) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(readFileSync(join(dir, "index.html")));
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? "✓" : "✗"} ${name.padEnd(20)} ${detail}`);
    if (!ok) failed++;
  };

  const browser = await webkit.launch({ headless: true, executablePath: exec });
  try {
    // 1) 登录失败路径
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 80)));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    const fields = await page.$$(".login-card .field input");
    check("登录页字段", fields.length === 3, `${fields.length} 个输入框`);
    if (fields.length === 3) {
      await fields[0].fill("http://127.0.0.1:59999");
      await fields[1].fill("synthetic-user");
      await fields[2].fill("synthetic-pass");
      await page.click(".login-submit");
      await page.waitForTimeout(9000);
      const state = await page.evaluate(() => ({
        login: !!document.querySelector(".login-screen"),
        desktop: !!document.querySelector(".desktop"),
        alert: (document.querySelector('[role="alert"]')?.textContent || "").trim(),
        stuck: !!document.querySelector(".login-submit")?.disabled,
        suspicious: ["undefined", "NaN", "[object Object]"].filter((t) => document.body.innerText.includes(t)),
      }));
      check("留在登录页", state.login && !state.desktop, state.desktop ? "竟然进了桌面（假登录）" : "没有假装登录成功");
      check("给出中文原因", state.alert.includes("无法直接连接 NAS"), state.alert.slice(0, 46) || "没有任何提示");
      check("按钮不卡死", !state.stuck, state.stuck ? "一直在「正在连接…」" : "恢复为「登录」");
      check("没有可疑文本", state.suspicious.length === 0, state.suspicious.join(",") || "无");
    }
    check("登录页无脚本异常", errors.length === 0, errors[0] ?? "0");

    // 1b) 登录页上的小交互：密码可见切换、地址栏展开/收起、商店入口
    const before = await page.evaluate(() => ({
      passwordType: document.querySelector('.login-card input[type="password"]')?.type ?? null,
      hasAddress: !!document.querySelector(".login-card input[type=\"url\"]"),
      toggles: [...document.querySelectorAll(".login-links button")].map((b) => (b.textContent || "").trim()),
    }));
    const reveal = await page.$('[aria-label*="密码"], .password-toggle, .login-card button[type="button"]');
    if (reveal) { await reveal.click(); await page.waitForTimeout(400); }
    const afterReveal = await page.evaluate(() =>
      document.querySelector('.login-card input[type="password"]')?.type ??
      (document.querySelector('.login-card input[type="text"]') ? "text" : null),
    );
    check("密码可见切换", before.passwordType === "password" && afterReveal === "text", `${before.passwordType} -> ${afterReveal}`);
    check("商店入口在位", before.toggles.some((t) => t.includes("独立应用商店")), before.toggles.join(" / ") || "没有按钮");
    await page.close();

    // 2) 独立商店页
    const shop = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const shopErrors = [];
    shop.on("pageerror", (e) => shopErrors.push(String(e).slice(0, 80)));
    await shop.goto(`${base}/store.html`, { waitUntil: "domcontentloaded" });
    await shop.waitForTimeout(8000);
    const shopState = await shop.evaluate(() => ({
      text: document.body.innerText.replace(/\s+/g, " "),
      mounted: !!document.querySelector("[class*=store]"),
    }));
    check("商店页渲染", shopState.mounted && shopState.text.includes("空间应用商店"), shopState.mounted ? "组件已挂载" : "没挂载");
    check("网关缺失时如实报错", shopState.text.includes("暂时无法读取") || shopState.text.includes("无效数据"), shopState.text.includes("暂时无法读取") ? "显示「暂时无法读取」" : shopState.text.slice(0, 50));
    check("商店页无脚本异常", shopErrors.length === 0, shopErrors[0] ?? "0");
    await shop.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed ? `\n${failed} 项未通过` : "\n界面流程检查通过");
  process.exit(failed ? 1 : 0);
})();
