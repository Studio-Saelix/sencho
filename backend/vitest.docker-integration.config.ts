import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/docker-integration/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    globalSetup: ['./src/__tests__/helpers/vitestGlobalSetup.ts'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    sequence: { concurrent: false },
  },
});
