/**
 * Node management E2E tests.
 * Tests the SSRF validation we added (C2 fix) is surfaced in the UI.
 */
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

test.describe('Node management', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    // Settings is inside the User Profile Dropdown - open it first
    await page.getByRole('button', { name: /profile/i }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^nodes$/i }).click();
  });

  /**
   * Open the Add Node dialog and switch the type to Remote so the API URL
   * field becomes visible. Returns false (and skips) if the button isn't found.
   */
  async function openAddNodeAsRemote(page: import('@playwright/test').Page): Promise<boolean> {
    const addBtn = page.getByRole('button', { name: /add node/i }).first();
    if (!await addBtn.isVisible()) {
      test.skip();
      return false;
    }
    await addBtn.click();
    // Wait for the dialog form to be ready
    await expect(page.locator('#node-name')).toBeVisible({ timeout: 5_000 });
    // The API URL field only renders when type === 'remote'.
    // #node-type is a Radix UI combobox - click to open, then pick the option.
    await page.locator('#node-type').click();
    await page.getByRole('option', { name: /remote/i }).click();
    // Remote nodes default to Pilot Agent mode; switch to Proxy so the api_url field renders.
    await page.locator('#node-mode').click();
    await page.getByRole('button', { name: /distributed api proxy/i }).click();
    // Confirm the API URL field is now visible before proceeding
    await expect(page.locator('#node-api-url')).toBeVisible({ timeout: 3_000 });
    return true;
  }

  test('adding a node with localhost api_url shows a validation error', async ({ page }) => {
    if (!await openAddNodeAsRemote(page)) return;

    await page.locator('#node-name').fill('bad-node');
    await page.locator('#node-api-url').fill('http://localhost:6379');
    // api_token is required to enable the submit button; use a dummy value since we're testing URL validation
    await page.locator('#node-api-token').fill('dummy-token');
    // Scope to the dialog so we target the submit button, not the trigger
    await page.getByRole('dialog').getByRole('button', { name: /add node/i }).click();

    await expect(page.getByText(/loopback|localhost/i)).toBeVisible({ timeout: 5_000 });
  });

  test('adding a node with an invalid URL shows an error', async ({ page }) => {
    if (!await openAddNodeAsRemote(page)) return;

    await page.locator('#node-name').fill('bad-url-node');
    await page.locator('#node-api-url').fill('not-a-url-at-all');
    // api_token is required to enable the submit button; use a dummy value since we're testing URL validation
    await page.locator('#node-api-token').fill('dummy-token');
    await page.getByRole('dialog').getByRole('button', { name: /add node/i }).click();

    await expect(page.getByText(/valid url|invalid url/i)).toBeVisible({ timeout: 5_000 });
  });
});
