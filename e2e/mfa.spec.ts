/**
 * Two-factor authentication (TOTP) E2E tests.
 *
 * These tests run serially and share mutable state (the enrolment secret and
 * the freshly issued backup codes). The chain is:
 *   1. Enrol via the Account section, capture secret and backup codes from the
 *      network responses so we do not have to scrape the DOM.
 *   2. Log out, log back in, satisfy the TOTP challenge, land on the dashboard.
 *   3. Log out, log back in, satisfy the challenge with a backup code,
 *      re-use the same backup code and confirm the second attempt fails.
 *   4. Disable 2FA to leave the dev DB in a clean state for the next run.
 *
 * Every worker starts and ends with MFA off (see resetMfaState), so the block
 * is self-healing: if a test dies mid-chain, or the run is retried in a fresh
 * worker, the next attempt re-enrols from a clean slate instead of inheriting
 * a half-finished enrolment.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect, Page } from '@playwright/test';
import { loginAs, totpNow, TEST_USERNAME, TEST_PASSWORD, isDashboard } from './helpers';

/**
 * Clear MFA for the shared E2E account straight in the database.
 *
 * The emergency CLI (backend/src/cli/resetMfa.ts) is the only way to do this
 * without proving possession of a second factor, which is exactly the
 * situation a half-finished test run leaves behind: no usable session and no
 * unused backup codes. It deletes the enrolment, clears the replay blacklist,
 * and bumps the token version.
 */
function resetMfaState(): void {
  // The CLI resolves the database as DATA_DIR, else <cwd>/data, so it has to
  // run from backend/ to reach the same file the dev server has open.
  const backendDir = path.resolve(__dirname, '..', 'backend');
  const cli = path.join(backendDir, 'dist', 'cli', 'resetMfa.js');
  try {
    execFileSync(process.execPath, [cli, TEST_USERNAME], { cwd: backendDir, stdio: 'pipe' });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    // A missing account cannot have MFA enrolled, so there is nothing to clear.
    if (stderr.includes('User not found')) return;
    throw new Error(
      `Could not reset MFA for "${TEST_USERNAME}" via ${cli}. ` +
      'Build the backend first (`cd backend && npm run build`); without dist/cli/resetMfa.js ' +
      'this suite cannot guarantee a clean starting state.\n' +
      `${stderr || String(err)}`,
    );
  }
}

async function logout(page: Page) {
  await page.getByRole('button', { name: /profile/i }).click();
  await page.getByRole('button', { name: /log out/i }).click();
  // The MfaChallenge / Login screen has no dashboard indicator.
  await expect.poll(async () => isDashboard(page), { timeout: 5_000 }).toBe(false);
}

async function openAccountSettings(page: Page) {
  await page.getByRole('button', { name: /profile/i }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Password$/i })).toBeVisible();
}

/** Fill a login form (no MFA branch). */
async function fillLoginForm(page: Page, username: string, password: string) {
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('button:has-text("Login"), button:has-text("Sign in")').first().click();
}

test.describe.serial('Two-factor authentication', () => {
  let secret = '';
  let backupCodes: string[] = [];

  // Start from "MFA off" in every worker. A serial block is retried as a whole
  // in a new worker process, so a retry that inherits an enrolment from the
  // previous attempt cannot re-enrol: the start endpoint answers 409 and the
  // whole block fails again. Resetting here is what makes a retry able to
  // recover, and it also clears a half-finished enrolment left by an aborted
  // run against a long-lived dev database.
  test.beforeAll(() => {
    resetMfaState();
  });

  // Unconditional cleanup. This must not depend on the enrolment state the
  // block captured: a failing test destroys both the secret and the unused
  // backup codes, which is what previously left MFA switched on and broke
  // every spec that ran afterwards.
  test.afterAll(() => {
    resetMfaState();
  });

  test('enrol from Account settings captures secret and backup codes', async ({ page }) => {
    await loginAs(page, TEST_USERNAME, TEST_PASSWORD);
    await openAccountSettings(page);

    // Capture the raw base32 secret from the enroll/start response so we
    // do not need to strip formatting spaces off the DOM value.
    const startPromise = page.waitForResponse(
      (r) => r.url().includes('/api/auth/mfa/enroll/start') && r.status() === 200,
    );
    await page.getByRole('button', { name: /Set up 2FA/i }).click();
    const startRes = await startPromise;
    const startBody = await startRes.json();
    secret = startBody.secret;
    expect(secret).toMatch(/^[A-Z2-7]+$/); // base32 alphabet

    // Step 1 (QR) -> Continue
    await page.getByRole('button', { name: /^Continue$/ }).click();

    // Step 2 (Confirm): enter a fresh TOTP. The confirm step auto-submits on
    // the sixth digit, so no explicit click is required. Capture the backup
    // codes from the response.
    const confirmPromise = page.waitForResponse(
      (r) => r.url().includes('/api/auth/mfa/enroll/confirm') && r.status() === 200,
    );
    await page.locator('#mfa-confirm-code').fill(totpNow(secret));
    const confirmRes = await confirmPromise;
    const confirmBody = await confirmRes.json();
    backupCodes = confirmBody.backupCodes;
    expect(backupCodes.length).toBe(10);

    // Step 3 (Backup codes) -> acknowledge.
    await page.getByRole('button', { name: /^Done$/ }).click();

    // Section kicker flips to 'enabled' and the field shows 'enrolled'.
    await expect(page.getByText('enrolled')).toBeVisible();
  });

  test('low backup codes warning renders when <=2 codes remain', async ({ page }) => {
    // Mock the status endpoint so we can exercise the warning branch without
    // racing backup-code consumption in this serial suite. The UI only cares
    // about the fields on the response, so this is a pure rendering check.
    await page.route('**/api/auth/mfa/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, backupCodesRemaining: 1, sso_enforce_mfa: false }),
      });
    });

    // The test user has MFA on, so loginAs is not usable. Drive the challenge
    // manually with a backup code so we do not race the TOTP replay blacklist
    // against the next test's fresh code in the same 30-second window.
    await page.goto('/');
    await expect(page.locator('#username')).toBeVisible({ timeout: 10_000 });
    await fillLoginForm(page, TEST_USERNAME, TEST_PASSWORD);
    await expect(page.getByRole('heading', { name: /^Verify$/ })).toBeVisible();
    await page.getByRole('button', { name: /Use backup code/i }).click();
    await page.locator('#mfa-backup').fill(backupCodes[5]);
    await page.getByRole('button', { name: /^Verify$/ }).click();
    await expect.poll(async () => isDashboard(page), { timeout: 10_000 }).toBe(true);

    await openAccountSettings(page);
    // SettingsField body renders "{n} remaining"; helper renders "Running low. Regenerate a fresh set."
    await expect(page.getByText('1 remaining')).toBeVisible();
    await expect(page.getByText(/regenerate a fresh set/i)).toBeVisible();

    // Now exercise the exhausted branch (0 codes): the dedicated warning card.
    await page.unroute('**/api/auth/mfa/status');
    await page.route('**/api/auth/mfa/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, backupCodesRemaining: 0, sso_enforce_mfa: false }),
      });
    });

    // Navigate away first so AccountSection unmounts and refetches on the
    // next open (same-URL navigation in the route-based design does not
    // trigger a remount, so Escape alone is not enough).
    await page.goto('/');
    await openAccountSettings(page);
    // Verify the zero-codes warning card is rendered in the DOM.
    // The callout is below the Disable 2FA section, scrolled out of the
    // Radix ScrollArea's clipping root on a standard 1280x720 viewport.
    // toBeAttached confirms the component responded to backupCodesRemaining:0
    // without requiring the element to be in the visible scroll position.
    await expect(page.getByText(/No backup codes left/i)).toBeAttached({ timeout: 10_000 });
    await expect(page.getByText(/recovery needs an administrator/i)).toBeAttached();

    await page.unroute('**/api/auth/mfa/status');
  });

  test('typing a 6-digit TOTP auto-submits and reaches the dashboard', async ({ page }) => {
    // Fresh page lands on the login screen; password passes but the MFA
    // challenge appears because test #1 enrolled the user. Entering the 6th
    // digit must auto-submit the form without the user clicking "Verify".
    await page.goto('/');
    await expect(page.locator('#username')).toBeVisible({ timeout: 10_000 });
    await fillLoginForm(page, TEST_USERNAME, TEST_PASSWORD);
    await expect(page.getByRole('heading', { name: /^Verify$/ })).toBeVisible();

    // fill() emits the final value in a single onChange, which at length === 6
    // schedules a submit via requestAnimationFrame. No explicit click.
    await page.locator('#mfa-otp').fill(totpNow(secret));

    await expect.poll(async () => isDashboard(page), { timeout: 10_000 }).toBe(true);
  });

  test('backup code entered without the dash still succeeds', async ({ page }) => {
    // The backup-code input accepts any paste form; the client normalises to
    // 10 alphanumeric characters before sending. Consumes backupCodes[4].
    await page.goto('/');
    await expect(page.locator('#username')).toBeVisible({ timeout: 10_000 });

    const raw = backupCodes[4].replace('-', '');
    expect(raw).toMatch(/^[A-Z0-9]{10}$/);

    await fillLoginForm(page, TEST_USERNAME, TEST_PASSWORD);
    await expect(page.getByRole('heading', { name: /^Verify$/ })).toBeVisible();
    await page.getByRole('button', { name: /Use backup code/i }).click();
    await page.locator('#mfa-backup').fill(raw);
    await page.getByRole('button', { name: /^Verify$/ }).click();
    await expect.poll(async () => isDashboard(page), { timeout: 10_000 }).toBe(true);
  });

  test('backup code works once and cannot be replayed', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#username')).toBeVisible({ timeout: 10_000 });

    const code = backupCodes[0];
    expect(code).toBeTruthy();

    // First use: should succeed.
    await fillLoginForm(page, TEST_USERNAME, TEST_PASSWORD);
    await expect(page.getByRole('heading', { name: /^Verify$/ })).toBeVisible();
    await page.getByRole('button', { name: /Use backup code/i }).click();
    await page.locator('#mfa-backup').fill(code);
    await page.getByRole('button', { name: /^Verify$/ }).click();
    await expect.poll(async () => isDashboard(page), { timeout: 10_000 }).toBe(true);

    // Log out and try the same backup code again: should fail.
    await logout(page);
    await fillLoginForm(page, TEST_USERNAME, TEST_PASSWORD);
    await expect(page.getByRole('heading', { name: /^Verify$/ })).toBeVisible();
    await page.getByRole('button', { name: /Use backup code/i }).click();
    await page.locator('#mfa-backup').fill(code);
    await page.getByRole('button', { name: /^Verify$/ }).click();

    // Error should be visible and we should still be on the challenge screen.
    await expect(page.locator('.text-destructive')).toBeVisible();
    expect(await isDashboard(page)).toBe(false);

    // Recover using a fresh backup code. Using a TOTP here races the
    // 30-second window against the one test #2 consumed, which the server
    // (correctly) rejects as a replay when the boundary falls the wrong
    // way. Backup codes are single-use and sidestep that blacklist.
    await page.locator('#mfa-backup').clear();
    await page.locator('#mfa-backup').fill(backupCodes[1]);
    await page.getByRole('button', { name: /^Verify$/ }).click();
    await expect.poll(async () => isDashboard(page), { timeout: 10_000 }).toBe(true);
  });

  test('disable 2FA with a valid code removes the challenge on next login', async ({ page }) => {
    // loginAs does not understand the MFA challenge screen, so drive the
    // login manually. Use a backup code for both the challenge and the
    // disable step so we do not race the TOTP replay blacklist against
    // codes consumed by earlier tests in this serial block.
    await page.goto('/');
    await expect(page.locator('#username')).toBeVisible({ timeout: 10_000 });
    await fillLoginForm(page, TEST_USERNAME, TEST_PASSWORD);
    await expect(page.getByRole('heading', { name: /^Verify$/ })).toBeVisible();
    await page.getByRole('button', { name: /Use backup code/i }).click();
    await page.locator('#mfa-backup').fill(backupCodes[2]);
    await page.getByRole('button', { name: /^Verify$/ }).click();
    await expect.poll(async () => isDashboard(page), { timeout: 10_000 }).toBe(true);

    await openAccountSettings(page);
    await page.getByRole('button', { name: /Disable 2FA/i }).click();
    await page.getByRole('button', { name: /Use backup code/i }).click();
    await page.locator('#mfa-disable-backup').fill(backupCodes[3]);
    await page.getByRole('button', { name: /^Disable$/ }).click();

    // Card flips back to the "Set up 2FA" call to action.
    await expect(page.getByRole('button', { name: /Set up 2FA/i })).toBeVisible();

    // Close settings, log out, log back in without the MFA challenge.
    await page.keyboard.press('Escape').catch(() => {});
    await logout(page);
    await fillLoginForm(page, TEST_USERNAME, TEST_PASSWORD);
    await expect.poll(async () => isDashboard(page), { timeout: 10_000 }).toBe(true);
  });
});
