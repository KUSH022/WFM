import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In local development the API runs on :3001 (npm run dev:api) and Vite proxies /api to it.
export default defineConfig({
    plugins: [react()],
    server: { port: 5173, proxy: { '/api': 'http://localhost:3001' } },
    build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});

