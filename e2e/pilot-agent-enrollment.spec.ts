/**
 * E2E coverage for the operator-side pilot-agent enrollment flow.
 *
 * Backend integration is covered by pilot-tunnel-integration.test.ts and
 * the pilot-enrollment / pilot-enrollment-replay vitest suites. This file
 * exercises the parts only the browser sees: the mode selector, the
 * enrollment dialog, the docker run code block, and the regenerate
 * affordance on an existing pilot-mode node.
 *
 * Out of scope: simulating an agent connecting to flip the row to Online.
 * The integration test covers the wire side; the E2E focuses on what the
 * operator clicks and reads.
 */
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

test.describe('Pilot Agent enrollment', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    // Settings lives inside the User Profile Dropdown.
    await page.getByRole('button', { name: /profile/i }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^nodes$/i }).click();
  });

  test('creating a pilot-agent node opens the enrollment dialog with a docker run command', async ({ page }) => {
    // Use a unique name per run so re-runs do not collide on the UNIQUE
    // constraint and leave behind nodes that would skew later assertions.
    const nodeName = `pilot-e2e-${Date.now()}`;

    const addBtn = page.getByRole('button', { name: /add node/i }).first();
    if (!await addBtn.isVisible()) {
      test.skip();
      return;
    }
    await addBtn.click();
    await expect(page.locator('#node-name')).toBeVisible({ timeout: 5_000 });

    // Switch type to Remote. Pilot Agent is the default mode for remote
    // nodes, so the mode combobox does not need to be touched.
    await page.locator('#node-type').click();
    await page.getByRole('option', { name: /remote/i }).click();

    // Confirm pilot mode is selected and the proxy-only api_url field is
    // NOT rendered (a regression that flipped the default would surface
    // here as the api_url field becoming visible).
    await expect(page.locator('#node-api-url')).toHaveCount(0);

    await page.locator('#node-name').fill(nodeName);
    await page.getByRole('dialog').getByRole('button', { name: /add node/i }).click();

    // Enrollment modal opens. The docker run command must contain the
    // SENCHO_MODE flag and a JWT-shaped Bearer token.
    const enrollText = page.getByText(/Run this command on/i);
    await expect(enrollText).toBeVisible({ timeout: 10_000 });

    const dockerCommand = page.locator('pre').filter({ hasText: /SENCHO_MODE=pilot/ });
    await expect(dockerCommand).toBeVisible();

    const cmd = await dockerCommand.innerText();
    expect(cmd).toContain('SENCHO_MODE=pilot');
    expect(cmd).toContain('SENCHO_PRIMARY_URL=');
    expect(cmd).toContain('SENCHO_ENROLL_TOKEN=');
    // JWT shape: three base64url segments separated by dots.
    expect(cmd).toMatch(/SENCHO_ENROLL_TOKEN=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);

    // Cleanup: close the dialog and delete the node we just created so
    // re-runs of this test do not accumulate rows.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const row = page.getByRole('row', { name: new RegExp(nodeName) }).first();
    if (await row.isVisible().catch(() => false)) {
      await row.getByRole('button', { name: /delete|remove/i }).click().catch(() => { /* delete affordance may differ */ });
      // Confirmation dialog is best-effort; if it does not appear, the
      // delete was either inline or the node already gone.
      await page.getByRole('button', { name: /^(confirm|delete|yes)$/i }).click().catch(() => undefined);
    }
  });

  test('regenerating the enrollment token issues a fresh docker run command', async ({ page }) => {
    const nodeName = `pilot-regen-${Date.now()}`;

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

    const firstCommand = page.locator('pre').filter({ hasText: /SENCHO_MODE=pilot/ });
    await expect(firstCommand).toBeVisible({ timeout: 10_000 });
    const firstText = await firstCommand.innerText();
    const firstToken = firstText.match(/SENCHO_ENROLL_TOKEN=([A-Za-z0-9_.-]+)/)?.[1];
    expect(firstToken).toBeTruthy();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Open the row's edit dialog and regenerate. The selector is broad
    // because the row layout may use an icon-only edit affordance with
    // an aria-label rather than a visible text node.
    const row = page.getByRole('row', { name: new RegExp(nodeName) }).first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.getByRole('button', { name: /edit|pencil/i }).first().click();
    await page.getByRole('button', { name: /regenerate enrollment token/i }).click();

    const secondCommand = page.locator('pre').filter({ hasText: /SENCHO_MODE=pilot/ });
    await expect(secondCommand).toBeVisible({ timeout: 10_000 });
    const secondText = await secondCommand.innerText();
    const secondToken = secondText.match(/SENCHO_ENROLL_TOKEN=([A-Za-z0-9_.-]+)/)?.[1];
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Cleanup.
    if (await row.isVisible().catch(() => false)) {
      await row.getByRole('button', { name: /delete|remove/i }).click().catch(() => { /* affordance may differ */ });
      await page.getByRole('button', { name: /^(confirm|delete|yes)$/i }).click().catch(() => undefined);
    }
  });
});
