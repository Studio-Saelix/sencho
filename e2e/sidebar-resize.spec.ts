/**
 * Desktop shell: resizable stacks sidebar journeys.
 *
 * Covers the Fixed default (no separator, 256px pane), the Resizable opt-in
 * with drag + keyboard resize, one preference write per drag (release is the
 * persistence boundary), viewport clamping without persisting the clamped
 * width, the targeted sidebar reset (mode + width only; other appearance
 * values survive), account scoping, and the mobile layout showing no handle.
 *
 * Seeding uses the shared preference helpers; drag writes are asserted on the
 * network (PUT /api/user-preferences/appearance) because the 400ms debounce
 * makes DOM-only timing flaky.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForShellReady, TEST_PASSWORD } from './helpers';
import {
  APPEARANCE_DOC, adminApiContext, currentUserId, disposePrefUser, getPreferences, putDomain,
  seedPrefUser,
} from './preferences-helpers';

const SUITE_USER = 'sidebar-resize-e2e';
const DEBOUNCE_MS = 700;

/** The sidebar pane (Resizable mode only) and its separator handle. */
function pane(page: Page) {
  return page.getByTestId('sidebar-resize-pane');
}
function separator(page: Page) {
  return page.getByTestId('sidebar-resize-separator');
}

/** Navigate to Settings > Appearance (desktop path via the profile menu). */
async function openAppearanceSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /profile/i }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sidebar layout' })).toBeVisible();
}

/** Wait for the preference sync bus to flush its queued appearance write. */
async function flushPreferenceWrite(page: Page): Promise<void> {
  await page.waitForTimeout(DEBOUNCE_MS);
}

/**
 * Log in on a phone viewport. loginAs cannot be used here: its readiness
 * probes target the desktop topbar, which bespoke mobile screens never
 * render (the phone shell rehomes notifications and the nav into the
 * masthead and the bottom navigation). Waits for the mobile sidebar chrome
 * on the stacks list surface instead.
 */
async function mobileLogin(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#username').fill(SUITE_USER);
  await page.locator('#password').fill(TEST_PASSWORD);
  await page.locator('button:has-text("Login"), button:has-text("Sign in")').first().click();
  await expect(page.getByRole('navigation', { name: 'Primary mobile' })).toBeVisible({ timeout: 15_000 });
  await page.goto('/nodes/local/stacks');
  await expect(page.locator('[data-sn-chrome="sidebar"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
}

test.describe('Resizable stacks sidebar', () => {
  test.describe.configure({ mode: 'serial' });

  let prefUser: Awaited<ReturnType<typeof seedPrefUser>> | undefined;
  let admin: Awaited<ReturnType<typeof adminApiContext>> | undefined;

  test.beforeAll(async () => {
    prefUser = await seedPrefUser(SUITE_USER, TEST_PASSWORD, 'viewer');
    // A retried or reseeded suite account may carry a stale Resizable row
    // (the tests run serially); reset the domain so the Fixed-default test
    // always starts from the true default.
    await putDomain(prefUser.request, prefUser.userId, 'appearance', APPEARANCE_DOC);
  });

  test.afterAll(async () => {
    await disposePrefUser(prefUser, admin);
  });

  test('Fixed is the default: no separator and the pane is absent', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);
    await expect(separator(page)).toHaveCount(0);
    await expect(pane(page)).toHaveCount(0);
    await context.close();
  });

  test('opting in through Settings shows the separator and one PUT lands', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);

    const puts: { body: Record<string, unknown> }[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/user-preferences/appearance')) {
        puts.push({ body: req.postDataJSON() as Record<string, unknown> });
      }
    });

    await openAppearanceSettings(page);
    await page.getByRole('radio', { name: 'Resizable' }).click();
    await expect(separator(page)).toBeVisible();
    await flushPreferenceWrite(page);

    const writes = puts.filter((p) => p.body.sidebarMode === 'resizable');
    expect(writes).toHaveLength(1);
    expect(writes[0].body.sidebarMode).toBe('resizable');
    expect(writes[0].body.sidebarWidth).toBe(256);

    await context.close();
  });

  test('dragging the separator resizes, persists after reload, and writes exactly once', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);

    let putCount = 0;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/user-preferences/appearance')
        && (req.postDataJSON() as Record<string, unknown>).sidebarWidth !== undefined) {
        putCount += 1;
      }
    });

    const box = await separator(page).boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;

    // Drag right by 64px: release is the persistence boundary, so no PUT may
    // fire while the pointer is still down.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 32, startY, { steps: 4 });
    await page.mouse.move(startX + 64, startY, { steps: 4 });
    expect(putCount).toBe(0);
    await page.mouse.up();
    await flushPreferenceWrite(page);
    expect(putCount).toBe(1);

    const widthDuringDrag = 256 + 64;
    await expect
      .poll(async () => parseInt(await pane(page).evaluate((el: HTMLElement) => el.style.width), 10))
      .toBe(widthDuringDrag);

    // The committed width survives a reload (server-backed preference).
    await page.reload();
    await waitForShellReady(page);
    await expect(pane(page)).toHaveAttribute('style', /width: 320px/);

    await context.close();
  });

  test('keyboard resize commits per key press', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);
    await expect(pane(page)).toHaveAttribute('style', /width: 320px/);

    await separator(page).focus();
    const before = Number(await pane(page).evaluate((el: HTMLElement) => parseInt(el.style.width, 10)));
    await page.keyboard.press('ArrowRight');
    await flushPreferenceWrite(page);
    await expect(pane(page)).toHaveAttribute('style', /width: 328px/);
    expect(before).toBe(320);
    await separator(page).focus();
    await page.keyboard.press('Home');
    await flushPreferenceWrite(page);
    await expect(pane(page)).toHaveAttribute('style', /width: 224px/);

    // Leave a comfortable width for the later retention tests.
    await separator(page).focus();
    await page.keyboard.press('End');
    await flushPreferenceWrite(page);
    await expect(separator(page)).toHaveAttribute('aria-valuemax', '440');
    await expect(pane(page)).toHaveAttribute('style', /width: 440px/);

    await context.close();
  });

  test('dragging past the viewport bound clamps live without persisting the clamp', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);

    // effectiveMax = 900 - 560 (workspace) - 12 (handle) = 328, even though the
    // stored preference says 440. The clamp is viewport-derived, not persisted.
    await expect(pane(page)).toHaveAttribute('style', /width: 328px/);
    await expect(separator(page)).toHaveAttribute('aria-valuemax', '328');

    const rows = await getPreferences(page.request, prefUser!.userId);
    expect(rows.preferences.appearance?.data).toMatchObject({ sidebarWidth: 440 });

    // Dragging into the bound stops there and still persists the clamped value
    // the user actually landed on.
    const box = await separator(page).boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 120, startY, { steps: 4 });
    await page.mouse.up();
    await flushPreferenceWrite(page);

    await expect(pane(page)).toHaveAttribute('style', /width: 328px/);
    const afterRows = await getPreferences(page.request, prefUser!.userId);
    expect(afterRows.preferences.appearance?.data).toMatchObject({ sidebarWidth: 328 });

    await context.close();
  });

  test('Fixed retains the width; returning to Resizable restores it', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);

    // Seed a known preferred width so the retained value is deterministic
    // regardless of what the clamp test committed before this test.
    await putDomain(page.request, prefUser!.userId, 'appearance',
      { ...APPEARANCE_DOC, sidebarMode: 'resizable', sidebarWidth: 440 });
    await page.reload();
    await waitForShellReady(page);

    await openAppearanceSettings(page);
    await page.getByRole('radio', { name: 'Fixed' }).click();
    await expect(separator(page)).toHaveCount(0);
    await expect(pane(page)).toHaveCount(0);
    await flushPreferenceWrite(page);

    // Fixed keeps the preferred width in the stored document.
    const rows = await getPreferences(page.request, prefUser!.userId);
    expect(rows.preferences.appearance?.data).toMatchObject({ sidebarMode: 'fixed', sidebarWidth: 440 });

    // Back to Resizable: the retained width applies again (the default
    // viewport allows it, so no clamp rewrites it).
    await page.getByRole('radio', { name: 'Resizable' }).click();
    await expect(pane(page)).toBeVisible();
    await flushPreferenceWrite(page);
    const restored = parseInt(await pane(page).evaluate((el: HTMLElement) => el.style.width), 10);
    expect(restored).toBe(440);

    await context.close();
  });

  test('targeted reset restores Fixed + default width and leaves theme/density untouched', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);

    // Give the suite account a non-default theme and density so the reset's
    // "other appearance preferences are untouched" promise is observable.
    const userId = await currentUserId(page.request);
    await putDomain(page.request, userId, 'appearance', { ...APPEARANCE_DOC, theme: 'dim', sidebarMode: 'resizable', sidebarWidth: 400 });
    await page.reload();
    await waitForShellReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dim');

    await openAppearanceSettings(page);
    await page.getByRole('button', { name: 'Reset sidebar layout' }).click();
    await flushPreferenceWrite(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dim');
    await expect(separator(page)).toHaveCount(0);
    await expect(pane(page)).toHaveCount(0);

    const rows = await getPreferences(page.request, prefUser!.userId);
    expect(rows.preferences.appearance?.data).toMatchObject({
      sidebarMode: 'fixed', sidebarWidth: 256, theme: 'dim',
    });

    await context.close();
  });

  test('each account keeps its own layout: no leakage across users', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, SUITE_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(page);

    // A fresh account has no row at all: its shell is Fixed/256 even though
    // the suite account has a persisted Resizable layout on this install.
    const second = await seedPrefUser('sidebar-resize-e2e-2', TEST_PASSWORD, 'viewer');
    try {
      const contextB = await browser.newContext();
      const pageB = await contextB.newPage();
      await loginAs(pageB, 'sidebar-resize-e2e-2', TEST_PASSWORD, { viewerSafe: true });
      await waitForShellReady(pageB);
      await expect(separator(pageB)).toHaveCount(0);
      await expect(pane(pageB)).toHaveCount(0);
      await contextB.close();

      // And the suite account's row still carries its own values.
      const rows = await getPreferences(page.request, prefUser!.userId);
      expect(rows.preferences.appearance?.data).toMatchObject({ sidebarMode: 'fixed', sidebarWidth: 256 });
    } finally {
      const adminCtx = await adminApiContext();
      await disposePrefUser(second, adminCtx);
    }
    await context.close();
  });

  test('mobile viewport shows no handle and unchanged layout', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await mobileLogin(page);
    await expect(separator(page)).toHaveCount(0);
    await expect(pane(page)).toHaveCount(0);
    await expect(page.locator('[data-sn-chrome="sidebar"]')).toBeVisible();
    await context.close();
  });
});
