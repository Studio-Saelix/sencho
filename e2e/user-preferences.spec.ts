/**
 * Server-backed per-user interface preferences: cross-browser convergence,
 * pre-paint caching, remote reset precedence, account switching, and
 * localStorage legacy migration through the new persistence layer.
 *
 * Seeding uses the API (page.request carries the auth cookie) with the
 * x-sencho-pref-user identity header; raw-localStorage setup appears only
 * where the test targets the pre-paint path itself.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForShellReady, waitForStacksLoaded, TEST_USERNAME, TEST_PASSWORD } from './helpers';
import {
  APPEARANCE_DOC, NAVIGATION_DOC, currentUserId, ensureE2EUser, getPreferences, prefHeaders, putDomain,
  type PreferenceEnvelope,
} from './preferences-helpers';

test.describe('User preferences across browsers', () => {
  test.describe.configure({ mode: 'serial' });

  let adminId = 0;
  let secondUserId = 0;
  const SECOND_USER = 'pref-e2e-user';
  const SECOND_PASSWORD = 'pref-e2e-password-123';
  // Viewer persona from the shared dev seed (role: viewer): used to prove the
  // rail filter is presentation-only. Test runs provide matching credentials
  // via the standard env pair; the viewer shares the admin's password there.
  const VIEWER_USER = process.env.E2E_VIEWER_USERNAME ?? 'persona-viewer';

  test.beforeAll(async ({ request }) => {
    const login = await request.post('/api/auth/login', {
      data: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    if (!login.ok()) throw new Error('admin login failed; set E2E_USERNAME/E2E_PASSWORD');
    const check = await request.get('/api/auth/check');
    const body = (await check.json()) as { user?: { userId?: number } };
    adminId = body.user?.userId ?? 0;

    // Clean up a second account orphaned by an aborted earlier run.
    const list = await request.get('/api/users');
    if (list.ok()) {
      const users = (await list.json()) as Array<{ id: number; username: string }>;
      const orphan = users.find((u) => u.username === SECOND_USER);
      if (orphan) secondUserId = orphan.id;
    }

    // The viewer persona must exist before any test logs in as it; the shared
    // dev seed normally provides it, but a bare environment needs the account.
    await ensureE2EUser(request, VIEWER_USER, TEST_PASSWORD, 'viewer');
  });

  test.afterAll(async ({ request }) => {
    // Clean the second account (keeps the shared dev DB tidy across runs).
    if (secondUserId) {
      const login = await request.post('/api/auth/login', {
        data: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });
      if (login.ok()) {
        await request.delete(`/api/users/${secondUserId}`).catch(() => undefined);
      }
    }
  });

  test('appearance and navigation edits in context A converge into a fresh context B', async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await loginAs(pageA);
    adminId = await currentUserId(pageA.request);

    // Seed the server documents through the API (page.request shares cookies).
    await putDomain(pageA.request, adminId, 'appearance', APPEARANCE_DOC);
    await putDomain(pageA.request, adminId, 'navigation', NAVIGATION_DOC);

    // Reload A so hydration reflects the server document (convergence check
    // for the writing browser itself).
    await pageA.reload();
    await waitForStacksLoaded(pageA);
    await expect(pageA.locator('html')).toHaveAttribute('data-theme', 'oled');
    await expect(pageA.locator('body')).toHaveClass(/density-compact/);
    await expect(pageA.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'compact');

    // Fresh storage: context B has never seen this user's cache.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await loginAs(pageB);
    await waitForStacksLoaded(pageB);
    await expect(pageB.locator('html')).toHaveAttribute('data-theme', 'oled');
    await expect(pageB.locator('body')).toHaveClass(/density-compact/);
    await expect(pageB.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'compact');

    // The pinned quick links cross browsers in their exact saved order
    // (dashboard, networking, auto-updates): Home, Networking, Update.
    const rail = pageB.locator('[data-sn-quick-link-rail]');
    await expect(rail.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Networking', exact: true })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
    const pinnedLabels = await rail.getByRole('button').evaluateAll((buttons) =>
      buttons.map((b) => b.getAttribute('aria-label')),
    );
    expect(pinnedLabels).toEqual(['Home', 'Networking', 'Update']);

    await contextA.close();
    await contextB.close();
  });

  test('a viewer filters hidden pins from the rail without modifying the saved ids', async ({ browser }) => {
    // Preferences are per-user, so the viewer's own navigation record is
    // seeded (not the admin's): the assertion is that the rail filters the
    // viewer's saved pins for presentation only.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await loginAs(pageB, VIEWER_USER, TEST_PASSWORD, { viewerSafe: true });
    await waitForShellReady(pageB);
    const viewerId = await currentUserId(pageB.request);
    await putDomain(pageB.request, viewerId, 'navigation', NAVIGATION_DOC);
    await pageB.goto('/');
    await waitForShellReady(pageB);

    // auto-updates (Update) is a hidden view for viewers, so the rail must
    // filter it out of the saved pin list while the ids survive.
    const rail = pageB.locator('[data-sn-quick-link-rail]');
    const pinnedLabels = await rail.getByRole('button').evaluateAll((buttons) =>
      buttons.map((b) => b.getAttribute('aria-label')),
    );
    expect(pinnedLabels).toEqual(['Home', 'Networking']);

    // The filter is presentation-only: the viewer's own record still returns
    // the saved list untouched.
    const rows = await getPreferences(pageB.request, viewerId);
    expect(rows.preferences.navigation?.data).toMatchObject({ quickLinks: NAVIGATION_DOC.quickLinks });
    await contextB.close();
  });

  test('a cached reload paints the server-canonical theme at pre-paint', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page);

    // The user edits theme in the UI (server write + cache write-through),
    // then the reload is the pre-paint path: theme-init.js reads the cache.
    await page.getByRole('button', { name: /profile/i }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByText('Motion & effects')).toBeVisible();
    await page.getByRole('radio', { name: 'Dim' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dim');
    // The debounce must have flushed before the reload.
    await page.waitForTimeout(700);

    // Reload the pre-paint path from the dashboard: '/' (not reload()) so the
    // URL-synced Settings view does not restore and hide the stacks sidebar
    // that waitForStacksLoaded waits on.
    await page.addInitScript(() => {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          (window as unknown as { __snThemeAtDCL?: string | null }).__snThemeAtDCL =
            document.documentElement.getAttribute('data-theme');
        },
        { once: true },
      );
    });
    await page.goto('/');
    await waitForStacksLoaded(page);
    const atDcl = await page.evaluate(
      () => (window as unknown as { __snThemeAtDCL?: string | null }).__snThemeAtDCL ?? null,
    );
    expect(atDcl).toBe('dim');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dim');

    // Restore OLED so later tests start from a known state.
    await putDomain(page.request, adminId, 'appearance', APPEARANCE_DOC);
    await context.close();
  });

  test('a complete reset in one browser converges the other to defaults', async ({ browser }) => {
    // Known baseline first: the reset must be observable as a change.
    const contextSeed = await browser.newContext();
    const pageSeed = await contextSeed.newPage();
    await loginAs(pageSeed);
    await putDomain(pageSeed.request, adminId, 'appearance', APPEARANCE_DOC);
    await putDomain(pageSeed.request, adminId, 'navigation', NAVIGATION_DOC);
    await contextSeed.close();

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await loginAs(pageA);
    await waitForStacksLoaded(pageA);

    // Drive the in-UI reset (both domains + browser-local toggles cleared).
    await pageA.getByRole('button', { name: /profile/i }).click();
    await pageA.getByRole('button', { name: 'Settings', exact: true }).click();
    await pageA.getByRole('button', { name: 'Recovery', exact: true }).click();
    await pageA.getByRole('button', { name: 'Reset interface preferences' }).click();
    await expect(pageA.getByText('Interface preferences reset to defaults. Reloading...')).toBeVisible();
    await pageA.waitForLoadState('load');
    // The app auto-reloads on the settings URL, which hides the stacks sidebar;
    // go to the dashboard root so the standard readiness sentinel applies.
    await pageA.goto('/');
    await waitForStacksLoaded(pageA);
    await expect(pageA.locator('html')).toHaveAttribute('data-theme', 'dim');

    // Browser B (fresh context, same account) converges to the tombstone.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await loginAs(pageB);
    await waitForStacksLoaded(pageB);
    await expect(pageB.locator('html')).toHaveAttribute('data-theme', 'dim');
    await expect(pageB.locator('body')).not.toHaveClass(/density-compact/);

    // Restore the seeded documents so later tests (and other suites that use
    // the shared admin account) do not start from the reset tombstones.
    await putDomain(pageB.request, adminId, 'appearance', APPEARANCE_DOC);
    await putDomain(pageB.request, adminId, 'navigation', NAVIGATION_DOC);

    await contextA.close();
    await contextB.close();
  });

  test('a pending write captured before an account switch is rejected and neither record changes', async ({ browser }) => {
    // Create the second account via the admin API.
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page);
    await waitForStacksLoaded(page);
    adminId = await currentUserId(page.request);

    const create = await page.request.post('/api/users', {
      data: { username: SECOND_USER, password: SECOND_PASSWORD, role: 'viewer' },
    });
    if (create.status() === 409) {
      // From a previous run: log in to find its id. The account is a viewer,
      // so the viewer-safe readiness wait applies.
      const ctx2 = await browser.newContext();
      const p2 = await ctx2.newPage();
      await loginAs(p2, SECOND_USER, SECOND_PASSWORD, { viewerSafe: true });
      secondUserId = await currentUserId(p2.request);
      await ctx2.close();
    } else {
      expect(create.ok()).toBeTruthy();
      const body = (await create.json()) as { id: number };
      secondUserId = body.id;
    }

    // Seed each account with a distinguishable appearance document.
    await putDomain(page.request, adminId, 'appearance', APPEARANCE_DOC);
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await loginAs(pageB, SECOND_USER, SECOND_PASSWORD, { viewerSafe: true });
    const secondId = await currentUserId(pageB.request);
    expect(secondId).toBe(secondUserId);
    await putDomain(pageB.request, secondId, 'appearance', {
      ...APPEARANCE_DOC, theme: 'light', density: 'comfortable',
    });

    // Stale-tab simulation: in one request context, swap the auth cookie to
    // the second account, then replay a write captured for the admin (the
    // header a tab that has not yet noticed the switch would send).
    const loginB = await page.context().request.post('/api/auth/login', {
      data: { username: SECOND_USER, password: SECOND_PASSWORD },
    });
    expect(loginB.ok()).toBeTruthy();
    const rejected = await page.context().request.put('/api/user-preferences/appearance', {
      headers: prefHeaders(adminId),
      data: { expectedRevision: 1, ...APPEARANCE_DOC },
    });
    expect(rejected.status()).toBe(409);
    const rejectBody = (await rejected.json()) as { error?: string; current?: unknown };
    expect(rejectBody.error).toBe('IDENTITY_CHANGED');
    // No other account's data may ride along on an identity error.
    expect(rejectBody.current).toBeUndefined();

    // Both records are unchanged by the rejected write: B still shows light.
    const bCheck = await pageB.request.get('/api/user-preferences', { headers: prefHeaders(secondUserId) });
    const bRows = (await bCheck.json()) as { preferences: Record<string, PreferenceEnvelope | null> };
    expect(bRows.preferences.appearance?.data).toMatchObject({ theme: 'light' });

    await ctxB.close();
    await context.close();
  });

  test('legacy classic mode migrates to compact under the persistence layer', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page);
    await waitForStacksLoaded(page);

    // Raw-localStorage seed: this test targets the client-side normalization
    // of a legacy value, so pre-seeding is the point, not a bypass.
    await page.evaluate(() => {
      window.localStorage.setItem('sencho.appearance.topNavMode', JSON.stringify('classic'));
    });
    await page.reload();
    await waitForStacksLoaded(page);
    await expect(page.locator('[data-sn-chrome="topbar"]')).toHaveAttribute('data-sn-nav-mode', 'compact');
    await context.close();
  });
});
