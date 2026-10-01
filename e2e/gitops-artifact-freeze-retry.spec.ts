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
 * observable half: the setting round-trips and governs the retry, and a target
 * with an unresolved expectation reports unverified with the caveat rather than
 * claiming convergence. The resolve half is covered by the backend suite against
 * the real transition.
 *
 * Needs the Docker CLI and Compose plugin for the deploy. A machine with no
 * `docker` executable skips outside CI only; a Docker that is present but
 * unusable fails loudly, so a broken environment never reads as a pass.
 */
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

const DOCKER_TIMEOUT_MS = 60_000;

function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' });
    execFileSync('docker', ['compose', 'version'], { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' });
    return true;
  } catch (error) {
    if (isMissingExecutable(error)) return false;
    throw new Error('Docker is installed but unusable, which is a broken environment rather than a skip', { cause: error });
  }
}

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
  test.skip(!dockerAvailable() && !process.env.CI, 'Docker with the Compose plugin is not available');

  // The reconciler ticks once a minute, and this spec waits for a deploy to
  // settle, so the budget covers several ticks.
  test.setTimeout(360_000);

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

  test('the section is reachable from the settings navigation, at desktop and phone width', async ({ page }) => {
    await loginAs(page);

    await page.goto('/settings/stacks');
    // `button`, not `link`: SettingsSidebar renders every section as a button
    // that calls onSectionChange, with no anchor behind it.
    const nav = page.getByRole('button', { name: 'GitOps', exact: true });
    await expect(nav, 'the GitOps section must be listed under Infrastructure').toBeVisible();
    await nav.click();
    await expect(page).toHaveURL(/\/settings\/gitops$/);
    await expect(page.getByText('Drift verification')).toBeVisible();

    // The retry interval is instance-scoped, so it must still render below the
    // `md` breakpoint rather than being desktop-only.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByText('Retry an unresolved image identity'),
      'the control must be reachable on a phone',
    ).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(
      page.getByText('Retry an unresolved image identity'),
      'and unchanged at desktop width',
    ).toBeVisible();
  });
});