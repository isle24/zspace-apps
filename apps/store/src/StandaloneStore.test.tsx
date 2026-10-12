import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { StandaloneStore } from './StandaloneStore';
import { api } from './api/client';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); api.storeSession = ''; vi.useRealTimers(); });
it('requests only bootstrap and shows only login before authentication', async () => {
  const read = vi.spyOn(api, 'store').mockResolvedValue({ configured: true, items: [{ id: 'fixture', name: 'Secret app', category: 'media' }] });
  render(<StandaloneStore />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  expect(read.mock.calls.map(call => call[0])).toEqual(['bootstrap']);
  expect(screen.queryByText('Secret app')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '登录商店' })).toBeInTheDocument();
});
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: status === 200, data, error: { code: 'store_auth_required' } }), { status });
it('logs in before catalog reads and unmounts content immediately at logout', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/bootstrap')) return reply({ configured: true });
    if (url.endsWith('/login')) return reply({ sessionId: 'memory-session', expiresAt: new Date(Date.now() + 43200000).toISOString() });
    if (url.endsWith('/status')) return reply({ configured: true, engineReady: true });
    if (url.endsWith('/catalog')) return reply({ items: [{ id: 'secret', name: 'Secret app', category: 'media', installable: false }] });
    if (url.endsWith('/logout')) return new Promise<Response>(() => {});
    return reply({ items: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<StandaloneStore />);
  await waitFor(() => expect(screen.getByRole('button', { name: '登录商店' })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('管理员账号'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password' } });
  fireEvent.click(screen.getByRole('button', { name: '登录商店' }));
  expect(await screen.findByText('Secret app')).toBeInTheDocument();
  const catalog = fetcher.mock.calls.find(([url]) => url.endsWith('/catalog'));
  expect(catalog?.[1]?.headers).toHaveProperty('X-Store-Session', 'memory-session');
  fireEvent.click(screen.getByRole('button', { name: '管理员已登录' }));
  fireEvent.click(screen.getByRole('button', { name: '退出商店账号' }));
  expect(screen.queryByText('Secret app')).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: '登录商店' })).toBeInTheDocument();
});
it('hides loaded content when a protected refresh expires', async () => {
  let expired = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/bootstrap')) return reply({ configured: true });
    if (expired) return reply(null, 401);
    if (url.endsWith('/status')) return reply({ configured: true, engineReady: true });
    return reply({ items: url.endsWith('/catalog') ? [{ id: 'secret', name: 'Secret app', category: 'media' }] : [] });
  }));
  api.storeSession = 'fixture';
  render(<StandaloneStore />);
  expect(await screen.findByText('Secret app')).toBeInTheDocument();
  expired = true;
  fireEvent.click(screen.getByRole('button', { name: '刷新商店' }));
  expect(await screen.findByRole('button', { name: '登录商店' })).toBeInTheDocument();
  expect(screen.queryByText('Secret app')).not.toBeInTheDocument();
});
it('service change hides content and rejects an old catalog body that arrives later', async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/bootstrap')) return reply({ configured: true });
    if (url.endsWith('/catalog')) return new Promise<Response>(done => release = done);
    if (url.endsWith('/status')) return reply({ configured: true, engineReady: true });
    return reply({ items: [] });
  }));
  api.storeSession = 'old'; render(<StandaloneStore />);
  await waitFor(() => expect(release).toBeDefined());
  fireEvent.change(screen.getByLabelText('独立商店服务地址', { exact: false }), { target: { value: 'https://other.example' } });
  fireEvent.click(screen.getByRole('button', { name: '应用服务地址' }));
  expect(await screen.findByRole('button', { name: '登录商店' })).toBeInTheDocument();
  release(reply({ items: [{ id: 'late', name: 'Late secret', category: 'media' }] }));
  await waitFor(() => expect(screen.queryByText('Late secret')).not.toBeInTheDocument());
  await api.setStoreAddress('');
});
it.each([undefined, null, {}, { configured: 'false' }])('keeps unknown bootstrap state blocked (%j)', async data => {
  const fetcher = vi.fn(async () => reply(data)); vi.stubGlobal('fetch', fetcher);
  render(<StandaloneStore />);
  expect(await screen.findByRole('alert')).toHaveTextContent('商店初始化信息无效');
  expect(screen.getByRole('button', { name: '登录商店' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '创建并登录' })).not.toBeInTheDocument();
  expect(fetcher.mock.calls).toHaveLength(1);
});

it.each(['offline', 'stalled'])('unmounts catalog at the server deadline with %s requests and no 401', async mode => {
  const deadline = Date.now() + 60000;
  let unavailable = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/bootstrap')) return reply({ configured: true });
    if (url.endsWith('/login')) return reply({ sessionId: 'deadline-session', expiresAt: new Date(deadline).toISOString() });
    if (unavailable) {
      if (mode === 'offline') throw new TypeError('offline');
      return new Promise<Response>(() => {});
    }
    if (url.endsWith('/status')) return reply({ configured: true, engineReady: true });
    return reply({ items: url.endsWith('/catalog') ? [{ id: 'secret', name: 'Deadline secret', category: 'media' }] : [] });
  }));
  render(<StandaloneStore />);
  await waitFor(() => expect(screen.getByRole('button', { name: '登录商店' })).toBeEnabled());
  vi.useFakeTimers();
  await act(async () => { await api.store('login', {}, true); });
  expect(screen.getByText('Deadline secret')).toBeInTheDocument();
  unavailable = true;
  void api.store('status').catch(() => {});
  fireEvent.click(screen.getByRole('button', { name: '管理员已登录' }));
  expect(screen.getByText('Deadline secret')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '退出商店账号' })).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.queryByRole('button', { name: '管理员已登录' })).not.toBeInTheDocument();
  expect(screen.queryByText('Deadline secret')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '退出商店账号' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '登录商店' })).toBeInTheDocument();
  expect(api.storeSession).toBe('');
});
