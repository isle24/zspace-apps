import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {PublicCatalog} from './PublicCatalog';
import type {CloudApp} from './api';

const icon = 'https://raw.githubusercontent.com/isle24/nas-app-store-catalog/main/icons/homarr.png';
const base = {description: '家庭服务器应用', category: 'tools', icon: '', version: '1.0', image: 'public/image:1', containerPort: 8080, dataTargets: ['/data'], published: true, releaseNumber: 1};
const signed = ['homarr', 'homepage', 'komari', 'koodo-reader', 'memos', 'suwayomi', 'wizarr'].map(id => ({...base, id, name: id === 'homarr' ? 'Homarr' : id, manifestDigest: 'a'.repeat(64), ...(id === 'homarr' ? {icon} : {})}));
const native = ['immich', 'jellyfin', 'nasreader', 'navidrome', 'syncthing', 'uptime-kuma'].map(id => ({...base, id, name: id === 'jellyfin' ? 'Jellyfin' : id, category: id === 'jellyfin' ? 'video' : 'tools'}));
const pending = Array.from({length: 163}, (_, index) => ({...base, id: `pending-${index}`, name: `待适配应用 ${index}`, catalogOnly: true, compatibilityNote: '安装配置正在适配', image: '', containerPort: 0, releaseNumber: 0, dataTargets: []}));
const items: CloudApp[] = [...signed, ...native, ...pending];
const response = (value: unknown = items) => new Response(JSON.stringify({ok: true, data: {items: value}}), {status: 200});
function open() {
  const fetcher = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetcher);
  render(<PublicCatalog />);
  return fetcher;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('counts all public apps and distinguishes signed deliveries, NAS recipes, and pending adaptation', async () => {
  open();
  await screen.findByRole('heading', {name: '待适配应用 162'});
  const stats = screen.getByLabelText('公开目录统计');
  expect(stats).toHaveTextContent('176');
  expect(stats).toHaveTextContent('7 项云签名清单');
  expect(stats).toHaveTextContent('6 项 NAS 本地配方');
  expect(stats).toHaveTextContent('163 项待适配');
  expect(within(screen.getByRole('article', {name: 'Homarr'})).getByText('云签名清单')).toBeInTheDocument();
  expect(within(screen.getByRole('article', {name: 'Jellyfin'})).getByText('NAS 本地配方')).toBeInTheDocument();
  const awaiting = within(screen.getByRole('article', {name: '待适配应用 0'}));
  expect(awaiting.getByRole('button', {name: '安装支持待适配'})).toBeDisabled();
  expect(awaiting.queryByRole('link', {name: '在 NAS 商店安装'})).not.toBeInTheDocument();
});

it('combines case-insensitive search with the selected category and shows an empty result', async () => {
  open();
  await screen.findByRole('heading', {name: 'Jellyfin'});
  fireEvent.change(screen.getByLabelText('搜索公开应用'), {target: {value: 'JELLY'}});
  expect(screen.getByRole('heading', {name: 'Jellyfin'})).toBeInTheDocument();
  expect(screen.queryByRole('heading', {name: 'Homarr'})).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('应用分类'), {target: {value: 'tools'}});
  expect(screen.getByText('没有匹配的应用')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('应用分类'), {target: {value: 'video'}});
  expect(screen.getByRole('heading', {name: 'Jellyfin'})).toBeInTheDocument();
});

it('loads icons through the backend first and falls back to the public original', async () => {
  open();
  const image = await screen.findByAltText('Homarr图标');
  expect(image.getAttribute('src')).toMatch(/\/api\/cloud\/artwork\/[a-f0-9]{64}$/);
  fireEvent.error(image);
  expect(image).toHaveAttribute('src', icon);
});

it('keeps installation in the NAS shop and never requests a NAS address or password', async () => {
  const fetcher = open();
  await screen.findByRole('heading', {name: 'Homarr'});
  expect(screen.getByText('安装和账号操作在你的 NAS 本地商店完成。')).toBeInTheDocument();
  expect(screen.getByRole('link', {name: '部署 NAS 本地商店'})).toHaveAttribute('href', 'https://github.com/isle24/nas-app-store-catalog#独立商店-docker无需第三方桌面');
  expect(within(screen.getByRole('article', {name: 'Homarr'})).getByRole('link', {name: '在 NAS 商店安装'})).toHaveAttribute('href', '#nas-shop-guide');
  expect(screen.queryByLabelText(/密码|NAS 地址/)).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith('/api/cloud/public-catalog', expect.objectContaining({credentials: 'omit', redirect: 'error'}));
});

it('shows a recoverable failure without leaking raw errors and retries the same public endpoint', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(Error('internal-private-detail')).mockResolvedValueOnce(response());
  vi.stubGlobal('fetch', fetcher);
  render(<PublicCatalog />);
  expect(await screen.findByRole('alert')).toHaveTextContent('公开目录暂时无法读取');
  expect(screen.queryByText('internal-private-detail')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: '重新读取'}));
  expect(await screen.findByRole('heading', {name: 'Homarr'})).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('rejects malformed public responses instead of displaying an invented empty catalog', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({private: 'not an array'})));
  render(<PublicCatalog />);
  expect(await screen.findByRole('alert')).toHaveTextContent('公开目录暂时无法读取');
});
