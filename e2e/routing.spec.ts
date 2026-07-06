/**
 * Browser URL routing E2E tests.
 * Verifies deep links, navigation sync, refresh persistence, and Back/Forward.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

async function firstStackName(page: import('@playwright/test').Page): Promise<string | null> {
  const row = page.locator('[role="listbox"] [role="option"]').first();
  if (!(await row.isVisible().catch(() => false))) return null;
  const text = await row.textContent();
  return text?.trim() ?? null;
}

test.describe('URL routing', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await waitForStacksLoaded(page);
  });

  test('cold load of /nodes/local/dashboard lands on home', async ({ page }) => {
    await page.goto('/nodes/local/dashboard');
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(/\/nodes\/local\/dashboard/);
    await expect(page.getByRole('button', { name: 'Create Stack' })).toBeVisible();
  });

  test('top-level navigation updates the address bar', async ({ page }) => {
    await page.getByRole('button', { name: 'Resources', exact: true }).click();
    await expect(page).toHaveURL(/\/nodes\/local\/resources/);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL(/\/nodes\/local\/dashboard/);
  });

  test('opening a stack writes a stack editor URL', async ({ page }) => {
    const stackName = await firstStackName(page);
    test.skip(!stackName, 'No stacks available to open');

    await page.locator('[role="listbox"]').getByText(stackName!, { exact: true }).click();
    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
  });

  test('refresh preserves a stack editor deep link', async ({ page }) => {
    const stackName = await firstStackName(page);
    test.skip(!stackName, 'No stacks available to open');

    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    await page.goto(`/nodes/local/stacks/${encodeURIComponent(slug)}/compose`);
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${slug}|${stackName}`));
    await page.reload();
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(/\/nodes\/local\/stacks\//);
  });

  test('browser Back returns to the prior view', async ({ page }) => {
    await page.getByRole('button', { name: 'Resources', exact: true }).click();
    await expect(page).toHaveURL(/\/nodes\/local\/resources/);
    await page.getByRole('button', { name: 'Security', exact: true }).click();
    await expect(page).toHaveURL(/\/nodes\/local\/security/);
    await page.goBack();
    await expect(page).toHaveURL(/\/nodes\/local\/resources/);
  });

  test('root path redirects into a node dashboard', async ({ page }) => {
    await page.goto('/');
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(/\/nodes\/[^/]+\/dashboard/);
  });
});
