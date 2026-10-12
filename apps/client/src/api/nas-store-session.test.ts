import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Gateway } from './client';
import { officialFixture, officialJson } from './direct-test-fixture';
const native = vi.hoisted(() => ({ fetch: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
const provider = 'http://synthetic.invalid:5055';
const shop = 'https://shop.invalid';
const storeId = 'a'.repeat(48), sid = 'b'.repeat(48);
const metadata = { enabled: true, origin: provider, storeId };
const grant = () => officialJson({ ok: true, data: { sessionId: sid, username: 'fixture', expiresAt: new Date(Date.now() + 120000).toISOString(), authSource: 'nas' } });
const status = (nasAuth: unknown = metadata) => officialJson({ ok: true, data: { configured: true, nasAuth } });
function setup(exchange: (init: RequestInit) => Response | Promise<Response> = grant, nasAuth: unknown = metadata) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = officialFixture(async (url, init) => {
    calls.push({ url: url.href, init });
    if (url.pathname.endsWith('/api/store/bootstrap')) return status(nasAuth);
    if (url.pathname.endsWith('/api/store/nas-session')) return exchange(init);
    if (url.pathname.endsWith('/api/store/logout')) return officialJson({ ok: true, data: {} });
    return officialJson({ code: 200, data: {} });
  });
  const client = new Gateway(fetcher);
  client.storeAddress = shop;
  return { client, calls };
}
async function pair(client: Gateway) {
  await client.login(provider, 'fixture', 'synthetic-only');
  const binding = await client.getStoreNasBinding();
  client.trustStoreNasBinding(binding);
  return binding;
}
beforeEach(() => localStorage.clear());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('hands the accepted NAS grant and its expiry to the embedded storefront', async () => {
  const { client } = setup();
  await pair(client);
  const accepted = await client.connectStoreWithNas();
  await expect(client.grantForStoreFrame()).resolves.toEqual({
    sessionId: accepted.sessionId, expiresAt: accepted.expiresAt, storeAddress: shop,
  });
  client.logoutNas();
  await expect(client.grantForStoreFrame()).rejects.toThrow();
});
it('requires explicit exact trust before sending the private NAS credential', async () => {
  const { client, calls } = setup();
  await client.login(provider, 'fixture', 'synthetic-only');
  const binding = await client.getStoreNasBinding();
  expect(binding).toEqual({ providerId: provider, storeBase: shop, storeId });
  await expect(client.connectStoreWithNas()).rejects.toMatchObject({ code: 'STORE_TRUST_REQUIRED' });
  expect(calls.some(c => c.url.endsWith('/nas-session'))).toBe(false);
  client.trustStoreNasBinding(binding);
  const result = await client.connectStoreWithNas();
  expect(result).toEqual({ sessionId: sid, username: 'fixture', expiresAt: expect.any(String), authSource: 'nas' });
  const exchange = calls.find(c => c.url.endsWith('/nas-session'))!;
  expect(exchange.url).toBe(shop + '/api/store/nas-session');
  expect(exchange.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
  expect(new Headers(exchange.init.headers).get('Cookie')).toBeNull();
  expect(JSON.parse(String(exchange.init.body))).toEqual({ providerId: provider, storeId, token: 'synthetic-official-token', deviceId: expect.stringMatching(/^[a-f0-9]{32}$/), nasId: 'synthetic' });
  expect(JSON.stringify(result)).not.toContain('synthetic-official-token');
  expect(localStorage.getItem('space-store-nas-trust')).toBe(JSON.stringify(binding));
  expect(client.storeAuthSource).toBe('nas');
  client.logoutNas();
  expect(client.storeSession).toBe('');
});
it.each([{ enabled: false }, { ...metadata, origin: 'https://other.invalid' }, { ...metadata, storeId: '../bad' }])('rejects disabled or mismatching public binding before sending credentials: %j', async nasAuth => {
  const { client, calls } = setup(grant, nasAuth);
  await client.login(provider, 'fixture', 'synthetic-only');
  await expect(client.getStoreNasBinding()).rejects.toBeInstanceOf(Error);
  expect(calls.some(c => c.url.endsWith('/nas-session'))).toBe(false);
});
it('does not silently trust a new shop instance', async () => {
  const first = setup(); await pair(first.client);
  const changed = setup(grant, { ...metadata, storeId: 'c'.repeat(48) });
  await changed.client.login(provider, 'fixture', 'synthetic-only');
  await expect(changed.client.connectStoreWithNas()).rejects.toMatchObject({ code: 'STORE_TRUST_REQUIRED' });
  expect(changed.calls.some(c => c.url.endsWith('/nas-session'))).toBe(false);
});
it.each(['logout', 'login-start', 'cancel', 'password'])('revokes an abandoned successful grant after %s without overwriting new authorization', async action => {
  let resolve!: (value: Response) => void; let started!: () => void;
  const dispatched = new Promise<void>(r => { started = r; });
  const { client, calls } = setup(() => { started(); return new Promise(r => { resolve = r; }); });
  await pair(client);
  const pending = client.connectStoreWithNas();
  await dispatched;
  if (action === 'logout') client.logoutNas();
  if (action === 'login-start') void client.login(provider, 'fixture', 'synthetic-only');
  if (action === 'cancel') client.cancelStoreNasConnection();
  if (action === 'password') client.storeSession = 'independent-session';
  resolve(grant());
  await expect(pending).rejects.toMatchObject({ code: 'STORE_SESSION_CHANGED' });
  expect(client.storeSession).toBe(action === 'password' ? 'independent-session' : '');
  expect(calls.find(c => c.url.endsWith('/logout'))).toMatchObject({ url: shop + '/api/store/logout', init: { headers: { 'Content-Type': 'application/json', 'X-Store-Session': sid } } });
});
it('switching address invalidates immediately and reclaims late grants at the original address', async () => {
  let resolve!: (value: Response) => void; let started!: () => void;
  const dispatched = new Promise<void>(r => { started = r; });
  const { client, calls } = setup(() => { started(); return new Promise(r => { resolve = r; }); });
  await pair(client); const pending = client.connectStoreWithNas(); await dispatched;
  await client.setStoreAddress('https://new-shop.invalid'); resolve(grant());
  await expect(pending).rejects.toBeInstanceOf(Error);
  expect(client.storeSession).toBe('');
  expect(calls.filter(c => c.url.endsWith('/logout')).map(c => c.url)).toEqual([shop + '/api/store/logout']);
});
it('NAS logout and replacement preserve an independently logged-in password store session', async () => {
  const { client } = setup(); await client.login(provider, 'fixture', 'synthetic-only');
  client.storeSession = 'independent-session'; client.logoutNas();
  expect(client.storeSession).toBe('independent-session');
  await client.login(provider, 'fixture', 'synthetic-only');
  expect(client.storeSession).toBe('independent-session');
});
it.each([
  () => officialJson({ ok: false, error: { code: 'NAS_ADMIN_REQUIRED', message: 'synthetic-official-token' } }, 403),
  () => officialJson({ ok: true, data: { sessionId: sid, username: 'synthetic-official-token', expiresAt: new Date(Date.now()+120000).toISOString(), authSource: 'nas' } }),
  () => new Response('x'.repeat(65537)),
  () => officialJson({ ok: true, data: { sessionId: sid, username: 'fixture', expiresAt: 'never', authSource: 'nas' } }),
])('rejects unsafe responses with a fixed privacy-safe error', async exchange => {
  const { client } = setup(exchange); await pair(client);
  const error = await client.connectStoreWithNas().catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain('synthetic-official-token');
  expect(client.storeSession).toBe('');
});
it('clears expiring NAS authorization while retaining its trusted binding for a fresh exchange', async () => {
  vi.useFakeTimers(); const { client } = setup(); await pair(client); await client.connectStoreWithNas();
  await vi.advanceTimersByTimeAsync(120001);
  expect(client.storeSession).toBe('');
  await client.connectStoreWithNas(); expect(client.storeSession).toBe(sid);
  client.logoutNas();
});
it('cannot send credentials from an older session after a newer login has started', async () => {
  const { client, calls } = setup(); await pair(client);
  const replacement = client.login(provider, 'fixture', 'synthetic-only');
  await expect(client.connectStoreWithNas()).rejects.toMatchObject({ code: 'STORE_SESSION_CHANGED' });
  await replacement;
  expect(calls.some(c => c.url.endsWith('/nas-session'))).toBe(false);
});
it('requires fresh trust for a base URL with a different configured proxy prefix', async () => {
  const { client, calls } = setup(); client.storeAddress = shop + '/prefix';
  await pair(client); await client.connectStoreWithNas();
  expect(calls.find(c => c.url.endsWith('/nas-session'))?.url).toBe(shop + '/prefix/api/store/nas-session');
  client.logoutNas();
});
it('rejects a response decoded after its resolved base changed and revokes at its exact old base', async () => {
  let enqueue!: (data: string) => void, started!: () => void;
  const reading = new Promise<void>(r => { started = r; });
  const { client, calls } = setup(() => new Response(new ReadableStream({ start(controller) { enqueue = data => { controller.enqueue(new TextEncoder().encode(data)); controller.close(); }; started(); } })));
  await pair(client); const pending = client.connectStoreWithNas(); await reading;
  client.base = 'https://new.invalid'; enqueue(await grant().text());
  await expect(pending).rejects.toMatchObject({ code: 'STORE_SESSION_CHANGED' });
  expect(calls.some(c => c.url === shop + '/api/store/logout')).toBe(true);
});
it('does not echo base64 NAS credentials from store identity fields', async () => {
  const { client } = setup(() => officialJson({ ok: true, data: { sessionId: sid, username: btoa('synthetic-official-token'), expiresAt: new Date(Date.now()+120000).toISOString(), authSource: 'nas' } }));
  await pair(client);
  await expect(client.connectStoreWithNas()).rejects.toBeInstanceOf(Error);
  expect(client.storeSession).toBe('');
});
it('bounds even an injected transport that ignores the abort signal and reclaims its late SID', async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void, started!: () => void;
  const dispatched = new Promise<void>(r => { started = r; });
  const { client, calls } = setup(() => { started(); return new Promise(r => { finish = r; }); });
  await pair(client); const outcome = client.connectStoreWithNas().catch(e => e); await dispatched;
  await vi.advanceTimersByTimeAsync(5001);
  const error = await Promise.race([outcome, Promise.resolve('hung')]);
  expect(error).toBeInstanceOf(Error);
  finish(grant()); await vi.advanceTimersByTimeAsync(1);
  expect(client.storeSession).toBe(''); expect(calls.some(c => c.url.endsWith('/logout'))).toBe(true);
});
it('invalidates at address-change START while the old independent logout is pending', async () => {
  let finish!: (value: Response) => void, started!: () => void;
  const dispatched = new Promise<void>(r => { started = r; });
  const { client, calls } = setup(); await pair(client); client.storeSession = 'independent-session';
  const oldFetcher = (client as any).fetcher;
  (client as any).fetcher = (input: RequestInfo | URL, init: RequestInit) => String(input).endsWith('/logout') ? (started(), new Promise(r => { finish = r; })) : oldFetcher(input, init);
  const changing = client.setStoreAddress('https://new.invalid'); await dispatched;
  await expect(client.connectStoreWithNas()).rejects.toBeInstanceOf(Error);
  expect(calls.some(c => c.url.endsWith('/nas-session'))).toBe(false);
  finish(officialJson({ ok: true, data: {} })); await changing;
});
it('returns clear administrator verification feedback for the actual backend 401 denial', async () => {
  const { client } = setup(() => officialJson({ ok: false, error: { code: 'nas_auth_required', message: 'synthetic-official-token' } }, 401));
  await pair(client);
  await expect(client.connectStoreWithNas()).rejects.toMatchObject({ message: 'NAS 管理员身份校验失败，请确认账号权限或重新登录' });
});
it.each(['nas', 'store', 'signal'])('checks %s generation while the public status is pending before exchanging credentials', async action => {
  const { client, calls } = setup(); await pair(client);
  const read = vi.spyOn(client, 'store'); let finish!: (value: unknown) => void, started!: () => void;
  const pendingRead = new Promise<void>(r => { started = r; });
  read.mockImplementationOnce(() => { started(); return new Promise(r => { finish = r; }); });
  const controller = new AbortController(); const pending = client.connectStoreWithNas({ signal: controller.signal }).catch(e => e); await pendingRead;
  if (action === 'nas') client.logoutNas();
  if (action === 'store') client.storeSession = 'password';
  if (action === 'signal') controller.abort();
  finish({ nasAuth: metadata });
  expect(await pending).toBeInstanceOf(Error);
  expect(calls.some(c => c.url.endsWith('/nas-session'))).toBe(false);
  read.mockRestore();
});
it('cancellation while decoding a successful body reclaims the original grant', async () => {
  let enqueue!: (data: string) => void, started!: () => void;
  const reading = new Promise<void>(r => { started = r; });
  const { client, calls } = setup(() => new Response(new ReadableStream({ start(controller) { enqueue = data => { controller.enqueue(new TextEncoder().encode(data)); controller.close(); }; started(); } })));
  await pair(client); const pending = client.connectStoreWithNas(); await reading;
  client.cancelStoreNasConnection(); enqueue(await grant().text());
  await expect(pending).rejects.toBeInstanceOf(Error);
  expect(client.storeSession).toBe(''); expect(calls.some(c => c.url.endsWith('/logout'))).toBe(true);
});
it('rejects redirected responses and never accepts the foreign grant', async () => {
  const { client } = setup(() => { const response = grant(); Object.defineProperty(response, 'redirected', { value: true }); Object.defineProperty(response, 'url', { value: 'https://foreign.invalid/api/store/nas-session' }); return response; });
  await pair(client); await expect(client.connectStoreWithNas()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(client.storeSession).toBe('');
});
it('NAS permission expiry clears its derived authorization without keeping protected plans usable', async () => {
  const { client } = setup(); await pair(client); await client.connectStoreWithNas();
  vi.spyOn(client.nas, 'read').mockRejectedValueOnce({ code: 'SESSION_EXPIRED', status: 401 });
  await expect(client.read('files.roots')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  expect(client.nasSession).toBe(''); expect(client.storeSession).toBe('');
});

it('native exchange uses only exact shop URLs without a NAS Cookie and disables redirection', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  const calls: { url: string; init: RequestInit }[] = [];
  native.fetch.mockImplementation(officialFixture(async (url, init) => {
    calls.push({ url: url.href, init });
    if (url.pathname === '/api/store/nas-session') return grant();
    if (url.pathname === '/api/store/logout') return officialJson({ ok: true, data: {} });
    return officialJson({ code: 200, data: {} });
  }));
  vi.stubGlobal('fetch', vi.fn(async () => status()));
  const client = new Gateway(); client.storeAddress = shop;
  await pair(client); await client.connectStoreWithNas();
  const call = calls.find(c => c.url.endsWith('/nas-session'))!;
  expect(call.url).toBe(shop + '/api/store/nas-session');
  expect(call.init).toMatchObject({ credentials: 'omit', redirect: 'error', maxRedirections: 0 });
  expect(new Headers(call.init.headers).get('Cookie')).toBeNull();
  expect(new Headers(call.init.headers).get('X-NAS-Session')).toBeNull();
  client.logoutNas();
});
it('NAS logout revokes the accepted shop grant at its minting origin', async () => {
  const { client, calls } = setup(); await pair(client); await client.connectStoreWithNas();
  client.logoutNas();
  expect(calls.find(c => c.url.endsWith('/logout'))).toMatchObject({ url: shop + '/api/store/logout', init: { headers: { 'Content-Type': 'application/json', 'X-Store-Session': sid } } });
  expect(client.storeSession).toBe('');
});
it('re-reading a changed store instance clears the previous NAS grant and requires fresh trust', async () => {
  const { client } = setup(); await pair(client); await client.connectStoreWithNas();
  const original = client.store.bind(client);
  vi.spyOn(client, 'store').mockImplementation((path, body, publicRead) => path === 'bootstrap' ? Promise.resolve({ nasAuth: { ...metadata, storeId: 'c'.repeat(48) } }) as any : original(path, body, publicRead));
  const binding = await client.getStoreNasBinding();
  expect(client.storeSession).toBe(''); expect(client.isStoreNasTrusted(binding)).toBe(false);
});
it('rejects transport exceptions that impersonate GatewayError without reflecting private messages', async () => {
  const { client } = setup(() => { const error = new Error('synthetic-official-token'); error.name = 'GatewayError'; throw error; });
  await pair(client);
  const error = await client.connectStoreWithNas().catch(e => e);
  expect(String(error)).not.toContain('synthetic-official-token');
});
it('blocks new protected shop actions while an address change is waiting for old logout', async () => {
  let complete!: (value: Response) => void, started!: () => void;
  const called = new Promise<void>(r => { started = r; });
  const requests: string[] = [];
  const client = new Gateway(async (url) => { requests.push(String(url)); if (String(url).endsWith('/logout')) { started(); return new Promise(r => { complete = r; }); } return officialJson({ ok: true, data: {} }); });
  client.storeAddress = shop; client.storeSession = 'old-password';
  const switching = client.setStoreAddress('https://new.invalid'); await called;
  await expect(client.store('install', { planId: 'old-plan' })).rejects.toMatchObject({ code: 'STORE_SERVICE_CHANGED' });
  expect(requests.some(url => url.endsWith('/install'))).toBe(false);
  complete(officialJson({ ok: true, data: {} })); await switching;
});
it('disposes an exchange response rejected by its declared body limit', async () => {
  const cancelled = vi.fn();
  const { client } = setup(() => new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Length': '65537' } }));
  await pair(client); await expect(client.connectStoreWithNas()).rejects.toBeInstanceOf(Error);
  expect(cancelled).toHaveBeenCalled();
});
it.each([
  'synthetic-official-token',
  encodeURIComponent(Array.from('synthetic-official-token', character => '%' + character.charCodeAt(0).toString(16)).join('')),
  Array.from('synthetic-official-token', character => '%' + character.charCodeAt(0).toString(16)).join(''),
  btoa('synthetic-official-token'),
])('normalizes parseable expiry comments before publishing a store grant: %s', async comment => {
  const canonical = new Date(Date.now() + 120000).toUTCString();
  const expiresAt = canonical + ' (' + comment + ')';
  expect(Number.isFinite(Date.parse(expiresAt))).toBe(true);
  const { client, calls } = setup(() => officialJson({ ok: true, data: { sessionId: sid, username: 'fixture', expiresAt, authSource: 'nas' } }));
  await pair(client);
  const result = await client.connectStoreWithNas();
  expect(result.expiresAt).toBe(new Date(Date.parse(canonical)).toISOString());
  expect(JSON.stringify(result)).not.toContain(comment);
  expect(result).toEqual({ sessionId: sid, username: 'fixture', expiresAt: new Date(Date.parse(canonical)).toISOString(), authSource: 'nas' });
  expect(localStorage.getItem('space-store-nas-trust')).not.toContain(comment);
  client.logoutNas();
  expect(client.storeSession).toBe('');
  expect(calls.find(call => call.url.endsWith('/logout'))).toMatchObject({ url: shop + '/api/store/logout', init: { headers: { 'Content-Type': 'application/json', 'X-Store-Session': sid } } });
});

/**
 * 下面三条把 docs/deployment/store-integration-contract.md 里的硬约束钉住，
 * 免得文档写的和代码做的不一致。
 */
it('rejects an origin that is only nearly the NAS address (no normalisation)', async () => {
  // 尾斜杠 / http-https 互换 / localhost 与 127.0.0.1 都不算匹配
  for (const origin of [`${provider}/`, provider.replace('http://', 'https://'), provider.replace('synthetic.invalid', 'localhost')]) {
    const { client, calls } = setup(grant, { ...metadata, origin });
    await client.login(provider, 'fixture', 'synthetic-only');
    await expect(client.getStoreNasBinding()).rejects.toMatchObject({ code: 'STORE_PROVIDER_MISMATCH' });
    expect(calls.some(c => c.url.endsWith('/nas-session'))).toBe(false);
  }
});

it('rejects a grant whose sessionId is not 48 lowercase hex', async () => {
  for (const sessionId of ['b'.repeat(47), 'B'.repeat(48), 'z'.repeat(48), '']) {
    const { client } = setup(() => officialJson({ ok: true, data: { sessionId, username: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString(), authSource: 'nas' } }));
    await pair(client);
    // 实现里非法授权数据统一是 INVALID_RESPONSE(502)，不是文档最初写的 STORE_NAS_AUTH_FAILED
    await expect(client.connectStoreWithNas()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  }
});

it('rejects a grant that lives longer than the twenty-minute ceiling', async () => {
  const { client } = setup(() => officialJson({ ok: true, data: { sessionId: sid, username: 'fixture', expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(), authSource: 'nas' } }));
  await pair(client);
  await expect(client.connectStoreWithNas()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
