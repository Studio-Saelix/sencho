/**
 * E2E coverage for the operator-side pilot-agent enrollment flow.
 *
 * Backend integration is covered by pilot-tunnel-integration.test.ts and
 * the pilot-enrollment / pilot-enrollment-replay vitest suites. This file
 * exercises the parts only the browser sees: the mode selector, the
 * enrollment dialog, the Compose file code block, and the regenerate
 * affordance on an existing pilot-mode node.
 *
 * Out of scope: simulating an agent connecting to flip the row to Online.
 * The integration test covers the wire side; the E2E focuses on what the
 * operator clicks and reads.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';

const NAME_PREFIX = 'pilot-e2e-';

/**
 * API-based teardown: list all nodes whose name starts with the test prefix
 * and DELETE them. Reuses the browser's auth cookie so we get the same
 * permissions as the logged-in admin. Reliable in a way that "click the
 * delete icon, then click confirm" never can be (animation timing,
 * confirmation modal markup drift, and so on).
 */
async function deleteTestNodes(page: Page): Promise<void> {
  const list = await page.request.get('/api/nodes');
  if (!list.ok()) return;
  const nodes = (await list.json()) as Array<{ id: number; name: string }>;
  for (const n of nodes) {
    if (n.name.startsWith(NAME_PREFIX)) {
      await page.request.delete(`/api/nodes/${n.id}`).catch(() => undefined);
    }
  }
}

test.describe('Pilot Agent enrollment', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    // Sweep any leftover test nodes BEFORE running so a previous failed
    // run cannot affect this one.
    await deleteTestNodes(page);
    // Settings lives inside the User Profile Dropdown.
    await page.getByRole('button', { name: /profile/i }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^nodes$/i }).click();
  });

  test.afterEach(async ({ page }) => {
    // Cleanup via the API so a UI assertion failure does not leave rows
    // behind. Runs even when the test body throws.
    await deleteTestNodes(page);
  });

  test('creating a pilot-agent node opens the enrollment dialog with a compose file', async ({ page }) => {
    const nodeName = `${NAME_PREFIX}create-${Date.now()}`;

    const addBtn = page.getByRole('button', { name: /add node/i }).first();
    if (!await addBtn.isVisible()) {
      test.skip();
      return;
    }
    await addBtn.click();
    await expect(page.locator('#node-name')).toBeVisible({ timeout: 5_000 });

    // Switch type to Remote. Pilot Agent is the default mode for remote
    // nodes (NodeManager.tsx initializes formData.mode = 'pilot_agent'),
    // so the mode combobox does not need to be touched.
    await page.locator('#node-type').click();
    await page.getByRole('option', { name: /remote/i }).click();

    // Confirm pilot mode is selected and the proxy-only api_url field is
    // NOT rendered. A regression that flipped the default would surface
    // here as the api_url field becoming visible.
    await expect(page.locator('#node-api-url')).toHaveCount(0);

    await page.locator('#node-name').fill(nodeName);
    await page.getByRole('dialog').getByRole('button', { name: /add node/i }).click();

    // Enrollment modal opens. The compose file must carry the SENCHO_MODE
    // env entry and a JWT-shaped enrollment token.
    await expect(page.getByText(/Deploy the pilot agent on/i)).toBeVisible({ timeout: 10_000 });

    const composeFile = page.locator('pre').filter({ hasText: /SENCHO_MODE: pilot/ });
    await expect(composeFile).toBeVisible();

    const cmd = await composeFile.innerText();
    expect(cmd).toContain('SENCHO_MODE: pilot');
    expect(cmd).toContain('SENCHO_PRIMARY_URL:');
    expect(cmd).toMatch(/SENCHO_ENROLL_TOKEN: "?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"?/);
  });

  test('regenerating the enrollment token issues a fresh compose file', async ({ page }) => {
    const nodeName = `${NAME_PREFIX}regen-${Date.now()}`;

    const addBtn = page.getByRole('button', { name: /add node/i }).first();
    if (!await addBtn.isVisible()) {
      test.skip();
      return;
    }
    await addBtn.click();
    await expect(page.locator('#node-name')).toBeVisible({ timeout: 5_000 });
    await page.locator('#node-type').click();
    await page.getByRole('option', { name: /remote/i }).click();
    await page.locator('#node-name').fill(nodeName);
    await page.getByRole('dialog').getByRole('button', { name: /add node/i }).click();

    const firstCompose = page.locator('pre').filter({ hasText: /SENCHO_MODE: pilot/ });
    await expect(firstCompose).toBeVisible({ timeout: 10_000 });
    const firstText = await firstCompose.innerText();
    const firstToken = firstText.match(/SENCHO_ENROLL_TOKEN: "?([A-Za-z0-9_.-]+)"?/)?.[1];
    expect(firstToken).toBeTruthy();

    // Close the enrollment dialog (Escape lands on the row view).
    await page.keyboard.press('Escape');

    // Open the row's edit dialog via the aria-labeled icon button.
    const row = page.getByRole('row', { name: new RegExp(nodeName) }).first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.getByRole('button', { name: 'Edit node' }).click();
    await page.getByRole('button', { name: /regenerate enrollment token/i }).click();

    const secondCompose = page.locator('pre').filter({ hasText: /SENCHO_MODE: pilot/ });
    await expect(secondCompose).toBeVisible({ timeout: 10_000 });
    const secondText = await secondCompose.innerText();
    const secondToken = secondText.match(/SENCHO_ENROLL_TOKEN: "?([A-Za-z0-9_.-]+)"?/)?.[1];
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);
  });
});
