/**
 * Fleet node management menu.
 *
 * The Overview toolbar used to end with two separate controls: a Node Update
 * button and an icon-only Manage nodes button. This spec proves the single
 * sectioned menu replaced them and that each item reaches its existing surface.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';
import type { FleetNode } from '../frontend/src/components/FleetView/types';

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

test.describe('Fleet node management', () => {
  test('replaces the standalone toolbar controls with one sectioned menu', async ({ page }) => {
    await loginAs(page);
    await mockFleet(page);
    await page.goto('/nodes/local/fleet');

    const trigger = page.getByRole('button', { name: 'Node management' });
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Manage nodes' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Check for node updates/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Node Update/ })).toHaveCount(0);

    await trigger.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByText('Onboarding')).toBeVisible();
    await expect(page.getByText('Maintenance')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Connect existing node/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Bootstrap new Linux server/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Node updates/ })).toBeVisible();
  });

  test('Connect opens the Add node modal without leaving Fleet', async ({ page }) => {
    await loginAs(page);
    await mockFleet(page);
    await page.goto('/nodes/local/fleet');

    await page.getByRole('button', { name: 'Node management' }).click();
    await page.getByRole('menuitem', { name: /Connect existing node/ }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Add remote node' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/nodes/local/fleet');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Bootstrap opens the wizard and Escape returns focus to the trigger', async ({ page }) => {
    await loginAs(page);
    await mockFleet(page);
    await page.goto('/nodes/local/fleet');

    const trigger = page.getByRole('button', { name: 'Node management' });
    await trigger.click();
    await page.getByRole('menuitem', { name: /Bootstrap new Linux server/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByText('Bootstrap a new Linux server')).toBeVisible();
    await expect(page.getByLabel('Compose stacks directory')).toHaveValue('/opt/docker/sencho');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
