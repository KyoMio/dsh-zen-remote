// 控制台前端构建（PG-6a）：入口是包根的 index.html → src/web/main.tsx，
// 产物输出 dist/public（与后端 tsc 的 dist/ 其余产物互不干扰；emptyOutDir 只清 dist/public）。
// 纯逻辑（src/web/i18n、src/web/store）由后端 tsconfig.json 编译进 dist/web/，不走这里。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
});
