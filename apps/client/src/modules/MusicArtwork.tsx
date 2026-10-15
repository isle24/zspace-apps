import {useEffect,useRef,useState} from 'react';
import {MusicNote} from '@phosphor-icons/react';
import {api,safeMediaUrl,type Item} from '../api/client';
let cachedSession='';const cache=new Map<string,Promise<Blob|null>>();let running=0;const queue:Array<()=>void>=[];
async function artwork(item:Item){if(cachedSession!==api.nasSession){cache.clear();cachedSession=api.nasSession}const key=item.thumbnail||item.path||item.id;const existing=cache.get(key);if(existing)return existing;
 const promise=new Promise<Blob|null>((resolve,reject)=>{const run=()=>{running++;api.musicArtwork(item).then(resolve,reject).finally(()=>{running--;queue.shift()?.()})};if(running<3)run();else queue.push(run)});cache.set(key,promise);if(cache.size>64)cache.delete(cache.keys().next().value!);promise.catch(()=>cache.delete(key));return promise;}
export function MusicArtwork({item,className=''}:{item:Item;className?:string}){
 return <TrackArtwork key={JSON.stringify([api.nasSession,item.id,item.path,item.thumbnail])} item={item} className={className}/>;
}
function TrackArtwork({item,className}:{item:Item;className:string}){
 const initial=safeMediaUrl(item.thumbnail);const [failed,setFailed]=useState(false),[src,setSrc]=useState<string>();const root=useRef<HTMLSpanElement>(null);
 useEffect(()=>{let alive=true,url='';setSrc(undefined);if(initial&&!failed)return;
  const load=()=>{const session=api.nasSession;void artwork(item).then(blob=>{if(alive&&session===api.nasSession&&blob){url=URL.createObjectURL(blob);setSrc(url)}}).catch(()=>{})};
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer?.disconnect();load()}},{rootMargin:'150px'}):undefined;if(observer&&root.current)observer.observe(root.current);else load();return()=>{alive=false;observer?.disconnect();if(url)URL.revokeObjectURL(url)};
 },[api.nasSession,item.id,item.path,initial,failed]);
 const displayed=src||(!failed?initial:undefined);
 return <span ref={root} className={`music-artwork ${className}`} data-cover={displayed?'loaded':'placeholder'}>{displayed?<img alt={`${item.name}封面`} src={displayed} loading="lazy" onError={()=>{if(!src)setFailed(true);else setSrc(undefined)}}/>:<MusicNote weight="duotone"/>}</span>
}
