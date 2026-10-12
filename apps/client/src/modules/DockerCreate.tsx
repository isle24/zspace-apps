import { ManagementOverlay } from "./ManagementOverlay";
import { useState } from "react";
import { X } from "@phosphor-icons/react";
import { api, message } from "../api/client";
import { Status, useResource } from "./common";
type Port={host:string;container:string;protocol:"tcp"|"udp"};
export function DockerCreate({close,finished}:{close:()=>void;finished:()=>void}){
 const resource=useResource(()=>api.docker<{images:Array<{id:string;tags:string[];displayName?:string}>}>("images"),[api.nasSession]);
 const [name,setName]=useState(""),[image,setImage]=useState(""),[ports,setPorts]=useState<Port[]>([]),[volumes,setVolumes]=useState<Array<{name:string;target:string}>>([]),[environment,setEnvironment]=useState<Array<{name:string;value:string}>>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[created,setCreated]=useState("");
 async function submit(){
  if(busy||created)return;setBusy(true);setError("");const session=api.nasSession;
  let id="";
  try{
   if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)||!image)throw new Error("请输入有效的容器名称并选择镜像");
   const result=await api.docker<{id:string;state:string}>("create",{name,imageId:image,ports:ports.map(p=>({...p,host:Number(p.host),container:Number(p.container)})),volumes,environment});id=result.id;
   if(session!==api.nasSession)return;setCreated(id);
   await api.docker("control",{id,action:"start"});if(session!==api.nasSession)return;
   setNotice("容器已创建，运行状态已确认。");
  }catch(e){if(session===api.nasSession){setError((id?"容器已创建，启动未完成。请在容器列表检查状态。 ":"")+message(e))}}
  finally{if(session===api.nasSession){setBusy(false);if(id)finished();}}
 }
 const updatePort=(index:number,key:keyof Port,value:string)=>setPorts(rows=>rows.map((r,i)=>i===index?{...r,[key]:value}:r));
 return <ManagementOverlay><section className="management-dialog" role="dialog" aria-modal="true" aria-label="创建容器"><header><h2>创建容器</h2><button className="icon-button" aria-label="关闭创建容器" disabled={busy} onClick={close}><X/></button></header><Status {...resource} retry={resource.reload}/>
 <form onSubmit={e=>{e.preventDefault();void submit()}}><fieldset disabled={busy||!!created}><label className="field">容器名称<input aria-label="容器名称" value={name} onChange={e=>setName(e.target.value)} required placeholder="例如 my-reader"/></label>
 <label className="field">本地镜像<select aria-label="本地镜像" required value={image} onChange={e=>setImage(e.target.value)}><option value="">选择已下载的镜像</option>{resource.data?.images.map(i=><option key={i.id} value={i.id} disabled={!i.displayName&&!i.tags?.some(t=>t!=="<none>:<none>")}>{i.tags?.filter(t=>t!=="<none>:<none>").join(" / ")||i.displayName||`未命名镜像 ${resource.data!.images.indexOf(i)+1}（无仓库标签）`}</option>)}</select></label>
 <h3>端口映射</h3><p className="hint">主机端口是局域网访问端口，容器端口来自镜像说明。</p>{ports.map((p,index)=><div className="create-row" key={index}><input aria-label={`主机端口 ${index+1}`} type="number" min="1" max="65535" required value={p.host} placeholder="主机端口" onChange={e=>updatePort(index,"host",e.target.value)}/><span>→</span><input aria-label={`容器端口 ${index+1}`} type="number" min="1" max="65535" required value={p.container} placeholder="容器端口" onChange={e=>updatePort(index,"container",e.target.value)}/><select aria-label={`端口协议 ${index+1}`} value={p.protocol} onChange={e=>updatePort(index,"protocol",e.target.value)}><option>tcp</option><option>udp</option></select><button type="button" aria-label={`移除端口映射 ${index+1}`} onClick={()=>setPorts(rows=>rows.filter((_,i)=>i!==index))}><X/></button></div>)}<button type="button" className="secondary" onClick={()=>setPorts(rows=>[...rows,{host:"",container:"",protocol:"tcp"}])}>添加端口映射</button>
 <h3>持久化数据</h3><p className="hint">命名数据卷保存应用文件；名称以 space-client- 开头。停止容器会保留数据。</p>{volumes.map((v,index)=><div className="create-row" key={index}><input aria-label={`数据卷名称 ${index+1}`} required value={v.name} onChange={e=>setVolumes(rows=>rows.map((r,i)=>i===index?{...r,name:e.target.value}:r))}/><input aria-label={`容器目录 ${index+1}`} required value={v.target} placeholder="/data" onChange={e=>setVolumes(rows=>rows.map((r,i)=>i===index?{...r,target:e.target.value}:r))}/><button type="button" aria-label={`移除数据卷字段 ${index+1}`} onClick={()=>setVolumes(rows=>rows.filter((_,i)=>i!==index))}><X/></button></div>)}<button type="button" className="secondary" onClick={()=>setVolumes(rows=>[...rows,{name:`space-client-${name||"data"}`,target:"/data"}])}>添加数据卷</button>
 <h3>环境变量</h3>{environment.map((v,index)=><div className="create-row" key={index}><input aria-label={`变量名称 ${index+1}`} required value={v.name} onChange={e=>setEnvironment(rows=>rows.map((r,i)=>i===index?{...r,name:e.target.value}:r))}/><input aria-label={`变量值 ${index+1}`} type="password" value={v.value} autoComplete="off" onChange={e=>setEnvironment(rows=>rows.map((r,i)=>i===index?{...r,value:e.target.value}:r))}/><button type="button" aria-label={`移除环境变量字段 ${index+1}`} onClick={()=>setEnvironment(rows=>rows.filter((_,i)=>i!==index))}><X/></button></div>)}<button type="button" className="secondary" onClick={()=>setEnvironment(rows=>[...rows,{name:"",value:""}])}>添加环境变量</button></fieldset>
 <div className="management-actions"><button className="primary" disabled={busy||!!created||!image} type="submit">{busy?"正在创建并确认…":"创建并启动"}</button><button className="secondary" type="button" disabled={busy} onClick={close}>{created?"返回容器列表":"取消"}</button></div></form>{error&&<p role="alert" className="error-text">{error}</p>}{notice&&<p role="status">{notice}</p>}</section></ManagementOverlay>;
}
