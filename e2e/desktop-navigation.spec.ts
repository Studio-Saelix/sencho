/**
 * Desktop navigation styles: Smart default, mode persistence, Smart More,
 * Compact launcher, and Compact quick-link add/persist/render.
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
    // One-shot clear before the first login only. Do not use addInitScript to
    // clear these keys: it re-runs on every reload and would wipe values the
    // persistence tests write just before reload.
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

  test('Compact quick link add persists and renders after reload', async ({ page }) => {
    // Empty JSON array (not a missing key): missing falls back to recommended pins.
    await page.evaluate(() => {
      window.localStorage.setItem('sencho.appearance.topNavQuickLinks', '[]');
    });
    await setTopNavMode(page, 'compact');

    const topbar = page.locator('[data-sn-chrome="topbar"]');
    await expect(topbar).toHaveAttribute('data-sn-nav-mode', 'compact');

    // Home is the default view and is quick-link eligible.
    const add = page.getByRole('button', { name: 'Add current page to quick links' });
    await expect(add).toBeVisible();
    await add.click();

    await expect(topbar.getByRole('button', { name: 'Home' })).toBeVisible();
    await expect(add).toHaveCount(0);

    const stored = await page.evaluate(() => window.localStorage.getItem('sencho.appearance.topNavQuickLinks'));
    expect(stored).toBe(JSON.stringify(['dashboard']));

    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);

    await expect(topbar).toHaveAttribute('data-sn-nav-mode', 'compact');
    await expect(topbar.getByRole('button', { name: 'Home' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add current page to quick links' })).toHaveCount(0);
    const storedAfterReload = await page.evaluate(() => window.localStorage.getItem('sencho.appearance.topNavQuickLinks'));
    expect(storedAfterReload).toBe(JSON.stringify(['dashboard']));
  });
});
