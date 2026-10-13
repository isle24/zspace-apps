import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {VideoWindowBackdrop} from './VideoWindowBackdrop';
import {api} from '../api/client';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()});
function urls(){const create=vi.fn(()=>"blob:video-test");vi.stubGlobal('URL',class extends URL {static createObjectURL=create;static revokeObjectURL=vi.fn()});return create}
it('discards a late authenticated image after the selected artwork changes',async()=>{
 let finish!:(response:Response)=>void;vi.spyOn(api,'fetchMedia').mockImplementation(()=>new Promise(resolve=>{finish=resolve}));const create=urls(),failed=vi.fn();
 const {container,rerender}=render(<VideoWindowBackdrop source="https://nas.test/art.jpg?token=old-private" onFailure={failed}/>);
 rerender(<VideoWindowBackdrop source="https://nas.test/current.jpg" onFailure={failed}/>);
 await act(async()=>finish(new Response(new Uint8Array([1]),{headers:{'content-type':'image/png'}})));
 expect(container.querySelector('img')).toHaveAttribute('src','https://nas.test/current.jpg');expect(create).not.toHaveBeenCalled();expect(failed).not.toHaveBeenCalled();expect(container.innerHTML).not.toContain('old-private');
});
it('shows the neutral backdrop when protected artwork returns a non-image or exceeds the bound',async()=>{
 const read=vi.spyOn(api,'fetchMedia').mockResolvedValue(new Response('{}',{headers:{'content-type':'application/json'}}));const failed=vi.fn();const {container,rerender}=render(<VideoWindowBackdrop source="https://nas.test/art?token=one" onFailure={failed}/>);
 await waitFor(()=>expect(failed).toHaveBeenCalledOnce());expect(container.querySelector('img')).toBeNull();
 read.mockResolvedValue(new Response(new Uint8Array(8*1024*1024+1),{headers:{'content-type':'image/png'}}));rerender(<VideoWindowBackdrop source="https://nas.test/art?token=two" onFailure={failed}/>);
 await waitFor(()=>expect(failed).toHaveBeenCalledTimes(2));expect(container.querySelector('img')).toBeNull();expect(container.innerHTML).not.toContain('token=');
});
it('reports an artwork timeout without leaving the background pending',async()=>{
 vi.useFakeTimers();vi.spyOn(api,'fetchMedia').mockImplementation((_source,options)=>new Promise((_resolve,reject)=>{options?.signal?.addEventListener('abort',()=>reject(Error('aborted')))}));const failed=vi.fn();render(<VideoWindowBackdrop source="https://nas.test/art?token=private" onFailure={failed}/>);
 await act(async()=>vi.advanceTimersByTimeAsync(15000));expect(failed).toHaveBeenCalledOnce();
});
