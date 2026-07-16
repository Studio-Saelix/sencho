/**
 * Desktop navigation styles: Smart default, Compact quick-link picker,
 * labeled pins, and persistence.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

async function setTopNavMode(page: import('@playwright/test').Page, mode: 'classic' | 'smart' | 'compact' | null) {
  await page.evaluate((next) => {
    if (next === null) {
      window.localStorage.removeItem('sencho.appearance.topNavMode');
      window.localStorage.removeItem('sencho.appearance.topNavQuickLinks');
      return;
    }
    window.localStorage.setItem('sencho.appearance.topNavMode', next);
  }, mode);
  await page.reload();
  await loginAs(page);
  await waitForStacksLoaded(page);
}

test.describe('Desktop navigation styles', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.removeItem('sencho.appearance.topNavMode');
      window.localStorage.removeItem('sencho.appearance.topNavQuickLinks');
    });
    await loginAs(page);
    await waitForStacksLoaded(page);
  });

  test('defaults to Smart bar with a More control', async ({ page }) => {
    const topbar = page.locator('[data-sn-chrome="topbar"]');
    await expect(topbar).toHaveAttribute('data-sn-nav-mode', 'smart');
    await expect(page.getByRole('button', { name: 'More navigation' })).toBeVisible();
  });

  test('persists mode across reload and navigates via Smart More', async ({ page }) => {
    await setTopNavMode(page, 'classic');
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'classic');

    await setTopNavMode(page, 'smart');
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'smart');
    await page.getByRole('button', { name: 'More navigation' }).click();
    await expect(page.locator('.font-heading').filter({ hasText: 'More' })).toBeVisible();
    await page.getByRole('menuitem', { name: /Logs/i }).click();
    await expect(page.locator('body')).toContainText(/Logs|Central|Observability/i);
  });

  test('Compact launcher opens Settings', async ({ page }) => {
    await setTopNavMode(page, 'compact');
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'compact');
    await page.getByRole('button', { name: 'Open navigation launcher' }).click();
    await page.getByRole('menuitem', { name: /^Settings$/i }).click();
    await expect(page.getByText('Appearance', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('Compact trailing + adds a labeled pin that survives reload', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.evaluate(() => {
      window.localStorage.setItem('sencho.appearance.topNavQuickLinks', '[]');
    });
    await setTopNavMode(page, 'compact');

    const topbar = page.locator('[data-sn-chrome="topbar"]');
    await expect(topbar).toHaveAttribute('data-sn-nav-mode', 'compact');

    await page.getByRole('button', { name: 'Add quick link' }).click();
    await page.getByRole('menuitem', { name: /Networking/i }).click();

    const pin = topbar.getByRole('button', { name: 'Networking' });
    await expect(pin).toBeVisible();
    await expect(pin.locator('span.inline')).toBeVisible();

    const stored = await page.evaluate(() => window.localStorage.getItem('sencho.appearance.topNavQuickLinks'));
    expect(stored).toContain('networking');

    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);

    await expect(page.locator('[data-sn-chrome="topbar"]').getByRole('button', { name: 'Networking' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add quick link' })).toBeVisible();
  });
});
