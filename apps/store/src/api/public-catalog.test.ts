import {expect,it,vi} from 'vitest';
vi.unmock('./public-catalog');
import {readPublicCatalog} from './public-catalog';
const listing={id:'native-reference',name:'资料',description:'公开资料',category:'tools',icon:'',version:'1.0',image:'',containerPort:0,dataTargets:[],environment:[],published:true,releaseNumber:0,catalogOnly:true,compatibilityNote:'待适配'};
it('reads public applications without transmitting user credentials',async()=>{
 const fetcher=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>new Response(JSON.stringify({ok:true,data:{items:[listing]}}),{status:200}));
 expect((await readPublicCatalog(fetcher as typeof fetch)).items[0].catalogOnly).toBe(true);
 expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
 expect(fetcher.mock.calls[0][1]?.headers).toBeUndefined();
});
it('uses the public Github fallback and rejects executable fields in metadata-only references',async()=>{
 const fetcher=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(new Response(JSON.stringify({items:[listing]}),{status:200}));
 expect((await readPublicCatalog(fetcher)).items).toHaveLength(1);
 expect(fetcher.mock.calls[1][0]).toContain('catalog-apps.json');
 const invalid=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>new Response(JSON.stringify({ok:true,data:{items:[{...listing,image:'nginx:stable',manifestDigest:'fake'}]}}),{status:200}));
 await expect(readPublicCatalog(invalid as typeof fetch)).rejects.toThrow();
});
it('tries Github with a fresh deadline after the primary catalog times out',async()=>{
 vi.useFakeTimers();
 try{
  const fetcher=vi.fn((_url:string|URL|Request,init?:RequestInit)=>String(_url).startsWith('https://raw.githubusercontent.com')?Promise.resolve(new Response(JSON.stringify({items:[listing]}))):new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));
  const pending=readPublicCatalog(fetcher as typeof fetch);
  const assertion=expect(pending).resolves.toMatchObject({items:[listing]});
  await vi.advanceTimersByTimeAsync(10001);
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(false);
 }finally{vi.useRealTimers()}
});
