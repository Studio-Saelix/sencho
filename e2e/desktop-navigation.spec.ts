/**
 * Desktop navigation styles: Compact default, Smart alternate, labeled pins,
 * launcher animation, Navigate panel scrolling, and persistence.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

async function setTopNavMode(page: import('@playwright/test').Page, mode: 'smart' | 'compact' | null) {
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

  test('defaults to Compact launcher with an Open navigation launcher control', async ({ page }) => {
    const topbar = page.locator('[data-sn-chrome="topbar"]');
    await expect(topbar).toHaveAttribute('data-sn-nav-mode', 'compact');
    await expect(page.getByRole('button', { name: 'Open navigation launcher' })).toBeVisible();
  });

  test('a legacy classic preference migrates to compact on load', async ({ page }) => {
    await page.evaluate(() => {
      window.localStorage.setItem('sencho.appearance.topNavMode', 'classic');
    });
    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'compact');
  });

  test('persists mode across reload and navigates via Smart More', async ({ page }) => {
    await setTopNavMode(page, 'smart');
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'smart');
    await page.getByRole('button', { name: 'More navigation' }).click();
    await expect(page.getByRole('menuitem', { name: /Logs/i })).toBeVisible();
    await expect(page.locator('.font-heading').filter({ hasText: 'More' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: /Logs/i }).click();
    await expect(page.locator('body')).toContainText(/Logs|Central|Observability/i);
  });

  test('Compact launcher opens Settings', async ({ page }) => {
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

    const pin = topbar.getByRole('button', { name: 'Networking', exact: true });
    await expect(pin).toBeVisible();
    await expect(pin.locator('span.inline')).toBeVisible();

    const stored = await page.evaluate(() => window.localStorage.getItem('sencho.appearance.topNavQuickLinks'));
    expect(stored).toContain('networking');

    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);

    await expect(page.locator('[data-sn-chrome="topbar"]').getByRole('button', { name: 'Networking', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add quick link' })).toBeVisible();
  });

  test('the launcher hamburger morphs open/closed and does not animate under Reduced motion', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Open navigation launcher' });
    await expect(trigger).toHaveAttribute('data-state', 'closed');
    await trigger.click();
    await expect(trigger).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('data-state', 'closed');

    // The bar actually rotates open vs. closed, not just a duration-clamp check.
    const bar = trigger.locator('span > span').first();
    const closedTransform = await bar.evaluate((el) => getComputedStyle(el).transform);
    await trigger.click();
    await expect(trigger).toHaveAttribute('data-state', 'open');
    const openTransform = await bar.evaluate((el) => getComputedStyle(el).transform);
    expect(openTransform).not.toBe(closedTransform);
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('data-state', 'closed');

    // Under normal motion, the morph bar has a non-trivial transition duration.
    const normalDurationMs = await bar.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) * 1000);
    expect(normalDurationMs).toBeGreaterThan(1);

    // Enable Reduced motion from Appearance settings, then confirm the clamp applies.
    await trigger.click();
    await page.getByRole('menuitem', { name: /^Settings$/i }).click();
    await page.getByText('Appearance', { exact: true }).first().waitFor();
    await page.getByRole('switch', { name: 'Reduced motion' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

    const reducedDurationMs = await trigger.locator('span > span').first()
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) * 1000);
    expect(reducedDurationMs).toBeLessThan(1);
  });

  test('the Navigate panel scrolls at a constrained viewport height with no horizontal scrollbar', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 420 });
    const trigger = page.getByRole('button', { name: 'Open navigation launcher' });
    await trigger.click();

    const panel = page.getByRole('menu').filter({ has: page.getByText('Navigate', { exact: true }) });
    const viewport = panel.locator('[data-radix-scroll-area-viewport]');
    await expect(viewport).toBeVisible();

    // The destination list overflows the constrained viewport, so the viewport's
    // scrollable content is taller than its visible box.
    const { scrollHeight, clientHeight, scrollWidth, clientWidth } = await viewport.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); // no horizontal overflow

    // Keyboard navigation still reaches a destination past the fold.
    await page.keyboard.press('ArrowDown');
    await expect(panel.getByRole('menuitem').first()).toBeFocused();
  });
});
