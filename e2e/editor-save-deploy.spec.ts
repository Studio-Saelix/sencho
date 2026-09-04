/**
 * EditorView save-and-deploy: a failed PUT must abort the deploy. Verified by
 * intercepting the PUT with a forced 500 and asserting that no POST to /deploy
 * is observed, plus a "Failed to save file" toast surfaces.
 *
 * Empty-stack create opens an editable compose workspace immediately
 * (startInComposeEdit), so this spec waits for Save & Deploy rather than
 * clicking Anatomy "Edit compose".
 */
import { test, expect } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const TEST_STACK = 'e2e-save-deploy-stack';
const REMOTE_NODE_NAME = 'e2e-editor-pin-node';

// The two-tab test needs a second node so the NodeSwitcher offers a switch.
// Seeded via the API (like deleteTestNodes in pilot-agent-enrollment.spec.ts)
// because a fresh install has only the local node, and the switcher hides its
// trigger entirely with a single node. Pilot-agent mode is used because
// proxy-mode node creation SSRF-validates api_url and loopback/TEST-NET
// targets are rejected even with the e2e loopback flag set. A pilot-agent node
// is a remote row with no api_url, which is all the switcher needs.
async function seedRemoteNode(page: import('@playwright/test').Page): Promise<number> {
  const res = await page.request.post('/api/nodes', {
    data: { name: REMOTE_NODE_NAME, type: 'remote', mode: 'pilot_agent' },
  });
  if (!res.ok()) {
    throw new Error(`Could not seed the remote node for the two-tab editor test (${res.status()})`);
  }
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function deleteSeededNode(page: import('@playwright/test').Page): Promise<void> {
  const list = await page.request.get('/api/nodes');
  if (!list.ok()) return;
  const nodes = (await list.json()) as Array<{ id: number; name: string }>;
  for (const n of nodes) {
    if (n.name === REMOTE_NODE_NAME) {
      await page.request.delete(`/api/nodes/${n.id}`).catch(() => undefined);
    }
  }
}

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
  // Empty create auto-opens compose edit; wait for that before asserting.
  await expect(page.getByRole('button', { name: 'Save & Deploy', exact: true })).toBeVisible({ timeout: 10_000 });
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

  // #1854 regression: two tabs of the same Sencho instance share
  // localStorage['sencho-active-node'] with no storage-event listener. When tab
  // 2 switches nodes, tab 1's unpinned editor requests silently retarget to tab
  // 2's node and Save & Deploy fails with a confusing error (refreshing tab 1
  // "fixed" it). The editor chain must pin every request to the node its tab
  // captured, so the PUT still carries tab 1's node id and succeeds.
  test('save succeeds in tab 1 after tab 2 switched the shared active node', async ({ page, context }) => {
    // Tab 1's identity is the local node; capture whatever x-node-id it sends
    // so the assertion does not hardcode the dev DB's id sequence.
    let tab1NodeId: string | null = null;
    await page.route(`**/api/stacks/${TEST_STACK}`, async (route, req) => {
      if (req.method() === 'PUT' && tab1NodeId === null) {
        tab1NodeId = await req.headerValue('x-node-id');
      }
      await route.continue();
    });
    // Count the deploy POST directly: visible "deploy" text also matches the
    // toolbar button, so it cannot prove the deploy was attempted.
    let deployAttempts = 0;
    await page.route(`**/api/stacks/${TEST_STACK}/deploy*`, async (route, req) => {
      if (req.method() === 'POST') deployAttempts += 1;
      await route.continue();
    });

    // Tab 2, same browser context (shared cookies AND localStorage): switch to
    // a remote node through the normal UI. This rewrites sencho-active-node
    // behind tab 1's back, exactly the user-reported sequence.
    const tab2 = await context.newPage();
    try {
      await seedRemoteNode(page);
      await tab2.goto('/');
      await loginAs(tab2);
      await waitForStacksLoaded(tab2);
      await tab2.reload();
      await loginAs(tab2);
      await waitForStacksLoaded(tab2);
      await tab2.getByRole('button', { name: 'Switch node' }).click();
      await tab2.getByRole('button', { name: REMOTE_NODE_NAME }).first().click();
      await expect(tab2.getByRole('button', { name: 'Switch node' })).toContainText(
        new RegExp(REMOTE_NODE_NAME, 'i'),
        { timeout: 10_000 },
      );

      // Capture the shared key after the switch; the inequality against
      // tab1NodeId below is what proves tab 1's PUT ignored it.
      const sharedKey = await page.evaluate(() => localStorage.getItem('sencho-active-node'));
      expect(sharedKey).not.toBeNull();

      // Tab 1 never reloaded; its React state still shows the local node, but
      // pre-fix its save PUT would follow the rewritten localStorage key.
      await page.getByRole('button', { name: 'Save & Deploy', exact: true }).click();

      // The save must succeed against tab 1's own node: success toast, no
      // failure toast, and the deploy POST must actually go out (counted, not
      // inferred from visible text). The deploy fires after the async
      // pre-deploy advisory fetch, so poll the counter instead of asserting
      // synchronously after the save toast.
      await expect(page.getByText('File saved successfully!')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/failed to save file/i)).toHaveCount(0);
      await expect.poll(() => deployAttempts, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

      // The PUT carried tab 1's captured node id, not the key tab 2 rewrote.
      // Both ids are decimal strings from the same DB, so string inequality
      // plus tab 1's success toast is the whole assertion.
      expect(tab1NodeId).not.toBeNull();
      expect(tab1NodeId).not.toBe(sharedKey);
    } finally {
      await deleteSeededNode(page);
      await tab2.close();
    }
  });
});
