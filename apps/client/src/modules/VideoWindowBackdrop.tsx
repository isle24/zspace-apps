import {useEffect,useRef,useState} from 'react';
import {api} from '../api/client';

const maxArtworkBytes=8*1024*1024;
// A browser media URL can carry the NAS session in its query. Keep that URL
// inside the existing authenticated reader; the decorative DOM gets a blob.
function needsPrivateRead(source:string){try{return new URL(source,location.href).search!==''}catch{return true}}

export function VideoWindowBackdrop({source,onFailure}:{source?:string;onFailure:()=>void}){
 const [loaded,setLoaded]=useState<{source:string;url:string}>(),[failed,setFailed]=useState(false);
 const failure=useRef(onFailure);failure.current=onFailure;
 const privateRead=!!source&&needsPrivateRead(source);
 useEffect(()=>{
  setLoaded(undefined);setFailed(false);
  if(!source||!privateRead)return;
  let active=true,blobURL='';const session=api.nasSession,controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  void(async()=>{
   const response=await api.fetchMedia(source,{signal:controller.signal});
   const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()||'';
   if(!response.ok||!/^image\/(jpeg|png|webp|avif)$/.test(type))throw Error('Artwork unavailable');
   const reader=response.body?.getReader();if(!reader)throw Error('Artwork unavailable');
   const chunks:BlobPart[]=[];let bytes=0;
   try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxArtworkBytes)throw Error('Artwork too large');chunks.push(new Uint8Array(next.value))}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
   if(!bytes)throw Error('Artwork unavailable');
   if(!active||session!==api.nasSession||controller.signal.aborted)return;
   blobURL=URL.createObjectURL(new Blob(chunks,{type}));setLoaded({source,url:blobURL});
  })().catch(()=>{if(active&&session===api.nasSession){setFailed(true);failure.current()}}).finally(()=>clearTimeout(timer));
  return()=>{active=false;controller.abort();clearTimeout(timer);if(blobURL)URL.revokeObjectURL(blobURL)};
 },[source,privateRead]);
 const shown=failed?undefined:privateRead?(loaded?.source===source?loaded.url:undefined):source;
 const reject=()=>{setFailed(true);failure.current()};
 return <div className="video-window-backdrop" aria-hidden="true">{shown&&<img className="video-window-art" src={shown} alt="" referrerPolicy="no-referrer" draggable={false} onError={reject} onLoad={e=>{if(e.currentTarget.naturalWidth<e.currentTarget.naturalHeight*1.2)reject()}}/>}<div className="video-window-shade"/></div>;
}
