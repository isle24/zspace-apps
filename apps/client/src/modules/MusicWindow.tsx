import { useState, type CSSProperties } from 'react';
import { ArrowLeft, ArrowClockwise, MusicNote, MusicNotes, Play, Playlist, VinylRecord, MagnifyingGlass } from '@phosphor-icons/react';
import { api, normalizeCollection, type Item } from '../api/client';
import { Status, useResource } from './common';
import { MusicArtwork } from './MusicArtwork';
import { mediaRequest } from '../api/operations';
import { Pagination, usePage, PAGE_SIZE, pagedRequest } from './Pagination';
import { formatMusicDuration, musicAlbum, musicArtist } from './music-presentation';
import type { MediaSelection } from './MediaWindow';

const tabs = [['songs', '全部歌曲', MusicNotes], ['albums', '专辑', VinylRecord], ['playlists', '歌单', Playlist]] as const;

export function MusicWindow({ connected, onPlay }: { connected: boolean; onPlay: (selection: MediaSelection) => void }) {
  const [tab, setTab] = useState('songs');
  const [parent, setParent] = useState<Item>();
  const [query, setQuery] = useState('');
  const { page, setPage } = usePage([api.nasSession, tab, parent?.id]);
  const resource = useResource(async () => {
    if (!connected) return { items: [] };
    const request = pagedRequest(mediaRequest('music', tab, parent), page);
    return normalizeCollection(await api.read(request.operation, request.params));
  }, [api.nasSession, connected, tab, parent?.id, page]);
  const search = query.trim().toLowerCase();
  const items = (resource.data?.items ?? []).filter(item => `${item.name} ${musicArtist(item)} ${musicAlbum(item)}`.toLowerCase().includes(search));
  const collection = !parent && tab !== 'songs';
  const title = parent?.name ?? tabs.find(entry => entry[0] === tab)?.[1];
  const complete = page === 1 && typeof resource.data?.total === 'number' && resource.data.total <= items.length;
  const playLabel = search ? '播放结果' : complete ? '播放全部' : '播放本页';
  const play = (index: number) => onPlay({ kind: 'music', items, index });
  const count = typeof resource.data?.total === 'number' && !resource.loading
    ? `${resource.data.total.toLocaleString()} ${collection ? tab === 'albums' ? '张专辑' : '个歌单' : '首歌曲'}`
    : connected ? '歌曲、专辑与歌单，来自你的 NAS' : '连接 NAS，打开你的音乐库';

  return <div className="qq-music ios-music">
    <aside className="music-sidebar">
      <h2><MusicNote weight="fill" />音乐</h2>
      <small>资料库</small>
      <nav aria-label="音乐分类">{tabs.map(([id, label, Icon]) => <button type="button" key={id} className={id === tab ? 'active' : ''} aria-current={id === tab ? 'page' : undefined} onClick={() => { setTab(id); setParent(undefined); setQuery(''); }}><Icon weight={id === tab ? 'fill' : 'regular'} />{label}</button>)}</nav>
      <div className="music-side-bottom"><span className="music-library-mark"><VinylRecord /></span><p>你的音乐，随时聆听</p><small>NAS 私人音乐库</small></div>
    </aside>
    <main className="music-library">
      <header className="music-toolbar">
        {parent && <button type="button" className="icon-button" aria-label="返回音乐列表" onClick={() => { setParent(undefined); setQuery(''); }}><ArrowLeft /></button>}
        <label className="official-search music-search"><MagnifyingGlass /><input aria-label="搜索当前音乐内容" placeholder="搜索本页歌曲、歌手或专辑" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button type="button" className="icon-button" aria-label="刷新音乐" onClick={resource.reload}><ArrowClockwise /></button>
      </header>
      <section className={`music-library-banner ${parent ? 'collection' : ''}`}>
        {parent && <MusicArtwork key={parent.id} item={parent} className="music-collection-cover" />}
        <div className="music-library-intro"><small>{parent ? tab === 'albums' ? '专辑' : '歌单' : '私人音乐库'}</small><h1>{title}</h1><p>{count}</p>{!collection && items.length > 0 && <button type="button" className="music-play-all" onClick={() => play(0)}><Play weight="fill" />{playLabel}</button>}</div>
        {!parent && <div className="music-cover-stack" aria-hidden="true">{items.length ? items.slice(0, 3).map((item, index) => <div key={item.id} style={{ '--cover-index': index } as CSSProperties}><MusicArtwork item={item} /></div>) : <span className="music-banner-disc"><VinylRecord weight="duotone" /></span>}</div>}
      </section>
      <Status {...resource} connected={connected} retry={resource.reload} />
      {items.length === 0 && !resource.loading && !resource.error && connected && <div className="photo-empty music-empty"><MusicNotes /><h2>{search ? '没有匹配的音乐' : '还没有找到音乐'}</h2><p>{search ? '当前筛选只查找本页内容。' : '在 NAS 音乐中添加音乐目录后，点击刷新。'}</p>{search && <button type="button" className="secondary" onClick={() => setQuery('')}>清除筛选</button>}</div>}
      <div className="music-library-scroll">{collection ? <div className="music-album-grid">{items.map(item => <button type="button" className="music-album" key={item.id} onClick={() => { setParent(item); setQuery(''); }}><MusicArtwork item={item} /><strong>{item.name}</strong><small>{musicArtist(item)}{item.metadata?.song_count !== undefined ? ` · ${item.metadata.song_count} 首` : ''}</small><span className="music-album-play"><Play weight="fill" /></span></button>)}</div> : <div className="music-song-table">
        <div className="music-song-row music-song-head"><span>#</span><span>歌曲</span><span>专辑</span><span>时长</span></div>
        {items.map((item, index) => <button type="button" className="music-song-row" key={item.id} onClick={() => play(index)} aria-label={`播放 ${item.name}`}><span className="song-order">{String((page - 1) * PAGE_SIZE + index + 1).padStart(2, '0')}<Play weight="fill" /></span><span className="song-cell"><MusicArtwork item={item} /><span><strong>{item.name}</strong><small>{musicArtist(item)}</small></span></span><span className="song-album">{musicAlbum(item)}</span><span className="song-duration">{formatMusicDuration(item)}</span></button>)}
      </div>}</div>
      <Pagination page={page} count={resource.data?.items.length ?? 0} total={resource.data?.total} loading={resource.loading} onPage={setPage} />
    </main>
  </div>;
}
