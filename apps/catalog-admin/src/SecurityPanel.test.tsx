import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {adminApi} from './api';
import {SecurityPanel} from './SecurityPanel';
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it('shows the production binding guide and does not enable until an OTP is confirmed',async()=>{
 const changed=vi.fn();const request=vi.spyOn(adminApi,'request').mockImplementation(async(path,body:any)=>{
  if(path==='store/admin/2fa')return {bound:false,enabled:false,required:true,pending:false} as never;
  if(path.endsWith('/setup'))return {challengeId:'challenge',secret:'TESTSECRET',otpauthUri:'otpauth://totp/test',qrDataUrl:'data:image/png;base64,test',expiresAt:new Date(Date.now()+600000).toISOString()} as never;
  if(body.otp==='111111')throw Error('动态码错误或已使用，请等待新的动态码。');
  return {bound:true,enabled:true,required:false,pending:false} as never;
 });render(<SecurityPanel onStatusChange={changed}/>);
 await screen.findByText('请先绑定双重验证，再使用管理功能。');
 fireEvent.change(screen.getByLabelText('安全验证密码'),{target:{value:'synthetic-pass'}});fireEvent.click(screen.getByRole('button',{name:'生成验证二维码'}));
 expect(await screen.findByAltText('双重验证二维码')).toHaveAttribute('src','data:image/png;base64,test');expect(changed).not.toHaveBeenCalledWith(expect.objectContaining({enabled:true}));
 fireEvent.change(screen.getByLabelText('安全验证密码'),{target:{value:'synthetic-pass'}});fireEvent.change(screen.getByLabelText('六位动态码'),{target:{value:'111111'}});fireEvent.click(screen.getByRole('button',{name:'验证并启用'}));await screen.findByText('动态码错误或已使用，请等待新的动态码。');expect(screen.getByAltText('双重验证二维码')).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('安全验证密码'),{target:{value:'synthetic-pass'}});fireEvent.change(screen.getByLabelText('六位动态码'),{target:{value:'222222'}});fireEvent.click(screen.getByRole('button',{name:'验证并启用'}));await screen.findByText('双重验证已启用');
 expect(request).toHaveBeenCalledWith('store/admin/2fa/confirm',{password:'synthetic-pass',otp:'222222',challengeId:'challenge'});expect(screen.queryByText('TESTSECRET')).not.toBeInTheDocument();expect(changed).toHaveBeenCalledWith(expect.objectContaining({enabled:true,required:false}));
});
it('requires password and a current code to explicitly disable a bound authenticator',async()=>{
 const request=vi.spyOn(adminApi,'request').mockImplementation(async(path)=>path.endsWith('/toggle')?{bound:true,enabled:false,required:false,pending:false} as never:{bound:true,enabled:true,required:false,pending:false} as never);render(<SecurityPanel/>);await screen.findByText('双重验证已启用');
 expect(screen.getByRole('button',{name:'停用双重验证'})).toBeDisabled();fireEvent.change(screen.getByLabelText('安全验证密码'),{target:{value:'synthetic-pass'}});fireEvent.change(screen.getByLabelText('六位动态码'),{target:{value:'345678'}});fireEvent.click(screen.getByRole('button',{name:'停用双重验证'}));await screen.findByText('双重验证已停用');expect(request).toHaveBeenCalledWith('store/admin/2fa/toggle',{password:'synthetic-pass',otp:'345678',enabled:false});expect(screen.getByLabelText('安全验证密码')).toHaveValue('');expect(screen.getByLabelText('六位动态码')).toHaveValue('');
});
it('reports a failed status load and permits retry without exposing setup controls',async()=>{
 const request=vi.spyOn(adminApi,'request').mockRejectedValueOnce(Error('读取失败')).mockResolvedValue({bound:false,enabled:false,required:false,pending:false} as never);render(<SecurityPanel/>);await screen.findByText('读取失败');expect(screen.queryByRole('button',{name:'生成验证二维码'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'重新读取安全状态'}));await waitFor(()=>expect(request).toHaveBeenCalledTimes(2));expect(await screen.findByRole('button',{name:'生成验证二维码'})).toBeInTheDocument();
});
