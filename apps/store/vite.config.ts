import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:18435' } }, build: { rollupOptions: { input: fileURLToPath(new URL('./store.html', import.meta.url)) } }, test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false } });
