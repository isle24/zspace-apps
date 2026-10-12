import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {ComposeImport} from './ComposeImport';
import {adminApi,type CloudApp} from './api';
afterEach(()=>{cleanup();vi.restoreAllMocks()});
const draft:CloudApp={id:'reader',name:'Reader',description:'Read books',image:'nginx:stable',version:'1.0',category:'reading',icon:'',containerPort:80,dataTargets:['/data'],environment:[],published:false,releaseNumber:0};
it('imports a draft and passes warnings to the editor without saving or publishing',async()=>{
 const call=vi.spyOn(adminApi,'request').mockResolvedValue({app:draft,warnings:['请确认数据目录']} as never),onImport=vi.fn();
 render(<ComposeImport onImport={onImport}/>);
 const compose='services:\n  reader:\n    image: nginx:stable\n    ports: [80]';
 fireEvent.change(screen.getByLabelText('Docker Compose 内容'),{target:{value:compose}});
 fireEvent.click(screen.getByRole('button',{name:'导入为应用草稿'}));
 await screen.findByText('请确认数据目录');
 expect(call).toHaveBeenCalledExactlyOnceWith('store/admin/import-compose',{compose});
 expect(onImport).toHaveBeenCalledExactlyOnceWith(draft,['请确认数据目录']);
});
it('shows unsupported Compose errors without discarding the entered services',async()=>{
 vi.spyOn(adminApi,'request').mockRejectedValue(Error('当前导入支持单服务 Compose'));const onImport=vi.fn();
 render(<ComposeImport onImport={onImport}/>);
 const compose='services: {first: {}, second: {}}';fireEvent.change(screen.getByLabelText('Docker Compose 内容'),{target:{value:compose}});
 fireEvent.click(screen.getByRole('button',{name:'导入为应用草稿'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('当前导入支持单服务 Compose');
 expect(screen.getByLabelText('Docker Compose 内容')).toHaveValue(compose);expect(onImport).not.toHaveBeenCalled();
});
