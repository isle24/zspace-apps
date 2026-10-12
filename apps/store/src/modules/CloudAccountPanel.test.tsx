import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {CloudAccountPanel} from './CloudAccountPanel';
import {cloud} from '../api/cloud-catalog';
afterEach(()=>{cleanup();vi.restoreAllMocks();cloud.clear()});
it('validates the simple registration rules before making a request',async()=>{
 const register=vi.spyOn(cloud,'register');render(<CloudAccountPanel/>);
 fireEvent.click(screen.getByRole('button',{name:'注册账号'}));
 fireEvent.change(screen.getByLabelText('商店用户名'),{target:{value:'abc'}});
 fireEvent.change(screen.getByLabelText('商店密码'),{target:{value:'123456'}});
 fireEvent.submit(screen.getByRole('form',{name:'商店账号'}));
 expect(await screen.findByText('用户名至少 4 位，密码至少 6 位')).toBeInTheDocument();expect(register).not.toHaveBeenCalled();
});
it('shows a wishlist submitted by the current account and its server status',async()=>{
 vi.spyOn(cloud,'user','get').mockReturnValue({id:'one',username:'alice',role:'user'});
 const call=vi.spyOn(cloud,'request').mockImplementation(async(path,body:any)=>{if(path==='wishlist')return {items:body?[{id:'wish',name:body.name,description:body.description,status:'pending',createdAt:'2026-10-12T00:00:00Z'}]:[]} as never;return {items:[]} as never});
 render(<CloudAccountPanel/>);fireEvent.click(screen.getByRole('button',{name:'心愿单'}));
 fireEvent.change(await screen.findByLabelText('希望上架的应用'),{target:{value:'家庭日历'}});
 fireEvent.change(screen.getByLabelText('心愿说明'),{target:{value:'家庭共享日程'}});
 fireEvent.click(screen.getByRole('button',{name:'提交心愿'}));
 expect(await screen.findByText('心愿已提交，管理员会在这里更新处理进度。')).toBeInTheDocument();
 expect(call.mock.calls.some(c=>c[0]==='wishlist'&&!!c[1])).toBe(true);
});
it('retains fallback applications when private history services are unavailable',async()=>{vi.spyOn(cloud,'user','get').mockReturnValue({id:'one',username:'alice',role:'user'});vi.spyOn(cloud,'request').mockImplementation(async(path)=>{if(path==='catalog')return {items:[{id:'reader',name:'备用阅读器',icon:'',description:'备用资料',version:'1.0',category:'reading',environment:[]}]} as never;throw Error('后台不可用')});render(<CloudAccountPanel/>);expect(await screen.findByText('备用阅读器')).toBeInTheDocument();expect(await screen.findByText(/应用目录仍可浏览/)).toBeInTheDocument()});
