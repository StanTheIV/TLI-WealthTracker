import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import electron from 'vite-plugin-electron';
import {resolve} from 'path';

const ELECTRON_EXTERNALS = ['electron', 'better-sqlite3'];
const SRC_ALIAS = {'@': resolve(__dirname, 'src')};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron([
      {
        // Main process
        entry: 'src/main/main.ts',
        vite: {
          resolve: {alias: SRC_ALIAS},
          build: {
            outDir: 'dist-electron',
            rollupOptions: {external: ELECTRON_EXTERNALS},
          },
        },
      },
      {
        // Preload script
        entry: 'src/main/preload.ts',
        vite: {
          resolve: {alias: SRC_ALIAS},
          build: {
            outDir: 'dist-electron',
            rollupOptions: {external: ELECTRON_EXTERNALS},
          },
        },
      },
      {
        // Log watcher utility process
        entry: 'src/worker/index.ts',
        vite: {
          resolve: {alias: SRC_ALIAS},
          build: {
            outDir: 'dist-electron',
            rollupOptions: {external: ELECTRON_EXTERNALS},
          },
        },
      },
    ]),
  ],
  resolve: {
    alias: SRC_ALIAS,
  },
});
