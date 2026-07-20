import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/docker-integration/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
  },
});
