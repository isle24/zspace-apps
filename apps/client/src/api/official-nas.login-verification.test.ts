import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSEncrypt } from "jsencrypt";
import { OfficialNas, OfficialNasError } from "./official-nas";

const nasKeys = [0, 1].map(() => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }));
const cloudKeys = [0, 1].map(() => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }));
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const base = "http://nas.test:5055", username = "synthetic-user", password = "synthetic-password";
function decrypt(value: string | null, key: string) { const rsa = new JSEncrypt(); rsa.setPrivateKey(key); return rsa.decrypt(value || ""); }
function fixture(overrides: { cloud?: (url: URL, form: URLSearchParams) => Response | Promise<Response>; nasCode?: string; sign?: string; native?: boolean } = {}) {
  let nasKey = -1, cloudKey = -1;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), form = init.method === "POST" ? new URLSearchParams(String(init.body)) : url.searchParams;
    expect(init.redirect).toBe("error");
    if (url.origin === "https://api.zenithspace.net") {
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
      const headers = new Headers(init.headers);
      expect([...headers.keys()].every(key => key === "content-type")).toBe(true);
      expect(String(init.body)).not.toContain(password);
      expect([...form.keys()].some(key => /token|password|cookie|device_id/.test(key))).toBe(false);
      if (url.pathname === "/key/pub") {
        expect(init.method).toBe("GET"); expect(form.get("signme")).toBe("1"); expect(form.get("webagent")).toBe("v2"); expect(form.get("rnd")).toBeTruthy();
        cloudKey++;
        return json({ success: true, data: { key: cloudKeys[cloudKey % 2].publicKey, key_id: `cloud-${cloudKey}` } });
      }
      expect(form.get("key_id")).toBe(`cloud-${cloudKey}`);
      expect(form.get("nasid")).toBe(overrides.sign === "" ? "nas-id" : "verification-sign");
      expect(decrypt(form.get("username"), cloudKeys[cloudKey % 2].privateKey)).toBe(username);
      expect(form.get("username")).not.toBe(username);
      if (overrides.cloud) return overrides.cloud(url, form);
      if (url.pathname === "/sms/usend") { expect(form.get("type")).toBe("new_device"); return json({ success: true, data: {} }); }
      expect(url.pathname).toBe("/sms/ucheck"); expect(form.get("sms_code")).toBe("123456");
      return json({ success: true, data: { sms_proof: "synthetic-proof" } });
    }
    expect(url.origin).toBe(base);
    if (url.pathname === "/key/pub") { nasKey++; return json({ success: true, data: { key: nasKeys[nasKey % 2].publicKey, sign: overrides.sign ?? "verification-sign", nasid: "nas-id" } }); }
    expect(url.pathname).toBe("/auth/login");
    expect(decrypt(form.get("username"), nasKeys[nasKey % 2].privateKey)).toBe(username);
    expect(decrypt(form.get("password"), nasKeys[nasKey % 2].privateKey)).toBe(password);
    if (!form.has("sms_proof")) return json({ success: false, code: overrides.nasCode || "N001414", message: password });
    expect(form.get("sms_proof")).toBe("synthetic-proof");
    expect(nasKey).toBe(1);
    return json({ success: true, data: { token: "synthetic-token", username, nasid: "nas-id" } });
  });
  const nas = new OfficialNas(fetcher as typeof fetch, { transport: overrides.native ? "native" : "browser" });
  return { nas, fetcher };
}
async function challenge(nas: OfficialNas) {
  const error = await nas.login(base, username, password).catch(e => e);
  expect(error).toBeInstanceOf(OfficialNasError);
  expect(error).toMatchObject({ code: "CHALLENGE_REQUIRED", verification: { id: expect.any(String), expiresAt: expect.any(Number) } });
  expect(JSON.stringify(error)).not.toContain(username);
  expect(JSON.stringify(error)).not.toContain(password);
  return error.verification.id as string;
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });
describe("official NAS new-device SMS verification", () => {
  it.each([false, true])("requires explicit SMS send, uses separate fresh keys, and only sends proof back to the NAS (native=%s)", async (native) => {
    const { nas, fetcher } = fixture({ native });
    const id = await challenge(nas);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(nas.sendLoginVerificationCode(id, base, username)).resolves.toMatchObject({ retryAt: expect.any(Number) });
    await expect(nas.completeLoginVerification(id, { baseUrl: base, username, password, code: "123456" })).resolves.toMatchObject({ baseUrl: base, user: { username } });
    expect(fetcher).toHaveBeenCalledTimes(8);
    await expect(nas.sendLoginVerificationCode(id, base, username)).rejects.toMatchObject({ code: "VERIFICATION_EXPIRED" });
    nas.logout();
  });
  it("uses NAS id when the public key has no sign", async () => {
    const { nas } = fixture({ sign: "" }); const id = await challenge(nas);
    await nas.sendLoginVerificationCode(id, base, username); nas.cancelLoginVerification();
  });
  it("rejects duplicate sends and checks before send or with invalid code", async () => {
    const { nas, fetcher } = fixture(); const id = await challenge(nas);
    await expect(nas.completeLoginVerification(id, { baseUrl: base, username, password, code: "123456" })).rejects.toMatchObject({ code: "VERIFICATION_NOT_SENT" });
    await nas.sendLoginVerificationCode(id, base, username);
    const count = fetcher.mock.calls.length;
    await expect(nas.sendLoginVerificationCode(id, base, username)).rejects.toMatchObject({ code: "VERIFICATION_SEND_COOLDOWN" });
    for (const code of ["", "123", "12345", "abc123"]) await expect(nas.completeLoginVerification(id, { baseUrl: base, username, password, code })).rejects.toMatchObject({ code: "VERIFICATION_CODE_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(count); nas.cancelLoginVerification();
  });
  it.each(["account", "address", "cancel", "logout", "new-login", "expired"])("rejects verification after %s changes", async (change) => {
    const { nas, fetcher } = fixture(); const id = await challenge(nas); let target = base, user = username;
    if (change === "account") user = "other-user";
    if (change === "address") target = "http://other.test";
    if (change === "cancel") nas.cancelLoginVerification();
    if (change === "logout") nas.logout();
    if (change === "new-login") await challenge(nas);
    if (change === "expired") { vi.useFakeTimers(); vi.advanceTimersByTime(5 * 60_000 + 1); }
    const count = fetcher.mock.calls.length;
    await expect(nas.sendLoginVerificationCode(id, target, user)).rejects.toMatchObject({ code: "VERIFICATION_EXPIRED" });
    expect(fetcher).toHaveBeenCalledTimes(count); nas.cancelLoginVerification();
  });
  it("does not let a cancelled cloud reply send SMS or retry login", async () => {
    let resolve!: (response: Response) => void;
    const { nas, fetcher } = fixture({ cloud: () => new Promise<Response>(done => { resolve = done; }) });
    const id = await challenge(nas), pending = nas.sendLoginVerificationCode(id, base, username).catch(e => e);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    nas.cancelLoginVerification(); resolve(json({ success: true, data: {} }));
    expect(await pending).toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(fetcher).toHaveBeenCalledTimes(4); expect(nas.session()).toBeNull();
  });
  it("sanitizes cloud failures and permits an explicit retry", async () => {
    const { nas } = fixture({ cloud: () => json({ success: false, code: "N005001", message: `${password} synthetic-proof` }) });
    const id = await challenge(nas);
    await expect(nas.sendLoginVerificationCode(id, base, username)).rejects.toMatchObject({ code: "VERIFICATION_FAILED", message: expect.stringContaining("N005001") });
    await expect(nas.sendLoginVerificationCode(id, base, username)).rejects.toMatchObject({ code: "VERIFICATION_FAILED", message: expect.not.stringContaining(password) });
    nas.cancelLoginVerification();
  });
  it.each(["N001205", "N001206"])("preserves %s without inventing a verification meaning", async (code) => {
    const { nas, fetcher } = fixture({ nasCode: code });
    await expect(nas.login(base, username, password)).rejects.toMatchObject({ code: "NAS_BUSINESS_ERROR", message: expect.stringContaining(code) });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

it("an old handle cannot cancel a newer login verification", async () => {
  const { nas } = fixture(); const old = await challenge(nas), current = await challenge(nas);
  await expect(nas.sendLoginVerificationCode(old, base, username)).rejects.toMatchObject({ code: "VERIFICATION_EXPIRED" });
  await expect(nas.sendLoginVerificationCode(current, base, username)).resolves.toHaveProperty("retryAt");
  nas.cancelLoginVerification();
});
it("accepts email_proof as the documented fallback when sms_proof is empty", async () => {
  const { nas } = fixture({ cloud: url => json({ success: true, data: url.pathname === "/sms/ucheck" ? { sms_proof: "", email_proof: "synthetic-proof" } : {} }) });
  const id = await challenge(nas); await nas.sendLoginVerificationCode(id, base, username);
  await expect(nas.completeLoginVerification(id, { baseUrl: base, username, password, code: "123456" })).resolves.toHaveProperty("sessionId");
  nas.logout();
});
it("times out a cloud service that ignores abort", async () => {
  const { nas, fetcher } = fixture({ cloud: () => new Promise<Response>(() => {}) });
  const id = await challenge(nas);
  vi.useFakeTimers(); const pending = nas.sendLoginVerificationCode(id, base, username).catch(e => e);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  await vi.advanceTimersByTimeAsync(15_001);
  expect(await pending).toMatchObject({ code: "VERIFICATION_TIMEOUT" });
  nas.cancelLoginVerification();
});
it.each(["oversized", "redirect", "missing-proof"])("rejects unsafe cloud %s responses before retrying NAS login", async mode => {
  const { nas, fetcher } = fixture({ cloud: url => {
    if (url.pathname === "/sms/usend") return json({ success: true, data: {} });
    if (mode === "oversized") return json({ success: true, data: { sms_proof: "x".repeat(70_000) } });
    if (mode === "redirect") { const response = json({ success: true, data: { sms_proof: "synthetic-proof" } }); Object.defineProperty(response, "redirected", { value: true }); return response; }
    return json({ success: true, data: {} });
  } });
  const id = await challenge(nas); await nas.sendLoginVerificationCode(id, base, username);
  await expect(nas.completeLoginVerification(id, { baseUrl: base, username, password, code: "123456" })).rejects.toBeInstanceOf(OfficialNasError);
  expect(fetcher).toHaveBeenCalledTimes(6); expect(nas.session()).toBeNull(); nas.cancelLoginVerification();
});

it.each(["cancel", "expire"])("does not accept NAS login retry after verification %s", async mode => {
  const { nas, fetcher } = fixture(); const original = fetcher.getMockImplementation()!;
  let resolve!: (response: Response) => void;
  fetcher.mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === base && url.pathname === "/auth/login" && new URLSearchParams(String(init.body)).has("sms_proof")) {
      const response = await original(input, init);
      return new Promise<Response>(done => { resolve = () => done(response); });
    }
    return original(input, init);
  });
  if (mode === "expire") vi.useFakeTimers();
  const id = await challenge(nas); await nas.sendLoginVerificationCode(id, base, username);
  const pending = nas.completeLoginVerification(id, { baseUrl: base, username, password, code: "123456" }).catch(e => e);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  if (mode === "expire") await vi.advanceTimersByTimeAsync(300_001); else nas.cancelLoginVerification();
  resolve(json({}));
  expect(await pending).toMatchObject({ code: "REQUEST_CANCELLED" }); expect(nas.session()).toBeNull();
  nas.cancelLoginVerification();
});
it("does not send SMS after a late cloud-key reply and prevents overlapping requests", async () => {
  const { nas, fetcher } = fixture(), original = fetcher.getMockImplementation()!;
  let resolve!: (response: Response) => void;
  fetcher.mockImplementation(async (input, init = {}) => {
    if (String(input).startsWith("https://api.zenithspace.net/key/pub")) return new Promise<Response>(done => { resolve = done; });
    return original(input, init);
  });
  const id = await challenge(nas), pending = nas.sendLoginVerificationCode(id, base, username).catch(e => e);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  await expect(nas.sendLoginVerificationCode(id, base, username)).rejects.toMatchObject({ code: "VERIFICATION_BUSY" });
  nas.cancelLoginVerification(); resolve(json({ success: true, data: { key: cloudKeys[0].publicKey, key_id: "late-key" } }));
  expect(await pending).toMatchObject({ code: "REQUEST_CANCELLED" }); expect(fetcher).toHaveBeenCalledTimes(3);
});


it.each([null, "sent", 1, false, []].map(data => [data]))("accepts a successful SMS send acknowledgement with data=%j", async data => {
  const { nas } = fixture({ cloud: url => json({ success: true, data: url.pathname === "/sms/usend" ? data : { sms_proof: "synthetic-proof" } }) });
  const id = await challenge(nas);
  await expect(nas.sendLoginVerificationCode(id, base, username)).resolves.toHaveProperty("retryAt");
  await expect(nas.completeLoginVerification(id, { baseUrl: base, username, password, code: "123456" })).resolves.toHaveProperty("sessionId");
  nas.logout();
});
it.each([null, "sent"])("still rejects a non-object verification proof response with data=%j", async data => {
  const { nas, fetcher } = fixture({ cloud: url => json({ success: true, data: url.pathname === "/sms/usend" ? {} : data }) });
  const id = await challenge(nas); await nas.sendLoginVerificationCode(id, base, username);
  await expect(nas.completeLoginVerification(id, { baseUrl: base, username, password, code: "123456" })).rejects.toBeInstanceOf(OfficialNasError);
  expect(fetcher).toHaveBeenCalledTimes(6); expect(nas.session()).toBeNull(); nas.cancelLoginVerification();
});
