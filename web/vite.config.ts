import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// C8：真实 dashboard——/api 代理到 FastAPI 观测服务（C7）
// chunk 拆分：单一 1.8MB 产物 → react 运行时 / antd / echarts 三 vendor 分包
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': { target: process.env.CANNAGENT_API ?? 'http://127.0.0.1:8300', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          antd: ['antd', '@ant-design/icons'],
          echarts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
        },
      },
    },
  },
});
