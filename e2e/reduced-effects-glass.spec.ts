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
    const v = cs.backdropFilter || (cs as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none';
    return v.trim() || 'none';
  });
}

async function backgroundAlpha(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(',').map((p) => p.trim());
    if (parts.length < 4) return 1;
    return Number(parts[3]);
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

test.describe('Reduced-effects glass', () => {
  test('cold load with Calm seeds data-effects before hydration and clears chrome blur', async ({ page }) => {
    await seedAppearance(page, CALM_STATE);

    let effectsAtDomContent: string | null = null;
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
    effectsAtDomContent = await page.evaluate(
      () => (window as unknown as { __snEffectsAtDCL?: string | null }).__snEffectsAtDCL ?? null,
    );
    expect(effectsAtDomContent).toBe('reduced');

    await loginAs(page);
    await waitForStacksLoaded(page);

    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expectNoBlur(page.locator('[data-sn-chrome="topbar"]'));
    await expectNoBlur(page.locator('[data-sn-chrome="sidebar"]'));
    expect(await backgroundAlpha(page.locator('[data-sn-chrome="topbar"]'))).toBeGreaterThan(0.99);
    expect(await backgroundAlpha(page.locator('[data-sn-chrome="sidebar"]'))).toBeGreaterThan(0.99);
  });

  test('Signature keeps chrome glass; Reduced effects removes it without reload', async ({ page }) => {
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expectHasBlur(page.locator('[data-sn-chrome="topbar"]'));
    await expectHasBlur(page.locator('[data-sn-chrome="sidebar"]'));

    await openAppearance(page);
    await expect(page.getByText('Constrained rendering devices', { exact: true })).toBeVisible();

    await page.getByRole('switch', { name: 'Reduced effects' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.getByText('Constrained rendering devices', { exact: true })).toHaveCount(0);
    await expectNoBlur(page.locator('[data-sn-chrome="topbar"]'));
    await expectNoBlur(page.locator('[data-sn-chrome="sidebar"]'));

    // Profile menu is a floating popover: reopen after toggle and assert no blur.
    await page.getByRole('button', { name: /profile/i }).click();
    const menu = page.getByRole('menu').or(page.locator('[data-radix-popper-content-wrapper]').last());
    await expect(menu.first()).toBeVisible();
    // Prefer a concrete popover/menu node if present.
    const floating = page.locator('[role="menu"], [data-radix-popper-content-wrapper] [class*="backdrop"], [data-state="open"].z-50').first();
    if (await floating.count()) {
      await expectNoBlur(floating);
    }

    await page.keyboard.press('Escape');
    await page.getByRole('switch', { name: 'Reduced effects' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-effects', 'reduced');
    await expectHasBlur(page.locator('[data-sn-chrome="topbar"]'));
    await expect(page.getByText('Constrained rendering devices', { exact: true })).toBeVisible();
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
      expect(await backgroundAlpha(page.locator('[data-sn-chrome="sidebar"]'))).toBeGreaterThan(0.99);
    }

    await setThemeMode(page, /^Auto$/i);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', /^(dim|oled)$/);
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
    expect(await backgroundAlpha(tabBar)).toBeGreaterThan(0.99);
  });

  test('Readability hides the constrained-device callout', async ({ page }) => {
    await seedAppearance(page, SIGNATURE_STATE);
    await loginAs(page);
    await waitForStacksLoaded(page);
    await openAppearance(page);

    await expect(page.getByText('Constrained rendering devices', { exact: true })).toBeVisible();
    await page.getByRole('switch', { name: 'Readability mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-effects', 'reduced');
    await expect(page.getByText('Constrained rendering devices', { exact: true })).toHaveCount(0);
  });
});
