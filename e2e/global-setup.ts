/**
 * Completes first-run setup once, before any spec runs, so every spec file can
 * assume the test admin exists regardless of which files ran before it. CI
 * shards the suite across fresh instances, so no file can rely on an earlier
 * file having clicked through the setup screen. Idempotent: an instance that
 * is already set up is left alone.
 */
import { request, type FullConfig } from '@playwright/test';
import { TEST_USERNAME, TEST_PASSWORD } from './helpers';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  const api = await request.newContext({ baseURL });
  try {
    const status = await api.get('/api/auth/status');
    if (!status.ok()) throw new Error(`auth status check failed with ${status.status()}`);
    const { needsSetup } = (await status.json()) as { needsSetup: boolean };
    if (!needsSetup) return;

    const setup = await api.post('/api/auth/setup', {
      data: { username: TEST_USERNAME, password: TEST_PASSWORD, confirmPassword: TEST_PASSWORD },
    });
    if (!setup.ok()) {
      throw new Error(`first-run setup failed with ${setup.status()}: ${await setup.text()}`);
    }
  } finally {
    await api.dispose();
  }
}
