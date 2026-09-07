/**
 * Desktop navigation styles: Compact default, Smart alternate, labeled pins,
 * launcher animation, Navigate panel scrolling, and persistence.
 *
 * Environment isolation: the suite logs in as a dedicated admin account and
 * seeds its navigation row through the preference API, so tests neither read
 * another suite's rows nor depend on raw-localStorage setup. Raw localStorage
 * is used only where the migration path itself is the test target. Admin is
 * required because the Smart bar's More group depends on overflow-classified
 * views surviving the role filter. The notifications subsystem is mocked for
 * every test: this suite asserts navigation chrome, not notifications, and
 * the local notification WebSocket reconnect churn accumulates renderer
 * resources across page loads.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded, waitForShellReady, TEST_USERNAME, TEST_PASSWORD } from './helpers';
import {
  NAVIGATION_DOC, ensureE2EUser, currentUserId, putDomain,
} from './preferences-helpers';

const SUITE_USER = 'nav-styles-e2e';
const SUITE_PASSWORD = 'nav-styles-password-123';
// Admin, not viewer: the Smart bar's More group only exists when an
// overflow-classified view survives the role filter, and every overflow view
// (Logs, Update, Schedules, Console, Audit) is hidden for a viewer. A viewer
// account therefore never renders More navigation at any viewport width.
const SUITE_ROLE = 'admin' as const;

let suiteUserId = 0;
let api: import('@playwright/test').APIRequestContext;
let adminApiContext: import('@playwright/test').APIRequestContext;

/** A suite-owned request context (beforeAll fixtures cannot span tests). */
async function suiteApi(): Promise<import('@playwright/test').APIRequestContext> {
  if (!api) {
    api = await import('@playwright/test').then(({ request: pwRequest }) =>
      pwRequest.newContext({ baseURL: 'http://localhost:5173' }));
  }
  return api;
}

/** An admin request context, used only for suite-account lifecycle. */
async function adminApi(): Promise<import('@playwright/test').APIRequestContext> {
  if (!adminApiContext) {
    adminApiContext = await import('@playwright/test').then(({ request: pwRequest }) =>
      pwRequest.newContext({ baseURL: 'http://localhost:5173' }));
    const login = await adminApiContext.post('/api/auth/login', {
      data: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    if (!login.ok()) throw new Error(`admin login failed with ${login.status()}`);
  }
  return adminApiContext;
}

/**
 * Seed the suite account's navigation row through the API, then give the
 * browser a matching cached state so the next load hydrates from the server
 * (which rewrites the cache) and paints exactly what was seeded.
 */
type NavPatch = Partial<Omit<typeof NAVIGATION_DOC, 'status'>> & Record<string, unknown>;
async function seedNavigation(doc: NavPatch) {
  return putDomain(await suiteApi(), suiteUserId, 'navigation', { ...NAVIGATION_DOC, ...doc });
}

/**
 * Fresh page in the same context: the auth cookie persists, so the new page
 * loads straight into the dashboard. Used instead of page.reload() where the
 * reload itself is not the behavior under test.
 */
async function freshDashboard(context: import('@playwright/test').BrowserContext, viewerSafe = false) {
  const page = await context.newPage();
  await page.goto('/');
  if (viewerSafe) await waitForShellReady(page);
  else await waitForStacksLoaded(page);
  return page;
}

test.describe('Desktop navigation styles', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // Seeding runs as the suite account itself: the identity guard rejects a
    // request whose x-sencho-pref-user does not match the session, so the
    // suite context logs in as SUITE_USER before writing its row.
    const request = await suiteApi();
    await ensureE2EUser(await adminApi(), SUITE_USER, SUITE_PASSWORD, SUITE_ROLE);
    const login = await request.post('/api/auth/login', {
      data: { username: SUITE_USER, password: SUITE_PASSWORD },
    });
    if (!login.ok()) throw new Error(`suite login failed with ${login.status()}`);
    suiteUserId = await currentUserId(request);
    // Baseline: Compact launcher, labeled, left-aligned, defaults pins.
    await putDomain(request, suiteUserId, 'navigation', NAVIGATION_DOC);
  });

  test.afterAll(async () => {
    if (adminApiContext) {
      const users = await adminApiContext.get('/api/users');
      if (users.ok()) {
        const list = (await users.json()) as Array<{ id: number; username: string }>;
        const found = list.find((u) => u.id === suiteUserId);
        if (found) await adminApiContext.delete(`/api/users/${suiteUserId}`);
      }
      await adminApiContext.dispose();
      adminApiContext = undefined as unknown as typeof adminApiContext;
    }
    if (api) {
      await api.dispose();
      api = undefined as unknown as typeof api;
    }
  });

  test.beforeEach(async ({ page }) => {
    // The suite does not test notifications; quieting the local notification
    // WebSocket and its polling keeps repeated page loads within renderer
    // resource limits on constrained hosts.
    await page.route('**/api/notifications**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/ws/notifications**', (route) => route.abort());
    await loginAs(page, SUITE_USER, SUITE_PASSWORD, { viewerSafe: true });
  });

  test('defaults to Compact launcher with an Open navigation launcher control', async ({ page }) => {
    const topbar = page.locator('[data-sn-chrome="topbar"]');
    await expect(topbar).toHaveAttribute('data-sn-nav-mode', 'compact');
    await expect(page.getByRole('button', { name: 'Open navigation launcher' })).toBeVisible();
  });

  test('a legacy classic preference migrates to compact on load', async ({ page, context }) => {
    // Raw localStorage seed: the legacy-value migration path is the test
    // target. Navigation hydration normalizes classic to Compact before any
    // server write, so the migrated value is what the server ends up with.
    await page.evaluate(() => {
      window.localStorage.setItem('sencho.appearance.topNavMode', 'classic');
    });
    const second = await freshDashboard(context, true);
    await expect(second.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'compact');
    await second.close();
  });

  test('persists mode across reload and navigates via Smart More', async ({ page, context }) => {
    await seedNavigation({ mode: 'smart' });
    const second = await context.newPage();
    await second.goto('/');
    await waitForShellReady(second);
    const topbar = second.locator('[data-sn-chrome="topbar"]');
    await expect(topbar).toHaveAttribute('data-sn-nav-mode', 'smart');
    await second.getByRole('button', { name: 'More navigation' }).click();
    await expect(second.getByRole('menuitem', { name: /Logs/i })).toBeVisible();
    await expect(second.locator('.font-heading').filter({ hasText: 'More' })).toHaveCount(0);
    await second.getByRole('menuitem', { name: /Logs/i }).click();
    await expect(second.locator('body')).toContainText(/Logs|Central|Observability/i);
    await second.close();
    // Restore the compact baseline for the remaining tests.
    await seedNavigation({ mode: 'compact' });
  });

  test('Compact launcher opens Settings', async ({ page }) => {
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'compact');
    await page.getByRole('button', { name: 'Open navigation launcher' }).click();
    await page.getByRole('menuitem', { name: /^Settings$/i }).click();
    await expect(page.getByText('Appearance', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('Compact trailing + adds a labeled pin that survives reload', async ({ page, context }) => {
    await seedNavigation({ quickLinks: [] });
    const second = await freshDashboard(context, true);
    await second.setViewportSize({ width: 1100, height: 800 });
    const topbar = second.locator('[data-sn-chrome="topbar"]');
    await expect(topbar).toHaveAttribute('data-sn-nav-mode', 'compact');

    await second.getByRole('button', { name: 'Add quick link' }).click();
    await second.getByRole('menuitem', { name: /Networking/i }).click();

    const pin = topbar.getByRole('button', { name: 'Networking', exact: true });
    await expect(pin).toBeVisible();
    await expect(pin.locator('span.inline')).toBeVisible();

    // The seed pinned an empty list, so the debounced sync write has landed
    // exactly when the server row starts including the new pin.
    await expect.poll(async () => {
      const after = await import('./preferences-helpers').then((h) =>
        h.getPreferences(second.request, suiteUserId));
      return (after.preferences.navigation?.data?.quickLinks as string[] | undefined)?.includes('networking');
    }, { timeout: 10_000 }).toBe(true);

    // Persistence across a real reload on the same page (load 2 of 3 here).
    await second.reload();
    await waitForShellReady(second);
    await expect(topbar.getByRole('button', { name: 'Networking', exact: true })).toBeVisible();
    await expect(second.getByRole('button', { name: 'Add quick link' })).toBeVisible();
    await second.close();
    // Restore the baseline pin set for the remaining tests.
    await seedNavigation({ quickLinks: NAVIGATION_DOC.quickLinks });
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
    await page.getByRole('menuitem', { name: /^Settings$/i }).click({ force: false, timeout: 10_000 }).catch(async (e) => {
      // Under a long-running idle animation the menu item can report
      // "not stable" to Playwright's actionability check, then get replaced by
      // a re-render before the retry lands. Escape closes the launcher and a
      // second open presents a fresh, settled panel, so recover that way
      // instead of letting the actionability loop eat the 30s test timeout.
      void e;
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('data-state', 'closed');
      await trigger.click();
      await page.getByRole('menuitem', { name: /^Settings$/i }).click();
    });
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
