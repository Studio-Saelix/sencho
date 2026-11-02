/**
 * Updates card header with a policy skip.
 *
 * The skip pill and its risk badge are one status group in the card header.
 * The group must never take priority over the stack identity: when the group
 * kept a zero flex basis beside it, the name collapsed to 0px on the desktop
 * Cards view at 1024-1536px, and on a 360px phone the name column shrank to
 * 23px so the STACK kicker ran under the pill. jsdom cannot measure layout, so
 * this spec mocks the readiness endpoints and asserts the real geometry in
 * Chromium, on both card headers (phone and desktop).
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
          tag_update: false,
          semver_bump: 'patch',
          check_status: 'ok',
        }],
        summary: {
          has_update: true,
          primary_image: 'postgres:16.0-alpine',
          current_tag: '16.0-alpine',
          next_tag: '16.1-alpine',
          semver_bump: 'patch',
          update_kind: 'rebuild',
          blocked: false,
          blocked_reason: null,
          rebuild_available: true,
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

/** The header parts of one card flavour (phone or desktop). */
interface CardSelectors {
  card: string;
  header: string;
  identity: string;
  stack: string;
  status: string;
}

const MOBILE: CardSelectors = {
  card: 'mobile-readiness-card',
  header: 'mobile-readiness-header',
  identity: 'mobile-readiness-identity',
  stack: 'mobile-readiness-stack',
  status: 'mobile-readiness-status',
};

const DESKTOP: CardSelectors = {
  card: 'readiness-card',
  header: 'readiness-card-header',
  identity: 'readiness-card-identity',
  stack: 'readiness-card-stack',
  status: 'readiness-card-status',
};

interface HeaderGeometry {
  statusRight: number;
  statusLeft: number;
  statusTop: number;
  identityRight: number;
  identityBottom: number;
  /** Width of the element that renders the stack name. */
  stackWidth: number;
  stackHeight: number;
  /** Right edge of the STACK kicker text (not its column). */
  kickerRight: number;
  kickerBottom: number;
  nameRight: number;
  cardContentRight: number;
  cardContentLeft: number;
  cardScrollWidth: number;
  cardClientWidth: number;
  badgeRight: number;
  badgeVisible: boolean;
  /** True when the pill's label is wider than the space it was given. */
  pillLabelClipped: boolean;
}

async function measureHeader(page: Page, ids: CardSelectors): Promise<HeaderGeometry> {
  const card = page.getByTestId(ids.card).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card.evaluate((cardEl, sel) => {
    const header = cardEl.querySelector<HTMLElement>(`[data-testid="${sel.header}"]`);
    const identity = cardEl.querySelector<HTMLElement>(`[data-testid="${sel.identity}"]`);
    const stackName = cardEl.querySelector<HTMLElement>(`[data-testid="${sel.stack}"]`);
    const status = cardEl.querySelector<HTMLElement>(`[data-testid="${sel.status}"]`);
    if (!header || !identity || !stackName || !status) {
      throw new Error('card header, identity, name or status group missing');
    }
    // The kicker is the first span of the identity column; its inline box is
    // the text, so a column narrower than the word shows up here.
    const kicker = identity.firstElementChild ?? identity;
    const badge = status.lastElementChild as HTMLElement;
    const pillLabel = cardEl.querySelector<HTMLElement>('[data-testid="auto-pill"] span');
    const cardRect = cardEl.getBoundingClientRect();
    const style = getComputedStyle(cardEl);
    const padLeft = parseFloat(style.paddingLeft);
    const padRight = parseFloat(style.paddingRight);
    const statusRect = status.getBoundingClientRect();
    const identityRect = identity.getBoundingClientRect();
    const stackRect = stackName.getBoundingClientRect();
    const kickerRect = kicker.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    const badgeStyle = getComputedStyle(badge);
    return {
      statusRight: statusRect.right,
      statusLeft: statusRect.left,
      statusTop: statusRect.top,
      identityRight: identityRect.right,
      identityBottom: identityRect.bottom,
      stackWidth: stackRect.width,
      stackHeight: stackRect.height,
      kickerRight: kickerRect.right,
      kickerBottom: kickerRect.bottom,
      nameRight: stackRect.right,
      cardContentRight: cardRect.right - padRight,
      cardContentLeft: cardRect.left + padLeft,
      cardScrollWidth: cardEl.scrollWidth,
      cardClientWidth: cardEl.clientWidth,
      badgeRight: badgeRect.right,
      badgeVisible: badgeRect.width > 0
        && badgeRect.height > 0
        && badgeStyle.visibility !== 'hidden'
        && badgeStyle.display !== 'none',
      pillLabelClipped: Boolean(pillLabel)
        && pillLabel!.scrollWidth > pillLabel!.clientWidth + 1,
    };
  }, ids);
}

function expectIdentityLegible(geom: HeaderGeometry): void {
  // The card itself must not scroll sideways.
  expect(geom.cardScrollWidth, 'card horizontally overflows').toBeLessThanOrEqual(geom.cardClientWidth + 1);
  // The status group stays inside the card's content box, so the badge is
  // neither pushed past the edge nor clipped.
  expect(geom.statusLeft).toBeGreaterThanOrEqual(geom.cardContentLeft - 1);
  expect(geom.statusRight).toBeLessThanOrEqual(geom.cardContentRight + 1);
  expect(geom.badgeVisible).toBe(true);
  expect(geom.badgeRight).toBeLessThanOrEqual(geom.cardContentRight + 1);
  // The status group must not slide over the identity: either it wraps below
  // the name, or it starts to the right of it.
  const below = geom.statusTop >= geom.identityBottom - 1;
  const beside = geom.statusLeft >= geom.identityRight - 1;
  expect(below || beside, 'status group overlaps the stack identity').toBe(true);
  // The STACK kicker text itself must stay clear of the pill. This is the
  // measure that caught the 360px overlap: the name column was 23px wide
  // while the kicker text ran past it.
  const kickerBelow = geom.statusTop >= geom.kickerBottom - 1;
  const kickerBeside = geom.statusLeft >= geom.kickerRight - 1;
  expect(kickerBelow || kickerBeside, 'status group overlaps the STACK kicker').toBe(true);
  // The name keeps a legible width: 0px on desktop and 23px at 360px were
  // both unreadable. 64px fits several characters of the heading face.
  expect(geom.stackWidth, 'stack name collapsed').toBeGreaterThanOrEqual(64);
  expect(geom.stackHeight).toBeGreaterThan(0);
  expect(geom.nameRight).toBeLessThanOrEqual(geom.cardContentRight + 1);
  // The pill must show its whole label: at 1024px the crowded header clipped it
  // to "AUTO: SKIPPED BY UPDATE POLIC...".
  expect(geom.pillLabelClipped, 'skip pill label is clipped').toBe(false);
}

/** Open the Updates view with one skipped stack and return its card. */
async function openSkippedCard(page: Page, ids: CardSelectors, desktop = false) {
  await loginAs(page);
  const nodeId = await localNodeId(page);
  await mockReadiness(page, { nodeId });
  await page.goto('/nodes/local/updates');
  if (desktop) await page.getByRole('radio', { name: 'Cards' }).click();
  const card = page.getByTestId(ids.card).first();
  await expect(card.getByTestId('auto-pill')).toHaveText(/Auto: skipped/);
  await expect(card.getByText('Skipped by update policy', { exact: true })).toBeVisible();
  return card;
}

test.describe('Phone Updates card header with a policy skip', () => {
  for (const width of [390, 360, 320]) {
    test(`keeps the skip pill and risk badge inside the card at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await openSkippedCard(page, MOBILE);

      expectIdentityLegible(await measureHeader(page, MOBILE));
    });
  }
});

test.describe('Desktop Updates Cards view with a policy skip', () => {
  // The name collapsed to 0px across the whole desktop Cards range, so test
  // both grid breakpoints (lg two columns, 2xl three columns) and the widest.
  for (const width of [1536, 1280, 1024]) {
    test(`keeps the stack name beside the skip pill and risk badge at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openSkippedCard(page, DESKTOP, true);

      expectIdentityLegible(await measureHeader(page, DESKTOP));
    });
  }
});
