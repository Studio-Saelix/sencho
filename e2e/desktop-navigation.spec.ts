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

    // The bar actually moves open vs. closed, not just a duration-clamp check.
    // Read translate and rotate alongside transform: Tailwind v4 compiles these
    // utilities to the standalone `translate` and `rotate` properties, so reading
    // `transform` alone reports "none" in both states and proves nothing. Keeping
    // transform in the snapshot means this still holds if that ever changes back.
    const bar = trigger.locator('span > span').first();
    const morphState = (el: Element) => {
      const s = getComputedStyle(el);
      return `${s.translate}|${s.rotate}|${s.transform}`;
    };
    const closedMorph = await bar.evaluate(morphState);
    await trigger.click();
    await expect(trigger).toHaveAttribute('data-state', 'open');
    const openMorph = await bar.evaluate(morphState);
    expect(openMorph).not.toBe(closedMorph);
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('data-state', 'closed');

    // Drive Reduced motion explicitly in both directions rather than assuming the
    // starting state: a fresh install defaults to the Calm visual style, which
    // turns Reduced motion on, so the clamp is already active before any toggle.
    // The top bar stays mounted on the Settings view, so the bar can be measured
    // from there without navigating back.
    await trigger.click();
    await page.getByRole('menuitem', { name: /^Settings$/i }).click();
    await page.getByText('Appearance', { exact: true }).first().waitFor();
    const reducedMotion = page.getByRole('switch', { name: 'Reduced motion' });
    const durationMs = () => bar.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) * 1000);

    if (await reducedMotion.getAttribute('aria-checked') === 'true') {
      await reducedMotion.click();
    }
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    expect(await durationMs()).toBeGreaterThan(1);

    await reducedMotion.click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    expect(await durationMs()).toBeLessThan(1);
  });

  test('the Navigate panel has one vertical scroll owner and no horizontal scrollbar', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 420 });
    const trigger = page.getByRole('button', { name: 'Open navigation launcher' });
    await trigger.click();

    const panel = page.getByRole('menu').filter({ has: page.getByText('Navigate', { exact: true }) });
    const viewport = panel.locator('[data-radix-scroll-area-viewport]');
    await expect(viewport).toBeVisible();

    // Exactly one scroll owner: the ScrollArea viewport scrolls vertically, the
    // outer menu only clips. This is the property that regressed before, when the
    // menu's own overflow-hidden replaced the base dropdown's overflow-y-auto and
    // left the panel capped but unscrollable. Asserted structurally rather than by
    // measuring overflow, which depends on Radix having applied its available-height
    // variable at read time and on how many destinations the account can reach.
    const overflow = await viewport.evaluate((el) => {
      const outer = el.closest('[role="menu"]') as HTMLElement;
      return {
        viewportY: getComputedStyle(el).overflowY,
        viewportX: getComputedStyle(el).overflowX,
        outerY: getComputedStyle(outer).overflowY,
      };
    });
    expect(['auto', 'scroll']).toContain(overflow.viewportY);
    expect(overflow.outerY).toBe('hidden');
    expect(overflow.viewportX).not.toBe('scroll');

    // No horizontal overflow, and the panel stays inside the viewport.
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(420 + 1);
    const { scrollWidth, clientWidth } = await viewport.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // Keyboard navigation still reaches the destinations inside the scroll region.
    await page.keyboard.press('ArrowDown');
    await expect(panel.getByRole('menuitem').first()).toBeFocused();
  });
});
