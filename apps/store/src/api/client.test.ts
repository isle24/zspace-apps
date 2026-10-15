import { afterEach, expect, it, vi } from 'vitest';
import { Gateway } from './client';
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); vi.useRealTimers(); });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: status === 200, data }), { status });
function delayed() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(done => resolve = done); vi.stubGlobal('fetch', vi.fn(() => promise)); return resolve; }
it('blocks protected reads before login even if callers request public access', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const api = new Gateway();
  await expect(api.store('catalog')).rejects.toThrow('请先登录');
  await expect(api.store('catalog', undefined, true)).rejects.toThrow('需要商店登录');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['replacement', 'logout', 'service'])('fences late login after %s', async scope => {
  const resolve = delayed(), api = new Gateway();
  const pending = api.store('login', {}, true);
  if (scope === 'service') await api.setStoreAddress('https://store.example');
  else api.storeSession = scope === 'replacement' ? 'new' : '';
  resolve(reply({ sessionId: 'late', expiresAt: new Date(Date.now() + 43200000).toISOString() }));
  await expect(pending).rejects.toThrow('已改变');
  expect(api.storeSession).toBe(scope === 'replacement' ? 'new' : '');
});
it('an expired old request cannot clear a replacement session', async () => {
  const resolve = delayed(), api = new Gateway(); api.storeSession = 'old';
  const pending = api.store('catalog'); api.storeSession = 'new'; resolve(reply(null, 401));
  await expect(pending).rejects.toThrow('已改变'); expect(api.storeSession).toBe('new');
});
it('fences response bodies that finish after the scope changes', async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(done => resolve = done) })));
  const api = new Gateway(); api.storeSession = 'old'; const pending = api.store('catalog');
  await Promise.resolve(); api.storeSession = 'new'; resolve({ ok: true, data: { items: ['secret'] } });
  await expect(pending).rejects.toThrow('已改变');
});
it.each([200, 500])('revokes the captured old service session without disturbing a replacement (%s)', async status => {
  const releases: ((response: Response) => void)[] = [];
  const fetcher = vi.fn(() => new Promise<Response>(done => releases.push(done)));
  vi.stubGlobal('fetch', fetcher);
  const api = new Gateway();
  await api.setStoreAddress('https://old.example'); api.storeSession = 'old-session';
  await api.setStoreAddress('https://new.example');
  expect(api.storeSession).toBe('');
  expect(fetcher).toHaveBeenCalledWith('https://old.example/api/store/logout', expect.objectContaining({
    method: 'POST', keepalive: true, headers: expect.objectContaining({ 'X-Store-Session': 'old-session' }),
  }));
  api.storeSession = 'replacement-session';
  await api.setStoreAddress('https://newer.example');
  api.storeSession = 'newest-session';
  releases.forEach(release => release(reply({}, status)));
  await Promise.resolve(); await Promise.resolve();
  expect(api.storeAddress).toBe('https://newer.example');
  expect(api.storeSession).toBe('newest-session');
});

it('keeps logout revocation alive after immediate local exit can unmount the embedded page', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const api = new Gateway();
  api.storeSession = 'captured-session';
  const pending = api.logoutStore();
  expect(api.storeSession).toBe('');
  expect(fetcher).toHaveBeenCalledWith('/api/store/logout', expect.objectContaining({
    method: 'POST', keepalive: true, credentials: 'omit', redirect: 'error',
    headers: expect.objectContaining({ 'X-Store-Session': 'captured-session' }), body: '{}',
  }));
  api.storeSession = 'replacement-session';
  finish(reply({}));
  await pending;
  expect(api.storeSession).toBe('replacement-session');
});

it('expires a server-issued session without a request', async () => {
  vi.useFakeTimers();
  const api = new Gateway();
  vi.stubGlobal('fetch', vi.fn(async () => reply({ sessionId: 'timed', expiresAt: new Date(Date.now() + 1000).toISOString() })));
  await api.store('login', {}, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.storeSession).toBe('');
});
it.each([undefined, null, 'garbage', '2026-02-30T00:00:00Z', '2000-01-01T00:00:00Z'])('rejects invalid or expired login deadline %s', async expiresAt => {
  const api = new Gateway();
  vi.stubGlobal('fetch', vi.fn(async () => reply({ sessionId: 'invalid', expiresAt })));
  await expect(api.store('login', {}, true)).rejects.toThrow('会话');
  expect(api.storeSession).toBe('');
});
it('replacement expiry survives the old deadline and expires at its own deadline', async () => {
  vi.useFakeTimers();
  const api = new Gateway();
  const login = async (sessionId: string, delay: number) => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ sessionId, expiresAt: new Date(Date.now() + delay).toISOString() })));
    await api.store('login', {}, true);
  };
  await login('old', 1000); await login('replacement', 2000);
  await vi.advanceTimersByTimeAsync(1000); expect(api.storeSession).toBe('replacement');
  await vi.advanceTimersByTimeAsync(1000); expect(api.storeSession).toBe('');
});
it.each(['focus', 'visibilitychange'])('checks expiry on %s after a suspended timer', async event => {
  vi.useFakeTimers();
  const api = new Gateway();
  vi.stubGlobal('fetch', vi.fn(async () => reply({ sessionId: 'sleeping', expiresAt: new Date(Date.now() + 1000).toISOString() })));
  await api.store('login', {}, true);
  vi.setSystemTime(Date.now() + 2000);
  if (event === 'focus') window.dispatchEvent(new Event(event));
  else document.dispatchEvent(new Event(event));
  expect(api.storeSession).toBe('');
});

it.each(['logout', 'service'])('removes expiry timers and wake listeners on %s', async scope => {
  vi.useFakeTimers();
  const removeWindow = vi.spyOn(window, 'removeEventListener');
  const removeDocument = vi.spyOn(document, 'removeEventListener');
  const api = new Gateway();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.endsWith('/login') ? { sessionId: 'timed', expiresAt: new Date(Date.now() + 1000).toISOString() } : {})));
  await api.store('login', {}, true);
  if (scope === 'logout') await api.logoutStore();
  else await api.setStoreAddress('https://expiry.example');
  await vi.advanceTimersByTimeAsync(0); // Flush the detached old-service revocation body.
  expect(vi.getTimerCount()).toBe(0);
  expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function));
  expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  api.storeSession = 'replacement';
  vi.setSystemTime(Date.now() + 2000); window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.storeSession).toBe('replacement');
  api.storeSession = '';
  vi.restoreAllMocks();
});
it('fences a protected body completing after the session deadline', async () => {
  vi.useFakeTimers();
  const api = new Gateway();
  vi.stubGlobal('fetch', vi.fn(async () => reply({ sessionId: 'timed', expiresAt: new Date(Date.now() + 1000).toISOString() })));
  await api.store('login', {}, true);
  let release!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(done => release = done) })));
  const pending = api.store('catalog'); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  release({ ok: true, data: { items: ['secret'] } });
  await expect(pending).rejects.toThrow('已改变');
});
