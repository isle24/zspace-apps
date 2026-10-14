import {defineConfig} from 'vitest/config';import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({plugins:[react()],base:'/admin/',build:{rolldownOptions:{input:{admin:fileURLToPath(new URL('./index.html',import.meta.url)),public:fileURLToPath(new URL('./public.html',import.meta.url))}}},server:{host:'127.0.0.1',port:5175,strictPort:true,proxy:{'/api':'http://127.0.0.1:18442'}},test:{environment:'jsdom',setupFiles:['./src/test-setup.ts'],css:false}});
