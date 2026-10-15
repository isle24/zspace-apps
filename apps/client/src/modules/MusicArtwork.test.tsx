import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { api, type Item } from '../api/client';
import { MusicArtwork } from './MusicArtwork';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('tries refreshed artwork after an earlier URL failed for the same track', async () => {
  vi.spyOn(api.nas, 'safeMediaUrl').mockImplementation(value => typeof value === 'string' && value.startsWith('https://nas.test/') ? value : undefined);
  const artwork = vi.spyOn(api, 'musicArtwork').mockResolvedValue(null);
  const item: Item = { id: 'changed-cover', name: '歌曲', kind: 'song', thumbnail: 'https://nas.test/old.jpg' };
  const view = render(<MusicArtwork item={item} />);
  fireEvent.error(view.container.querySelector('img')!);
  await waitFor(() => expect(artwork).toHaveBeenCalledOnce());
  view.rerender(<MusicArtwork item={{ ...item, thumbnail: 'https://nas.test/new.jpg' }} />);
  expect(view.container.querySelector('img')).toHaveAttribute('src', 'https://nas.test/new.jpg');
});
