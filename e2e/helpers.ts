/**
 * Shared helpers for Sencho E2E tests.
 *
 * CREDENTIALS: Set E2E_USERNAME and E2E_PASSWORD env vars to match
 * your dev instance's admin account. Defaults assume the initial setup
 * was completed with username "admin" and password "password123".
 *
 *   E2E_USERNAME=admin E2E_PASSWORD=mypassword npx playwright test
 */
import { Page, expect, type Locator, type Route } from '@playwright/test';
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

/** Returns true if the current page is the login screen */
async function isLoginPage(page: Page): Promise<boolean> {
  return page.locator('button:has-text("Login"), button:has-text("Sign in")').isVisible().catch(() => false);
}

/** Returns true if the dashboard (EditorLayout) is loaded */
export async function isDashboard(page: Page): Promise<boolean> {
  const indicator = page.locator(DASHBOARD_INDICATOR).first();
  return indicator.isVisible().catch(() => false);
}

async function fulfillExperimental(route: Route, experimental: boolean): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ experimental }),
  });
}

/**
 * Serve a chosen experimental discovery value from /api/meta for one page.
 * Register it before the dashboard mounts, since the frontend reads the flag
 * once and caches it for the session. The response is built here rather than
 * fetched from the dev server so the flag settles before the UI reads it;
 * only the discovery field matters to the callers.
 */
export async function mockExperimentalFlag(page: Page, experimental = true): Promise<void> {
  await page.route('**/api/meta', (route) => fulfillExperimental(route, experimental));
}

export interface HeldExperimentalFlag {
  /**
   * Wait for the next /api/meta request. Start waiting before the navigation
   * that triggers it, so a pending assertion cannot run before the page asks.
   */
  waitForRequest: () => Promise<void>;
  /** Answer the held request, and any later one, with the given value. */
  release: (experimental: boolean) => Promise<void>;
}

/**
 * Hold /api/meta unanswered so a test can prove the UI fails closed while
 * experimental discovery is still pending. Register it before the dashboard
 * mounts. Only the discovery field matters to the callers. Each page load
 * issues its own request, so wait for the one the assertion depends on.
 */
export async function holdExperimentalFlag(page: Page): Promise<HeldExperimentalFlag> {
  let released: boolean | null = null;
  const held: Route[] = [];
  const requestWaiters: Array<() => void> = [];
  await page.route('**/api/meta', async (route) => {
    for (const resolve of requestWaiters.splice(0)) resolve();
    if (released === null) {
      held.push(route);
      return;
    }
    await fulfillExperimental(route, released);
  });
  return {
    waitForRequest() {
      return new Promise<void>((resolve) => {
        requestWaiters.push(resolve);
      });
    },
    async release(experimental: boolean) {
      released = experimental;
      for (const route of held.splice(0)) {
        await fulfillExperimental(route, experimental);
      }
    },
  };
}

/**
 * Role-independent dashboard probe. DASHBOARD_INDICATOR can false-negative for
 * a viewer account: the logo img may not have resolved yet and a viewer never
 * renders Create Stack, so isDashboard() then reports "not on the dashboard"
 * for a page that is actually ready. The desktop topbar is present for every
 * authenticated role; bespoke phone screens drop it, so the bottom tab bar
 * stands in there. Both appear only once a session exists.
 */
async function hasAuthenticatedChrome(page: Page): Promise<boolean> {
  if (await page.locator('[data-sn-chrome="topbar"]').isVisible().catch(() => false)) return true;
  return page.locator('[data-sn-glass="mobile-tabbar"]').isVisible().catch(() => false);
}

/**
 * Wait for the boot permission answer. Until it settles every permission-gated
 * control is hidden, so a role assertion made before this point proves that the
 * answer is still loading, not what the role can reach. A failed answer never
 * reaches ready; the shell shows its permission banner instead.
 */
export async function waitForPermissionsReady(page: Page): Promise<void> {
  await expect(page.locator('[data-sn-permissions="ready"]')).toBeAttached({ timeout: 15_000 });
}

/**
 * Wait for the stacks sidebar to finish loading. Waits for the Create Stack
 * button, the data-stacks-loaded sentinel set by the CommandList after its
 * async refreshStacks() call resolves, and the permission answer.
 */
export async function waitForStacksLoaded(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Create Stack' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
  await waitForPermissionsReady(page);
}

/**
 * Role-independent shell readiness. waitForStacksLoaded requires the Create
 * Stack button, which needs stack:create, so viewer-role accounts can never
 * satisfy it. The topbar chrome renders for every authenticated role, the
 * stacks sentinel settles once the (read-only) list resolves, and the
 * permission marker covers every role's role-gated controls.
 */
export async function waitForShellReady(page: Page): Promise<void> {
  await expect(page.locator('[data-sn-chrome="topbar"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
  await waitForPermissionsReady(page);
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

/** The shared-account MFA failure, at boot or after a submit. */
function mfaLoginError(username: string): Error {
  return new Error(
    `loginAs: login for "${username}" landed on the two-factor challenge, so it can never ` +
    'reach the dashboard. The shared E2E account still has MFA enrolled, usually because a ' +
    'previous run aborted before its cleanup ran. Reset it with ' +
    '`node backend/dist/cli/resetMfa.js ' + username + '` (build the backend first), then re-run.',
  );
}

/** Terminal screens the app shows once its boot auth check has resolved. */
type AuthSurface = 'setup' | 'login' | 'mfa' | 'dashboard';

/** How long the app may spend on its auth check before the test calls it stuck. */
const AUTH_SURFACE_TIMEOUT = 15_000;

/**
 * Wait for the app's one-shot auth check to resolve to a screen the helper can
 * act on. A fixed sleep cannot do this: on a loaded runner the boot splash can
 * outlast any guess, and a one-shot probe that ran early used to miss the
 * sign-in screen entirely and then wait fifteen seconds for a dashboard nobody
 * had logged in to.
 */
async function waitForAuthSurface(page: Page): Promise<AuthSurface> {
  const visible = (locator: Locator) => locator.first().isVisible().catch(() => false);
  const probes: Array<[AuthSurface, () => Promise<boolean>]> = [
    ['setup', () => visible(page.locator('#confirmPassword, input[placeholder*="Confirm"]'))],
    ['login', () => visible(page.getByRole('heading', { name: 'Sign in', exact: true }))],
    ['mfa', () => visible(page.locator(MFA_CHALLENGE))],
    ['dashboard', () => hasAuthenticatedChrome(page)],
  ];
  const deadline = Date.now() + AUTH_SURFACE_TIMEOUT;
  for (;;) {
    for (const [surface, probe] of probes) {
      if (await probe()) return surface;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `loginAs: the app never finished its auth check within ${AUTH_SURFACE_TIMEOUT / 1000}s. ` +
        'Expected the setup form, the sign-in screen, the two-factor challenge, or the dashboard; ' +
        'the page is still on its loading splash. Check the backend log for a stalled ' +
        '/api/auth/status or /api/auth/check.',
      );
    }
    await page.waitForTimeout(100);
  }
}

/**
 * Explain why a login that should have produced a session did not, instead of
 * letting the caller time out on a generic readiness wait.
 *
 * Each state is a shared-suite problem rather than anything wrong with the
 * test:
 *   - The second-factor challenge. The account still has MFA enrolled, so every
 *     login stops here and never reaches the dashboard. E2E tests share one
 *     account, so one spec that leaves MFA on breaks every spec that runs after
 *     it.
 *   - A permission-metadata failure. The dashboard shell renders, but the
 *     permission response never arrived, so every permission-gated control
 *     (including Create Stack) stays hidden.
 *   - Still on the sign-in form after submitting. The credentials were rejected
 *     or the request never completed, and the usual suspect under load is the
 *     shared per-user API rate limit rejecting the login POST.
 *
 * When the page is in none of these states, the readiness failure that got us
 * here is the more useful message, so it is carried through rather than
 * discarded.
 */
async function explainUnreadyLogin(page: Page, username: string, cause?: unknown): Promise<Error> {
  if (await page.locator(MFA_CHALLENGE).isVisible().catch(() => false)) {
    return mfaLoginError(username);
  }
  const permissionBanner = page.getByText('Permission controls are unavailable');
  if (await permissionBanner.isVisible().catch(() => false)) {
    return new Error(
      `loginAs: "${username}" reached the dashboard, but its permission metadata could not be ` +
      'loaded, so permission-gated controls stay hidden. Check GET /api/permissions/me in the ' +
      'backend log, then retry the test once the endpoint answers.',
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
   * render that button, and preferred for any case that does not create a
   * stack: Create Stack needs stack:create, so a permission-metadata failure
   * hides it even though the shell the test needs is up.
   */
  viewerSafe?: boolean;
}

/** How long the login POST may take before the helper calls it stalled. */
const LOGIN_RESPONSE_TIMEOUT = 10_000;

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

  // The sign-in screen fails closed: when its own auth discovery request
  // fails, it hides the password form behind an error instead of showing it.
  // One reload retries those requests; it also covers any other page state
  // that withholds the form, and it runs before credentials are submitted, so
  // it cannot replay a login. This is a page-state recovery, not a test retry.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 0) await page.goto('/');
    else await page.reload();

    const surface = await waitForAuthSurface(page);
    if (surface === 'dashboard') {
      try {
        await ready(page);
      } catch (err) {
        throw await explainUnreadyLogin(page, username, err);
      }
      return;
    }
    if (surface === 'mfa') throw mfaLoginError(username);

    // ── First-run setup ────────────────────────────────────────────────────
    if (surface === 'setup') {
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

    // ── Login screen ───────────────────────────────────────────────────────
    const usernameField = page.locator('#username');
    const formVisible = await usernameField
      .waitFor({ state: 'visible', timeout: attempt === 0 ? 5_000 : AUTH_SURFACE_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    if (!formVisible) continue;

    await usernameField.fill(username);
    await page.locator('#password').fill(password);
    // Watch the POST itself: a rejected or stalled login is a call the reader
    // has to act on, and waiting only for readiness turns it into a generic
    // timeout. A 2xx here means the session exists; readiness still has to
    // confirm the shell rendered.
    const loginResponse = page
      .waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/auth/login' &&
          response.request().method() === 'POST',
        { timeout: LOGIN_RESPONSE_TIMEOUT },
      )
      .catch(() => null);
    await page.locator('button:has-text("Login"), button:has-text("Sign in")').first().click();
    const response = await loginResponse;
    if (response && !response.ok()) {
      throw new Error(
        `loginAs: /api/auth/login rejected "${username}" with ${response.status()}. A 429 means ` +
        'the shared per-user rate limit; a 401 means the credentials were not accepted. Check ' +
        'the backend log before re-running.',
      );
    }
    try {
      await waitForLoginOutcome(page, () => ready(page));
    } catch (err) {
      throw await explainUnreadyLogin(page, username, err);
    }
    return;
  }

  throw new Error(
    `loginAs: the sign-in form never appeared for "${username}". The sign-in screen fails closed ` +
    'when its auth discovery fails, so it showed an error instead of the form on two page loads. ' +
    'Check /api/auth/status and /api/auth/sso/providers in the backend log.',
  );
}

/**
 * Sign in as the test admin and wait for the role-independent shell, not for
 * Create Stack. Use this for any case that does not create a stack: Create
 * Stack needs stack:create, so a permission-metadata failure hides it while the
 * surface the case actually exercises is already usable.
 */
export async function loginToShell(page: Page): Promise<void> {
  await loginAs(page, TEST_USERNAME, TEST_PASSWORD, { viewerSafe: true });
}
