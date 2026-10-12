import {expect,it} from 'vitest';
import {extractEmbeddedArtwork} from './embedded-art';
const syn=(n:number)=>[n>>21&127,n>>14&127,n>>7&127,n&127];
it('extracts an ID3 APIC image instead of downloading the audio payload',async()=>{const art=[255,216,255,225,0,1,2,3];const body=[0,...new TextEncoder().encode('image/jpeg'),0,3,0,...art];const frame=[...new TextEncoder().encode('APIC'),0,0,0,body.length,0,0,...body];const bytes=new Uint8Array([...new TextEncoder().encode('ID3'),3,0,0,...syn(frame.length),...frame]);const blob=extractEmbeddedArtwork(bytes);expect(blob?.type).toBe('image/jpeg');expect(blob?.size).toBe(art.length)});
it('rejects truncated and oversized frames without reading outside the provided bytes',()=>{expect(extractEmbeddedArtwork(new Uint8Array([73,68,51,3,0,0,127,127,127,127]))).toBeNull();expect(extractEmbeddedArtwork(new Uint8Array([1,2,3]))).toBeNull()});
