/**
 * Auto-Heal Policies E2E tests - happy-path CRUD via the sheet UI.
 *
 * Opens the Auto-Heal sheet from the stack sidebar context menu, creates a
 * policy, verifies it appears in the list, then deletes it.
 *
 * Auto-heal policies are available on every tier, so no paid license is
 * required; the test skips gracefully when no stacks exist on the instance.
 */
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

/** Wait for the stacks sidebar to finish loading. */
async function waitForStacksLoaded(page: import('@playwright/test').Page) {
  await expect(page.getByRole('button', { name: 'Create Stack' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
}

test.describe('Auto-Heal Policies', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await waitForStacksLoaded(page);
  });

  test('CRUD: create and delete a policy via the sheet', async ({ page }) => {
    // Find the first stack item in the sidebar. cmdk renders items with role="option".
    const stackItems = page.locator('[data-stacks-loaded="true"] [role="option"]');
    const count = await stackItems.count();
    if (count === 0) {
      test.skip();
      return;
    }

    // Right-click the first stack to open the context menu
    await stackItems.first().click({ button: 'right' });

    // Wait for the Radix context menu to appear
    await expect(page.locator('[role="menu"]')).toBeVisible({ timeout: 5_000 });

    // Click "Auto-Heal" menu item
    await page.locator('[role="menu"]').getByText('Auto-Heal').click();

    // The sheet title should be visible
    await expect(page.getByText(/Auto-Heal Policies/)).toBeVisible({ timeout: 5_000 });

    // Detect PaidGate: skip if the upgrade prompt blocks the UI (community instance)
    const upgradePrompt = page.getByText(/requires a paid license/i);
    if (await upgradePrompt.isVisible({ timeout: 2_000 }).catch(() => false)) {
      test.skip();
      return;
    }

    // Wait for the policy list and form to be ready
    await expect(page.getByText('Active Policies')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Add Policy' })).toBeVisible({ timeout: 8_000 });

    // ── Fill in the add-policy form ─────────────────────────────────────────
    // Leave Service as default "All services"

    const unhealthyInput = page.locator('#unhealthy-duration');
    await unhealthyInput.clear();
    await unhealthyInput.fill('2');

    const cooldownInput = page.locator('#cooldown');
    await cooldownInput.clear();
    await cooldownInput.fill('5');

    const maxRestartsInput = page.locator('#max-restarts');
    await maxRestartsInput.clear();
    await maxRestartsInput.fill('3');

    const autoDisableInput = page.locator('#auto-disable');
    await autoDisableInput.clear();
    await autoDisableInput.fill('5');

    // ── Submit ──────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Add Policy' }).click();

    // Wait for the save to complete (button re-enables) then verify the row appears
    await expect(page.getByRole('button', { name: 'Add Policy' })).toBeEnabled({ timeout: 8_000 });

    // The PolicyRow subtitle shows "Unhealthy for 2 min" for the value we entered
    const policySubtitle = page.getByText(/Unhealthy for 2 min/i).first();
    await expect(policySubtitle).toBeVisible({ timeout: 8_000 });

    // ── Delete the policy ───────────────────────────────────────────────────
    // Find the policy card containing the subtitle and click its delete button
    const policyCard = page
      .locator('.rounded-lg.border')
      .filter({ hasText: 'Unhealthy for 2 min' })
      .first();
    await expect(policyCard).toBeVisible({ timeout: 5_000 });

    const deleteBtn = policyCard.getByRole('button', { name: 'Delete policy' });
    await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
    await deleteBtn.click();

    // Confirm the policy row is removed
    await expect(policySubtitle).not.toBeVisible({ timeout: 8_000 });
  });
});
