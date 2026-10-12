/** Extract only a bounded JPEG/PNG picture from ID3 or FLAC metadata. */
export function extractEmbeddedArtwork(bytes:Uint8Array):Blob|null{
 const ascii=(at:number,n:number)=>String.fromCharCode(...bytes.subarray(at,at+n));
 const u32=(at:number)=>at+4<=bytes.length?new DataView(bytes.buffer,bytes.byteOffset+at,4).getUint32(0):0;
 const syn=(at:number)=>{const a=bytes.subarray(at,at+4);return a.length===4&&a.every(n=>n<128)?a[0]*2097152+a[1]*16384+a[2]*128+a[3]:-1};
 const picture=(at:number,length:number)=>{if(length<4||length>4*1024*1024||at<0||at+length>bytes.length)return null;const data=bytes.slice(at,at+length);const type=data[0]===255&&data[1]===216&&data[2]===255?'image/jpeg':ascii(at,8)==='\x89PNG\r\n\x1a\n'?'image/png':'';return type?new Blob([data],{type}):null};
 if(ascii(0,3)==='ID3'&&[3,4].includes(bytes[3])&&!(bytes[5]&0xc0)){
  const tag=syn(6);if(tag<0)return null;let offset=10;const end=Math.min(bytes.length,10+tag);
  for(let n=0;n<256&&offset+10<=end;n++){
   const name=ascii(offset,4),size=bytes[3]===4?syn(offset+4):u32(offset+4),flags=bytes[offset+9];if(size<1||offset+10+size>end)break;const begin=offset+10,last=begin+size;
   if(name==='APIC'&&!flags){let at=begin+1;while(at<last&&bytes[at]!==0)at++;at+=2;const encoding=bytes[begin];if(encoding===0||encoding===3){while(at<last&&bytes[at]!==0)at++;at++}else if(encoding===1||encoding===2){while(at+1<last&&(bytes[at]!==0||bytes[at+1]!==0))at+=2;at+=2}else return null;return picture(at,last-at)}offset=last;
  }
 }else if(ascii(0,4)==='fLaC'){
  let offset=4;for(let n=0;n<128&&offset+4<=bytes.length;n++){const flags=bytes[offset],size=bytes[offset+1]*65536+bytes[offset+2]*256+bytes[offset+3],end=offset+4+size;if(end>bytes.length)break;if((flags&127)===6){let at=offset+8;if(at+4>end)return null;const mime=u32(at);at+=4+mime;if(at+4>end)return null;const description=u32(at);at+=4+description+16;if(at+4>end)return null;const length=u32(at);at+=4;return at+length<=end?picture(at,length):null}offset=end;if(flags&128)break}
 }
 return null;
}
