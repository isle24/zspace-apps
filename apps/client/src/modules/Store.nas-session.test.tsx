import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { Store } from './Store';
import { api } from '../api/client';
import { officialFixture, officialJson } from '../api/direct-test-fixture';
const provider = 'http://synthetic.invalid:5055', shop = 'https://shop.invalid', storeId = 'a'.repeat(48), sid = 'b'.repeat(48);
let exchanges = 0, deny = false;
beforeEach(async () => {
  localStorage.clear(); api.logoutNas(); api.storeSession = ''; api.storeAddress = shop; api.base = shop;
  exchanges = 0; deny = false;
  vi.stubGlobal('fetch', officialFixture(url => {
    if (url.pathname === '/api/store/bootstrap') return officialJson({ ok: true, data: { configured: true, engineReady: true, nasAuth: { enabled: true, origin: provider, storeId } } });
    if (url.pathname === '/api/store/nas-session') {
      exchanges++;
      return deny ? officialJson({ ok: false, error: { message: 'synthetic-official-token' } }, 403) : officialJson({ ok: true, data: { sessionId: sid, username: 'fixture', expiresAt: new Date(Date.now()+120000).toISOString(), authSource: 'nas' } });
    }
    return officialJson({ ok: true, data: { items: [] } });
  }));
  await api.login(provider, 'fixture', 'synthetic-only');
});
afterEach(() => { cleanup(); api.logoutNas(); api.storeSession = ''; api.storeAddress = ''; api.base = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('embedded entry shows both exact trust destinations and exchanges only after explicit pairing', async () => {
  render(<Store embedded onInstances={() => {}} />);
  const trust = await screen.findByRole('button', { name: '信任此商店并使用 NAS 登录' });
  expect(screen.getByText(provider)).toBeInTheDocument(); expect(screen.getByText(shop)).toBeInTheDocument();
  expect(screen.getByText(storeId)).toBeInTheDocument(); expect(exchanges).toBe(0);
  fireEvent.click(trust);
  await waitFor(() => expect(api.storeSession).toBe(sid)); expect(exchanges).toBe(1);
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
});
it('automatically exchanges an already explicitly trusted embedded binding', async () => {
  api.trustStoreNasBinding(await api.getStoreNasBinding());
  render(<Store embedded onInstances={() => {}} />);
  await waitFor(() => expect(api.storeSession).toBe(sid)); expect(exchanges).toBe(1);
});
it('standalone mode never reads NAS identity or exchanges even with persisted trust', async () => {
  api.trustStoreNasBinding(await api.getStoreNasBinding());
  const identity = vi.spyOn(api, 'getStoreNasBinding'); const connect = vi.spyOn(api, 'connectStoreWithNas');
  render(<Store onInstances={() => {}} />);
  await screen.findByText(/独立商店 · 执行模式/);
  expect(identity).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(exchanges).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: '管理员登录' }));
  expect(await screen.findByLabelText('管理员账号')).toBeInTheDocument();
});
it('ordinary NAS users receive fixed permission feedback and can choose independent login', async () => {
  deny = true; api.trustStoreNasBinding(await api.getStoreNasBinding());
  render(<Store embedded onInstances={() => {}} />);
  expect(await screen.findByText('当前 NAS 账号没有商店管理员权限')).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('synthetic-official-token');
  fireEvent.click(screen.getByRole('button', { name: '管理员登录' }));
  expect(await screen.findByLabelText('管理员账号')).toBeInTheDocument(); expect(exchanges).toBe(1);
});
it('embedded expiry refreshes authorization but explicit shop logout stays logged out', async () => {
  api.trustStoreNasBinding(await api.getStoreNasBinding());
  render(<Store embedded onInstances={() => {}} />);
  await waitFor(() => expect(api.storeSession).toBe(sid));
  act(() => { api.storeSession = ''; });
  await waitFor(() => expect(exchanges).toBe(2));
  fireEvent.click(screen.getByRole('button', { name: '管理员已登录' }));
  fireEvent.click(await screen.findByRole('button', { name: '退出商店账号' }));
  await waitFor(() => expect(api.storeSession).toBe(''));
  expect(exchanges).toBe(2);
});

it("uses public bootstrap before NAS sign-in and keeps the catalogue protected",async()=>{
 api.storeSession="";const calls:Array<{path:string;public?:boolean}>=[];
 vi.spyOn(api,"store").mockImplementation(async(path,_body,isPublic)=>{
  calls.push({path,public:isPublic});if(path!=="bootstrap")throw new Error("protected before login");
  return {configured:true,nasAuth:{enabled:true,origin:"http://nas.test:5055",storeId:"a".repeat(48)}} as never;
 });
 render(<Store embedded onInstances={()=>{}}/>);
 await waitFor(()=>expect(calls.length).toBeGreaterThan(0));
 expect(calls.every(c=>c.path==="bootstrap"&&c.public===true)).toBe(true);
});
