/**
 * Browser URL routing E2E tests.
 * Verifies deep links, navigation sync, refresh persistence, and Back/Forward.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

async function firstStackName(page: import('@playwright/test').Page): Promise<string | null> {
  const response = await page.request.get('/api/stacks');
  await expect(response).toBeOK();
  const stacks = await response.json() as string[];
  return stacks[0] ?? null;
}

async function openStack(page: import('@playwright/test').Page, stackName: string): Promise<void> {
  const option = page.locator(`[data-stacks-loaded="true"] [cmdk-item][data-value="${stackName}"]`);
  await expect(option).toBeVisible();
  await option.click();
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

  test('cold load of shell views preserves the URL and mounts the view', async ({ page }) => {
    await page.goto('/nodes/local/fleet');
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(/\/nodes\/local\/fleet/);
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 15_000 });

    await page.goto('/nodes/local/security/images');
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(/\/nodes\/local\/security\/images/);
    await expect(page.getByRole('tab', { name: 'Images' })).toBeVisible();

    await page.goto('/nodes/local/resources');
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(/\/nodes\/local\/resources/);
    await expect(page.getByRole('tab', { name: 'Images' })).toBeVisible();
  });

  test('top-level navigation updates the address bar', async ({ page }) => {
    await page.getByRole('button', { name: 'Resources', exact: true }).click();
    await expect(page).toHaveURL(/\/nodes\/local\/resources/);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL(/\/nodes\/local\/dashboard/);
  });

  test('opening a stack writes a stack detail URL', async ({ page }) => {
    const stackName = await firstStackName(page);
    test.skip(!stackName, 'No stacks available to open');

    await openStack(page, stackName!);
    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${escaped}/?$`));
    await expect(page.getByRole('tab', { name: 'Anatomy' })).toBeVisible();
  });

  test('refresh preserves a stack detail deep link', async ({ page }) => {
    const stackName = await firstStackName(page);
    test.skip(!stackName, 'No stacks available to open');

    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await page.goto(`/nodes/local/stacks/${encodeURIComponent(slug)}`);
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${escaped}/?$`));
    await expect(page.getByRole('tab', { name: 'Anatomy' })).toBeVisible();
    await page.reload();
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${escaped}/?$`));
    await expect(page.getByRole('tab', { name: 'Anatomy' })).toBeVisible();
  });

  test('refresh preserves a compose editor deep link', async ({ page }) => {
    const stackName = await firstStackName(page);
    test.skip(!stackName, 'No stacks available to open');

    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await page.goto(`/nodes/local/stacks/${encodeURIComponent(slug)}/compose`);
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${escaped}/compose`));
    await page.reload();
    await waitForStacksLoaded(page);
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${escaped}/compose`));
  });

  test('compose editor env tab updates the URL', async ({ page }) => {
    const stackName = await firstStackName(page);
    test.skip(!stackName, 'No stacks available to open');

    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    await openStack(page, stackName!);
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/`));
    await expect(page).not.toHaveURL(/\/compose$/);

    await page.getByTestId('anatomy-edit-compose-btn').click();
    await expect(page).toHaveURL(/\/compose/);
    const envTab = page.getByRole('tab', { name: '.env' });
    test.skip(!(await envTab.isEnabled()), 'Stack has no .env file');
    await envTab.click();
    await expect(page).toHaveURL(/\/env/);
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

test.describe('URL routing (mobile)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('cold load of stack deep link opens mobile detail', async ({ page }) => {
    const stackName = await page.evaluate(async () => {
      const res = await fetch('/api/stacks', { credentials: 'include' });
      const stacks = await res.json() as string[];
      return stacks[0] ?? null;
    });
    test.skip(!stackName, 'No stacks available to open');

    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    await page.goto(`/nodes/local/stacks/${encodeURIComponent(slug)}/compose`);
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/compose`));
    await expect(page.getByRole('tablist', { name: 'Stack detail sections' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: 'Health' })).toBeVisible();
  });

  test('reload preserves mobile stack deep link', async ({ page }) => {
    const stackName = await page.evaluate(async () => {
      const res = await fetch('/api/stacks', { credentials: 'include' });
      const stacks = await res.json() as string[];
      return stacks[0] ?? null;
    });
    test.skip(!stackName, 'No stacks available to open');

    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    await page.goto(`/nodes/local/stacks/${encodeURIComponent(slug)}/compose`);
    await expect(page.getByRole('tablist', { name: 'Stack detail sections' })).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page).toHaveURL(/\/nodes\/local\/stacks\//);
    await expect(page.getByRole('tab', { name: 'Health' })).toBeVisible({ timeout: 15_000 });
  });

  test('stack list API failure shows retryable mobile error and preserves URL', async ({ page }) => {
    const stackName = await page.evaluate(async () => {
      const res = await fetch('/api/stacks', { credentials: 'include' });
      const stacks = await res.json() as string[];
      return stacks[0] ?? null;
    });
    test.skip(!stackName, 'No stacks available to open');

    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    await page.route('**/api/stacks', async (route) => {
      if (route.request().method() === 'GET' && !route.request().url().includes(`/api/stacks/${encodeURIComponent(stackName!)}`)) {
        await route.fulfill({ status: 500, body: 'list failure' });
        return;
      }
      await route.continue();
    });

    await page.goto(`/nodes/local/stacks/${encodeURIComponent(slug)}/compose`);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/compose`));
  });

  test('compose API failure shows retryable mobile error and preserves URL', async ({ page }) => {
    const stackName = await page.evaluate(async () => {
      const res = await fetch('/api/stacks', { credentials: 'include' });
      const stacks = await res.json() as string[];
      return stacks[0] ?? null;
    });
    test.skip(!stackName, 'No stacks available to open');

    const slug = stackName!.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    await page.route(`**/api/stacks/${encodeURIComponent(stackName!)}`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 500, body: 'compose failure' });
        return;
      }
      await route.continue();
    });

    await page.goto(`/nodes/local/stacks/${encodeURIComponent(slug)}/compose`);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 15_000 });
    await expect(page).not.toHaveURL(/\/dashboard/);
    await expect(page).toHaveURL(new RegExp(`/nodes/local/stacks/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/compose`));
  });

  test('Stacks tab from Fleet updates URL to stack list', async ({ page }) => {
    await page.goto('/nodes/local/fleet');
    await expect(page).toHaveURL(/\/nodes\/local\/fleet/);
    await page.getByRole('button', { name: 'Stacks', exact: true }).click();
    await expect(page).toHaveURL(/\/nodes\/local\/stacks$/);
  });
});
