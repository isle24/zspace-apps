import {afterEach, expect, it, vi} from 'vitest';
import {act, screen} from '@testing-library/react';

afterEach(() => { history.replaceState({}, '', '/'); });
it('preserves the administrator password and two-factor login at /admin/', async () => {
  history.replaceState({}, '', '/admin/');
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => { await import('./main'); await vi.dynamicImportSettled(); });
  expect(await screen.findByRole('heading', {name: '登录管理后台'})).toBeInTheDocument();
  expect(screen.getByLabelText('管理员密码')).toBeInTheDocument();
  expect(screen.getByLabelText('管理员动态验证码')).toBeInTheDocument();
  expect(screen.queryByRole('heading', {name: '发现适合你的 NAS 应用'})).not.toBeInTheDocument();
});
