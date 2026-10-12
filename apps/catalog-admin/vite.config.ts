import {defineConfig} from 'vitest/config';import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],base:'/admin/',server:{host:'127.0.0.1',port:5175,strictPort:true,proxy:{'/api':'http://127.0.0.1:18442'}},test:{environment:'jsdom',setupFiles:['./src/test-setup.ts'],css:false}});
