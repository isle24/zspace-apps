import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { createNasProxy } from './dev/nas-proxy.ts';

export default defineConfig({
  plugins: [react(), {
    name: 'official-nas-development-transport',
    apply: 'serve',
    configureServer(server) {
      const target = process.env.NAS_DEV_TARGET || process.env.VITE_NAS_DEV_TARGET;
      if (target) server.middlewares.use(createNasProxy(target));
    },
  }],
  define: { 'import.meta.env.VITE_NAS_DEV_TARGET': JSON.stringify(process.env.NAS_DEV_TARGET || process.env.VITE_NAS_DEV_TARGET || '') },
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/.runtime/**'] }, proxy: { '/api': 'http://127.0.0.1:18435' } },
  build: {
    rollupOptions: {
      input: {
        client: fileURLToPath(new URL('./index.html', import.meta.url)),
        store: fileURLToPath(new URL('./store.html', import.meta.url)),
      },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false },
});
