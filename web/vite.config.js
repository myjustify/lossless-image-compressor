import { defineConfig } from 'vite';

export default defineConfig({
  // 相对 base：本地 preview、GitHub Pages 子路径、静态托管目录都能直接跑
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0
  },
  worker: {
    format: 'es'
  },
  server: {
    port: 5174
  }
});
