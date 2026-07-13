/**
 * Reduced-effects glass correctness (not GPU %).
 *
 * Proves that data-effects="reduced" clears backdrop-filter and solidifies
 * chrome/floating fills, and that full-effects still keeps glass. Fresh Calm
 * installs already set reduced via theme-init; Signature keeps blur until the
 * operator opts into Reduced effects.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const CALM_STATE = {
  theme: 'dim',
  accent: 'cyan',
  borderBoost: 0,
  glow: 0.16,
  contrast: 0,
  uiFont: 'Geist',
  monoFont: 'Geist Mono',
  typeScale: 1,
  visualStyle: 'calm',
  headingStyle: 'clean',
  chartStyle: 'muted',
  reducedEffects: true,
  readability: false,
  reducedMotion: false,
} as const;

const SIGNATURE_STATE = {
  ...CALM_STATE,
  visualStyle: 'signature',
  headingStyle: 'signature',
  chartStyle: 'signature',
  reducedEffects: false,
} as const;

async function seedAppearance(page: Page, state: Record<string, unknown>) {
  await page.addInitScript((payload) => {
    localStorage.setItem('sencho.appearance.theme', JSON.stringify(payload));
  }, state);
}

async function computedBackdrop(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const v =
      cs.backdropFilter ||
      (cs as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ||
      'none';
    return v.trim() || 'none';
  });
}

/**
 * Parse alpha from getComputedStyle backgroundColor. Handles rgb/rgba,
 * space-separated rgb, and Color Level 4 forms that keep a slash alpha
 * (oklch / oklab / lab / lch / color / hsl / hwb). Returns 1 only when the
 * color is genuinely opaque or unparseable without an alpha channel.
 */
async function backgroundAlpha(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const bg = getComputedStyle(el).backgroundColor.trim();
    if (!bg || bg === 'transparent') return 0;

    const slash = bg.match(/\/\s*([0-9]*\.?[0-9]+)\s*\)\s*$/);
    if (slash) {
      const n = Number(slash[1]);
      return Number.isFinite(n) ? n : 1;
    }

    const rgbaComma = bg.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
    if (rgbaComma) {
      return rgbaComma[4] !== undefined ? Number(rgbaComma[4]) : 1;
    }

    const rgbSpace = bg.match(/^rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\s*\)$/i);
    if (rgbSpace) {
      return rgbSpace[4] !== undefined ? Number(rgbSpace[4]) : 1;
    }

    // Modern color functions without a slash alpha are opaque.
    if (/^(oklch|oklab|lab|lch|color|hsl|hwb)\(/i.test(bg)) return 1;
    return 1;
  });
}

async function expectNoBlur(locator: Locator) {
  const filter = await computedBackdrop(locator);
  expect(filter === 'none' || filter === 'none none').toBeTruthy();
}

async function expectHasBlur(locator: Locator) {
  const filter = await computedBackdrop(locator);
  expect(filter === 'none' || filter === 'none none').toBeFalsy();
}

async function expectOpaque(locator: Locator) {
  expect(await backgroundAlpha(locator)).toBeGreaterThan(0.99);
}

async function expectTranslucent(locator: Locator) {
  expect(await backgroundAlpha(locator)).toBeLessThan(0.99);
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: /profile/i }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByText('Motion & effects')).toBeVisible();
}

async function setThemeMode(page: Page, label: RegExp) {
  await openAppearance(page);
  await page.getByRole('radio', { name: label }).click();
}

async function showInfoToast(page: Page) {
  await page.evaluate(async () => {
    const mod = await import('/src/components/ui/toast-store.ts');
    mod.toast.info('Glass opacity probe', { duration: 60_000 });
  });
  await expect(page.locator('[data-sn-glass="panel"]').filter({ hasText: 'Glass opacity probe' })).toBeVisible();
}

async function openCreateStackDialog(page: Page) {
  await page.getByRole('button', { name: 'Create Stack' }).click();
  await expect(page.locator('[data-sn-chrome="dialog"]')).toBeVisible();
}

test.describe('Reduced-effects glass', () => {
  test('cold load with Calm applies data-effects by DOMContentLoaded and clears chrome blur', async ({ page }) => {
    await seedAppearance(page, CALM_STATE);

    await page.addInitScript(() => {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          (window as unknown as { __snEffectsAtDCL?: string | null }).__snEffectsAtDCL =
            document.documentElement.getAttribute('data-effects');
        },
        { once: true },
      );
    });

    await page.goto('/');
    const effectsAtDomContent = await page.evaluate(
      () => (window as unknown as { __snEffectsAtDCL?: string | null }).__snEffectsAtDCL ?? null,
    );
    expect(effectsAtDomContent).toBe('reduced');

    await loginAs(page);
    await waitForStacksLoaded(page);

    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expectNoBlur(page.locator('[data-sn-chrome="topbar"]'));
    await expectNoBlur(page.locator('[data-sn-chrome="sidebar"]'));
    await expectOpaque(page.locator('[data-sn-chrome="topbar"]'));
    await expectOpaque(page.locator('[data-sn-chrome="sidebar"]'));
  });

  test('Signature chrome is translucent with blur; Reduced effects reverses both without reload', async ({ page }) => {
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);

    const topbar = page.locator('[data-sn-chrome="topbar"]');
    const sidebar = page.locator('[data-sn-chrome="sidebar"]');

    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expectHasBlur(topbar);
    await expectHasBlur(sidebar);
    await expectTranslucent(sidebar);

    await openAppearance(page);
    await expect(page.getByText('Constrained graphics', { exact: true })).toBeVisible();

    await page.getByRole('switch', { name: 'Reduced effects' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.getByText('Constrained graphics', { exact: true })).toBeVisible();

    await page.getByRole('switch', { name: 'Reduced motion' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByText('Constrained graphics', { exact: true })).toHaveCount(0);
    await expectNoBlur(topbar);
    await expectNoBlur(sidebar);
    await expectOpaque(sidebar);

    await page.getByRole('button', { name: /profile/i }).click();
    const popover = page.locator('[data-sn-chrome="popover"]');
    await expect(popover).toBeVisible();
    await expectNoBlur(popover);
    await expectOpaque(popover);
    await page.keyboard.press('Escape');

    await page.getByRole('switch', { name: 'Reduced motion' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByText('Constrained graphics', { exact: true })).toBeVisible();

    await page.getByRole('switch', { name: 'Reduced effects' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expectHasBlur(topbar);
    await expectTranslucent(sidebar);
  });

  test('dialog toast and overlay glass flip with Reduced effects both ways', async ({ page }) => {
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);

    // Dialog (Create Stack uses Modal -> DialogContent)
    await openCreateStackDialog(page);
    const dialog = page.locator('[data-sn-chrome="dialog"]');
    await expectHasBlur(dialog);
    // Dialog uses bg-popover; under Signature --pop-a is translucent.
    await expectTranslucent(dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Panel toast (data-sn-glass="panel")
    await showInfoToast(page);
    const toastPanel = page.locator('[data-sn-glass="panel"]').filter({ hasText: 'Glass opacity probe' });
    await expectHasBlur(toastPanel);
    await expectTranslucent(toastPanel);

    // Overlay probe: mount the same contract as Terminal overlay chrome so we
    // exercise data-sn-glass="overlay" without depending on a live PTY.
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.setAttribute('data-sn-glass', 'overlay');
      el.setAttribute('data-testid', 'glass-overlay-probe');
      el.className = 'fixed bottom-4 left-4 z-[100] h-10 w-40 bg-background/80 backdrop-blur-sm';
      document.body.appendChild(el);
    });
    const overlay = page.getByTestId('glass-overlay-probe');
    await expect(overlay).toBeVisible();
    await expectHasBlur(overlay);
    await expectTranslucent(overlay);

    await openAppearance(page);
    await page.getByRole('switch', { name: 'Reduced effects' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');

    await expectNoBlur(toastPanel);
    await expectOpaque(toastPanel);
    await expectNoBlur(overlay);
    await expectOpaque(overlay);

    await openCreateStackDialog(page);
    await expectNoBlur(dialog);
    await expectOpaque(dialog);
    await page.keyboard.press('Escape');

    // Back to full effects without reload: translucency and blur return.
    await page.getByRole('switch', { name: 'Reduced effects' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expectHasBlur(toastPanel);
    await expectTranslucent(toastPanel);
    await expectHasBlur(overlay);
    await expectTranslucent(overlay);

    await openCreateStackDialog(page);
    await expectHasBlur(dialog);
    await expectTranslucent(dialog);
  });

  test('Dim OLED Light and Auto media prefs keep reduced chrome opaque', async ({ page }) => {
    await seedAppearance(page, CALM_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);

    for (const mode of [
      { radio: /^Dim$/i, theme: 'dim' },
      { radio: /^OLED$/i, theme: 'oled' },
      { radio: /^Light$/i, theme: 'light' },
    ] as const) {
      await setThemeMode(page, mode.radio);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode.theme);
      await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
      await expectNoBlur(page.locator('[data-sn-chrome="topbar"]'));
      await expectOpaque(page.locator('[data-sn-chrome="sidebar"]'));
    }

    await setThemeMode(page, /^Auto$/i);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dim');
    await expectNoBlur(page.locator('[data-sn-chrome="topbar"]'));

    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expectNoBlur(page.locator('[data-sn-chrome="topbar"]'));
  });

  test('mobile tab bar clears blur and solidifies under reduced effects', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAppearance(page, CALM_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);

    const tabBar = page.locator('[data-sn-glass="mobile-tabbar"]');
    await expect(tabBar).toBeVisible();
    await expectNoBlur(tabBar);
    await expectOpaque(tabBar);
  });

  test('Reduced motion hides the constrained-graphics callout', async ({ page }) => {
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);
    await openAppearance(page);

    await expect(page.getByText('Constrained graphics', { exact: true })).toBeVisible();
    await page.getByRole('switch', { name: 'Reduced motion' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByText('Constrained graphics', { exact: true })).toHaveCount(0);
  });
});
