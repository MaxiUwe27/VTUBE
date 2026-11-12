import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Renderer build. Two pages:
//  - index.html  : main app window (Electron)
//  - output.html : avatar-only page for the OBS browser source (served by the main process)
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: resolve(__dirname, 'src/renderer/public'),
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        output: resolve(__dirname, 'src/renderer/output.html'),
      },
    },
  },
});
