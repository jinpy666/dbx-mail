import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 版本号从 package.json 读取，构建时注入，避免与清单漂移 */
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

/**
 * 构建配置：
 * - base 用相对路径，产物写入 ui/，与 manifest 的 ui.root 一致
 * - 必须打成单文件 bundle：宿主把页面注入 sandbox iframe，只内联 <script src> 与样式，
 *   拆包会白屏，因此关闭代码分割、modulePreload 与 CSS 拆分
 */
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'ui',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 8192,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
