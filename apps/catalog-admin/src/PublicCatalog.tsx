import {useEffect, useState} from 'react';
import {ArrowClockwise, ArrowRight, Cube, HardDrives, MagnifyingGlass} from '@phosphor-icons/react';
import type {CloudApp} from './api';
import {IconPreview} from './IconPreview';
import './public-catalog.css';

const deploymentGuide = 'https://github.com/isle24/nas-app-store-catalog#独立商店-docker无需第三方桌面';
const categoryNames: Record<string, string> = {tools: '实用工具', monitoring: '服务监控', music: '音乐播放', video: '影视媒体', photos: '照片管理', sync: '文件同步', reading: '图书阅读'};
const nativeRecipes = new Set(['immich', 'jellyfin', 'nasreader', 'navidrome', 'syncthing', 'uptime-kuma']);
type Delivery = 'signed' | 'native' | 'pending';
function delivery(app: CloudApp): Delivery {
  if (app.catalogOnly) return 'pending';
  if (app.releaseNumber > 0 && /^[a-f0-9]{64}$/.test(app.manifestDigest || '')) return 'signed';
  return nativeRecipes.has(app.id) ? 'native' : 'pending';
}

function publicApps(result: unknown): CloudApp[] {
  const value = result as {ok?: boolean; data?: {items?: CloudApp[]}};
  const apps = value?.data?.items;
  if (value?.ok !== true || !Array.isArray(apps) || apps.length > 1000) throw Error('invalid public catalog');
  const seen = new Set<string>();
  for (const app of apps) {
    if (!app || typeof app.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(app.id) || seen.has(app.id) || app.published !== true || !['name', 'description', 'category', 'icon', 'version'].every(key => typeof app[key as keyof CloudApp] === 'string')) throw Error('invalid public application');
    seen.add(app.id);
  }
  return apps;
}

export function PublicCatalog() {
  const [apps, setApps] = useState<CloudApp[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false), [revision, setRevision] = useState(0);
  const [query, setQuery] = useState(''), [category, setCategory] = useState('');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    setLoading(true);
    setError(false);
    void fetch('/api/cloud/public-catalog', {credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal})
      .then(async response => {
        if (!response.ok) throw Error('public catalog unavailable');
        return publicApps(await response.json());
      })
      .then(items => { if (active) setApps(items); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [revision]);
  const counts = {signed: 0, native: 0, pending: 0};
  for (const app of apps) counts[delivery(app)]++;
  const categories = [...new Set(apps.map(app => app.category))];
  const search = query.trim().toLowerCase();
  const listed = apps.filter(app => (!category || app.category === category) && `${app.id} ${app.name} ${app.description}`.toLowerCase().includes(search));

  return <div className="public-catalog">
    <header className="public-header public-shell">
      <a className="public-brand" href="/" aria-label="空间应用商店首页"><span><Cube weight="duotone" /></span><div><strong>空间应用商店</strong><small>SPACE STORE</small></div></a>
      <nav aria-label="网站导航"><a href="#catalog">应用目录</a><a href="#nas-shop-guide">如何安装</a><a href="/admin/">管理后台<ArrowRight /></a></nav>
    </header>
    <main className="public-shell">
      <section className="public-hero">
        <div><span className="public-eyebrow">为自己的服务器，发现更多可能</span><h1>发现适合你的 NAS 应用</h1><p>浏览完整公开目录，了解应用用途与当前适配状态。安装和账号操作在你的 NAS 本地商店完成。</p><a className="public-primary" href="#catalog">浏览应用<ArrowRight /></a></div>
        <aside><HardDrives weight="duotone" /><h2>你的应用，运行在你的 NAS</h2><p>先浏览，再在本地商店确认数据目录、端口和应用配置。</p><a href={deploymentGuide} target="_blank" rel="noreferrer noopener">部署 NAS 本地商店<ArrowRight /></a></aside>
      </section>
      <dl className="public-stats" aria-label="公开目录统计"><div><dt>公开应用</dt><dd>{loading ? '—' : apps.length}<span>款应用资料</span></dd></div><div><dt>云端交付</dt><dd>{counts.signed}<span>{counts.signed} 项云签名清单</span></dd></div><div><dt>本地审核</dt><dd>{counts.native}<span>{counts.native} 项 NAS 本地配方</span></dd></div><div><dt>适配进度</dt><dd>{counts.pending}<span>{counts.pending} 项待适配</span></dd></div></dl>
      <section id="catalog" aria-label="公开应用目录" className="public-directory">
        <div className="public-section-heading"><div><span className="public-eyebrow">APPLICATIONS</span><h2>完整应用目录</h2></div><button className="secondary" disabled={loading} onClick={() => setRevision(value => value + 1)}><ArrowClockwise />刷新目录</button></div>
        <div className="public-filters"><label className="public-search"><MagnifyingGlass /><input aria-label="搜索公开应用" placeholder="搜索名称、标识或应用介绍" value={query} onChange={event => setQuery(event.target.value)} /></label><label>应用分类<select aria-label="应用分类" value={category} onChange={event => setCategory(event.target.value)}><option value="">全部分类</option>{categories.map(id => <option key={id} value={id}>{categoryNames[id] || id}</option>)}</select></label></div>
        {loading && <p className="public-message" role="status">正在读取公开应用目录…</p>}
        {error && <div className="public-error" role="alert"><p>公开目录暂时无法读取，请稍后重试。</p><button className="secondary" onClick={() => setRevision(value => value + 1)}>重新读取</button></div>}
        {!loading && !error && <p className="public-result" role="status">显示 {listed.length} / {apps.length} 款应用</p>}
        {!loading && !error && !listed.length && <div className="public-empty"><Cube weight="duotone" /><h3>没有匹配的应用</h3><p>试试其他关键词或切换分类。</p></div>}
        <div className="public-grid">{listed.map(app => {
          const kind = delivery(app);
          return <article aria-label={app.name} key={app.id} className="public-app">
            <div className="public-app-heading"><span className="public-app-icon"><IconPreview key={app.icon} icon={app.icon} alt={app.name + '图标'} loading="lazy" /></span><div><h3>{app.name}</h3><small>{categoryNames[app.category] || app.category} · {app.version}</small></div></div>
            <p>{app.description}</p>
            <span className={`public-delivery ${kind}`}>{kind === 'signed' ? '云签名清单' : kind === 'native' ? 'NAS 本地配方' : '安装支持待适配'}</span>
            {kind === 'pending' && <small className="public-compatibility">{app.compatibilityNote || '安装配置尚待适配，当前仅展示公开资料。'}</small>}
            <footer>{kind === 'pending' ? <button className="secondary" disabled>安装支持待适配</button> : <a href="#nas-shop-guide">在 NAS 商店安装<ArrowRight /></a>}</footer>
          </article>;
        })}</div>
      </section>
      <section id="nas-shop-guide" className="public-guide"><div><span className="public-eyebrow">在自己的 NAS 上开始</span><h2>把喜欢的应用，带回自己的服务器</h2><p>安装和账号操作在你的 NAS 本地商店完成。</p></div><ol><li><strong>部署本地商店</strong><span>按部署文档在 NAS 的 Docker Compose 中启动独立商店。</span></li><li><strong>创建自己的管理员</strong><span>打开 NAS 上的商店网页，首次创建本地账号。</span></li><li><strong>选择并安装应用</strong><span>在本地商店检查安装支持，确认目录、端口和应用配置后执行。</span></li></ol><a className="public-primary" href={deploymentGuide} target="_blank" rel="noreferrer noopener">查看独立商店部署文档<ArrowRight /></a></section>
    </main>
    <footer className="public-footer public-shell"><span>空间应用商店 · 公开应用目录</span><p>云签名清单与 NAS 本地配方采用各自的安装检查；待适配资料保留展示，安装支持以本地商店结果为准。</p></footer>
  </div>;
}
