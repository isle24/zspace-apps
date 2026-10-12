import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {AiSettingsPanel} from './AiSettingsPanel';
import {adminApi} from './api';
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it('keeps a configured AI key private and omits an unchanged key when saving',async()=>{
 const call=vi.spyOn(adminApi,'request').mockResolvedValue({endpoint:'https://api.example.com/v1',model:'draft-model',apiKeyConfigured:true,configured:true} as never);
 render(<AiSettingsPanel/>);
 await waitFor(()=>expect(screen.getByLabelText('AI 模型')).toHaveValue('draft-model'));
 expect(screen.getByLabelText('AI 密钥')).toHaveValue('');
 fireEvent.change(screen.getByLabelText('AI 模型'),{target:{value:'next-model'}});
 fireEvent.click(screen.getByRole('button',{name:'保存 AI 设置'}));
 await screen.findByText('AI 设置已保存。');
 expect(call.mock.calls.at(-1)).toEqual(['store/admin/ai-settings',{endpoint:'https://api.example.com/v1',model:'next-model'}]);
});
it('submits a replacement key and clears the password field after success',async()=>{
 const call=vi.spyOn(adminApi,'request').mockResolvedValue({endpoint:'https://api.example.com/v1',model:'draft-model',apiKeyConfigured:false} as never);
 render(<AiSettingsPanel/>);
 await waitFor(()=>expect(screen.getByLabelText('AI 模型')).toHaveValue('draft-model'));
 fireEvent.change(screen.getByLabelText('AI 密钥'),{target:{value:'test-private-key'}});
 fireEvent.click(screen.getByRole('button',{name:'保存 AI 设置'}));
 await screen.findByText('AI 设置已保存。');
 expect(call.mock.calls.at(-1)?.[1]).toMatchObject({apiKey:'test-private-key'});
 expect(screen.getByLabelText('AI 密钥')).toHaveValue('');
 expect(screen.queryByText('test-private-key')).not.toBeInTheDocument();
});
