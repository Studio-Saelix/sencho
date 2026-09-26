import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config for Sencho.
 *
 * Before running: ensure both dev servers are up:
 *   cd backend && npm run dev &
 *   cd frontend && npm run dev &
 *
 * Or use the webServer config below (which starts them automatically).
 */
export default defineConfig({
  testDir: './e2e',
  // Creates the test admin once so no spec depends on file order.
  globalSetup: './e2e/global-setup.ts',
  // Don't stop on first failure - show all results
  maxFailures: 0,
  // How long to wait for a single test
  timeout: 30_000,
  // How long to wait for an expect() assertion
  expect: { timeout: 5_000 },
  // Run tests serially - Sencho is a single-user app and tests share DB state
  workers: 1,
  // Retry once in CI: the deploy/health-gate specs drive real Docker container
  // runs, so image-pull and gate-window timing varies on shared runners. One
  // retry absorbs a transient blip without tripling the cost of a real failure;
  // a test reported as flaky still needs a fix. trace: 'on-first-retry'
  // captures the retried run.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'e2e/report', open: 'never' }]],

  use: {
    baseURL: 'http://localhost:5173',
    // Persist auth state between tests in the same file
    storageState: undefined,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      // Default project (what CI runs via --project=chromium). Skips the manual
      // screenshot capture spec.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/screenshots.spec.ts'],
    },
    {
      // Manual-only project for capturing docs/images/. Run explicitly:
      //   npx playwright test --project=screenshots
      name: 'screenshots',
      use: { ...devices['Desktop Chrome'] },
      testMatch: ['**/screenshots.spec.ts'],
    },
  ],
});
