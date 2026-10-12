/*
 * 部署冒烟：不登录也能验的线上检查
 *
 *   node scripts/deploy-smoke.mjs [站点地址]
 *
 * 值守用：确认**线上服务**没坏、且跑的是仓库里这份产物。
 * 不需要登录态 —— 这不依赖 NAS 会话。
 *
 * 检查：页面与指纹、入口资源（含 gzip）、runtime-config、健康检查、
 * Docker 只读接口、独立商店页。
 */
const base = (process.argv[2] || "http://192.168.3.56:18436").replace(/\/$/, "");
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(24)} ${detail}`);
  if (!ok) failed++;
};

const get = async (path, init) => {
  try { return await fetch(base + path, init); } catch (error) { return { error: String(error).slice(0, 60) }; }
};

// 1) 页面 + 入口指纹
const page = await get("/");
const html = page.error ? "" : await page.text();
const entry = /assets\/(client-[A-Za-z0-9._-]+\.js)/.exec(html)?.[1];
check("首页", page.status === 200, page.error ?? `HTTP ${page.status}`);
check("入口指纹", !!entry, entry ?? "HTML 里找不到 client-*.js");

// 2) 入口资源可下载，且文本资源是 gzip 传输
if (entry) {
  const asset = await get(`/assets/${entry}`, { headers: { "Accept-Encoding": "gzip" } });
  const encoding = asset.headers?.get?.("content-encoding");
  check("入口资源", asset.status === 200, `HTTP ${asset.status}，Content-Encoding: ${encoding ?? "无"}`);
  check("压缩传输", encoding === "gzip", encoding === "gzip" ? "gzip" : "没有 gzip（预压缩没生效？）");
}

// 3) 同源部署配置
const config = await get("/runtime-config.json");
if (config.error) check("runtime-config", false, config.error);
else {
  const body = await config.json().catch(() => null);
  check("runtime-config", config.status === 200 && body && typeof body === "object", JSON.stringify(body)?.slice(0, 60) ?? "无法解析");
}

// 4) 反代健康检查
const health = await get("/healthz");
check("反代健康", health.status === 200 && (await health.text()).trim() === "ok", health.error ?? `HTTP ${health.status}`);

// 5) Docker 只读接口（走本机引擎，不依赖 NAS 会话）
const containers = await get("/api/docker/containers");
if (containers.status === 200) {
  const body = await containers.json().catch(() => null);
  // 实测结构是 { containers: [...] }（不是 items）；两种都认，但要在报告里写清楚
  const list = body?.containers ?? body?.items ?? (Array.isArray(body) ? body : null);
  check("Docker 只读接口", Array.isArray(list) && list.length > 0, Array.isArray(list) ? `${list.length} 个容器` : `返回结构不认识：${JSON.stringify(body)?.slice(0, 60)}`);
} else {
  check("Docker 只读接口", false, containers.error ?? `HTTP ${containers.status}`);
}

// 6) 独立商店页（Codex 的组件；未启用也应能打开）
const shop = await get("/shop.html");
check("独立商店页", shop.status === 200, shop.error ?? `HTTP ${shop.status}`);

/*
 * 7) 商店网关
 *
 * "未启用"是正常状态，不算失败 ✓。但**启用之后配置不对**必须报出来 ——
 * 契约（docs/deployment/store-integration-contract.md）要求：
 *   - nasAuth.enabled 为 true 时，origin 必须等于客户端登录用的 NAS 地址；
 *   - storeId 必须是 48 位小写十六进制。
 * 满足不了客户端会直接拒绝绑定，而那时看起来像"客户端 bug"。
 * 所以这里把"引擎已启用但配置不合格"当成**失败**，而不是等用户撞上。
 */
const status = await get("/api/store/status");
if (status.status === 200) {
  const body = await status.json().catch(() => null);
  const data = body?.data ?? {};
  const engine = data.engineMode ?? "?";
  const enabled = data.nasAuth?.enabled === true;
  const origin = String(data.nasAuth?.origin ?? "");
  const storeId = String(data.nasAuth?.storeId ?? "");
  check("商店网关", body?.ok === true, `引擎=${engine}，NAS 管理员登录=${enabled ? "已启用" : "未启用"}`);
  if (enabled) {
    check("商店 origin 合规", /^https?:\/\/[^/]+$/.test(origin), origin ? origin : "为空 —— 客户端会按契约拒绝绑定");
    check("商店 storeId 合规", /^[a-f0-9]{48}$/.test(storeId), storeId ? `${storeId.length} 字符` : "为空");
  } else {
    console.log(`  （引擎未启用，暂不校验 origin/storeId；启用后这里会强制检查）`);
  }
} else {
  check("商店网关", status.status === 404 || status.status === 503, status.error ?? `HTTP ${status.status}`);
}

console.log(failed ? `\n${failed} 项未通过` : "\n线上冒烟通过");
process.exit(failed ? 1 : 0);
