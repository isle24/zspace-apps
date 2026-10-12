import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {CacheSettingsPanel} from './CacheSettingsPanel';
import {adminApi} from './api';
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it('waits for stored cache settings before allowing a save',async()=>{
 let loaded!:(value:unknown)=>void;
 vi.spyOn(adminApi,'request').mockImplementation(()=>new Promise(resolve=>{loaded=resolve}) as never);
 render(<CacheSettingsPanel/>);
 expect(screen.getByRole('button',{name:'保存缓存设置'})).toBeDisabled();
 loaded({enabled:true,maxBytes:10*1024**3,usedBytes:0,items:[]});
 await waitFor(()=>expect(screen.getByLabelText('缓存池容量')).toHaveValue(10));
 expect(screen.getByLabelText('启用镜像缓存池')).toBeChecked();
 expect(screen.getByRole('button',{name:'保存缓存设置'})).toBeEnabled();
});
