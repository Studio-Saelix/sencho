/**
 * EditorView save-and-deploy: a failed PUT must abort the deploy. Verified by
 * intercepting the PUT with a forced 500 and asserting that no POST to /deploy
 * is observed, plus a "Failed to save file" toast surfaces.
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const TEST_STACK = 'e2e-save-deploy-stack';

async function deleteTestStack(page: import('@playwright/test').Page) {
  await page.evaluate(async (name) => {
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => { });
  }, TEST_STACK);
}

async function createTestStack(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Create Stack' }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  await page.locator('#create-stack-name').fill(TEST_STACK);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8_000 });
}

test.describe('EditorView save-and-deploy', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await waitForStacksLoaded(page);
    await deleteTestStack(page);
    await page.waitForTimeout(300);
    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);
    await createTestStack(page);
    // Open the new stack in the editor.
    await page.locator('[role="listbox"]').getByText(TEST_STACK, { exact: true }).click();
  });

  test.afterEach(async ({ page }) => {
    await deleteTestStack(page);
  });

  test('does NOT deploy when the save PUT fails', async ({ page }) => {
    // Force the compose-save PUT to fail.
    await page.route(`**/api/stacks/${TEST_STACK}`, async (route, req) => {
      if (req.method() === 'PUT') {
        await route.fulfill({ status: 500, body: 'forced save failure' });
        return;
      }
      await route.continue();
    });

    // Track whether the deploy POST is ever attempted.
    let deployAttempts = 0;
    await page.route(`**/api/stacks/${TEST_STACK}/deploy*`, async (route, req) => {
      if (req.method() === 'POST') deployAttempts += 1;
      await route.continue();
    });

    // The editor surface has two distinct edit affordances. First click swaps
    // the right panel from Anatomy to the editor tabs (Monaco mounts read-only);
    // second click flips Monaco into edit mode and reveals Save & Deploy.
    await page.getByRole('button', { name: /^edit$/ }).click();
    await page.getByRole('button', { name: /^Edit$/ }).click();

    // No need to modify Monaco content: saveFile fires the PUT regardless of
    // dirty state. The route interceptor forces it to 500; the gated handler
    // then must not call POST /deploy.
    await page.getByRole('button', { name: 'Save & Deploy', exact: true }).click();

    // Failure toast must appear.
    await expect(page.getByText(/failed to save file/i)).toBeVisible({ timeout: 5_000 });

    // Give the UI a beat to (incorrectly) fire a deploy if the guard is broken.
    await page.waitForTimeout(1_000);
    expect(deployAttempts).toBe(0);
  });
});
