import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Only run TypeScript sources - exclude the compiled dist/ output.
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**', 'src/__tests__/docker-integration/**'],
    // Build the baseline DB (schema + migrations + admin seed) once; each
    // test file's setupTestDb copies it instead of re-running migrations.
    globalSetup: ['./src/__tests__/helpers/vitestGlobalSetup.ts'],
    setupFiles: ['./src/__tests__/helpers/allowLoopbackTargets.ts'],
    // Each test file gets its own worker so singletons are fresh between files.
    pool: 'forks',
    // Cap concurrency: each worker dynamic-imports the full Express stack
    // (TypeScript transform + DB init + every migration), so an uncapped
    // fork pool that scales with availableParallelism saturates CPU and
    // the suite spends most of its wall time waiting on cold-start
    // contention. Four parallel workers is a sweet spot on both CI
    // runners and laptops.
    maxWorkers: 4,
    minWorkers: 1,
    // Timeout generous for DB init and HTTP calls.
    testTimeout: 30_000,
    // Every test file dynamic-imports the full Express stack; each fork pays
    // TypeScript transformation cost and can take tens of seconds under
    // CPU contention.
    hookTimeout: 45_000,
    // Sequential within each file (DB state is shared per file).
    sequence: { concurrent: false },
  },
});
