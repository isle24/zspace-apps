import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WindowFrame } from './WindowFrame';
import type { DesktopWindow } from './state';
afterEach(cleanup);

it('keeps media appearance scoped to its own window while preserving window controls', () => {
  const close = vi.fn();
  const window: DesktopWindow = { id: 'music-window', appId: 'music', scope: 'nas', rect: { x: 100, y: 100, width: 1100, height: 640 }, z: 1, minimized: false, maximized: false };
  render(<WindowFrame window={window} active mobile={false} title="音乐" dispatch={vi.fn()} onClose={close}><p>曲库</p></WindowFrame>);
  expect(screen.getByRole('region', { name: '音乐窗口' })).toHaveAttribute('data-window-app', 'music');
  fireEvent.click(screen.getByRole('button', { name: '关闭音乐' }));
  expect(close).toHaveBeenCalledOnce();
});
