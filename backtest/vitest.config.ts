import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@bot': path.resolve(__dirname, '../bot/src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
