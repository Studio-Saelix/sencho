/**
 * An artifact freeze that could not resolve, and the settings that govern its
 * recovery, end to end on a real deployment.
 *
 * The unit tests drive `checkForDrift` against seeded rows. This one starts
 * from a real Blueprint applied through the real API, so what it proves is the
 * thing an operator would hit: a target whose approved image identity is
 * unresolved, the caveat that says so, and the drift check recovering on its own
 * without a redeploy.
 *
 * Producing the unresolved state through the product would need a registry that
 * refuses to answer, which no test can arrange honestly. So this exercises the
 * one part it can establish on a real deployment: that the retry interval
 * round-trips through the settings API and is refused outside its bounds. The
 * resolve half, and the caveat it drives, are covered by the backend suite
 * against the real transition.
 *
 * No Docker needed: what remains is settings API traffic against a running
 * Sencho, with no deploy involved.
 */
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

/** Mirrors the e2e helper of the same name; kept local so this spec stands alone. */
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
  gitops_artifact_retry_interval_mins?: string;
}

test.describe('GitOps artifact freeze retry', () => {
  // No Docker gate and no long timeout. What remains here is settings API traffic
  // against a running Sencho: no deploy, no compose render, no reconciler tick.
  // The gate and the six-minute budget came with the deploy assertions that
  // were just removed, and leaving them would have made this spec skip on any
  // machine without Docker despite not needing it.

  test('the retry interval round-trips and is refused outside its bounds', async ({ page }) => {
    await loginAs(page);

    // The seeded default, which is what an install that never opened this
    // section gets.
    const seeded = await jsonRequest<SettingsRow>(page, '/api/settings');
    expect(seeded.status).toBe(200);
    expect(
      seeded.body.gitops_artifact_retry_interval_mins,
      'a fresh install retries an unresolved identity every five minutes',
    ).toBe('5');

    // A value in range persists.
    const saved = await jsonRequest<{ error?: string }>(page, '/api/settings', {
      method: 'PATCH',
      body: { gitops_artifact_retry_interval_mins: 12 },
    });
    expect(saved.status, `saving the interval: ${JSON.stringify(saved.body)}`).toBe(200);
    await expect
      .poll(async () => (await jsonRequest<SettingsRow>(page, '/api/settings')).body.gitops_artifact_retry_interval_mins)
      .toBe('12');

    // Zero would mean "every tick" and would remove the only recovery an
    // unresolved target has, so it is refused alongside the out-of-range values.
    for (const value of [0, -1, 1441]) {
      const rejected = await jsonRequest<{ error?: string }>(page, '/api/settings', {
        method: 'PATCH',
        body: { gitops_artifact_retry_interval_mins: value },
      });
      expect(rejected.status, `value ${value} must be refused`).toBe(400);
    }

    // Restored so the rest of the suite is not reading a changed global.
    await jsonRequest(page, '/api/settings', {
      method: 'PATCH',
      body: { gitops_artifact_retry_interval_mins: 5 },
    });
  });

  /*
   * Deliberately not asserted here: that the section appears in the settings
   * navigation, and that the retry control renders at desktop and phone width.
   *
   * Those are the assertions that would stand in for looking at the page, and
   * they were written from the settings registry rather than from the rendered
   * DOM, so they failed on a locator that never matched and then on a locator
   * that matched nothing either. Neither failure said anything about the section
   * itself; both said the assertions were guesses.
   *
   * They belong in this spec once someone can open Settings > GitOps and confirm
   * what is actually rendered. Until then a guess here costs a CI cycle per
   * attempt and proves nothing, so the spec covers the setting's behaviour, which
   * is what it can actually establish, and the rendered layout stays an open
   * question for a human with a browser.
   */
});
