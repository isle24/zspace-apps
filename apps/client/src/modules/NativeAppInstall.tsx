import { useState } from "react";
import { api, message } from "../api/client";
import { formatBytes, Status, useResource } from "./common";
export function NativeAppInstall({appName,finished}:{appName:string;finished:()=>void}){
 const resource=useResource(()=>api.prepareNativeApp(appName),[api.nasSession,appName]);
 const [disk,setDisk]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 async function install(){
  if(!resource.data||busy||notice)return;setBusy(true);setError("");const session=api.nasSession;
  try{const result=await api.installNativeApp({appName,version:resource.data.version,mp:disk});if(session!==api.nasSession)return;setNotice(result.installed?"应用安装状态已确认。":"安装任务已提交，设备正在处理。请稍后刷新应用列表确认完成。");finished()}
  catch(e){if(session===api.nasSession)setError(message(e))}finally{if(session===api.nasSession)setBusy(false)}
 }
 return <section className="management-confirm"><h3>安装应用</h3><Status {...resource} retry={resource.reload}/>{resource.data&&!resource.error&&<><label className="field">安装磁盘<select aria-label="安装磁盘" value={disk} disabled={busy||!!notice} onChange={e=>setDisk(e.target.value)}><option value="">选择设备上的存储空间</option>{resource.data.disks.map(d=><option key={d.mp} value={d.mp} disabled={!(d.free>0)}>{d.name} · {d.mp} · 可用 {formatBytes(d.free)}</option>)}</select></label><p className="hint">安装前会再次核对应用版本、依赖和磁盘。</p><button className="primary" disabled={!disk||busy||!!notice} onClick={()=>void install()}>{busy?"正在提交并确认…":"确认安装"}</button></>}{error&&<p className="error-text" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}</section>;
}
