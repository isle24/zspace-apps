import {afterEach, expect, it, vi} from 'vitest';
import {act, screen} from '@testing-library/react';

afterEach(() => { vi.unstubAllGlobals(); });
it('opens an anonymous public catalog at the domain root instead of the administrator login', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const items = Array.from({length: 176}, (_, index) => ({id: `app-${index}`, name: `应用 ${index}`, description: '公开应用资料', category: 'tools', icon: '', image: '', version: '1.0', containerPort: 0, dataTargets: [], catalogOnly: true, published: true, releaseNumber: 0}));
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ok: true, data: {items}}), {status: 200}));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => { await import('./main'); await vi.dynamicImportSettled(); });
  expect(await screen.findByRole('heading', {name: '发现适合你的 NAS 应用'})).toBeInTheDocument();
  expect(await screen.findByRole('heading', {name: '应用 175'})).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith('/api/cloud/public-catalog', expect.objectContaining({credentials: 'omit'}));
  expect(screen.queryByLabelText('管理员密码')).not.toBeInTheDocument();
});
