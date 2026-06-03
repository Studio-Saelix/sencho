/**
 * Global search command palette E2E - the keyboard-driven navigation journey.
 *
 * The cross-node failure modes (a remote node returning 502/500 or throwing,
 * which drives the "N nodes unreachable" affordance) are covered
 * deterministically by the hook unit tests in
 * frontend/src/hooks/__tests__/useCrossNodeStackSearch.test.tsx, since they
 * cannot be triggered reliably from a single-node E2E environment.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const PALETTE_INPUT = 'input[placeholder="Search the app..."]';
const PALETTE_STACK = 'e2e-palette-stack';

async function createStackViaUi(page: Page, name: string) {
  await page.evaluate(async (n) => {
    await fetch(`/api/stacks/${n}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  }, name);
  await page.reload();
  await loginAs(page);
  await waitForStacksLoaded(page);

  await page.getByRole('button', { name: 'Create Stack' }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  await page.locator('#create-stack-name').fill(name);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8_000 });
}

test.describe('Global search command palette', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await waitForStacksLoaded(page);
  });

  test('opens with Ctrl+K and closes with Esc', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator(PALETTE_INPUT)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('dialog').getByText('Pages', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator(PALETTE_INPUT)).toBeHidden({ timeout: 5_000 });
  });

  test('opens from the top-bar search trigger', async ({ page }) => {
    await page.getByRole('button', { name: 'Open search (Ctrl+K)' }).click();
    await expect(page.locator(PALETTE_INPUT)).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator(PALETTE_INPUT)).toBeHidden({ timeout: 5_000 });
  });

  test('filters pages by substring and navigates on select', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const input = page.locator(PALETTE_INPUT);
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('fleet');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Fleet', { exact: true })).toBeVisible();
    // A non-matching page is hidden because the palette owns matching.
    await expect(dialog.getByText('Home', { exact: true })).toBeHidden();

    await dialog.getByText('Fleet', { exact: true }).click();
    await expect(input).toBeHidden({ timeout: 5_000 });
  });

  test('shows "No results." for a query that matches nothing', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const input = page.locator(PALETTE_INPUT);
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('zzzznomatchzzzz');
    await expect(page.getByRole('dialog').getByText('No results.')).toBeVisible({ timeout: 8_000 });
  });

  test('finds a stack by filename and surfaces it in the Stacks group', async ({ page }) => {
    await createStackViaUi(page, PALETTE_STACK);

    await page.keyboard.press('Control+k');
    const input = page.locator(PALETTE_INPUT);
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('e2e-palette');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Stacks', { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByText(new RegExp(PALETTE_STACK))).toBeVisible({ timeout: 8_000 });

    // Selecting the stack closes the palette and opens it in the editor.
    await dialog.getByText(new RegExp(PALETTE_STACK)).first().click();
    await expect(input).toBeHidden({ timeout: 8_000 });
  });
});
