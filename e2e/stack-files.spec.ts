/**
 * File explorer E2E tests.
 *
 * The file explorer is available on every Sencho tier; writes are gated on
 * `stack:edit` permission (admin role), not on the license tier. Two scenarios
 * are covered:
 *
 * 1. Community admin (full read+write under a mocked community license): the
 *    license endpoint is intercepted to force `tier: 'community'` on the
 *    frontend, then the suite asserts that an admin still sees the Upload
 *    affordance and the editor opens in write mode. This guards against
 *    regressing to a tier-based gate.
 *
 * 2. Admin full CRUD (real license state): upload, edit-and-save, delete, and
 *    download are exercised end-to-end. Runs on every tier because writes are
 *    role-based, not tier-based.
 *
 * Fixture files (config/app.conf and assets/logo.png) are seeded once via
 * direct filesystem writes in a beforeAll hook. The entire test stack is torn
 * down in afterAll.
 */
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

// Matches the COMPOSE_DIR passed to the backend in CI (start-app default) and
// in local dev. The test runner and the backend share the same host so both
// see the same path.
const COMPOSE_DIR = process.env.COMPOSE_DIR ?? '/tmp/compose';

const TEST_STACK = 'e2e-files-test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dismiss any "requires a paid license" or upgrade gate overlays that may
 * appear when operating in community mode. These are informational overlays
 * rendered by CapabilityGate for features like Auto-Heal Policies.
 */
async function dismissUpgradeOverlays(page: Page): Promise<void> {
  const dismissBtn = page.getByRole('button', { name: /dismiss/i });
  if (await dismissBtn.isVisible().catch(() => false)) {
    await dismissBtn.click();
    await page.waitForTimeout(200);
  }
}

/**
 * Click the test stack in the sidebar, then click the "files" button in the
 * anatomy panel header to enter the Files tab. Writes inside the panel are
 * gated on `canEdit` (the `stack:edit` RBAC permission); the panel itself
 * always renders for any authenticated session.
 */
async function openFilesTab(page: Page): Promise<void> {
  await waitForStacksLoaded(page);

  // Ensure the stack appears in the sidebar (reload if necessary after seeding)
  const stackInSidebar = page.getByText(TEST_STACK, { exact: true }).first();
  if (!await stackInSidebar.isVisible().catch(() => false)) {
    await page.reload();
    await loginAs(page);
    await waitForStacksLoaded(page);
  }

  // Click the stack in the sidebar
  await page.getByText(TEST_STACK, { exact: true }).first().click();

  // Dismiss any upgrade/capability-gate overlays that block navigation
  await dismissUpgradeOverlays(page);

  // The anatomy panel header has a stable testid on the "files" button.
  const filesBtn = page.getByTestId('anatomy-files-btn');
  await expect(filesBtn).toBeVisible({ timeout: 8_000 });
  await filesBtn.click();

  // Wait for the file tree to populate: span.font-mono appears once the
  // tree data has loaded for both paid and community tiers.
  await expect(page.locator('span.font-mono').first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Seed the test stack with fixture files.
 *
 * Stack creation uses the API (community-allowed) so the backend registry
 * stays in sync. Fixture files are written directly via Node fs so seeding
 * works on any tier without hitting the paid upload/mkdir endpoints.
 */
async function seedTestStack(page: Page): Promise<void> {
  // Create the stack via API (community-OK; ignore 409 if already exists).
  await page.evaluate(async (name: string) => {
    const res = await fetch('/api/stacks', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stackName: name }),
    });
    if (!res.ok && res.status !== 409) throw new Error(`stack create: ${res.status}`);
  }, TEST_STACK);

  // Write fixture files directly on the host filesystem.
  const stackDir = nodePath.join(COMPOSE_DIR, TEST_STACK);
  await fs.mkdir(nodePath.join(stackDir, 'config'), { recursive: true });
  await fs.mkdir(nodePath.join(stackDir, 'assets'), { recursive: true });
  await fs.writeFile(nodePath.join(stackDir, 'config', 'app.conf'), 'key=value\n');
  const pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
  await fs.writeFile(nodePath.join(stackDir, 'assets', 'logo.png'), Buffer.from(pngB64, 'base64'));
}

/** Delete the test stack via the authenticated browser session. */
async function teardownTestStack(page: Page): Promise<void> {
  await page.evaluate(async (name: string) => {
    await fetch(`/api/stacks/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => {});
  }, TEST_STACK);
}

/**
 * Open a new page, login, seed the test stack, then close the page.
 * Used as a beforeAll body so each describe suite shares one seed call.
 */
async function seedSuite(browser: import('@playwright/test').Browser): Promise<void> {
  const page = await browser.newPage();
  try {
    await loginAs(page);
    await seedTestStack(page);
  } finally {
    await page.close();
  }
}

/**
 * Open a new page, login, tear down the test stack, then close the page.
 * Logs a warning on failure so a teardown error never masks test failures.
 */
async function teardownSuite(browser: import('@playwright/test').Browser, label: string): Promise<void> {
  const page = await browser.newPage();
  try {
    await loginAs(page);
    await teardownTestStack(page);
  } catch (e) {
    console.warn(`teardown failed (${label}):`, e);
  } finally {
    await page.close();
  }
}

const COMMUNITY_LICENSE_BODY = JSON.stringify({
  tier: 'community',
  status: 'community',
  variant: null,
  customerName: null,
  productName: null,
  maskedKey: null,
  validUntil: null,
  trialDaysRemaining: null,
  instanceId: 'test-instance',
  portalUrl: null,
  isLifetime: false,
});

/** Stub the /api/license endpoint so the frontend treats the session as community tier. */
async function mockCommunityLicense(context: BrowserContext): Promise<void> {
  await context.route('/api/license', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: COMMUNITY_LICENSE_BODY });
  });
}

// ---------------------------------------------------------------------------
// Community admin (full read+write under a mocked community license)
// ---------------------------------------------------------------------------

test.describe('File explorer - community admin (full read+write)', () => {
  // Increase timeout: seeding + navigation add overhead
  test.setTimeout(60_000);

  test.beforeAll(async ({ browser }) => { await seedSuite(browser); });
  test.afterAll(async ({ browser }) => { await teardownSuite(browser, 'community'); });

  test.beforeEach(async ({ page, context }) => {
    // Login without the license stub first so cookies are established.
    await loginAs(page);

    // Install the community-tier stub and reload so the frontend picks it up.
    await mockCommunityLicense(context);
    await page.reload();
    await loginAs(page);

    await openFilesTab(page);
  });

  test.afterEach(async ({ context }) => {
    // Remove the stub so subsequent requests use the real license state.
    await context.unroute('/api/license');
  });

  test('upload control is visible for a community admin', async ({ page }) => {
    await expect(page.getByLabel('Upload file').first()).toBeVisible({ timeout: 5_000 });
  });

  test('opening config/app.conf as a community admin shows Save (write mode)', async ({ page }) => {
    // The config/ directory should be visible in the tree
    const configNode = page.locator('span.font-mono').filter({ hasText: /^config$/ }).first();
    await expect(configNode).toBeVisible({ timeout: 8_000 });

    // Click to expand the directory
    await configNode.click();

    // app.conf should now appear under config/
    const appConfNode = page.locator('span.font-mono').filter({ hasText: /^app\.conf$/ }).first();
    await expect(appConfNode).toBeVisible({ timeout: 8_000 });
    await appConfNode.click();

    // Editor opens in write mode for any admin (stack:edit); the `Read-only`
    // chip is reserved for viewer accounts and must not appear here.
    await expect(page.getByRole('button', { name: /^save$/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Read-only')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Admin full CRUD (real license state, runs on every tier)
// ---------------------------------------------------------------------------

test.describe('File explorer - admin (full CRUD)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async ({ browser }) => { await seedSuite(browser); });
  test.afterAll(async ({ browser }) => { await teardownSuite(browser, 'admin'); });

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await openFilesTab(page);
  });

  test('upload a text file and verify it appears in the tree', async ({ page }) => {
    // Admins with stack:edit see the upload dropzone on every tier. The
    // dropzone label includes "upload" (e.g. "Upload or drop file"); match
    // on the word alone so future copy edits don't break this assertion.
    await expect(
      page.locator('[role="button"]').filter({ hasText: /upload/i }).first()
    ).toBeVisible({ timeout: 5_000 });

    // Set a file on the hidden input
    const input = page.locator('input[type="file"][aria-label="Upload file"]');
    await input.setInputFiles({
      name: 'e2e-upload-test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello e2e\n'),
    });

    // Success toast
    await expect(page.getByText(/uploaded/i).first()).toBeVisible({ timeout: 10_000 });

    // File appears in the tree at root level
    await expect(
      page.locator('span.font-mono').filter({ hasText: /^e2e-upload-test\.txt$/ }).first()
    ).toBeVisible({ timeout: 8_000 });
  });

  test('edit config/app.conf and save - success toast appears', async ({ page }) => {
    // Expand config/ and open app.conf
    const configNode = page.locator('span.font-mono').filter({ hasText: /^config$/ }).first();
    await expect(configNode).toBeVisible({ timeout: 8_000 });
    await configNode.click();

    const appConfNode = page.locator('span.font-mono').filter({ hasText: /^app\.conf$/ }).first();
    await expect(appConfNode).toBeVisible({ timeout: 8_000 });
    await appConfNode.click();

    // Wait for Monaco to load
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    // Save button must be present and initially disabled (no changes yet)
    const saveBtn = page.getByRole('button', { name: /^save$/i });
    await expect(saveBtn).toBeVisible({ timeout: 8_000 });
    await expect(saveBtn).toBeDisabled();

    // Edit the file content via Monaco
    const editorTextarea = page.locator('.monaco-editor textarea').first();
    await editorTextarea.click({ force: true });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('key=value\ne2e-edited=true\n');

    // Save button should now be enabled
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();

    // Success toast
    await expect(page.getByText(/saved/i).first()).toBeVisible({ timeout: 8_000 });
  });

  test('delete an uploaded file - it disappears from the tree', async ({ page }) => {
    // Upload a disposable file first
    const input = page.locator('input[type="file"][aria-label="Upload file"]');
    await input.setInputFiles({
      name: 'e2e-to-delete.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('delete me\n'),
    });
    await expect(page.getByText(/uploaded/i).first()).toBeVisible({ timeout: 10_000 });

    // Click the file to select it
    const fileNode = page.locator('span.font-mono').filter({ hasText: /^e2e-to-delete\.txt$/ }).first();
    await expect(fileNode).toBeVisible({ timeout: 8_000 });
    await fileNode.click();

    // The action bar Delete button has a stable data-testid for reliable targeting.
    const actionBarDeleteBtn = page.getByTestId('file-action-delete');
    await expect(actionBarDeleteBtn).toBeVisible({ timeout: 5_000 });
    await actionBarDeleteBtn.click();

    // Wait for the DeleteFileConfirm dialog to open, then confirm deletion.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 8_000 });
    await page.getByTestId('delete-confirm-btn').click();

    // Use the tree-specific class (text-sm) to avoid a strict-mode violation:
    // the FileViewer header renders the same filename in a different span until
    // handleDeleted() clears selectedPath.
    await expect(
      page.locator('span.font-mono.text-sm').filter({ hasText: /^e2e-to-delete\.txt$/ })
    ).not.toBeAttached({ timeout: 8_000 });
  });

  test('download assets/logo.png - response is 200 with attachment header', async ({ page, request }) => {
    // Replay the browser's session cookies in a raw request to the download endpoint.
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const res = await request.get(
      `/api/stacks/${encodeURIComponent(TEST_STACK)}/files/download` +
        `?path=${encodeURIComponent('assets/logo.png')}`,
      { headers: { cookie: cookieHeader } },
    );

    expect(res.status()).toBe(200);
    const disposition = res.headers()['content-disposition'] ?? '';
    expect(disposition).toMatch(/attachment/i);
  });
});
