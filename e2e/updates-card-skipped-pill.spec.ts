/**
 * Phone Updates card header with a policy skip.
 *
 * The skip pill and its risk badge are one status group in the card header.
 * When the pill kept the full sentence beside the badge, the group measured
 * wider than the card at 390px: it slid over the STACK kicker, clipped the risk
 * badge and gave the list a horizontal scrollbar. jsdom cannot measure layout,
 * so this spec mocks the readiness endpoints and asserts the real geometry in
 * Chromium at phone widths.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';

const STACK = 'qp-skip-layout';

interface ReadinessMocks {
  nodeId: number;
}

async function localNodeId(page: Page): Promise<number> {
  const nodes = await page.evaluate(async () => {
    const res = await fetch('/api/nodes', { credentials: 'include' });
    return (await res.json()) as Array<{ id: number; type: string }>;
  });
  const local = nodes.find(n => n.type === 'local');
  if (!local) throw new Error('no local node in /api/nodes');
  return local.id;
}

async function mockReadiness(page: Page, { nodeId }: ReadinessMocks): Promise<void> {
  const now = Date.now();
  await page.route('**/api/image-updates/fleet**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/fleet/detail')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          [String(nodeId)]: {
            [STACK]: {
              hasUpdate: true,
              checkStatus: 'ok',
              lastError: null,
              checkedAt: now,
              unattendedPolicy: {
                decision: 'skip',
                ineligible: [{ service: 'db', policy: 'manual' }],
              },
            },
          },
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/fleet')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ [String(nodeId)]: { [STACK]: true } }),
      });
      return;
    }
    await route.continue();
  });

  await page.route('**/api/scheduled-tasks**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 1,
        name: 'nightly',
        enabled: true,
        action: 'update',
        target_type: 'stack',
        target_id: STACK,
        node_id: nodeId,
        cron_expression: '0 3 * * *',
        next_run_at: now + 60 * 60_000,
      }]),
    });
  });

  await page.route(`**/api/stacks/${STACK}/update-preview`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stack_name: STACK,
        images: [{
          service: 'db',
          image: 'postgres:16.0-alpine',
          current_tag: '16.0-alpine',
          next_tag: '16.1-alpine',
          has_update: true,
          digest_update: false,
          tag_update: true,
          semver_bump: 'patch',
          check_status: 'ok',
        }],
        summary: {
          has_update: true,
          primary_image: 'postgres:16.0-alpine',
          current_tag: '16.0-alpine',
          next_tag: '16.1-alpine',
          semver_bump: 'patch',
          update_kind: 'tag',
          blocked: false,
          blocked_reason: null,
          rebuild_available: false,
          verification_failed: false,
          verification_error: null,
          check_status: 'ok',
        },
        build_services: [],
        rollback_target: null,
        changelog: 'Security fixes.',
      }),
    });
  });
}

interface HeaderGeometry {
  /** Right edge of the status group, in viewport coordinates. */
  statusRight: number;
  /** Left edge of the status group. */
  statusLeft: number;
  /** Top edge of the status group (below the name when the header wraps). */
  statusTop: number;
  stackRight: number;
  stackBottom: number;
  cardContentRight: number;
  cardContentLeft: number;
  cardScrollWidth: number;
  cardClientWidth: number;
  badgeRight: number;
  badgeVisible: boolean;
}

async function measureHeader(page: Page): Promise<HeaderGeometry> {
  const card = page.getByTestId('mobile-readiness-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card.evaluate((cardEl) => {
    const header = cardEl.querySelector<HTMLElement>('[data-testid="mobile-readiness-header"]');
    const status = cardEl.querySelector<HTMLElement>('[data-testid="mobile-readiness-status"]');
    if (!header || !status) throw new Error('card header or status group missing');
    const stack = header.firstElementChild as HTMLElement;
    const stackName = stack.lastElementChild as HTMLElement;
    const badge = status.lastElementChild as HTMLElement;
    const cardRect = cardEl.getBoundingClientRect();
    const style = getComputedStyle(cardEl);
    const padLeft = parseFloat(style.paddingLeft);
    const padRight = parseFloat(style.paddingRight);
    const statusRect = status.getBoundingClientRect();
    const stackRect = stackName.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    const badgeStyle = getComputedStyle(badge);
    return {
      statusRight: statusRect.right,
      statusLeft: statusRect.left,
      statusTop: statusRect.top,
      stackRight: stackRect.right,
      stackBottom: stackRect.bottom,
      cardContentRight: cardRect.right - padRight,
      cardContentLeft: cardRect.left + padLeft,
      cardScrollWidth: cardEl.scrollWidth,
      cardClientWidth: cardEl.clientWidth,
      badgeRight: badgeRect.right,
      badgeVisible: badgeRect.width > 0
        && badgeRect.height > 0
        && badgeStyle.visibility !== 'hidden'
        && badgeStyle.display !== 'none',
    };
  });
}

test.describe('Phone Updates card header with a policy skip', () => {
  for (const width of [390, 320]) {
    test(`keeps the skip pill and risk badge inside the card at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await loginAs(page);
      const nodeId = await localNodeId(page);
      await mockReadiness(page, { nodeId });
      await page.goto('/nodes/local/updates');

      const card = page.getByTestId('mobile-readiness-card').first();
      await expect(card.getByTestId('auto-pill')).toHaveText(/Auto: skipped/);
      await expect(card.getByText('Skipped by update policy', { exact: true })).toBeVisible();

      const geom = await measureHeader(page);
      // The card itself must not scroll sideways: the header overflowed the
      // card before this fix (scrollWidth 408 against 348).
      expect(geom.cardScrollWidth, 'card horizontally overflows').toBeLessThanOrEqual(geom.cardClientWidth + 1);
      // The status group stays inside the card's content box, so the badge is
      // neither pushed past the edge nor clipped.
      expect(geom.statusLeft).toBeGreaterThanOrEqual(geom.cardContentLeft - 1);
      expect(geom.statusRight).toBeLessThanOrEqual(geom.cardContentRight + 1);
      expect(geom.badgeVisible).toBe(true);
      expect(geom.badgeRight).toBeLessThanOrEqual(geom.cardContentRight + 1);
      // It must not slide over the stack identity: either it wraps below the
      // name, or it starts to the right of it.
      const below = geom.statusTop >= geom.stackBottom - 1;
      const beside = geom.statusLeft >= geom.stackRight - 1;
      expect(below || beside, 'status group overlaps the stack name').toBe(true);
    });
  }
});
