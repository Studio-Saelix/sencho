/**
 * The GitOps history window, end to end against a running Sencho.
 *
 * The unit tests drive the prune against seeded rows. This one proves the
 * setting an operator would hit: a fresh install keeps 30 days, a value in
 * range persists, and a value outside 1 to 365 is refused.
 *
 * No Docker needed: settings API traffic only, with no deploy involved.
 */
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

async function jsonRequest<T>(
  page: import('@playwright/test').Page,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: T }> {
  const result = await page.evaluate(
    async ([url, method, payload]) => {
      const response = await fetch(url, {
        method: method ?? 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(payload === null ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await response.text();
      return { status: response.status, text };
    },
    [path, init?.method ?? 'GET', init?.body ?? null] as const,
  );
  return { status: result.status, body: (result.text ? JSON.parse(result.text) : null) as T };
}

interface SettingsRow {
  gitops_history_retention_days?: string;
}

test.describe('GitOps history retention', () => {
  test('the history window round-trips and is refused outside its bounds', async ({ page }) => {
    await loginAs(page);

    const seeded = await jsonRequest<SettingsRow>(page, '/api/settings');
    expect(seeded.status).toBe(200);
    expect(
      seeded.body.gitops_history_retention_days,
      'a fresh install keeps 30 days of GitOps history',
    ).toBe('30');

    const saved = await jsonRequest<{ error?: string }>(page, '/api/settings', {
      method: 'PATCH',
      body: { gitops_history_retention_days: 14 },
    });
    expect(saved.status, `saving the window: ${JSON.stringify(saved.body)}`).toBe(200);
    await expect
      .poll(async () => (await jsonRequest<SettingsRow>(page, '/api/settings')).body.gitops_history_retention_days)
      .toBe('14');

    for (const value of [0, 366]) {
      const rejected = await jsonRequest<{ error?: string }>(page, '/api/settings', {
        method: 'PATCH',
        body: { gitops_history_retention_days: value },
      });
      expect(rejected.status, `value ${value} must be refused`).toBe(400);
    }

    await jsonRequest(page, '/api/settings', {
      method: 'PATCH',
      body: { gitops_history_retention_days: 30 },
    });
  });
});
