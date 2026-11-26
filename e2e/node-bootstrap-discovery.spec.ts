/**
 * Experimental discovery gates for node bootstrap.
 *
 * Bootstrap is only discoverable while the gateway reports the experimental
 * flag. Both desktop entry points, the Fleet node-management menu and the
 * Settings Nodes button, must stay hidden while /meta is pending and while the
 * flag is off, then become usable for an Admin once discovery resolves on.
 * Non-admins never see either entry, and the rest of node management stays
 * available in every state.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, holdExperimentalFlag, mockExperimentalFlag } from './helpers';
import { adminApiContext, deleteE2EUser, ensureE2EUser } from './preferences-helpers';
import type { FleetNode } from '../frontend/src/components/FleetView/types';

const VIEWER_USER = 'bootstrap-gate-viewer';
const VIEWER_PASSWORD = 'bootstrap-gate-password-123';

const NODE: FleetNode = {
  id: 1,
  name: 'sencho-test-01',
  type: 'remote',
  mode: 'pilot_agent',
  status: 'online',
  stats: { active: 1, managed: 1, unmanaged: 0, exited: 0, total: 1 },
  systemStats: {
    cpu: { usage: '10.0', cores: 4 },
    memory: { total: 100, used: 20, free: 80, usagePercent: '20.0' },
    disk: { total: 100, used: 10, free: 90, usagePercent: '10.0' },
  },
  stacks: ['web'],
  cordoned: false,
  cordoned_at: null,
  cordoned_reason: null,
};

async function mockFleet(page: Page): Promise<void> {
  await page.route('**/api/fleet/overview*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([NODE]) });
  });
  await page.route('**/api/fleet/update-status*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nodes: [] }) });
  });
}

async function openFleetMenu(page: Page) {
  const trigger = page.getByRole('button', { name: 'Node management' });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
}

async function expectBootstrapButtonAbsent(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Bootstrap new Linux server' })).toHaveCount(0);
}

async function expectSettingsReady(page: Page): Promise<void> {
  await page.goto('/nodes/local/settings/nodes');
  await expect(page.getByRole('button', { name: 'Add node' })).toBeVisible({ timeout: 15_000 });
}

test.describe('Node bootstrap discovery gates', () => {
  test('keeps the Fleet entry hidden while discovery is pending, then opens the wizard', async ({ page }) => {
    const gate = await holdExperimentalFlag(page);
    await loginAs(page);
    await mockFleet(page);
    await page.goto('/nodes/local/fleet');

    await openFleetMenu(page);
    await gate.requested;
    await expect(page.getByRole('menuitem', { name: /Connect existing node/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Node updates/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Bootstrap new Linux server/ })).toHaveCount(0);

    await gate.release(true);
    const bootstrap = page.getByRole('menuitem', { name: /Bootstrap new Linux server/ });
    await expect(bootstrap).toBeVisible();
    await bootstrap.click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Bootstrap a new Linux server')).toBeVisible();
    await expect(page.getByLabel('Compose stacks directory')).toHaveValue('/opt/docker/sencho');
  });

  test('keeps the Settings entry hidden while discovery is pending, then opens the wizard', async ({ page }) => {
    const gate = await holdExperimentalFlag(page);
    await loginAs(page);
    await expectSettingsReady(page);

    await gate.requested;
    await expectBootstrapButtonAbsent(page);
    await expect(page.getByRole('button', { name: 'Add node' })).toBeVisible();
    await expect(page.getByText('Generate Node Token')).toBeVisible();

    await gate.release(true);
    const bootstrap = page.getByRole('button', { name: 'Bootstrap new Linux server' });
    await expect(bootstrap).toBeVisible();
    await bootstrap.click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Bootstrap a new Linux server')).toBeVisible();
    await expect(page.getByLabel('Compose stacks directory')).toHaveValue('/opt/docker/sencho');
  });

  test('hides the Settings entry when the flag is off and keeps Add node available', async ({ page }) => {
    await mockExperimentalFlag(page, false);
    await loginAs(page);
    await expectSettingsReady(page);

    await expectBootstrapButtonAbsent(page);
    await expect(page.getByRole('button', { name: 'Add node' })).toBeVisible();
  });

  test.describe('non-admin session', () => {
    let viewerId = 0;

    test.beforeAll(async () => {
      // Account seeding goes through Node-side request contexts, which can be
      // slower than the browser path on a host where localhost resolves to
      // IPv6 first; the work is two short API calls, not a hung request.
      test.setTimeout(120_000);
      const admin = await adminApiContext();
      try {
        viewerId = await ensureE2EUser(admin, VIEWER_USER, VIEWER_PASSWORD, 'viewer');
      } finally {
        await admin.dispose();
      }
    });

    test.afterAll(async () => {
      test.setTimeout(120_000);
      if (!viewerId) return;
      const admin = await adminApiContext();
      try {
        await deleteE2EUser(admin, viewerId);
      } finally {
        await admin.dispose();
      }
    });

    test('never shows Bootstrap on either entry point, even with the flag on', async ({ page }) => {
      await mockExperimentalFlag(page, true);
      await loginAs(page, VIEWER_USER, VIEWER_PASSWORD, { viewerSafe: true });

      await mockFleet(page);
      await page.goto('/nodes/local/fleet');
      await openFleetMenu(page);
      await expect(page.getByRole('menuitem', { name: /Node updates/ })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /Bootstrap new Linux server/ })).toHaveCount(0);

      await page.goto('/nodes/local/settings/nodes');
      // The viewer keeps read access to the node table, but loses every write affordance.
      await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('columnheader', { name: 'Actions' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add node' })).toHaveCount(0);
      await expectBootstrapButtonAbsent(page);
    });
  });
});
