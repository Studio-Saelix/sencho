/**
 * Calm Reduced Motion defaults + Reduced Effects decorative-rail quieting.
 * Related to #1614; correctness only (not GPU %).
 *
 * Environment isolation: the suite runs under a dedicated account whose
 * appearance row is seeded through the preference API, so hydration mirrors
 * the intended visualStyle/reducedMotion state and server convergence cannot
 * overwrite a raw-localStorage seed mid-test. The DCL test keeps its raw
 * localStorage removal on purpose: it targets the pre-paint path, where the
 * server cannot have run yet. The notifications subsystem is mocked for every
 * test (this suite asserts motion, not notifications) to keep repeated page
 * loads within renderer resource limits on constrained hosts.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { loginAs, waitForShellReady } from './helpers';
import {
  adminApiContext, disposePrefUser, seedPrefUser, putDomain,
} from './preferences-helpers';

const SUITE_USER = 'motion-styles-e2e';
const SUITE_PASSWORD = 'motion-styles-password-123';
const LEGACY_KEY = 'sencho-theme';

const SIGNATURE_STATE = {
  theme: 'dim',
  accent: 'cyan',
  borderBoost: 0,
  glow: 0.16,
  contrast: 0,
  uiFont: 'Geist',
  monoFont: 'Geist Mono',
  typeScale: 1,
  visualStyle: 'signature',
  headingStyle: 'signature',
  chartStyle: 'signature',
  reducedEffects: false,
  reducedMotion: false,
  readability: false,
  density: 'comfortable',
  logChipColorMode: 'unified',
} as const;

const CALM_STATE = {
  ...SIGNATURE_STATE,
  visualStyle: 'calm',
  headingStyle: 'clean',
  chartStyle: 'muted',
  reducedEffects: true,
  reducedMotion: true,
} as const;

let suiteUserId = 0;
let suiteRequest: import('@playwright/test').APIRequestContext | undefined;
let adminCtx: import('@playwright/test').APIRequestContext | undefined;

/**
 * Seed the suite account's appearance row as the given state. The document is
 * spread, so partial overrides keep the remaining fields at their baseline.
 */
async function seedAppearance(state: Omit<typeof SIGNATURE_STATE, 'reducedMotion'> & { reducedMotion?: boolean }) {
  return putDomain(suiteRequest!, suiteUserId, 'appearance', state);
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: /profile/i }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByText('Motion & effects')).toBeVisible();
}

async function railAnim(locator: Locator): Promise<{ duration: string; iterations: string; name: string }> {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      duration: cs.animationDuration,
      iterations: cs.animationIterationCount,
      name: cs.animationName,
    };
  });
}

function expectRailsStatic(info: { duration: string; iterations: string; name: string }) {
  const stopped =
    info.name === 'none' ||
    info.duration === '0s' ||
    info.duration === '0.01ms' ||
    info.iterations === '1';
  expect(stopped).toBeTruthy();
}

function expectRailsRunning(info: { duration: string; iterations: string; name: string }) {
  expect(info.name === 'none').toBeFalsy();
  expect(info.duration === '0s' || info.duration === '0.01ms').toBeFalsy();
}

async function assertRails(page: Page, mode: 'static' | 'running') {
  const glow = page.locator('.masthead-rail-glow');
  const shimmer = page.locator('.masthead-rail-shimmer');
  const glowCount = await glow.count();
  const shimmerCount = await shimmer.count();
  expect(glowCount + shimmerCount).toBeGreaterThan(0);
  for (let i = 0; i < glowCount; i++) {
    const info = await railAnim(glow.nth(i));
    if (mode === 'static') expectRailsStatic(info);
    else expectRailsRunning(info);
  }
  for (let i = 0; i < shimmerCount; i++) {
    const info = await railAnim(shimmer.nth(i));
    if (mode === 'static') expectRailsStatic(info);
    else expectRailsRunning(info);
  }
}

test.describe('Calm reduced motion defaults', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    const seeded = await seedPrefUser(SUITE_USER, SUITE_PASSWORD, 'viewer');
    suiteUserId = seeded.userId;
    suiteRequest = seeded.request;
    adminCtx = await adminApiContext();
  });

  test.afterAll(async () => {
    await disposePrefUser(
      suiteRequest ? { request: suiteRequest, userId: suiteUserId } : undefined,
      adminCtx,
    );
    suiteRequest = undefined;
    adminCtx = undefined;
  });

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/notifications**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/ws/notifications**', (route) => route.abort());
    await loginAs(page, SUITE_USER, SUITE_PASSWORD, { viewerSafe: true });
  });

  test('fresh load applies data-motion by DOMContentLoaded', async ({ page }) => {
    // Raw-localStorage removal targets the pre-paint path: with no cache, the
    // fresh Calm default must already be applied by DOMContentLoaded, before
    // any server round-trip could have happened.
    await seedAppearance(CALM_STATE);
    await page.reload();
    await page.evaluate((legacy) => {
      localStorage.removeItem('sencho.appearance.theme');
      localStorage.removeItem(legacy);
    }, LEGACY_KEY);
    await page.reload();
    await page.addInitScript(() => {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          (window as unknown as { __snMotionAtDCL?: string | null }).__snMotionAtDCL =
            document.documentElement.getAttribute('data-motion');
        },
        { once: true },
      );
    });
    await page.reload();
    const atDcl = await page.evaluate(
      () => (window as unknown as { __snMotionAtDCL?: string | null }).__snMotionAtDCL ?? null,
    );
    expect(atDcl).toBe('reduced');
  });

  test('returning Signature object missing reducedMotion is motion-on at pre-paint', async ({ page }) => {
    // Raw-localStorage seed targets the pre-paint read path for a stored
    // object that predates the reducedMotion field: theme-init.js must fill
    // it from Signature (motion on), not from the fresh-user Calm default.
    // The assertion is captured at DOMContentLoaded: the account's server row
    // (seeded Calm by the previous test) legitimately re-applies reduced
    // motion once hydration settles, so only the pre-paint contract is
    // asserted here.
    const { reducedMotion: _omit, ...withoutMotion } = SIGNATURE_STATE;
    await page.addInitScript((payload) => {
      localStorage.setItem('sencho.appearance.theme', JSON.stringify(payload));
    }, withoutMotion);
    await page.addInitScript(() => {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          (window as unknown as { __snMotionAtDCL?: string | null }).__snMotionAtDCL =
            document.documentElement.getAttribute('data-motion');
        },
        { once: true },
      );
    });
    await page.reload();
    const atDcl = await page.evaluate(
      () => (window as unknown as { __snMotionAtDCL?: string | null }).__snMotionAtDCL ?? null,
    );
    expect(atDcl).toBeNull();
  });

  test('stored reducedMotion true and false survive reload', async ({ page }) => {
    await seedAppearance({ ...SIGNATURE_STATE, reducedMotion: true });
    await page.reload();
    await waitForShellReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await page.reload();
    await waitForShellReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

    // The false write persists through the sync layer; the reload reads the
    // hydrated document, not a localStorage seed. pagehide fires on
    // page.reload(), but keepalive fetches race the navigation, so poll for
    // the server row flipping rather than sleeping a fixed debounce.
    await openAppearance(page);
    await page.getByRole('switch', { name: 'Reduced motion' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await expect.poll(async () => {
      const after = await import('./preferences-helpers').then((h) =>
        h.getPreferences(suiteRequest!, suiteUserId));
      return after.preferences.appearance?.data?.reducedMotion;
    }, { timeout: 10_000 }).toBe(false);
    await page.reload();
    await waitForShellReady(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
  });

  test('Signature to Calm and back writes both effects and motion', async ({ page }) => {
    await seedAppearance(SIGNATURE_STATE);
    await page.reload();
    await waitForShellReady(page);
    await openAppearance(page);

    await page.getByRole('button', { name: /readable default|Calm/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

    await page.getByRole('button', { name: /Today's look|Signature/i }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
  });

  test('Calm card stays selected when Motion is toggled off; rails stay static', async ({ page }) => {
    await seedAppearance(SIGNATURE_STATE);
    await page.reload();
    await waitForShellReady(page);
    await openAppearance(page);

    await page.getByRole('button', { name: /readable default|Calm/i }).click();
    await page.getByRole('switch', { name: 'Reduced motion' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByRole('button', { name: /readable default/i })).toHaveAttribute('aria-pressed', 'true');

    await assertRails(page, 'static');
  });

  test('Signature full effects with Motion off keeps rails running', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedAppearance(SIGNATURE_STATE);
    await page.reload();
    await waitForShellReady(page);
    await openAppearance(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await assertRails(page, 'running');
  });

  test('manual Reduced effects under custom style staticizes rails without enabling Motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedAppearance(SIGNATURE_STATE);
    await page.reload();
    await waitForShellReady(page);
    await openAppearance(page);

    await page.getByRole('radio', { name: 'Heat' }).click();
    await page.getByRole('switch', { name: 'Reduced effects' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await assertRails(page, 'static');
  });

  test('Readability with Motion off staticizes rails and leaves Motion off', async ({ page }) => {
    await seedAppearance(SIGNATURE_STATE);
    await page.reload();
    await waitForShellReady(page);
    await openAppearance(page);

    await page.getByRole('switch', { name: 'Readability mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await assertRails(page, 'static');
  });
});
