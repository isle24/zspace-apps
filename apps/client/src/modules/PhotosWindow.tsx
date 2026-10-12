import {lazy,Suspense,useEffect,useState} from 'react';
import {ArrowLeft,ArrowClockwise,Baby,Folder,Heart,ImageSquare,Images,ShareNetwork,SquaresFour,Copy,Calendar} from '@phosphor-icons/react';
import {api,normalizeCollection,safeMediaUrl,type Item,type Collection} from '../api/client';
import {Status,useResource} from './common';
import {PhotoViewer} from './PhotoViewer';
import {supportsImagePreview} from '../api/official-nas';
import {localPhotoConnection} from './photo-quality';
const PhotoAlbumCreate=lazy(()=>import('./PhotoAlbumCreate').then(m=>({default:m.PhotoAlbumCreate})));
const sections=[['timeline','图库',ImageSquare],['folders','文件夹',Folder],['smart','智能分类',SquaresFour],['favorites','收藏',Heart],['albums','我的相册',Images],['baby','宝宝相册',Baby],['shared','共享相册',ShareNetwork],['duplicates','相似重复',Copy]] as const;
const smartTypes=[[100,'人物'],[150,'宠物'],[110,'场景'],[130,'地点'],[120,'回忆']] as const;
const PAGE=60;
function day(item:Item){const m=item.metadata??{};const value=String(m.cdate??'');if(/^\d{8}$/.test(value))return `${value.slice(0,4)} 年 ${Number(value.slice(4,6))} 月 ${Number(value.slice(6,8))} 日`;const timestamp=Number(m.crtime);return timestamp>0?new Date(timestamp*1000).toLocaleDateString('zh-CN'):'日期未知'}
function Artwork({item,original=false}:{item:Item;original?:boolean}){
 const identity=JSON.stringify([api.nasSession,item.id,item.path,item.metadata?.encrypted_path,item.metadata?.from,item.metadata?.up,item.metadata?.updated_at,original]);
 return <PhotoArtwork key={identity} item={item} original={original&&supportsImagePreview(item)}/>;
}
function PhotoArtwork({item,original}:{item:Item;original:boolean}){
 const session=api.nasSession;
 const thumbnail=safeMediaUrl(item.thumbnail);
 const [source,setSource]=useState(original?undefined:thumbnail),[fallback,setFallback]=useState(false),[failed,setFailed]=useState(false);
 useEffect(()=>{
  if(!original||!session)return;
  let alive=true;
  api.imageOriginal(item).then(value=>{
   if(alive&&session===api.nasSession){const url=safeMediaUrl(value);if(url)setSource(url);else{setFallback(true);setSource(thumbnail)}}
  }).catch(()=>{if(alive&&session===api.nasSession){setFallback(true);setSource(thumbnail)}});
  return ()=>{alive=false};
 },[session,original,item.path,item.metadata?.encrypted_path,item.metadata?.from,item.metadata?.up,item.metadata?.updated_at]);
 return <>{source&&!failed?<img src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>{if(original&&!fallback){setFallback(true);setSource(thumbnail)}else setFailed(true)}}/>:<ImageSquare className="photo-art-placeholder"/>}{fallback&&<span className="photo-quality-notice">原图暂不可用，显示预览</span>}</>;
}
export function PhotosWindow({connected}:{connected:boolean}){
 const [original,setOriginal]=useState(()=>localPhotoConnection(api.nas.session()?.baseUrl));
 useEffect(()=>setOriginal(localPhotoConnection(api.nas.session()?.baseUrl)),[api.nasSession]);
 const [creating,setCreating]=useState(false),[babyView,setBabyView]=useState('photos'),[growthDate,setGrowthDate]=useState('');
 const [section,setSection]=useState('timeline'),[parent,setParent]=useState<Item>(),[query,setQuery]=useState(''),[size,setSize]=useState(180),[page,setPage]=useState(1),[year,setYear]=useState(''),[smartType,setSmartType]=useState(100),[viewing,setViewing]=useState<Item>();
 const dates=useResource(async()=>connected?api.read('photos.dates'):{items:[]} as Collection,[api.nasSession,connected]);
 const dateList=(dates.data?.values?.list??[]) as Array<{date:string;num:number}>;
 const years=[...new Set(dateList.map(d=>String(d.date).slice(0,4)).filter(y=>/^\d{4}$/.test(y)))];
 const listing=!parent&&['folders','smart','albums','baby','shared'].includes(section);
 const resource=useResource(async()=>{
  if(!connected||section==='duplicates')return {items:[]} as any;
  let operation='photos.timeline';const params:Record<string,unknown>={page,pageSize:PAGE};
  if(parent){if(section==='folders')params.dir_id=parent.id;else{operation='photos.feeds';params.album_id=parent.id;if(growthDate)params.cdate_list=growthDate}}
  else if(section==='folders'){operation='photos.folders';delete params.page;delete params.pageSize}
  else if(section==='smart'){operation='photos.smart';delete params.page;delete params.pageSize}
  else if(['albums','baby','shared'].includes(section))operation='photos.albums';
  else if(section==='favorites')operation='photos.favorites';
  if(year&&section==='timeline'){const matching=dateList.filter(d=>String(d.date).startsWith(year)).map(d=>d.date);if(matching.length)params.cdate_list=matching.join(',')}
  return normalizeCollection(await api.read(operation,listing?{}:params));
 },[api.nasSession,connected,section,parent?.id,page,year,growthDate]);
 const all=(resource.data?.items??[]) as Item[];
 const filtered=all.filter(i=>{if(!i.name.toLowerCase().includes(query.toLowerCase()))return false;if(parent)return true;const type=Number(i.metadata?.type);if(section==='baby')return type===60;if(section==='shared')return Number(i.metadata?.can_shared)===1;if(section==='smart')return type===smartType&&!i.metadata?.is_hide;if(section==='albums')return [10,50,90].includes(type);return true});
 const visible=listing?filtered.slice((page-1)*PAGE,page*PAGE):filtered;
 const total=listing?filtered.length:resource.data?.total;
 const groups=new Map<string,Item[]>();for(const i of visible){const key=day(i);groups.set(key,[...(groups.get(key)??[]),i])}
 const select=(id:string)=>{setSection(id);setParent(undefined);setPage(1);setYear('');setQuery('');setBabyView('photos');setGrowthDate('')};
 const albumBaby=parent&&Number(parent.metadata?.type)===60;
 const growth=useResource(async()=>albumBaby&&babyView==='growth'?api.read('photos.growth',{album_id:parent!.id,order:'desc',isMilestone:0}):undefined,[api.nasSession,parent?.id,albumBaby,babyView]);
 const growthRows=(growth.data?.values?.list??[]) as Array<{Cdate:number;Num:number;babyGrowth?:{id?:number;desc?:string;locationStr?:string}}>;
 return <div className="photos-workspace"><aside className="photos-sidebar"><h2><Images/>相册</h2><nav aria-label="相册功能">{sections.map(([id,name,Icon])=><button key={id} className={id===section?'active':''} onClick={()=>select(id)}><Icon/>{name}</button>)}</nav><p>照片保存在你的 NAS 上</p></aside><main className="photos-main"><header className="photos-toolbar"><label className="official-search"><input aria-label="搜索当前相册内容" placeholder="搜索当前内容" value={query} onChange={e=>setQuery(e.target.value)}/></label>{connected&&["albums","baby"].includes(section)&&!parent&&<button className="secondary" onClick={()=>setCreating(true)}>＋ {section==="baby"?"创建宝宝相册":"创建相册"}</button>}<div className="photo-quality" role="group" aria-label="照片清晰度"><button aria-pressed={original} onClick={()=>setOriginal(true)}>原图</button><button aria-pressed={!original} onClick={()=>setOriginal(false)}>预览</button></div><label className="photo-zoom">大小<input type="range" aria-label="缩略图大小" min="100" max="280" value={size} onChange={e=>setSize(Number(e.target.value))}/></label><button className="icon-button" aria-label="刷新相册" onClick={()=>resource.reload()}><ArrowClockwise/></button></header>
 <div className="photos-title">{parent&&<button className="icon-button" aria-label="返回相册列表" onClick={()=>{setParent(undefined);setPage(1)}}><ArrowLeft/></button>}<h1>{parent?.name??sections.find(s=>s[0]===section)?.[1]}</h1>{typeof total==='number'&&<span>共 {total.toLocaleString()} {listing?'个':'项'}</span>}</div>
 {section==='smart'&&!parent&&<nav className="photo-smart-tabs">{smartTypes.map(([id,name])=><button className={smartType===id?'active':''} key={id} onClick={()=>{setSmartType(id);setPage(1)}}>{name}</button>)}</nav>}
 {albumBaby&&<div className="baby-banner"><Baby/><div><strong>{parent.name}的成长时光</strong><p>{parent.metadata?.birthday?`出生于 ${String(parent.metadata.birthday).split(' ')[0]}`:'记录每一个值得珍藏的瞬间'} · {Number(parent.metadata?.fnum??0)} 张照片</p></div></div>}
 {albumBaby&&<nav className="photo-smart-tabs"><button className={babyView==='photos'?'active':''} onClick={()=>setBabyView('photos')}>照片与视频</button><button className={babyView==='growth'?'active':''} onClick={()=>setBabyView('growth')}>成长记录</button>{growthDate&&<button onClick={()=>{setGrowthDate('');setPage(1)}}>显示所有日期</button>}</nav>}
 {albumBaby&&babyView==='growth'?<section className="baby-growth-list"><Status {...growth} retry={growth.reload}/>{growthRows.map(row=><article key={row.Cdate}><span className="growth-dot"/><h3>{String(row.Cdate).replace(/(\d{4})(\d{2})(\d{2})/,'$1 年 $2 月 $3 日')}</h3>{row.babyGrowth?.desc&&<p>{row.babyGrowth.desc}</p>}{row.babyGrowth?.locationStr&&<small>{row.babyGrowth.locationStr}</small>}<button className="secondary" onClick={()=>{setGrowthDate(String(row.Cdate));setPage(1);setBabyView('photos')}}>查看这一天的照片 · {row.Num} 项</button></article>)}{growth.data&&!growthRows.length&&<p>还没有成长记录。照片与视频可在另一页浏览。</p>}</section>:section==='duplicates'?<section className="photo-capability"><Copy/><h2>相似与重复照片</h2><p>当前固件的相册接口没有返回重复分组。你可以在 NAS 的文件清理工具中扫描后查看；这里暂不能展示可信的相似结果。</p></section>:<><Status {...resource} connected={connected} retry={resource.reload}/>{!resource.loading&&!resource.error&&connected&&visible.length===0&&<div className="photo-empty"><Images/><h2>{section==='baby'?'还没有宝宝相册':'这里还没有内容'}</h2><p>{section==='baby'?'在 NAS 相册创建宝宝相册后，可在这里浏览照片和成长信息。':'试试其他分类，或清除当前搜索条件。'}</p></div>}
 <div className="photos-scroll">{listing?<div className="album-mosaic" style={{gridTemplateColumns:`repeat(auto-fill,minmax(${size}px,1fr))`}}>{visible.map(i=><button key={i.id} className="album-tile" onClick={()=>{setParent(i);setPage(1);setQuery('')}}><div className="album-art"><Artwork key={i.id} item={i}/>{section==='baby'&&<span className="baby-tag"><Baby/>成长相册</span>}</div><strong>{i.name}</strong><small>{Number(i.metadata?.fnum??i.metadata?.inum??0).toLocaleString()} 张{section==='folders'&&Number(i.metadata?.vnum)>0?` · ${i.metadata?.vnum} 个视频`:''}{section==='baby'&&i.metadata?.birthday?` · ${String(i.metadata.birthday).split(' ')[0]}`:''}</small></button>)}</div>:<>{[...groups].map(([date,items])=><section className="photo-date-group" key={date}><h3><Calendar/>{date}<small>{items.length} 项</small></h3><div className="photo-mosaic" style={{gridTemplateColumns:`repeat(auto-fill,minmax(${size}px,1fr))`}}>{items.map(i=><button key={i.id} className="photo-tile" aria-label={`查看 ${i.name}`} title={i.name} onClick={()=>setViewing(i)}><Artwork key={i.id} item={i} original={original}/>{Number(i.metadata?.ilike)===1&&<Heart weight="fill" className="photo-favorite"/>}</button>)}</div></section>)}</>}
 </div><footer className="photos-pagination"><button className="secondary" disabled={page===1} onClick={()=>setPage(p=>p-1)}>上一页</button><span>第 {page} 页</span><button className="secondary" disabled={typeof total==='number'?page*PAGE>=total:visible.length<PAGE} onClick={()=>setPage(p=>p+1)}>下一页</button></footer></>}
 {section==='timeline'&&years.length>0&&<nav className="photo-years" aria-label="照片年份"><button className={!year?'active':''} onClick={()=>{setYear('');setPage(1)}}>全部</button>{years.map(y=><button key={y} className={year===y?'active':''} onClick={()=>{setYear(y);setPage(1)}}>{y}</button>)}</nav>}
 </main>{creating&&<Suspense fallback={<p role="status">正在打开相册创建…</p>}><PhotoAlbumCreate baby={section==="baby"} close={()=>setCreating(false)} created={item=>{setCreating(false);resource.reload();setParent(item);setPage(1)}}/></Suspense>}{viewing&&<PhotoViewer preferOriginal={original} items={visible} index={Math.max(0,visible.findIndex(i=>i.id===viewing.id))} onIndex={index=>setViewing(visible[index])} onClose={()=>setViewing(undefined)}/>}</div>;
}
