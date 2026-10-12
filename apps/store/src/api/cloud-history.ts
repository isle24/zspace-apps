import {cloud} from './cloud-catalog';
import {api} from './client';
import type {RuntimePlan,RuntimeJob} from '../modules/runtime-types';
const pending=new Set<string>();
export function trackCloudInstallHistory(plans:RuntimePlan[],catalogIds:Record<string,string>={}){
 if(!cloud.signedIn)return;
 const account=cloud.generation,scope=api.captureStoreScope();
 for(const plan of plans){
  if(plan.kind!=='install'||pending.has(plan.id))continue;
  pending.add(plan.id);
  const current=()=>account===cloud.generation&&scope.generation===api.captureStoreScope().generation&&scope.storeAddress===api.storeAddress;
  const deadline=Date.now()+30*60*1000;
  const finish=()=>pending.delete(plan.id);
  async function poll(){
   if(!current()||Date.now()>deadline){finish();return}
   try{
    const result=await api.store<{items:RuntimeJob[]}>('v2/jobs');if(!current()){finish();return}
    const job=result.items.find(j=>j.planId===plan.id);
    if(job?.status==='succeeded'){
     const id=catalogIds[plan.id] || (plan.appId.startsWith('cloud-')?plan.appId.slice(6):plan.appId);
     await cloud.request('history',{appId:id,version:plan.targetVersion,status:'installed',deviceName:deviceNickname()});finish();
     window.dispatchEvent(new Event('space-cloud-history'));return;
    }
    if(job&&['failed','cancelled','needs_attention'].includes(job.status)){finish();return}
   }catch{if(!current()){finish();return}}
   setTimeout(()=>void poll(),2500);
  }
  void poll();
 }
}
export function deviceNickname(){try{return localStorage.getItem('space-cloud-device-nickname')||'我的 NAS'}catch{return '我的 NAS'}}
export function setDeviceNickname(value:string){const name=value.trim();if(!name||[...name].length>80||!/^[-\p{L}\p{N} _().]+$/u.test(name)||/^\d+\.\d+\.\d+\.\d+$/.test(name))throw Error('请填写 1–80 位设备昵称，不要填写 IP 地址');localStorage.setItem('space-cloud-device-nickname',name)}
