/** Local NAS addresses can load originals by default without a remote-link assumption. */
export function localPhotoConnection(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host === "::1" || /^(fc|fd)[\da-f]{2}:|^fe[89ab][\da-f]:/.test(host)) return true;
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  } catch {
    return false;
  }
}
