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

  test('the Navigate panel actually scrolls to reach destinations below the fold', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 420 });
    const trigger = page.getByRole('button', { name: 'Open navigation launcher' });
    await trigger.click();

    const panel = page.getByRole('menu').filter({ has: page.getByText('Navigate', { exact: true }) });
    const viewport = panel.locator('[data-radix-scroll-area-viewport]');
    await expect(viewport).toBeVisible();

    // A shrunken nav set would trip the overflow assertion below with a confusing
    // message, so fail here first, naming the real cause.
    expect(await panel.getByRole('menuitem').count()).toBeGreaterThan(8);

    // The viewport must have real internal overflow. This is the assertion that
    // matters: the panel previously rendered at its full content height, reported
    // scrollHeight === clientHeight, and was merely clipped by an ancestor, so it
    // looked capped while ignoring every wheel event. Checking only the computed
    // overflow-y properties passes in exactly that broken state.
    const metrics = await viewport.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      viewportOverflowX: getComputedStyle(el).overflowX,
      outerOverflowY: getComputedStyle(el.closest('[role="menu"]') as HTMLElement).overflowY,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    // Exactly one scroll owner: the outer menu clips rather than scrolling. Its
    // scrollHeight is not asserted, because the menu's 1px border alone puts it a
    // couple of pixels over its clientHeight without it being scrollable at all.
    expect(metrics.outerOverflowY).toBe('hidden');

    // No horizontal overflow, and the panel stays inside the browser viewport.
    // overflow-x is checked directly, not just measured: a reserved scrollbar
    // gutter from overflow-x: scroll would pass the width comparison below with
    // no actual overflow present.
    expect(metrics.viewportOverflowX).not.toBe('scroll');
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(420 + 1);

    // Keyboard reaches a destination below the fold and brings it fully into view.
    // End rather than ArrowDown, because ArrowDown landing on the first item is
    // stock roving focus and holds whether or not anything scrolls. Done before
    // any pointer movement, since Radix focuses a menu item on pointermove.
    const last = panel.getByRole('menuitem').last();
    await page.keyboard.press('End');
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 1 });

    // Back to the top so the wheel below starts from a known position.
    await viewport.evaluate((el) => { el.scrollTop = 0; });

    // Genuine mouse-wheel input over the panel must move it. Wheel input is the
    // exact path the regression ignored, so drive it rather than assigning scrollTop.
    const vpBox = await viewport.boundingBox();
    await page.mouse.move(vpBox!.x + vpBox!.width / 2, vpBox!.y + vpBox!.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // ...and it moved the viewport only, leaving the outer menu at rest: an
    // overflow-hidden element cannot be wheel-scrolled, so this is a fixed
    // invariant rather than something to poll for.
    expect(await panel.evaluate((el) => el.scrollTop)).toBe(0);

    // Keep wheeling to the bottom rather than assuming one gesture covers the whole
    // range, so adding destinations later cannot fail this for a reason unrelated
    // to scrolling.
    await expect.poll(async () => {
      await page.mouse.wheel(0, 200);
      return viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    }).toBeLessThanOrEqual(1);

    // The last destination is genuinely reachable by mouse, not just present.
    await expect(last).toBeInViewport({ ratio: 1 });
  });

  test('the Navigate panel sizes to its content when the viewport is tall', async ({ page }) => {
    // The mirror of the test above, guarding the other direction: the cap has to
    // track the popper's available height rather than a fixed pixel value. A
    // hardcoded cap would keep every assertion above green while needlessly
    // cropping the panel on a roomy screen.
    await page.setViewportSize({ width: 1400, height: 900 });
    const trigger = page.getByRole('button', { name: 'Open navigation launcher' });
    await trigger.click();

    const panel = page.getByRole('menu').filter({ has: page.getByText('Navigate', { exact: true }) });
    const viewport = panel.locator('[data-radix-scroll-area-viewport]');
    await expect(viewport).toBeVisible();

    // Content fits without being clipped when the viewport is roomy enough.
    const metrics = await viewport.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
  });
});
