import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';
import { buildFixtureRepo, serveRepos, fullProjectFiles } from './gitServer.helper';

const STACK = 'mobile-check';

let server: { url: string; close: () => void };

test.beforeAll(async () => {
  // Deterministic seed: the local TLS fixture git server (no external network).
  server = await serveRepos({ full: buildFixtureRepo(fullProjectFiles()) });
});

test.afterAll(() => {
  server.close();
});

async function openStack(page: Page): Promise<void> {
  await page.reload();
  await waitForStacksLoaded(page);
  await page.getByText(STACK, { exact: true }).first().click();
}

test('git source panel renders at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page);
  // Pre-clean any stack left by an interrupted run so the seeding assertions
  // below fail only on genuine errors, never on stale state.
  await page.evaluate(async (name) => {
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, STACK);
  // Seed the stack and the git-source row. Seeding failures fail the test
  // loudly instead of silently degrading the assertions to a no-op.
  const seed = await page.evaluate(async ({ name, repoUrl }) => {
    const stackRes = await fetch('/api/stacks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ stackName: name }) });
    const gitRes = await fetch(`/api/stacks/${name}/git-source`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ repo_url: repoUrl, branch: 'main', compose_paths: ['compose.yaml'], context_dir: null, sync_env: false, auth_type: 'none', auto_apply_on_webhook: false, auto_deploy_on_apply: false }),
    });
    return { stackOk: stackRes.ok, gitOk: gitRes.ok, gitStatus: gitRes.status, gitBody: await gitRes.text() };
  }, { name: STACK, repoUrl: `${server.url}/full.git` });
  expect(seed.stackOk).toBe(true);
  expect(seed.gitOk, `git-source seed failed (HTTP ${seed.gitStatus}): ${seed.gitBody}`).toBe(true);
  await openStack(page);
  await page.getByRole('tab', { name: 'Compose' }).click();
  await page.getByRole('button', { name: 'Git Source' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: /git source/i })).toBeVisible({ timeout: 10_000 });
  // No horizontal overflow at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  // The manifest section renders inside the scrollable dialog.
  await expect(page.getByText('Managed project').first()).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: 'e2e/report/mobile-panel.png' });
  await page.evaluate(async (name) => {
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, STACK);
});
