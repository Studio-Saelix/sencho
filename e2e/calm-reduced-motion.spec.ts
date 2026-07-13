/**
 * Calm Reduced Motion defaults + Reduced Effects decorative-rail quieting.
 * Related to #1614; correctness only (not GPU %).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const STORAGE_KEY = 'sencho.appearance.theme';
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
} as const;

async function seedAppearance(page: Page, state: Record<string, unknown> | null) {
  await page.addInitScript(
    ({ key, legacy, payload }) => {
      if (payload === null) {
        localStorage.removeItem(key);
        localStorage.removeItem(legacy);
      } else {
        localStorage.setItem(key, JSON.stringify(payload));
        localStorage.removeItem(legacy);
      }
    },
    { key: STORAGE_KEY, legacy: LEGACY_KEY, payload: state },
  );
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
  test('fresh load applies data-motion by DOMContentLoaded', async ({ page }) => {
    await seedAppearance(page, null);
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
    await page.goto('/');
    const atDcl = await page.evaluate(
      () => (window as unknown as { __snMotionAtDCL?: string | null }).__snMotionAtDCL ?? null,
    );
    expect(atDcl).toBe('reduced');
  });

  test('returning Signature object missing reducedMotion has no data-motion', async ({ page }) => {
    const { reducedMotion: _omit, ...withoutMotion } = SIGNATURE_STATE;
    await seedAppearance(page, withoutMotion);
    await loginAs(page);
    await waitForStacksLoaded(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
  });

  test('stored reducedMotion true and false survive reload', async ({ page }) => {
    await seedAppearance(page, { ...SIGNATURE_STATE, reducedMotion: true });
    await loginAs(page);
    await waitForStacksLoaded(page);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await page.reload();
    await waitForStacksLoaded(page);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

    await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      parsed.reducedMotion = false;
      localStorage.setItem(key, JSON.stringify(parsed));
    }, STORAGE_KEY);
    await page.reload();
    await waitForStacksLoaded(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
  });

  test('Signature to Calm and back writes both effects and motion', async ({ page }) => {
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);
    await openAppearance(page);

    await page.getByRole('button', { name: /readable default|Calm/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

    await page.getByRole('button', { name: /Today's look|Signature/i }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
  });

  test('Calm card stays selected when Motion is toggled off; rails stay static', async ({ page }) => {
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);
    await openAppearance(page);

    await page.getByRole('button', { name: /readable default|Calm/i }).click();
    await page.getByRole('switch', { name: 'Reduced motion' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByRole('button', { name: /readable default/i })).toHaveAttribute('aria-pressed', 'true');

    await assertRails(page, 'static');
  });

  test('Signature full effects with Motion off keeps rails running', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);
    await openAppearance(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await assertRails(page, 'running');
  });

  test('manual Reduced effects under custom style staticizes rails without enabling Motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);
    await openAppearance(page);

    await page.getByRole('radio', { name: 'Heat' }).click();
    await page.getByRole('switch', { name: 'Reduced effects' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await assertRails(page, 'static');
  });

  test('Readability with Motion off staticizes rails and leaves Motion off', async ({ page }) => {
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);
    await openAppearance(page);

    await page.getByRole('switch', { name: 'Readability mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await assertRails(page, 'static');
  });
});
