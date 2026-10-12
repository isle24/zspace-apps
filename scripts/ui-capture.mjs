#!/usr/bin/env node
/**
 * ui-capture.mjs — browser-based visual verification harness (headless Chrome + CDP).
 *
 * Zero dependencies: Node built-ins only (Node >= 22 for the global WebSocket).
 * It launches an isolated headless Chrome with a throwaway --user-data-dir under /tmp,
 * talks the DevTools Protocol over the global WebSocket, navigates, waits for network
 * idle, runs optional scripted steps (click / type / wait / shot / eval / viewport / ...)
 * and writes PNG screenshots.
 *
 * stdout is exactly one JSON object (the summary). Human/progress logs go to stderr.
 * Exit code: 0 ok, 1 a step or CDP command failed, 2 bad usage.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const VERSION = "1.0.0";
const DEFAULT_CHROME =
  process.env.UI_CAPTURE_CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Prefer a real /tmp when it exists (macOS ${os.tmpdir()} is a per-user /var/folders path). */
function tempRoot() {
  return existsSync("/tmp") ? "/tmp" : tmpdir();
}

const HELP = `ui-capture.mjs v${VERSION} — headless-Chrome screenshot + interaction harness (CDP, zero npm deps)

USAGE
  node scripts/ui-capture.mjs --url <url> --out <png path> [options]

CORE OPTIONS
  --url <url>                Page to open (http/https/file/data/about). Required unless --connect.
  --out <png path>           Final screenshot destination, relative to cwd (dirs are created).
                             Optional if every needed image comes from a {"shot": ...} step.
  --width <px>               Viewport width in CSS px (default 1600).
  --height <px>              Viewport height in CSS px (default 1000).
  --wait-ms <ms>             Settle time after load+network idle, before steps (default 1500).
  --steps <json>             JSON array of actions to run after load (see STEPS).
  --steps-file <path>        Read the steps JSON from a file ("-" reads stdin).
  --full-page                Capture the full scrollable page instead of the viewport.
  --mobile / --no-mobile     Force the emulation mobile flag. Default: mobile when width <= 700
                             (matches this app's own breakpoint at 700px).

TUNING
  --device-scale-factor <n>  Emulated DPR (default 1).
  --timeout <ms>             Per-CDP-command timeout (default 30000).
  --net-idle-ms <ms>         Quiet period that counts as "network idle" (default 600).
  --net-idle-timeout <ms>    Max wait for network idle before proceeding anyway (default 15000).
  --chrome <path>            Chrome binary (default $UI_CAPTURE_CHROME or the macOS Chrome path).
  --connect <url|port>       Attach to an already-running DevTools endpoint instead of launching
                             (e.g. --connect 9222 or --connect http://127.0.0.1:9222).
  --keep-temp                Keep the temporary --user-data-dir (debugging).
  --keep-open                Leave Chrome running at the end (debugging; implies --keep-temp).
  --summary <path>           Also write the JSON summary to this file.
  --quiet                    No progress logs on stderr (errors are still printed).
  --help, -h                 This text.

STEPS — JSON array, executed in order. Every step is an object with exactly one action key.
  {"click": <target>}                     Click an element (real CDP mouse events; falls back to
                                          el.click() if the hit test is covered/offscreen).
  {"type": {"selector": <target>, "value": "text",
            "mode": "set"|"keys", "clear": true}}
                                          Focus + set the value. <target> may be "selector" or "text".
                                          mode "set" (default) uses the native value setter and
                                          dispatches input+change so React state updates; mode "keys"
                                          uses Input.insertText (real typing). "clear": false appends
                                          instead of replacing (default true).
  {"wait": <ms>}                          Sleep.
  {"shot": "<path>"}                      Screenshot to <path> (cwd-relative). Optional siblings:
                                          {"shot": "x.png", "fullPage": true}
  {"eval": "<expression>"}                Evaluate JS in the page; result is printed and recorded.
                                          Optional: {"eval": "...", "as": "name"} to label it.
  {"viewport": {"width": 390, "height": 844, "mobile": true, "deviceScaleFactor": 2}}
  {"waitFor": <target>, "timeout": 8000}  Poll until <target> exists (default timeout 8000ms).
  {"press": "Enter" | "Meta+k" | "Escape"}  Real key event; modifiers Meta/Control/Shift/Alt
                                          supported via "Mod+key". Optional {"press": "Enter",
                                          "selector": <target>} focuses that element first.  {"scroll": <px>}                        Wheel-scroll; or {"scroll": {"y": 600, "selector": t}}.

<target> is either:
  "<css selector>"          e.g. ".preview-button", "[aria-label=\\"文件管理\\"]"
  {"selector": "<css>"}     same, explicit form; optional "nth": 1 picks the 2nd match
  "text=<visible text>"     e.g. "text=先体验桌面" — exact-then-substring match on rendered
  {"text": "先体验桌面",      text, smallest matching element preferred, visible elements first;
   "exact": true,            "within": "<css>" restricts the search scope; "nth": 0 picks one.
   "within": ".login-card"}

EXAMPLES
  # login screen, desktop size
  node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \\
    --out output/verification/login.png --width 1600 --height 1000

  # same page at iPhone-ish size
  node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ \\
    --out output/verification/login-mobile.png --width 390 --height 844

  # desktop shell: click the preview entry, then open 文件管理 and shoot the window
  node scripts/ui-capture.mjs --url http://127.0.0.1:5173/ --width 1600 --height 1000 \\
    --steps '[{"click":"text=先体验桌面"},{"wait":1200},{"shot":"output/verification/shell.png"},
              {"click":"[aria-label=\\"打开文件管理\\"]"},{"wait":1500},
              {"shot":"output/verification/files.png"},
              {"eval":"document.querySelectorAll(\\".app-window\\").length","as":"windows"}]'

OUTPUT (stdout, single JSON object — also emitted with ok:false on failure/usage error)
  { ok, url, title, viewport, chrome:{pid,port,userDataDir,reused}, durationMs,
    steps:[{index,action,target,ok,ms,mode,result,error}], screenshots:[{path,width,height,bytes}],
    evals:[{as,value}], console:[{type,text}], pageErrors:[...],
    pageNavigations:[{url,atMs}]  // main-frame navigations during the steps (e.g. a Vite HMR reload)
    error? }
`;

/* ------------------------------------------------------------------ args ---- */

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      out._.push(tok);
      continue;
    }
    let key = tok.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const takesValue = new Set([
      "url", "out", "width", "height", "wait-ms", "steps", "steps-file", "device-scale-factor",
      "timeout", "net-idle-ms", "net-idle-timeout", "chrome", "connect", "summary",
    ]);
    if (value === undefined) {
      if (takesValue.has(key)) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`--${key} requires a value`);
      } else {
        value = true;
      }
    }
    out[key] = value;
  }
  return out;
}

class UsageError extends Error {}

function num(v, fallback, name) {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${name} must be a positive number, got ${v}`);
  return Math.round(n);
}

/* ------------------------------------------------------- logging / utils ---- */

function makeLogger(quiet) {
  return (msg) => {
    if (!quiet) process.stderr.write(`[ui-capture] ${msg}\n`);
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read intrinsic PNG size from the IHDR chunk (no image libraries). */
function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

function clip(text, n = 400) {
  const s = typeof text === "string" ? text : JSON.stringify(text);
  if (s === undefined) return String(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/* ----------------------------------------------------------- CDP client ---- */

class CdpError extends Error {
  constructor(message, method, data) {
    super(message);
    this.method = method;
    this.data = data;
  }
}

class CDP {
  constructor(ws, { timeout = 30000, log = () => {} } = {}) {
    this.ws = ws;
    this.timeout = timeout;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener("message", (ev) => this.#onMessage(ev));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new CdpError("DevTools connection closed", p.method));
      this.pending.clear();
    });
    ws.addEventListener("error", () => {
      /* detail comes through close/command timeouts */
    });
  }

  static async connect(wsUrl, opts) {
    const { log } = opts;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError(`Timed out opening ${wsUrl}`, "ws-open")), 15000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new CdpError(`Failed to open ${wsUrl}: ${e?.message || "websocket error"}`, "ws-open"));
      });
    });
    return new CDP(ws, opts);
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new CdpError(`${p.method}: ${msg.error.message}`, p.method, msg.error));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const list = this.handlers.get(msg.method);
      if (list) for (const fn of list) fn(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new CdpError("DevTools connection closed", method));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${this.timeout}ms`, method));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.handlers.get(method) || [];
    list.push(fn);
    this.handlers.set(method, list);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------- chrome process ---- */

/** Chrome we launched, tracked so SIGINT/SIGTERM/exit cannot leak a process or a /tmp profile. */
let activeHandle = null;
let activeOpts = null;
let signalCleanupRunning = false;

async function cleanupOnSignal(signal) {
  if (signalCleanupRunning) return;
  signalCleanupRunning = true;
  process.stderr.write(`\n[ui-capture] received ${signal}; stopping Chrome and removing the temp profile…\n`);
  try {
    await shutdownChrome(activeHandle, { ...(activeOpts || {}), keepOpen: false, keepTemp: false }, () => {});
  } catch {
    /* best effort */
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => void cleanupOnSignal("SIGINT"));
process.on("SIGTERM", () => void cleanupOnSignal("SIGTERM"));
// Last-resort synchronous kill (no awaits possible in an 'exit' handler).
process.on("exit", () => {
  const child = activeHandle?.child;
  if (child && child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
});

async function httpJson(url, { method = "GET", timeout = 5000 } = {}) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function launchChrome(opts, log) {
  const profile = await mkdtemp(path.join(tempRoot(), "ui-capture-chrome-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-client-side-phishing-detection",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${opts.width},${opts.height}`,
    "about:blank",
  ];
  log(`launching ${opts.chrome}`);
  const child = spawn(opts.chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => {
    stderr += String(d);
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  const portFile = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 20000;
  let port = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited early (code ${child.exitCode}). stderr:\n${clip(stderr, 2000)}`);
    }
    try {
      const raw = await readFile(portFile, "utf8");
      const first = raw.split("\n")[0].trim();
      if (first) {
        port = Number(first);
        break;
      }
    } catch {
      /* not written yet */
    }
    const m = stderr.match(/DevTools listening on ws:\/\/[^\s]*?:(\d+)\//);
    if (m) {
      port = Number(m[1]);
      break;
    }
    await sleep(120);
  }
  if (!port) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    throw new Error(`Chrome did not report a DevTools port within 20s. stderr:\n${clip(stderr, 2000)}`);
  }
  return { child, profile, port, stderr: () => stderr };
}

async function pickPageTarget(port, log) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (pages.length) {
        log(`attached to page target ${pages[0].id} (${pages[0].url})`);
        return pages[0];
      }
    } catch {
      /* devtools http not ready */
    }
    await sleep(150);
  }
  throw new Error(`No page target on 127.0.0.1:${port}/json/list`);
}

async function connectExisting(connect, log) {
  const base = /^\d+$/.test(String(connect)) ? `http://127.0.0.1:${connect}` : String(connect).replace(/\/$/, "");
  const version = await httpJson(`${base}/json/version`);
  const pages = (await httpJson(`${base}/json/list`)).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error(`No page target at ${base}/json/list`);
  log(`attaching to existing browser at ${base} (${version.Browser})`);
  return { port: Number(new URL(base).port || 0), target: pages[0], child: null, profile: null, stderr: () => "" };
}

async function shutdownChrome(handle, opts, log) {
  if (!handle) return;
  if (activeHandle === handle) activeHandle = null;
  const { child, profile, port } = handle;
  if (child && child.exitCode === null) {
    if (opts.keepOpen) {
      // Detach: the child's piped stdio and process handle would otherwise keep Node's event loop
      // referenced and the script would never exit after printing its summary.
      log(`--keep-open: leaving Chrome pid ${child.pid} running (port ${port})`);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      } catch { /* ignore */ }
    } else {
      log(`stopping Chrome pid ${child.pid}`);
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      await Promise.race([exited, sleep(4000)]);
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        await Promise.race([exited, sleep(2000)]);
      }
    }
  }
  if (profile && !opts.keepTemp && !opts.keepOpen) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(profile, { recursive: true, force: true });
        log(`removed temp profile ${profile}`);
        return;
      } catch (e) {
        if (attempt === 2) log(`warn: could not remove ${profile}: ${e.message}`);
        else await sleep(400);
      }
    }
  } else if (profile) {
    log(`kept temp profile ${profile}`);
  }
}

/* ------------------------------------------------- page / query helpers ---- */

const RESOLVER_SOURCE = (targetJson) => `(() => {
  const spec = ${targetJson};
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  const depth = (el) => { let d = 0, n = el; while ((n = n.parentElement)) d++; return d; };
  const describe = (el) => el ? {
    tag: el.tagName.toLowerCase(),
    cls: typeof el.className === "string" ? el.className : "",
    id: el.id || "",
    aria: el.getAttribute("aria-label") || "",
    text: norm(el.textContent).slice(0, 80),
  } : null;
  const out = { ok: false, reason: "", candidates: [] };
  let pool = [];
  if (spec.selector != null) {
    let found;
    try { found = Array.from(document.querySelectorAll(spec.selector)); }
    catch (e) { out.reason = "bad-selector: " + e.message; return JSON.stringify(out); }
    out.how = "css";
    out.count = found.length;
    pool = found;
  } else if (spec.text != null) {
    const within = spec.within ? document.querySelector(spec.within) : document;
    if (!within) { out.reason = "within-not-found: " + spec.within; return JSON.stringify(out); }
    const sel = 'button,a,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],label,summary,legend,span,div,p,li,td,th,small,strong,h1,h2,h3,h4,h5,option,input[type="submit"],input[type="button"]';
    const all = Array.from(within.querySelectorAll(sel));
    const exact = all.filter((e) => norm(e.textContent) === spec.text);
    const loose = all.filter((e) => norm(e.textContent).includes(spec.text));
    const base = spec.exact === false ? loose : (exact.length ? exact : loose);
    out.how = exact.length ? "text-exact" : "text-contains";
    out.count = base.length;
    pool = base.slice().sort((a, b) =>
      (visible(b) ? 1 : 0) - (visible(a) ? 1 : 0) ||
      norm(a.textContent).length - norm(b.textContent).length ||
      depth(b) - depth(a));
  } else {
    out.reason = "target must have selector or text";
    return JSON.stringify(out);
  }
  const nth = spec.nth || 0;
  const ranked = pool.slice().sort((a, b) => (visible(b) ? 1 : 0) - (visible(a) ? 1 : 0));
  let el = ranked[nth] || pool[0] || null;
  if (!el) {
    out.reason = "not-found";
    const seen = new Set();
    out.candidates = pool.slice(0, 12).map(describe);
    const scan = Array.from(document.querySelectorAll('button,a,[role="button"],input,label')).filter(visible);
    for (const e of scan) {
      const label = (e.getAttribute("aria-label") || norm(e.textContent) || e.getAttribute("placeholder") || "").slice(0, 40);
      if (label && !seen.has(label)) { seen.add(label); out.candidates.push(describe(e)); }
      if (out.candidates.length >= 24) break;
    }
    return JSON.stringify(out);
  }
  out.node = describe(el);
  out.visible = visible(el);
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
  const r = el.getBoundingClientRect();
  out.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  out.point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  const hit = document.elementFromPoint(
    Math.min(Math.max(out.point.x, 0), innerWidth - 1),
    Math.min(Math.max(out.point.y, 0), innerHeight - 1));
  out.hit = describe(hit);
  out.hitIsSelf = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  out.ok = true;
  return JSON.stringify(out);
})()`;

async function evaluate(cdp, expression, { awaitPromise = false, returnByValue = true } = {}) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const msg = d.exception?.description || d.text || "evaluation threw";
    throw new Error(msg.split("\n")[0]);
  }
  return res.result?.value;
}

async function resolveTarget(cdp, target) {
  const spec = typeof target === "string"
    ? (target.startsWith("text=") ? { text: target.slice(5) } : { selector: target })
    : { ...target };
  const raw = await evaluate(cdp, RESOLVER_SOURCE(JSON.stringify(spec)));
  const info = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!info.ok) {
    const cands = (info.candidates || [])
      .map((c) => `<${c.tag}${c.aria ? ` aria-label="${c.aria}"` : ""}${c.cls ? ` class="${c.cls}"` : ""}> "${c.text}"`)
      .slice(0, 6)
      .join("; ");
    throw new Error(
      `target not found (${info.reason}): ${JSON.stringify(spec)}` +
      (cands ? ` — visible candidates: ${cands}` : ""),
    );
  }
  return info;
}

async function dispatchClick(cdp, info) {
  const { x, y } = info.point;
  const common = { x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: common.x, y: common.y, buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
}

async function jsClick(cdp, target) {
  const spec = typeof target === "string"
    ? (target.startsWith("text=") ? { text: target.slice(5) } : { selector: target })
    : { ...target };
  return evaluate(cdp, `(() => {
    const spec = ${JSON.stringify(spec)};
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
    let el = null;
    if (spec.selector != null) el = document.querySelector(spec.selector);
    else if (spec.text != null) {
      const within = spec.within ? document.querySelector(spec.within) : document;
      const all = Array.from(within.querySelectorAll('button,a,[role="button"],label,span,div,li'));
      el = all.find((e) => norm(e.textContent) === spec.text)
        || all.filter((e) => norm(e.textContent).includes(spec.text))
             .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0] || null;
    }
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

const KEY_DEFS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

function parseKeyCombo(combo) {
  const parts = String(combo).split("+");
  const keyName = parts.pop();
  let modifiers = 0;
  for (const mod of parts) {
    const m = mod.toLowerCase();
    if (m === "meta" || m === "cmd" || m === "command" || m === "super") modifiers |= 4;
    else if (m === "control" || m === "ctrl") modifiers |= 2;
    else if (m === "alt" || m === "option") modifiers |= 1;
    else if (m === "shift") modifiers |= 8;
    else throw new Error(`unknown modifier "${mod}" in "${combo}"`);
  }
  const def = KEY_DEFS[keyName] || KEY_DEFS[keyName.charAt(0).toUpperCase() + keyName.slice(1)];
  if (def) return { ...def, modifiers };
  if (keyName.length === 1) {
    const upper = keyName.toUpperCase();
    const shifted = modifiers & 8 ? upper : keyName;
    return { key: shifted, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: shifted, modifiers, unmodifiedText: shifted };
  }
  throw new Error(`unsupported key "${keyName}" (add it to KEY_DEFS)`);
}

/* ------------------------------------------------------------ screenshots -- */

async function screenshot(cdp, outPath, { fullPage = false } = {}) {
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  const params = { format: "png", fromSurface: true, captureBeyondViewport: false };
  if (fullPage) {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize || { width: 1600, height: 1000 };
    params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    params.captureBeyondViewport = true;
  }
  const { data } = await cdp.send("Page.captureScreenshot", params);
  const buf = Buffer.from(data, "base64");
  await writeFile(outPath, buf);
  const size = pngSize(buf);
  return { path: path.resolve(outPath), width: size?.width ?? null, height: size?.height ?? null, bytes: buf.length, fullPage };
}

/** In-page function expression `(spec) => Element | null`; shared by the type/press steps. */
const RESOLVE_ELEMENT_FN = `(spec) => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const depth = (el) => { let d = 0, n = el; while ((n = n.parentElement)) d++; return d; };
  if (spec.selector != null) {
    const found = Array.from(document.querySelectorAll(spec.selector));
    return found.length ? (spec.nth != null ? found[spec.nth] : (found.find(vis) || found[0])) || null : null;
  }
  if (spec.text == null) return null;
  const within = spec.within ? document.querySelector(spec.within) : document;
  if (!within) return null;
  const all = Array.from(within.querySelectorAll('button,a,[role="button"],label,span,div,li,input,textarea,select'));
  const exact = all.filter((e) => norm(e.textContent) === spec.text);
  const loose = all.filter((e) => norm(e.textContent).includes(spec.text));
  const base = spec.exact === false ? loose : (exact.length ? exact : loose);
  base.sort((a, b) => (vis(b) ? 1 : 0) - (vis(a) ? 1 : 0) || norm(a.textContent).length - norm(b.textContent).length || depth(b) - depth(a));
  return base[spec.nth || 0] || null;
}`;

/* ----------------------------------------------------------------- steps --- */

/** Action keys a step may carry; every other key is treated as an option for that action. */
const ACTIONS = ["click", "type", "wait", "shot", "eval", "viewport", "waitFor", "press", "scroll"];

function runStep(cdp, step, index, ctx) {
  const started = Date.now();
  const keys = Object.keys(step || {});
  const actionKeys = keys.filter((k) => ACTIONS.includes(k));
  const entry = { index, action: actionKeys[0] ?? keys[0] ?? "(empty)", target: null, ok: true, ms: 0 };
  return runStepInner(cdp, step, index, ctx, entry, actionKeys, started);
}

async function runStepInner(cdp, step, index, ctx, entry, actionKeys, started) {
  const action = entry.action;
  const value = step[action];
  try {
    if (actionKeys.length !== 1) {
      throw new Error(
        `step ${index} must contain exactly one action key (${ACTIONS.join(", ")}), ` +
        `got [${Object.keys(step || {}).join(", ")}]`,
      );
    }
    switch (action) {
      case "click": {
        entry.target = value;
        const info = await resolveTarget(cdp, value);
        let mode = "cdp-mouse";
        if (info.visible && info.hitIsSelf) {
          await dispatchClick(cdp, info);
        } else {
          mode = "js-fallback";
          const ok = await jsClick(cdp, value);
          if (!ok) throw new Error("element disappeared before click");
          ctx.log(`step ${index}: used js-fallback (visible=${info.visible} hitIsSelf=${info.hitIsSelf})`);
        }
        entry.mode = mode;
        entry.result = info.node;
        break;
      }
      case "type": {
        const spec = typeof value === "string" ? { selector: value, value: "" } : { ...value };
        if (spec.selector == null && spec.text == null) throw new Error('type requires "selector" or "text"');
        const target = spec.selector != null
          ? { selector: spec.selector, nth: spec.nth }
          : { text: spec.text, nth: spec.nth, within: spec.within, exact: spec.exact };
        entry.target = spec.selector ?? `text=${spec.text}`;
        const info = await resolveTarget(cdp, target);
        const text = String(spec.value ?? "");
        const mode = spec.mode || "set";
        const replace = spec.clear !== false;
        const specJson = JSON.stringify(target);
        // Text matching can land on a wrapping <label>; descend to the real editable element.
        const EDITABLE_JS = `(el) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el;
          return el.querySelector('input,textarea,select,[contenteditable="true"],[contenteditable=""]') || null;
        }`;
        if (mode === "keys") {
          const res = await evaluate(cdp, `(() => {
            const found = (${RESOLVE_ELEMENT_FN})(${specJson});
            if (!found) return { ok: false, reason: "not-found" };
            const el = (${EDITABLE_JS})(found);
            if (!el) return { ok: false, reason: "not-editable", tag: found.tagName.toLowerCase() };
            el.focus();
            const len = (el.value ?? "").length;
            try { el.setSelectionRange(${replace ? "0" : "len"}, len); } catch {}
            return { ok: true, tag: el.tagName.toLowerCase(), mode: "keys" };
          })()`);
          if (!res?.ok) throw new Error(`type(${mode}) failed: ${res?.reason} ${res?.tag ? `on <${res.tag}>` : ""}`.trim());
          await cdp.send("Input.insertText", { text });
          entry.result = { target: entry.target, value: text, replace, mode, element: res };
        } else {
          const res = await evaluate(cdp, `(() => {
            const found = (${RESOLVE_ELEMENT_FN})(${specJson});
            if (!found) return { ok: false, reason: "not-found" };
            const el = (${EDITABLE_JS})(found);
            if (!el) return { ok: false, reason: "not-editable", tag: found.tagName.toLowerCase() };
            el.focus();
            let proto = null;
            if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
            else if (el instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
            else if (el instanceof HTMLInputElement) proto = HTMLInputElement.prototype;
            const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
            const prev = el.value ?? "";
            const next = ${JSON.stringify(text)};
            const value = ${replace ? "next" : "prev + next"};
            if (setter) setter.call(el, value); else el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            const after = el.value ?? "";
            return { ok: after === value, reason: after === value ? "" : "value-not-applied", tag: el.tagName.toLowerCase(), value: after };
          })()`);
          if (!res?.ok) throw new Error(`type(${mode}) failed: ${res?.reason} on <${res?.tag}>`);
          entry.result = { target: entry.target, value: text, replace, mode, element: res };
        }
        entry.mode = mode;
        entry.result.matched = info.node;
        break;
      }
      case "wait": {
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`wait needs a non-negative ms, got ${JSON.stringify(value)}`);
        entry.target = ms;
        await sleep(ms);
        break;
      }
      case "shot": {
        const spec = typeof value === "string" ? { path: value } : { ...value };
        if (!spec.path) throw new Error('shot requires a path: {"shot": "out.png"}');
        const shot = await screenshot(cdp, spec.path, { fullPage: !!spec.fullPage || ctx.fullPage });
        entry.target = spec.path;
        entry.result = { path: shot.path, width: shot.width, height: shot.height, bytes: shot.bytes };
        ctx.screenshots.push({ ...shot, step: index });
        break;
      }
      case "eval": {
        const spec = typeof value === "string" ? { expression: value } : { ...value };
        const expr = spec.expression ?? spec.script ?? spec.js;
        if (!expr) throw new Error('eval requires an expression: {"eval": "document.title"}');
        const result = await evaluate(cdp, `(() => { return (${expr}); })()`, { awaitPromise: true });
        const as = spec.as || step.as || null;
        entry.target = clip(expr, 120);
        entry.result = result === undefined ? null : result;
        if (as) entry.as = as;
        ctx.evals.push({ as, expression: clip(expr, 300), value: entry.result });
        ctx.log(`step ${index}: eval ${as || clip(expr, 60)} => ${clip(entry.result, 500)}`);
        break;
      }
      case "viewport": {
        const spec = typeof value === "string" ? { width: Number(value) } : { ...value };
        if (!spec.width || !spec.height) throw new Error('viewport requires {"width": n, "height": n}');
        await applyViewport(cdp, {
          width: Math.round(spec.width),
          height: Math.round(spec.height),
          mobile: spec.mobile ?? ctx.mobile,
          deviceScaleFactor: spec.deviceScaleFactor ?? ctx.deviceScaleFactor,
        });
        ctx.viewport = { width: Math.round(spec.width), height: Math.round(spec.height) };
        entry.target = ctx.viewport;
        break;
      }
      case "waitFor": {
        const spec = typeof value === "string" ? { target: value } : { ...value };
        const target = spec.target ?? spec.selector ?? spec.text;
        const timeout = Number(spec.timeout ?? 8000);
        const deadline = Date.now() + timeout;
        let lastErr = null;
        for (;;) {
          try {
            const info = await resolveTarget(cdp, target);
            entry.target = target;
            entry.result = { waitedMs: Date.now() - started, node: info.node };
            break;
          } catch (e) {
            lastErr = e;
            if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeout}ms: ${e.message}`);
            await sleep(150);
          }
        }
        void lastErr;
        break;
      }
      case "press": {
        const spec = typeof value === "string" ? { combo: value } : { ...value };
        const combo = spec.combo ?? spec.key;
        if (!combo) throw new Error('press requires a key: {"press": "Enter"}');
        if (spec.selector != null || spec.text != null) {
          const target = spec.selector != null
            ? { selector: spec.selector, nth: spec.nth }
            : { text: spec.text, nth: spec.nth, within: spec.within };
          const focused = await evaluate(cdp, `(() => {
            const el = (${RESOLVE_ELEMENT_FN})(${JSON.stringify(target)});
            if (!el) return false;
            el.focus();
            return true;
          })()`);
          if (focused !== true) throw new Error(`press target not found: ${JSON.stringify(target)}`);
          entry.target = `${combo} on ${spec.selector ?? `text=${spec.text}`}`;
        }
        const def = parseKeyCombo(combo);
        const base = { modifiers: def.modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
        await cdp.send("Input.dispatchKeyEvent", { type: def.text ? "keyDown" : "rawKeyDown", ...base, text: def.text, unmodifiedText: def.unmodifiedText ?? def.text });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        entry.target = entry.target ?? combo;
        break;
      }
      case "scroll": {
        const spec = typeof value === "number" ? { y: value } : { ...value };
        let x = 100, y = 100;
        if (spec.selector) {
          const info = await resolveTarget(cdp, { selector: spec.selector });
          x = Math.round(info.point.x);
          y = Math.round(info.point.y);
        }
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel", x, y, deltaX: Math.round(spec.x || 0), deltaY: Math.round(spec.y || 0),
        });
        entry.target = { x: Math.round(spec.x || 0), y: Math.round(spec.y || 0) };
        break;
      }
      default:
        throw new Error(`unknown step action "${action}" (supported: click, type, wait, shot, eval, viewport, waitFor, press, scroll)`);
    }
  } catch (e) {
    entry.ok = false;
    entry.error = e.message;
    entry.ms = Date.now() - started;
    throw Object.assign(e, { stepEntry: entry });
  }
  entry.ms = Date.now() - started;
  return entry;
}

async function applyViewport(cdp, { width, height, mobile, deviceScaleFactor }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: deviceScaleFactor || 1,
    mobile: !!mobile,
    screenWidth: width,
    screenHeight: height,
    screenOrientation: mobile
      ? { type: "portraitPrimary", angle: 0 }
      : { type: "landscapePrimary", angle: 90 },
  });
  await cdp.send("Emulation.setVisibleSize", { width, height }).catch(() => {});
}

/* --------------------------------------------------------------- driver --- */

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  if (argv.help || argv.h) {
    process.stdout.write(HELP);
    return 0;
  }
  const url = argv.url;
  const opts = {
    out: argv.out || null,
    width: num(argv.width, 1600, "--width"),
    height: num(argv.height, 1000, "--height"),
    waitMs: num(argv["wait-ms"], 1500, "--wait-ms"),
    fullPage: !!argv["full-page"],
    deviceScaleFactor: num(argv["device-scale-factor"], 1, "--device-scale-factor"),
    timeout: num(argv.timeout, 30000, "--timeout"),
    netIdleMs: num(argv["net-idle-ms"], 600, "--net-idle-ms"),
    netIdleTimeout: num(argv["net-idle-timeout"], 15000, "--net-idle-timeout"),
    chrome: argv.chrome || DEFAULT_CHROME,
    connect: argv.connect || null,
    keepTemp: !!argv["keep-temp"] || !!argv["keep-open"],
    keepOpen: !!argv["keep-open"],
    summary: argv.summary || null,
    quiet: !!argv.quiet,
  };
  const mobileFlag = argv.mobile ? true : argv["no-mobile"] ? false : null;
  const log = makeLogger(opts.quiet);

  let stepsRaw = argv.steps ?? null;
  if (argv["steps-file"]) {
    stepsRaw = argv["steps-file"] === "-" ? await readStdin() : await readFile(argv["steps-file"], "utf8");
  }
  let steps = [];
  if (stepsRaw != null) {
    try {
      steps = typeof stepsRaw === "string" ? JSON.parse(stepsRaw) : stepsRaw;
    } catch (e) {
      throw new UsageError(`--steps must be valid JSON: ${e.message}\nReceived: ${clip(stepsRaw, 300)}`);
    }
    if (!Array.isArray(steps)) throw new UsageError("--steps must be a JSON array");
    for (const [i, s] of steps.entries()) {
      if (!s || typeof s !== "object" || Array.isArray(s)) throw new UsageError(`step ${i} must be an object`);
    }
  }
  if (!url && !opts.connect) throw new UsageError("--url is required (or --connect to an existing DevTools endpoint)");
  if (!opts.out && !steps.some((s) => s && s.shot)) {
    throw new UsageError("nothing to capture: pass --out <png> or at least one {\"shot\": ...} step");
  }

  const started = Date.now();
  const mobile = mobileFlag ?? opts.width <= 700;
  const ctx = {
    log,
    screenshots: [],
    evals: [],
    fullPage: opts.fullPage,
    mobile,
    deviceScaleFactor: opts.deviceScaleFactor,
    viewport: { width: opts.width, height: opts.height },
  };

  let handle = null;
  let cdp = null;
  const pageErrors = [];
  const consoleMsgs = [];
  const stepEntries = [];
  /** Main-frame navigations observed after the steps began — e.g. a Vite HMR full reload. */
  const pageNavigations = [];
  let watchNavigations = false;
  const summary = {
    ok: false,
    tool: `ui-capture.mjs v${VERSION}`,
    url,
    title: null,
    viewport: ctx.viewport,
    mobile,
    steps: stepEntries,
    screenshots: ctx.screenshots,
    evals: ctx.evals,
    console: consoleMsgs,
    pageErrors,
    pageNavigations,
    chrome: {},
    durationMs: 0,
  };
  let exitCode = 0;
  let failure = null;

  try {
    if (opts.connect) {
      handle = await connectExisting(opts.connect, log);
    } else {
      if (!existsSync(opts.chrome)) {
        throw new Error(`Chrome binary not found at ${opts.chrome} (use --chrome <path> or $UI_CAPTURE_CHROME)`);
      }
      handle = await launchChrome(opts, log);
      activeHandle = handle;
      activeOpts = opts;
      handle.target = await pickPageTarget(handle.port, log);
    }
    summary.chrome = {
      pid: handle.child?.pid ?? null,
      port: handle.port,
      userDataDir: handle.profile,
      reused: !handle.child,
      binary: handle.child ? opts.chrome : null,
    };

    cdp = await CDP.connect(handle.target.webSocketDebuggerUrl, { timeout: opts.timeout, log });
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Network.enable"),
      cdp.send("Log.enable").catch(() => {}),
    ]);

    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (consoleMsgs.length > 60) return;
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      consoleMsgs.push({ type: p.type, text: clip(text, 300) });
    });
    cdp.on("Runtime.exceptionThrown", (p) => {
      if (pageErrors.length > 20) return;
      pageErrors.push(clip(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "error", 300));
    });
    cdp.on("Log.entryAdded", (p) => {
      if (p.entry?.level === "error" && consoleMsgs.length <= 60) consoleMsgs.push({ type: "log-error", text: clip(p.entry.text, 300) });
    });

    let inflight = 0;
    let lastActivity = Date.now();
    let loaded = false;
    cdp.on("Network.requestWillBeSent", () => { inflight++; lastActivity = Date.now(); });
    cdp.on("Network.loadingFinished", () => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); });
    cdp.on("Network.loadingFailed", () => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); });
    cdp.on("Page.loadEventFired", () => { loaded = true; });
    cdp.on("Page.frameNavigated", (p) => {
      if (!watchNavigations || p.frame?.parentId) return; // main frame only, after steps started
      pageNavigations.push({ url: p.frame?.url ?? "", atMs: Date.now() - started });
      log(`WARNING: main frame navigated during the run (${p.frame?.url}) — a Vite HMR reload resets the app`);
    });

    await applyViewport(cdp, { width: opts.width, height: opts.height, mobile, deviceScaleFactor: opts.deviceScaleFactor });
    log(`navigating to ${url} (viewport ${opts.width}x${opts.height}${mobile ? ", mobile" : ""})`);
    await cdp.send("Page.navigate", { url });

    const readyDeadline = Date.now() + opts.netIdleTimeout;
    while (Date.now() < readyDeadline) {
      const state = await evaluate(cdp, "document.readyState").catch(() => null);
      if (state === "complete" && loaded) break;
      await sleep(120);
    }
    log(`document.readyState=${await evaluate(cdp, "document.readyState").catch(() => "?")}`);

    const idleDeadline = Date.now() + opts.netIdleTimeout;
    while (Date.now() < idleDeadline) {
      if (inflight <= 0 && Date.now() - lastActivity >= opts.netIdleMs) break;
      await sleep(100);
    }
    log(`network idle (inflight=${inflight})`);
    if (opts.waitMs > 0) await sleep(opts.waitMs);

    summary.title = await evaluate(cdp, "document.title").catch(() => null);

    for (const [i, step] of steps.entries()) {
      if (i === 0) watchNavigations = true;
      log(`step ${i}: ${JSON.stringify(step).slice(0, 160)}`);
      const entry = await runStep(cdp, step, i, ctx);
      stepEntries.push(entry);
      log(`step ${i}: ${entry.action} ok (${entry.ms}ms)`);
    }

    if (opts.out) {
      const shot = await screenshot(cdp, opts.out, { fullPage: opts.fullPage });
      ctx.screenshots.push({ ...shot, step: null });
      log(`wrote ${shot.path} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
    }

    summary.title = await evaluate(cdp, "document.title").catch(() => summary.title);
    summary.ok = true;
    log(`done in ${Date.now() - started}ms`);
  } catch (e) {
    failure = e;
    exitCode = e instanceof UsageError ? 2 : 1;
    if (e.stepEntry) stepEntries.push(e.stepEntry);
    const reloadHint = pageNavigations.length
      ? ` — the page navigated ${pageNavigations.length}x during the run ` +
        `(most recently ${pageNavigations[pageNavigations.length - 1].url} at ` +
        `${pageNavigations[pageNavigations.length - 1].atMs}ms), most likely a Vite HMR full reload ` +
        `that reset the app; re-run once the source stops changing`
      : "";
    summary.ok = false;
    summary.error = {
      message: `${e.message}${reloadHint}`,
      step: e.stepEntry ? e.stepEntry.index : null,
      action: e.stepEntry?.action ?? null,
      pageNavigations: pageNavigations.length,
    };
    process.stderr.write(`[ui-capture] FAILED: ${e.message}${reloadHint}\n`);
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { await shutdownChrome(handle, opts, log); } catch (e) { log(`warn: cleanup: ${e.message}`); }
    summary.durationMs = Date.now() - started;
    summary.screenshots = ctx.screenshots;
    summary.evals = ctx.evals;
    summary.viewport = ctx.viewport;
    const text = JSON.stringify(summary, null, 2);
    process.stdout.write(`${text}\n`);
    if (opts.summary) {
      try {
        await mkdir(path.dirname(path.resolve(opts.summary)), { recursive: true });
        await writeFile(path.resolve(opts.summary), `${text}\n`);
      } catch (e) {
        process.stderr.write(`[ui-capture] warn: could not write --summary ${opts.summary}: ${e.message}\n`);
      }
    }
    void failure;
  }
  return exitCode;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    const usage = e instanceof UsageError;
    if (usage) {
      process.stderr.write(`[ui-capture] usage error: ${e.message}\nRun "node scripts/ui-capture.mjs --help" for the accepted options.\n`);
    } else {
      process.stderr.write(`[ui-capture] FATAL: ${e?.stack || e}\n`);
    }
    // Keep the "stdout is one JSON object" contract even when the run never started,
    // so `... | jq` / json.load() always has something to parse.
    process.stdout.write(`${JSON.stringify({
      ok: false,
      tool: `ui-capture.mjs v${VERSION}`,
      steps: [],
      screenshots: [],
      evals: [],
      error: { kind: usage ? "usage" : "fatal", message: e?.message ?? String(e) },
    }, null, 2)}\n`);
    process.exitCode = usage ? 2 : 1;
  });
