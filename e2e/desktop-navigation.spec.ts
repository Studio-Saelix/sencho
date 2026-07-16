/**
 * Desktop navigation styles — Smart default, mode persistence, Smart More and
 * Compact launcher navigation.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

test.describe('Desktop navigation styles', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
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
    await page.evaluate(() => {
      window.localStorage.setItem('sencho.appearance.topNavMode', 'classic');
    });
    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'classic');

    await page.evaluate(() => {
      window.localStorage.setItem('sencho.appearance.topNavMode', 'smart');
    });
    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'smart');
    await page.getByRole('button', { name: 'More navigation' }).click();
    await page.getByRole('menuitem', { name: /Logs/i }).click();
    await expect(page.locator('body')).toContainText(/Logs|Central|Observability/i);
  });

  test('Compact launcher opens Settings', async ({ page }) => {
    await page.evaluate(() => {
      window.localStorage.setItem('sencho.appearance.topNavMode', 'compact');
    });
    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'compact');
    await page.getByRole('button', { name: 'Open navigation launcher' }).click();
    await page.getByRole('menuitem', { name: /^Settings$/i }).click();
    await expect(page.getByText('Appearance', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });
});
