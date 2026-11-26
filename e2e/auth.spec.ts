/**
 * Authentication E2E tests.
 * Tests login, logout, and unauthenticated redirect.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, isDashboard, TEST_USERNAME, TEST_PASSWORD } from './helpers';
import { adminApiContext, deleteE2EUser, ensureE2EUser } from './preferences-helpers';

test.describe('Authentication', () => {
  test('login with valid credentials shows the dashboard', async ({ page }) => {
    await loginAs(page, TEST_USERNAME, TEST_PASSWORD);
    expect(await isDashboard(page)).toBe(true);
    // URL should not be on a login page
    expect(page.url()).not.toMatch(/login/i);
  });

  test('login with wrong password shows an error', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);

    // Skip if already logged in
    if (await isDashboard(page)) {
      await page.context().clearCookies();
      await page.reload();
      await page.waitForTimeout(500);
    }

    await page.locator('#username').fill(TEST_USERNAME);
    await page.locator('#password').fill('definitely-wrong-password-xyz');
    await page.locator('button:has-text("Login"), button:has-text("Sign in")').first().click();

    // Should show error message, not navigate to dashboard
    await expect(page.locator('text=/invalid|incorrect|wrong|failed/i')).toBeVisible({ timeout: 5_000 });
    expect(await isDashboard(page)).toBe(false);
  });

  test('visiting the app without auth redirects to login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/');
    await page.waitForTimeout(1_000);

    // Should be on login or setup, not dashboard
    expect(await isDashboard(page)).toBe(false);
    // Login button or setup form should be visible
    const loginOrSetup = await page.locator(
      'button:has-text("Login"), button:has-text("Sign in"), button[type="submit"]'
    ).first().isVisible();
    expect(loginOrSetup).toBe(true);
  });

  test('logout returns to the login screen', async ({ page }) => {
    await loginAs(page);
    // Log Out is inside the User Profile Dropdown - open it first
    await page.getByRole('button', { name: /profile/i }).click();
    await page.getByRole('button', { name: /log out/i }).click();
    await page.waitForTimeout(1_000);
    expect(await isDashboard(page)).toBe(false);
  });
});

/**
 * Delay every auth check, so the app stays on its boot splash past the point
 * where a single timed probe finds neither setup, sign-in, nor the dashboard.
 * The helper must wait for the surface, not sample it once. Every request is
 * delayed because the dev build mounts the auth provider in StrictMode, so the
 * check that wins is not necessarily the first one.
 */
async function delayAuthStatus(page: Page, delayMs: number): Promise<void> {
  await page.route('**/api/auth/status', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.continue();
  });
}

test.describe('login readiness', () => {
  const READINESS_VIEWER = 'auth-readiness-viewer';
  const READINESS_PASSWORD = 'auth-readiness-password-123';
  let viewerId = 0;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const admin = await adminApiContext();
    try {
      viewerId = await ensureE2EUser(admin, READINESS_VIEWER, READINESS_PASSWORD, 'viewer');
    } finally {
      await admin.dispose();
    }
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    if (!viewerId) return;
    const admin = await adminApiContext();
    try {
      await deleteE2EUser(admin, viewerId);
    } finally {
      await admin.dispose();
    }
  });

  test('waits for a delayed auth check instead of sampling the splash once', async ({ page }) => {
    await delayAuthStatus(page, 1_500);
    await loginAs(page);
    await expect(page.locator('[data-sn-chrome="topbar"]')).toBeVisible();
  });

  test('waits for a delayed auth check on the non-admin shell path', async ({ page }) => {
    await delayAuthStatus(page, 1_500);
    await loginAs(page, READINESS_VIEWER, READINESS_PASSWORD, { viewerSafe: true });
    await expect(page.locator('[data-sn-chrome="topbar"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Stack' })).toHaveCount(0);
  });

  /**
   * The sign-in screen fails closed: when its auth status request fails, it
   * hides the password form behind an error instead of showing it. The helper
   * has to retry that page load, not wait for a form that will never render.
   */
  test('recovers when the sign-in screen hides its form after a failed auth check', async ({ page }) => {
    const failUntil = Date.now() + 4_000;
    await page.route('**/api/auth/status', async (route) => {
      if (Date.now() < failUntil) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.continue();
    });
    await loginAs(page);
    await expect(page.locator('[data-sn-chrome="topbar"]')).toBeVisible();
  });
});
