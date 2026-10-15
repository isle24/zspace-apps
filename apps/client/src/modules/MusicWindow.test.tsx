import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api, type Item } from '../api/client';
import { MusicWindow } from './MusicWindow';

const song = (id: string, duration: unknown = 211173): Item => ({
  id, name: `歌曲 ${id}`, kind: 'song', path: `/music/${id}.mp3`,
  metadata: { song_duration: duration, song_artist: '测试歌手', song_album: '测试专辑' },
});
beforeEach(() => { vi.spyOn(api, 'musicArtwork').mockResolvedValue(null); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('formats NAS millisecond song durations consistently with the actual audio player', async () => {
  vi.spyOn(api, 'read').mockResolvedValue({ items: [song('a'), song('long', 3661000), song('unknown', null)], total: 3 });
  render(<MusicWindow connected onPlay={() => {}} />);
  expect(await screen.findByText('3:31')).toBeInTheDocument();
  expect(screen.getByText('1:01:01')).toBeInTheDocument();
  expect(screen.getByText('—')).toBeInTheDocument();
  expect(screen.getAllByText('测试歌手')).toHaveLength(3);
  expect(screen.getAllByText('测试专辑')).toHaveLength(3);
});

it('labels playback as this page instead of promising the entire NAS library', async () => {
  const items = [song('a'), song('b')];
  vi.spyOn(api, 'read').mockResolvedValue({ items, total: 76858 });
  const onPlay = vi.fn();
  render(<MusicWindow connected onPlay={onPlay} />);
  fireEvent.click(await screen.findByRole('button', { name: '播放本页' }));
  expect(onPlay).toHaveBeenCalledWith({ kind: 'music', items, index: 0 });
  expect(screen.queryByRole('button', { name: '播放全部' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('搜索当前音乐内容'), { target: { value: '歌曲 b' } });
  fireEvent.click(screen.getByRole('button', { name: '播放结果' }));
  expect(onPlay).toHaveBeenLastCalledWith({ kind: 'music', items: [items[1]], index: 0 });
});

it('only offers play all when the complete returned collection is available', async () => {
  vi.spyOn(api, 'read').mockResolvedValue({ items: [song('a')], total: 1 });
  render(<MusicWindow connected onPlay={() => {}} />);
  expect(await screen.findByRole('button', { name: '播放全部' })).toBeInTheDocument();
});
