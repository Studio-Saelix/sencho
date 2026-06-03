/**
 * Shared helpers for Sencho E2E tests.
 *
 * CREDENTIALS: Set E2E_USERNAME and E2E_PASSWORD env vars to match
 * your dev instance's admin account. Defaults assume the initial setup
 * was completed with username "admin" and password "password123".
 *
 *   E2E_USERNAME=admin E2E_PASSWORD=mypassword npx playwright test
 */
import { Page, expect } from '@playwright/test';
import { OTP } from 'otplib';

const totp = new OTP({ strategy: 'totp' });
const TOTP_PARAMS = { algorithm: 'sha1' as const, digits: 6, period: 30 };

export const TEST_USERNAME = process.env.E2E_USERNAME ?? 'admin';
export const TEST_PASSWORD = process.env.E2E_PASSWORD ?? 'password123';

/**
 * Generate a current TOTP code for the given base32 secret. Used by the MFA
 * E2E tests to drive the login challenge without a real authenticator app.
 */
export function totpNow(secret: string): string {
  return totp.generateSync({ secret: secret.replace(/\s+/g, ''), ...TOTP_PARAMS });
}

/** Selector for the dashboard - only present in EditorLayout, not on login/setup pages */
const DASHBOARD_INDICATOR = 'img[src*="sencho-logo"]';

/** Returns true if the current page is the first-run setup screen */
async function isSetupPage(page: Page): Promise<boolean> {
  return page.locator('#confirmPassword, input[placeholder*="Confirm"]').isVisible().catch(() => false);
}

/** Returns true if the current page is the login screen */
async function isLoginPage(page: Page): Promise<boolean> {
  return page.locator('button:has-text("Login"), button:has-text("Sign in")').isVisible().catch(() => false);
}

/** Returns true if the dashboard (EditorLayout) is loaded */
export async function isDashboard(page: Page): Promise<boolean> {
  return page.locator(DASHBOARD_INDICATOR).isVisible().catch(() => false);
}

/**
 * Wait for the stacks sidebar to finish loading. Waits for the Create Stack
 * button and the data-stacks-loaded sentinel set by the CommandList after its
 * async refreshStacks() call resolves.
 */
export async function waitForStacksLoaded(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Create Stack' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
}

/**
 * Navigate to the app root, complete first-run setup if needed, then log in.
 * After this call the dashboard is guaranteed to be visible.
 */
export async function loginAs(page: Page, username = TEST_USERNAME, password = TEST_PASSWORD) {
  await page.goto('/');

  // Wait for the app to finish its auth check (loading spinner disappears)
  await page.waitForTimeout(500);

  // ── First-run setup ───────────────────────────────────────────────────────
  if (await isSetupPage(page)) {
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    const confirmInput = page.locator('#confirmPassword');
    if (await confirmInput.isVisible()) await confirmInput.fill(password);
    await page.locator('button[type="submit"]').click();
    // Setup signs the new admin in and then shows an environment-preflight
    // step; clicking "Enter Sencho" completes onboarding and lands the dashboard.
    const enterButton = page.getByRole('button', { name: /enter sencho/i });
    await expect(enterButton).toBeVisible({ timeout: 10_000 });
    await enterButton.click();
    await expect(page.locator(DASHBOARD_INDICATOR)).toBeVisible({ timeout: 10_000 });
    return;
  }

  // ── Login screen ─────────────────────────────────────────────────────────
  if (await isLoginPage(page)) {
    // Confirm the username field is actually visible before filling. If
    // isLoginPage was a transient false positive (e.g. login form briefly
    // rendered before auth check redirected to dashboard), the fill would
    // hang forever waiting for #username to come back.
    const usernameField = page.locator('#username');
    const usernameVisible = await usernameField
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (usernameVisible) {
      await usernameField.fill(username);
      await page.locator('#password').fill(password);
      await page.locator('button:has-text("Login"), button:has-text("Sign in")').first().click();
      await expect(page.locator(DASHBOARD_INDICATOR)).toBeVisible({ timeout: 10_000 });
      return;
    }
    // Fall through to the dashboard check below.
  }

  // ── Already on the dashboard ──────────────────────────────────────────────
  if (await isDashboard(page)) {
    return;
  }

  throw new Error(
    'loginAs: could not determine page state - expected setup, login, or dashboard. ' +
    'Check that E2E_USERNAME and E2E_PASSWORD are set correctly.',
  );
}
