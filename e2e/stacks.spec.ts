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

    let postCount = 0;
    let releaseCreate: () => void = () => undefined;
    let markFirstPostSeen: () => void = () => undefined;
    let releasedCreate = false;
    const createMayContinue = new Promise<void>((resolve) => {
      releaseCreate = () => {
        if (releasedCreate) return;
        releasedCreate = true;
        resolve();
      };
    });
    const firstPostSeen = new Promise<void>((resolve) => {
      markFirstPostSeen = resolve;
    });

    // Count POST /api/stacks calls and hold the first response until after a
    // second click has been attempted. Continuing the original route after an
    // assertion failure can race Playwright cleanup, so fetch and fulfill it
    // explicitly once the test is ready to let the request complete.
    await page.route('**/api/stacks', async (route) => {
      if (route.request().method() === 'POST') {
        postCount += 1;
        markFirstPostSeen();
        await createMayContinue;
        const response = await route.fetch();
        await route.fulfill({ response });
        return;
      }
      await route.fallback();
    });

    try {
      await page.getByRole('button', { name: 'Create Stack' }).click();
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
      await page.locator('#create-stack-name').fill(stackName);

      const createBtn = page.locator('[role="dialog"]').getByRole('button', { name: /^Create/ });
      await createBtn.click();
      await firstPostSeen;

      // Best-effort second click while the first POST is still in flight. A
      // real user mash translates to a no-op once the button disables; the
      // synchronous ref guard catches it even if Playwright manages to dispatch
      // the click before React commits the disabled state.
      await createBtn.click({ force: true, timeout: 500 }).catch(() => undefined);
      await page.waitForTimeout(100);
      expect(postCount).toBe(1);

      releaseCreate();
      await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8_000 });
      await expect(page.getByText(`Stack "${stackName}" created.`)).toBeVisible({ timeout: 5_000 });
    } finally {
      releaseCreate();
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
