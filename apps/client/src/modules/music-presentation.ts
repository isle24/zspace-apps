import type { Item } from '../api/client';

// NAS music-list metadata uses milliseconds; the audio element uses seconds.
export function formatMusicDuration(item: Item): string {
  const value = item.metadata?.duration_ms ?? item.metadata?.song_duration ?? item.metadata?.duration;
  if (typeof value !== 'number' && typeof value !== 'string') return '—';
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—';
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function metadataText(item: Item, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = item.metadata?.[key];
    const text = Array.isArray(value) ? value.filter(v => typeof v === 'string').join('、') : typeof value === 'string' ? value : '';
    if (text.trim()) return text.trim();
  }
  return fallback;
}
export const musicArtist = (item: Item) => metadataText(item, ['artist', 'song_artist', 'album_artist'], '未知歌手');
export const musicAlbum = (item: Item) => metadataText(item, ['album', 'album_name', 'song_album'], '—');
