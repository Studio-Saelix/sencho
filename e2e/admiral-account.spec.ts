/**
 * Admiral Account (Settings → license) Phase 4 surfaces.
 * Community state must show AGPLv3 sourcing and channel info without auto-switching images.
 */
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

test.describe('Admiral Account', () => {
  test('Community settings show AGPLv3 source and image channel fields', async ({ page }) => {
    await loginAs(page);

    await page.goto('/settings/license');
    await page.waitForTimeout(1_000);

    // Section may still route as /settings/license with Admiral Account label.
    await expect(page.getByText(/Sencho Community|Community plan/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: /View source/i })).toBeVisible();
    await expect(page.getByText(/^Channel$/i).first()).toBeVisible();
    await expect(page.getByText(/Current image/i).first()).toBeVisible();

    // Activation alone must not open a Hardened switch dialog.
    await expect(page.getByText(/Review image switch/i)).toHaveCount(0);
  });

  test('Support section uses bounded business-day wording', async ({ page }) => {
    await loginAs(page);
    await page.goto('/settings/support');
    await page.waitForTimeout(1_000);

    // Community sees self-serve; Admiral may see priority email with business-day target.
    const selfServe = page.getByText(/Documentation|GitHub Issues/i).first();
    await expect(selfServe).toBeVisible({ timeout: 15_000 });

    const pageText = await page.locator('body').innerText();
    expect(pageText).not.toMatch(/responses within 24 hours/i);
  });
});
