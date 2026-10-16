import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@691sim/web',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
