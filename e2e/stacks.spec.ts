/**
 * Stack management E2E tests - happy path CRUD.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const TEST_STACK = 'e2e-test-stack';

/** Delete the test stack via the browser's authenticated fetch (so cookies are included). */
async function deleteTestStackViaApi(page: import('@playwright/test').Page) {
  await page.evaluate(async (name) => {
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => { });
  }, TEST_STACK);
}

test.describe('Stack management', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await waitForStacksLoaded(page);
  });

  test('create a new stack', async ({ page }) => {
    // Remove leftover from prior runs (using browser context auth)
    await deleteTestStackViaApi(page);
    await page.waitForTimeout(500);

    // Reload to get a fresh sidebar without the deleted stack
    await page.reload();
    await loginAs(page); // may re-login if cookie expired, otherwise skips to dashboard
    await waitForStacksLoaded(page);

    await page.getByRole('button', { name: 'Create Stack' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    await page.locator('#create-stack-name').fill(TEST_STACK);
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Create' }).click();

    // F-2: the dialog MUST close on a successful create. No silent .catch swallow.
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8_000 });

    // F-2: a success toast MUST appear so the click does not feel like a no-op.
    await expect(page.getByText(`Stack "${TEST_STACK}" created.`)).toBeVisible({ timeout: 5_000 });

    // F-2: the new stack appears in the sidebar without a manual reload.
    await expect(
      page.locator('[role="listbox"]').getByText(TEST_STACK, { exact: true })
    ).toBeVisible({ timeout: 5_000 });
  });

  test('create dialog: double-clicking Create fires only one POST', async ({ page }) => {
    const stackName = 'e2e-double-click-stack';

    // Clean any prior leftover and reload so we start from a known sidebar state.
    await page.evaluate(async (name) => {
      await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => { });
    }, stackName);
    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);

    // Count POST /api/stacks calls (exact path; the regex anchors avoid matching
    // /api/stacks/<name>/deploy and similar nested endpoints).
    let postCount = 0;
    await page.route('**/api/stacks', (route) => {
      if (route.request().method() === 'POST') postCount += 1;
      void route.continue();
    });

    try {
      await page.getByRole('button', { name: 'Create Stack' }).click();
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
      await page.locator('#create-stack-name').fill(stackName);

      const createBtn = page.locator('[role="dialog"]').getByRole('button', { name: /^Create/ });
      // Rapid double-click; the busy guard must reject the second click synchronously.
      await createBtn.click();
      await createBtn.click({ force: true }).catch(() => { /* second click may land on disabled btn */ });

      await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8_000 });
      await expect(page.getByText(`Stack "${stackName}" created.`)).toBeVisible({ timeout: 5_000 });
      expect(postCount).toBe(1);
    } finally {
      await page.unroute('**/api/stacks');
      // Cleanup
      await page.evaluate(async (name) => {
        await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => { });
      }, stackName);
    }
  });

  test('delete the test stack', async ({ page }) => {
    // Confirm the stack exists in the sidebar
    await expect(page.getByText(TEST_STACK).first()).toBeVisible({ timeout: 5_000 });

    // Click on the stack to open the editor
    await page.getByText(TEST_STACK).first().click();

    // Destructive actions live under the overflow menu in the stack toolbar
    await page.getByRole('button', { name: 'More actions' }).click();
    const deleteItem = page.getByRole('menuitem', { name: /delete/i });
    await expect(deleteItem).toBeVisible({ timeout: 10_000 });
    await deleteItem.click();

    // AlertDialog confirmation
    await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5_000 });
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();

    // Stack should no longer appear in the sidebar (exact match to avoid false positives from
    // similarly-named stacks; scoped to the CommandList)
    await expect(
      page.locator('[role="listbox"]').getByText(TEST_STACK, { exact: true })
    ).not.toBeVisible({ timeout: 8_000 });
  });
});
