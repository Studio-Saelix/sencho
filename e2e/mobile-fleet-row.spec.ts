/**
 * Phone Fleet card row layout.
 *
 * A node name as wide as the card used to push the status dot onto a line of
 * its own above the name, because the dot and the name were siblings of the
 * wrapping row. The dot and the name are now one non-wrapping unit: a long
 * name ellipsizes beside its dot and only the qualifier block (exception
 * words, chips, connection pin) wraps below. jsdom cannot measure layout, so
 * this spec asserts the real geometry in Chromium at phone widths.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';
import type { FleetNode } from '../frontend/src/components/FleetView/types';

// 30 characters: the width at which the dot used to wrap at 320px.
const FILLS_320 = 'sencho-prod-eu-west-01-primary';
// 61 characters: wider than the card at every phone width; the name truncates
// with an ellipsis and must still keep the dot beside it.
const WIDER_THAN_CARD = 'sencho-test-01-primary-europe-west-availability-zone-one';
const NORMAL = 'sencho-test-01';

function makeNode(id: number, name: string, overrides: Partial<FleetNode> = {}): FleetNode {
  return {
    id,
    name,
    type: 'remote',
    mode: 'proxy',
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
    ...overrides,
  };
}

async function mockFleet(page: Page, nodes: FleetNode[]): Promise<void> {
  await page.route('**/api/fleet/overview*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(nodes),
    });
  });
  await page.route('**/api/fleet/update-status*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nodes: [] }),
    });
  });
}

interface RowGeometry {
  dotRight: number;
  dotCenterY: number;
  nameTop: number;
  nameBottom: number;
  nameLeft: number;
  nameTruncated: boolean;
  hasHorizontalOverflow: boolean;
}

async function measureRow(page: Page, name: string): Promise<RowGeometry> {
  const nameLocator = page.getByText(name, { exact: true });
  await expect(nameLocator).toBeVisible({ timeout: 15_000 });
  return nameLocator.evaluate((nameEl) => {
    const identity = nameEl.parentElement;
    const dot = identity?.firstElementChild;
    if (!identity || !dot) throw new Error('node identity unit or status dot missing');
    const nameRect = nameEl.getBoundingClientRect();
    const dotRect = dot.getBoundingClientRect();
    return {
      dotRight: dotRect.right,
      dotCenterY: dotRect.top + dotRect.height / 2,
      nameTop: nameRect.top,
      nameBottom: nameRect.bottom,
      nameLeft: nameRect.left,
      nameTruncated: nameEl.scrollWidth > nameEl.clientWidth + 1,
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

async function openFleet(page: Page, width: number, nodes: FleetNode[]): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await mockFleet(page, nodes);
  await loginAs(page);
  await page.goto('/nodes/local/fleet');
}

test.describe('Phone Fleet node row', () => {
  for (const width of [320, 360, 390]) {
    test(`keeps the status dot beside a name wider than the ${width}px row`, async ({ page }) => {
      // Offline plus cordoned also carries the exception words and the Pilot
      // pin, the fullest qualifier block a card can have.
      await openFleet(page, width, [
        makeNode(2, WIDER_THAN_CARD, { mode: 'pilot_agent', status: 'offline', cordoned: true }),
      ]);

      const row = await measureRow(page, WIDER_THAN_CARD);
      expect(row.nameTruncated, 'the long name should ellipsize inside the card').toBe(true);
      // The dot shares the name's line: its centre sits inside the name's box
      // and it stays to the left of the name. A wrapped dot sits above the box.
      expect(row.dotCenterY).toBeGreaterThanOrEqual(row.nameTop);
      expect(row.dotCenterY).toBeLessThanOrEqual(row.nameBottom);
      expect(row.dotRight).toBeLessThanOrEqual(row.nameLeft + 1);
      expect(row.hasHorizontalOverflow).toBe(false);
    });
  }

  test('keeps the status dot beside a 30-character name at 320px', async ({ page }) => {
    await openFleet(page, 320, [makeNode(2, FILLS_320)]);

    const row = await measureRow(page, FILLS_320);
    expect(row.dotCenterY).toBeGreaterThanOrEqual(row.nameTop);
    expect(row.dotCenterY).toBeLessThanOrEqual(row.nameBottom);
    expect(row.dotRight).toBeLessThanOrEqual(row.nameLeft + 1);
    expect(row.hasHorizontalOverflow).toBe(false);
  });

  test('leaves a normal phone row whole and beside its dot', async ({ page }) => {
    await openFleet(page, 320, [makeNode(2, NORMAL)]);

    const row = await measureRow(page, NORMAL);
    expect(row.nameTruncated).toBe(false);
    expect(row.dotCenterY).toBeGreaterThanOrEqual(row.nameTop);
    expect(row.dotCenterY).toBeLessThanOrEqual(row.nameBottom);
    expect(row.dotRight).toBeLessThanOrEqual(row.nameLeft + 1);
    expect(row.hasHorizontalOverflow).toBe(false);
  });
});
