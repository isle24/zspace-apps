export const STORE_ADDRESS_KEY = "space-store-address";
export function normalizeStoreAddress(value: string): string {
  const clean = value.trim();
  if (!clean) return "";
  let url: URL;
  try {
    url = new URL(clean);
  } catch {
    throw new Error("请输入完整的 http:// 或 https:// 商店服务地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "商店地址只能使用 HTTP(S)，不能包含账号、密码、查询参数或片段",
    );
  return url.href.replace(/\/+$/, "");
}
export function loadStoreAddress(): string {
  try {
    return normalizeStoreAddress(localStorage.getItem(STORE_ADDRESS_KEY) || "");
  } catch {
    return "";
  }
}
export function persistStoreAddress(value: string) {
  try {
    if (value) localStorage.setItem(STORE_ADDRESS_KEY, value);
    else localStorage.removeItem(STORE_ADDRESS_KEY);
  } catch {
    /* Address remains active in memory when browser storage is unavailable. */
  }
}
