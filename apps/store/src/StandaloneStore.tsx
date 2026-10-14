import { useEffect, useState } from 'react';
import { Store, StoreAuth } from './modules/Store';
import { StoreServiceSettings } from './modules/StoreServiceSettings';
import { api } from './api/client';
import { useResource } from './modules/common';
import { ShoppingBag, ShieldCheck } from '@phosphor-icons/react';
const ignoreInstances = () => {};
export function StandaloneStore() {
  const embedded = window.parent !== window && new URLSearchParams(location.search).get('embedded') === '1';
  const [scope, setScope] = useState({ session: api.storeSession, address: api.storeAddress, revision: 0 });
  useEffect(() => {
    const update = () => setScope(previous => ({ session: api.storeSession, address: api.storeAddress, revision: previous.revision + 1 }));
    window.addEventListener('space-store-session', update);
    window.addEventListener('space-store-address', update);
    return () => { window.removeEventListener('space-store-session', update); window.removeEventListener('space-store-address', update); };
  }, []);
  return <main className={`standalone-store${embedded ? ' is-embedded' : ''}${scope.session ? ' is-connected' : ''}`}>
    <header className="standalone-brand"><ShoppingBag weight="duotone" /><div><strong>空间应用商店</strong><p>独立的第三方应用服务</p></div><span><ShieldCheck />独立管理员账号</span></header>
    <div className="standalone-intro"><span className="eyebrow">YOUR APPS. YOUR STORAGE.</span><h1>让自己的服务器，多一些可能</h1><p>登录商店管理员后浏览、安装和管理应用。现有媒体只读挂载，应用数据独立保存。</p></div>
    <section className="standalone-content">
      {scope.session ? <Store key={scope.revision} initialTab="runtime" onInstances={ignoreInstances} /> : <Login key={scope.address} />}
    </section>
    <footer className="standalone-footer">空间应用商店 · 商店会话仅保存在当前页面内存</footer>
  </main>;
}
function Login() {
  const bootstrap = useResource(async () => {
    const data = await api.store<{ configured: boolean; setupRequiresLoopback?: boolean; authMode?: string }>('bootstrap', undefined, true);
    if (!data || typeof data.configured !== 'boolean') throw new Error('商店初始化信息无效，请重新读取');
    return data;
  }, []);
  if (bootstrap.data?.authMode === 'nas-admin-only') return <div className="auth-box"><h2>使用 NAS 管理员登录</h2><p>请从空间桌面的“空间商店”入口连接当前 NAS 管理员身份。</p><a href="/" target="_top">打开空间桌面</a></div>;
  return <><StoreServiceSettings />{bootstrap.error && <p role="alert">{bootstrap.error}<button onClick={bootstrap.reload}>重新读取</button></p>}<StoreAuth configured={bootstrap.data?.configured} setupRequiresLoopback={bootstrap.data?.setupRequiresLoopback} onDone={() => {}} onLogout={() => { void api.logoutStore(); }} /></>;
}
