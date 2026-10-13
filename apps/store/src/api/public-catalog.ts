import type {CloudApp} from './cloud-catalog';
export type PublicCatalog={items:CloudApp[]};
const maxBytes=2*1024*1024;
function validate(value:unknown):PublicCatalog{
 const data=value as PublicCatalog;
 if(!data||!Array.isArray(data.items)||data.items.length>1000)throw Error('公开应用目录格式无效');
 const seen=new Set<string>();
 for(const app of data.items){
  if(!app||typeof app.id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(app.id)||seen.has(app.id)||typeof app.name!=='string'||typeof app.description!=='string'||typeof app.category!=='string'||typeof app.icon!=='string'||typeof app.version!=='string'||typeof app.image!=='string'||typeof app.containerPort!=='number'||!Array.isArray(app.dataTargets)||app.dataTargets.some(t=>typeof t!=='string')||app.published!==true||typeof app.releaseNumber!=='number'||app.catalogOnly!==undefined&&typeof app.catalogOnly!=='boolean')throw Error('公开应用目录格式无效');
  seen.add(app.id);
  if(app.environment!==undefined&&(!Array.isArray(app.environment)||app.environment.length>32||app.environment.some(e=>!e||typeof e.name!=='string'||typeof e.label!=='string'||typeof e.secret!=='boolean'||e.secret&&e.default!==undefined)))throw Error('公开应用变量格式无效');
  if(app.sourceURL!==undefined){try{const url=new URL(app.sourceURL);if(url.protocol!=='https:'||url.username||url.password)throw Error()}catch{throw Error('项目来源格式无效')}}
  if(app.catalogOnly&&(app.image!==''||app.containerPort!==0||app.releaseNumber!==0||app.manifestDigest||app.dataTargets.length||(app.environment?.length??0)>0||typeof app.compatibilityNote!=='string'))throw Error('待适配资料不能包含安装清单');
 }
 return data;
}
async function readJSON(response:Response){
 if(!response.body)throw Error('公开目录暂不可用');
 const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxBytes)throw Error('公开目录过大');chunks.push(next.value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length}
 return JSON.parse(new TextDecoder().decode(buffer));
}
export async function readPublicCatalog(fetcher:typeof fetch=(...args)=>fetch(...args)):Promise<PublicCatalog>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
 const options:RequestInit={credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal};
 try{
  let response:Response|undefined;
  try{response=await fetcher('https://zstore.2iwm.com/api/cloud/public-catalog',options)}catch{if(controller.signal.aborted)throw Error('公开目录读取超时')}
  if(response?.ok){const result=await readJSON(response);if(result?.ok!==true)throw Error('公开目录暂不可用');return validate(result.data)}
  const fallback=await fetcher('https://raw.githubusercontent.com/isle24/nas-app-store-catalog/main/catalog-apps.json',options);
  if(!fallback.ok)throw Error('公开目录与备用资料暂不可用');
  return validate(await readJSON(fallback));
 }finally{clearTimeout(timer)}
}
