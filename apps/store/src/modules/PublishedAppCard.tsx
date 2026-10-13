import {useState} from 'react';
import type {CloudApp} from '../api/cloud-catalog';
import {AppArtwork} from './AppArtwork';
import {ExternalLink} from './ExternalLink';
import {safeAppURL} from './runtime-types';
export const publicCategoryNames:Record<string,string>={tools:'实用工具',monitoring:'服务监控',music:'音乐播放',video:'影视媒体',photos:'照片管理',sync:'文件同步',reading:'图书阅读'};
export function PublishedAppCard({app,busy,onInstall}:{app:CloudApp;busy:boolean;onInstall:(app:CloudApp)=>void}){
 const [detail,setDetail]=useState(false);const supported=!app.catalogOnly&&!!app.manifestDigest;
 return <><article className="runtime-card"><div className="runtime-card-heading"><span className="store-app-icon"><AppArtwork appId={app.id} icon={app.icon}/></span><div><h3>{app.name}</h3><small>{publicCategoryNames[app.category]||app.category} · {app.version}</small></div></div><p className="runtime-card-description">{app.description}</p>{!supported&&<small className="runtime-source-warning">安装支持待适配</small>}<div className="runtime-actions"><button aria-label={`查看 ${app.name}`} onClick={()=>setDetail(true)}>详情</button><button className={supported?'primary':'secondary'} aria-label={supported?`安装 ${app.name}`:`${app.name}安装支持待适配`} disabled={!supported||busy} onClick={()=>supported&&onInstall(app)}>{supported?'安装':'待适配'}</button></div></article>{detail&&<div className="wizard-backdrop"><section className="install-wizard" role="dialog" aria-modal="true" aria-label={`${app.name} 详情`}><header><h2>{app.name}</h2><button onClick={()=>setDetail(false)}>关闭详情</button></header><div className="wizard-body"><p>{app.description}</p><p>{supported?'镜像架构与部署清单已核验；安装时将确认 NAS 的目录、端口和应用配置。':app.compatibilityNote||'安装支持待适配。'}</p><p>版本：{app.version}</p>{app.sourceURL&&safeAppURL(app.sourceURL)&&<ExternalLink href={app.sourceURL}>项目来源</ExternalLink>}</div></section></div>}</>;
}
