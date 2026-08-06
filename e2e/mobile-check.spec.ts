import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const STACK = 'mobile-check';

async function openStack(page: Page): Promise<void> {
  await page.reload();
  await waitForStacksLoaded(page);
  await page.getByText(STACK, { exact: true }).first().click();
}

test('git source panel renders at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page);
  // Best-effort seed of a git-source row; the dry-run reachability check may
  // be blocked in some environments, so the assertion below tolerates both.
  await page.evaluate(async (name) => {
    await fetch('/api/stacks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ stackName: name }) }).catch(() => {});
    await fetch(`/api/stacks/${name}/git-source`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ repo_url: 'https://github.com/docker/awesome-compose.git', branch: 'master', compose_paths: ['compose.yaml'], context_dir: null, sync_env: false, auth_type: 'none', auto_apply_on_webhook: false, auto_deploy_on_apply: false }),
    }).catch(() => {});
  }, STACK);
  await openStack(page);
  await page.getByRole('tab', { name: 'Compose' }).click();
  await page.getByRole('button', { name: 'Git Source' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: /git source/i })).toBeVisible({ timeout: 10_000 });
  // No horizontal overflow at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  // The manifest section renders inside the scrollable dialog when a source
  // row seeded successfully (the state badge is present either way).
  const linked = await page.evaluate(async (name) => {
    const res = await fetch(`/api/stacks/${name}/git-source`, { credentials: 'include' });
    const body = await res.json();
    return res.ok && 'stack_name' in body;
  }, STACK);
  if (linked) {
    await expect(page.getByText('Managed project').first()).toBeVisible({ timeout: 5_000 });
  }
  await page.screenshot({ path: 'e2e/report/mobile-panel.png' });
  await page.evaluate(async (name) => {
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, STACK);
});
