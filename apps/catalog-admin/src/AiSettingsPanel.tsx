import {useEffect,useState} from 'react';
import {adminApi} from './api';

type AISettings={endpoint:string;model:string;apiKeyConfigured:boolean;configured?:boolean};
const message=(e:unknown)=>e instanceof Error?e.message:'AI 设置操作失败';

export function AiSettingsPanel(){
 const [endpoint,setEndpoint]=useState('https://api.openai.com/v1'),[model,setModel]=useState(''),[apiKey,setAPIKey]=useState(''),[configured,setConfigured]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{let active=true;void adminApi.request<AISettings>('store/admin/ai-settings').then(settings=>{if(!active)return;if(settings.endpoint)setEndpoint(settings.endpoint);setModel(settings.model||'');setConfigured(settings.apiKeyConfigured)}).catch(e=>{if(active)setError(message(e))}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[]);
 async function save(){setBusy(true);setError('');setNotice('');try{const settings=await adminApi.request<AISettings>('store/admin/ai-settings',{endpoint:endpoint.trim(),model:model.trim(),...(apiKey?{apiKey}:{})});setAPIKey('');setConfigured(settings.apiKeyConfigured);setNotice('AI 设置已保存。')}catch(e){setError(message(e))}finally{setBusy(false)}}
 return <article className="ai-settings"><h2>AI 辅助填写</h2><p>配置兼容 OpenAI 的服务后，输入 Docker 镜像即可生成完整的应用资料草稿。保存和发布前请核对内容。</p><form onSubmit={e=>{e.preventDefault();void save()}}><fieldset disabled={busy||loading}><label>接口地址<input aria-label="AI 接口地址" type="url" required maxLength={1000} placeholder="https://服务地址/v1" value={endpoint} onChange={e=>setEndpoint(e.target.value)}/></label><label>模型<input aria-label="AI 模型" required maxLength={128} placeholder="服务支持的模型名称" value={model} onChange={e=>setModel(e.target.value)}/></label><label>API 密钥<input aria-label="AI 密钥" type="password" autoComplete="off" maxLength={4096} placeholder={configured?'已配置，留空保留当前密钥':'填写服务的 API 密钥'} value={apiKey} onChange={e=>setAPIKey(e.target.value)}/></label><p className="hint">密钥加密保存在服务器，读取设置时不会返回密钥。</p><button className="primary" type="submit">{busy?'正在保存…':'保存 AI 设置'}</button></fieldset></form>{loading&&<p role="status">正在读取 AI 设置…</p>}{error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="success" role="status">{notice}</p>}</article>
}
