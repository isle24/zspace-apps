import {useState} from 'react';
import {Cube} from '@phosphor-icons/react';
import {cloudArtworkSources} from '../../store/src/api/cloud-artwork';
import {adminApi} from './api';
export function IconPreview({icon,uploaded,alt='应用图标预览'}:{icon:string;uploaded?:{mimeType:string;base64:string};alt?:string}){
 const [index,setIndex]=useState(0);
 const sources=uploaded?[`data:${uploaded.mimeType};base64,${uploaded.base64}`]:cloudArtworkSources(icon,adminApi.base);
 return sources[index]?<img className="icon-preview" src={sources[index]} alt={alt} referrerPolicy="no-referrer" onError={()=>setIndex(i=>i+1)}/>:<Cube className="icon-preview" aria-label="暂无可预览图标" weight="duotone"/>;
}
