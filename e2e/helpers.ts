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
const DASHBOARD_INDICATOR = 'img[src*="sencho-logo"], button:has-text("Create Stack")';

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
  const indicator = page.locator(DASHBOARD_INDICATOR).first();
  return indicator.isVisible().catch(() => false);
}

/**
 * Role-independent dashboard probe. DASHBOARD_INDICATOR can false-negative for
 * a viewer account: the logo img may not have resolved yet and a viewer never
 * renders Create Stack, so isDashboard() then reports "not on the dashboard"
 * for a page that is actually ready. The topbar chrome is present for every
 * authenticated role, which makes it a safe identity signal.
 */
async function hasTopbarChrome(page: Page): Promise<boolean> {
  return page.locator('[data-sn-chrome="topbar"]').isVisible().catch(() => false);
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
 * Role-independent shell readiness. waitForStacksLoaded requires the Create
 * Stack button, which needs stack:create, so viewer-role accounts can never
 * satisfy it. The topbar chrome renders for every authenticated role and the
 * stacks sentinel settles once the (read-only) list resolves, so both are
 * safe readiness signals for any role.
 */
export async function waitForShellReady(page: Page): Promise<void> {
  await expect(page.locator('[data-sn-chrome="topbar"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
}

/** Selector for the second-factor challenge screen, in any of its states. */
const MFA_CHALLENGE = '[data-sn-chrome="mfa-challenge"]';

/**
 * Wait for the shell to become ready, but give up early on the one login
 * outcome that can never resolve on its own: a second-factor challenge, which
 * no amount of waiting will carry past. Without this, a cascade pays the full
 * readiness timeout on every attempt of every later test, which is what turns
 * a single bad spec into a 30-minute job.
 *
 * Everything else stays `ready`'s business, so its assertion messages are
 * unchanged for genuinely slow or broken dashboards.
 */
async function waitForLoginOutcome(page: Page, ready: () => Promise<void>): Promise<void> {
  // Keep readiness' own failure so it can be rethrown untouched. The handler
  // is attached immediately, so abandoning this promise when the challenge
  // wins the race cannot surface later as an unhandled rejection.
  let readyError: unknown;
  const settled = ready().then(() => 'ready' as const, (err: unknown) => {
    readyError = err;
    return 'failed' as const;
  });
  const challenge = page
    .locator(MFA_CHALLENGE)
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(
      () => 'challenge' as const,
      () => 'absent' as const,
    );
  const outcome = await Promise.race([settled, challenge]);
  if (outcome === 'ready') return;
  if (outcome === 'challenge') throw new Error('mfa-challenge');
  // The challenge never appeared, so the outcome belongs to readiness. Await it
  // rather than reading readyError now: readiness can take longer than the
  // challenge lookup's 15s, so its error may not be set yet.
  if ((await settled) === 'ready') return;
  throw readyError;
}

/**
 * Explain why a login that should have produced a session did not, instead of
 * letting the caller time out on a generic readiness wait.
 *
 * Two states are worth naming, and both are shared-suite problems rather than
 * anything wrong with the test:
 *   - The second-factor challenge. The account still has MFA enrolled, so every
 *     login stops here and never reaches the dashboard. E2E tests share one
 *     account, so one spec that leaves MFA on breaks every spec that runs after
 *     it.
 *   - Still on the sign-in form after submitting. The credentials were rejected
 *     or the request never completed, and the usual suspect under load is the
 *     shared per-user API rate limit rejecting the login POST.
 *
 * When the page is in neither state, the readiness failure that got us here is
 * the more useful message, so it is carried through rather than discarded.
 */
async function explainUnreadyLogin(page: Page, username: string, cause?: unknown): Promise<Error> {
  if (await page.locator(MFA_CHALLENGE).isVisible().catch(() => false)) {
    return new Error(
      `loginAs: login for "${username}" landed on the two-factor challenge, so it can never ` +
      'reach the dashboard. The shared E2E account still has MFA enrolled, usually because a ' +
      'previous run aborted before its cleanup ran. Reset it with ' +
      '`node backend/dist/cli/resetMfa.js ' + username + '` (build the backend first), then re-run.',
    );
  }
  if (await isLoginPage(page)) {
    return new Error(
      `loginAs: still on the sign-in form after submitting credentials for "${username}". The ` +
      'login was rejected or did not complete. Under parallel or sustained load the shared ' +
      'per-user API rate limit can reject the login POST; check the backend log for 429s.',
    );
  }
  const reason = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
  return new Error(
    `loginAs: could not determine page state - expected setup, login, or dashboard. ` +
    `Check that E2E_USERNAME and E2E_PASSWORD are set correctly. Readiness reported: ${reason}`,
  );
}

/** Options for loginAs. */
export interface LoginAsOptions {
  /**
   * Wait for role-independent shell readiness instead of the admin-only
   * Create Stack button. Required for viewer-role accounts, which never
   * render that button.
   */
  viewerSafe?: boolean;
}

/**
 * Navigate to the app root, complete first-run setup if needed, then log in.
 * After this call the dashboard is guaranteed to be visible.
 */
export async function loginAs(
  page: Page,
  username = TEST_USERNAME,
  password = TEST_PASSWORD,
  options?: LoginAsOptions,
) {
  const ready = options?.viewerSafe ? waitForShellReady : waitForStacksLoaded;
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
    await ready(page);
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
      // Name the reason instead of burning the full readiness timeout: a
      // challenge screen or a rejected login is a shared-state problem the
      // reader has to act on, not a slow dashboard.
      try {
        await waitForLoginOutcome(page, () => ready(page));
      } catch (err) {
        throw await explainUnreadyLogin(page, username, err);
      }
      return;
    }
    // Fall through to the dashboard check below.
  }

  // ── Already on the dashboard ──────────────────────────────────────────────
  if (await isDashboard(page)) {
    return;
  }
  // Same dashboard state, seen through the role-independent chrome probe:
  // covers a viewer account whose logo img has not painted yet.
  if (await hasTopbarChrome(page)) {
    await ready(page);
    return;
  }

  // Cookie session may still be restoring after a hard reload.
  let readyError: unknown;
  try {
    await waitForLoginOutcome(page, () => ready(page));
    return;
  } catch (err) {
    readyError = err;
  }

  throw await explainUnreadyLogin(page, username, readyError);
}
