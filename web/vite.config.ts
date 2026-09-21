import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// C8：真实 dashboard——/api 代理到 FastAPI 观测服务（C7）
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': { target: process.env.CANNAGENT_API ?? 'http://127.0.0.1:8300', changeOrigin: true },
    },
  },
});
