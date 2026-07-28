import {defineConfig} from 'vitest/config';
import {resolve} from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Engine code reaches `electron` transitively; the real module needs a
      // binary CI never downloads (`bun install --ignore-scripts`).
      electron: resolve(__dirname, 'src/test/electron-stub.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
