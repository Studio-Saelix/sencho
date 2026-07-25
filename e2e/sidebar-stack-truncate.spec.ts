/**
 * Sidebar stack-row truncation E2E tests.
 *
 * Verifies long stack names ellipsize instead of pushing trailing indicators
 * (update dot, check-failed icon, git-pending icon) past the sidebar edge.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const LONG_STACK = 'e2e-tick-grafana-docker-observability-monitoring';
const SHORT_STACK = 'e2e-z';
const UPDATE_STACK = 'e2e-long-stack-update-dot-indicator';
const FAILED_STACK = 'e2e-long-stack-check-failed-indicator';
const GIT_STACK = 'e2e-long-stack-git-pending-indicator';

const TEST_STACKS = [LONG_STACK, SHORT_STACK, UPDATE_STACK, FAILED_STACK, GIT_STACK];

interface RowLayoutMetrics {
  stackName: string;
  sidebarRight: number;
  rowRight: number;
  rowWithinSidebar: boolean;
  nameTruncated: boolean;
  nameOverflowHidden: boolean;
  rowHasMinWidthZero: boolean;
  trailingRight: number | null;
  trailingWithinSidebar: boolean;
  trailingKind: 'update' | 'failed' | 'git' | 'none';
}

async function createStack(page: Page, stackName: string): Promise<void> {
  const res = await page.evaluate(async (name) => {
    const response = await fetch('/api/stacks', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stackName: name }),
    });
    return { ok: response.ok, status: response.status };
  }, stackName);
  expect(res.ok || res.status === 409, `create ${stackName} failed: ${res.status}`).toBeTruthy();
}

async function deleteStack(page: Page, stackName: string): Promise<void> {
  await page.evaluate(async (name) => {
    await fetch(`/api/stacks/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => undefined);
  }, stackName);
}

async function deleteAllTestStacks(page: Page): Promise<void> {
  for (const name of TEST_STACKS) {
    await deleteStack(page, name);
  }
}

async function ensureTestStacks(page: Page): Promise<void> {
  await deleteAllTestStacks(page);
  for (const name of TEST_STACKS) {
    await createStack(page, name);
  }
  await page.reload();
  await waitForStacksLoaded(page);
}

function sidebarLocator(page: Page) {
  return page.locator('.w-64.border-r').first();
}

async function measureRow(page: Page, stackName: string): Promise<RowLayoutMetrics> {
  const row = page.locator('[data-testid="stack-row"]').filter({ hasText: stackName });
  await expect(row).toBeVisible({ timeout: 10_000 });

  return row.evaluate((rowEl) => {
    const sidebar = document.querySelector('.bg-sidebar.border-r, .w-64.border-r, .bg-sidebar');
    const sidebarRect = sidebar?.getBoundingClientRect();
    if (!sidebarRect) {
      throw new Error('Could not locate sidebar container');
    }

    const nameEl = rowEl.querySelector('.truncate') as HTMLElement | null;
    const updateDot = rowEl.querySelector('[data-testid="stack-trailing-update"]');
    const failedIcon = rowEl.querySelector('[data-testid="stack-trailing-check-failed"]');
    const gitIcon = rowEl.querySelector('[data-testid="stack-trailing-git-pending"]');
    const trailing = updateDot ?? failedIcon ?? gitIcon;

    let trailingKind: RowLayoutMetrics['trailingKind'] = 'none';
    if (updateDot) trailingKind = 'update';
    else if (failedIcon) trailingKind = 'failed';
    else if (gitIcon) trailingKind = 'git';

    const rowRect = rowEl.getBoundingClientRect();
    const trailingRect = trailing?.getBoundingClientRect() ?? null;

    return {
      stackName: nameEl?.textContent ?? '',
      sidebarRight: sidebarRect.right,
      rowRight: rowRect.right,
      rowWithinSidebar: rowRect.right <= sidebarRect.right + 0.5,
      nameTruncated: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : false,
      nameOverflowHidden: nameEl ? getComputedStyle(nameEl).overflow === 'hidden' : false,
      rowHasMinWidthZero: rowEl.classList.contains('min-w-0'),
      trailingRight: trailingRect?.right ?? null,
      trailingWithinSidebar: trailingRect ? trailingRect.right <= sidebarRect.right + 0.5 : true,
      trailingKind,
    };
  });
}

async function assertRowLayout(
  page: Page,
  stackName: string,
  opts: { expectTruncated: boolean; trailingKind?: RowLayoutMetrics['trailingKind'] },
): Promise<RowLayoutMetrics> {
  const metrics = await measureRow(page, stackName);
  expect(metrics.rowWithinSidebar, `${stackName} row clips past sidebar`).toBe(true);
  expect(metrics.nameOverflowHidden, `${stackName} name missing overflow hidden`).toBe(true);
  expect(metrics.rowHasMinWidthZero, `${stackName} row missing min-w-0`).toBe(true);
  expect(metrics.nameTruncated, `${stackName} truncation state`).toBe(opts.expectTruncated);
  if (opts.trailingKind) {
    expect(metrics.trailingKind, `${stackName} trailing indicator`).toBe(opts.trailingKind);
    expect(metrics.trailingWithinSidebar, `${stackName} trailing indicator clips`).toBe(true);
  }
  return metrics;
}

test.describe('Sidebar stack name truncation', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await waitForStacksLoaded(page);
    await ensureTestStacks(page);
  });

  test.afterEach(async ({ page }) => {
    await deleteAllTestStacks(page);
  });

  test('long stack names truncate and stay within the sidebar', async ({ page }) => {
    await assertRowLayout(page, LONG_STACK, { expectTruncated: true });
  });

  test('short stack names do not truncate unnecessarily', async ({ page }) => {
    await assertRowLayout(page, SHORT_STACK, { expectTruncated: false });
  });

  test('update dot stays visible on a long stack name', async ({ page }) => {
    await page.route('**/api/image-updates/detail', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          [UPDATE_STACK]: {
            hasUpdate: true,
            checkStatus: 'ok',
            lastError: null,
            checkedAt: Date.now(),
          },
        }),
      });
    });

    const detailResponse = page.waitForResponse(
      (res) => res.url().includes('/api/image-updates/detail') && res.ok(),
    );
    await page.reload();
    await waitForStacksLoaded(page);
    await detailResponse;
    await expect(
      page.locator('[data-testid="stack-row"]').filter({ hasText: UPDATE_STACK }).locator('[data-testid="stack-trailing-update"]'),
    ).toBeVisible({ timeout: 10_000 });

    await assertRowLayout(page, UPDATE_STACK, {
      expectTruncated: true,
      trailingKind: 'update',
    });
  });

  test('check-failed icon stays visible on a long stack name', async ({ page }) => {
    await page.route('**/api/image-updates/detail', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          [FAILED_STACK]: {
            hasUpdate: false,
            checkStatus: 'failed',
            lastError: 'Registry unreachable',
            checkedAt: Date.now(),
          },
        }),
      });
    });

    const detailResponse = page.waitForResponse(
      (res) => res.url().includes('/api/image-updates/detail') && res.ok(),
    );
    await page.reload();
    await waitForStacksLoaded(page);
    await detailResponse;
    await expect(
      page.locator('[data-testid="stack-row"]').filter({ hasText: FAILED_STACK }).locator('[data-testid="stack-trailing-check-failed"]'),
    ).toBeVisible({ timeout: 10_000 });

    await assertRowLayout(page, FAILED_STACK, {
      expectTruncated: true,
      trailingKind: 'failed',
    });
  });

  test('check-failed wins over a sticky update dot on a long stack name', async ({ page }) => {
    await page.route('**/api/image-updates/detail', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          [UPDATE_STACK]: {
            hasUpdate: true,
            checkStatus: 'failed',
            lastError: 'Registry unreachable',
            checkedAt: Date.now(),
          },
        }),
      });
    });

    await page.reload();
    await waitForStacksLoaded(page);

    await assertRowLayout(page, UPDATE_STACK, {
      expectTruncated: true,
      trailingKind: 'failed',
    });
  });

  test('git-pending icon stays visible on a long stack name', async ({ page }) => {
    await page.route('**/api/git-sources', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { stack_name: GIT_STACK, pending_commit_sha: 'abc123def456' },
        ]),
      });
    });

    const gitResponse = page.waitForResponse(
      (res) => res.url().includes('/api/git-sources') && res.ok(),
    );
    await page.reload();
    await waitForStacksLoaded(page);
    await gitResponse;
    await expect(
      page.locator('[data-testid="stack-row"]').filter({ hasText: GIT_STACK }).locator('[data-testid="stack-trailing-git-pending"]'),
    ).toBeVisible({ timeout: 10_000 });

    await assertRowLayout(page, GIT_STACK, {
      expectTruncated: true,
      trailingKind: 'git',
    });
  });

  test('active row with a long name still truncates', async ({ page }) => {
    const row = page.locator('[data-testid="stack-row"]').filter({ hasText: LONG_STACK });
    const slug = LONG_STACK.replace(/^-+/, '').replace(/\.(ya?ml)$/i, '');
    await Promise.all([
      page.waitForURL(new RegExp(`/nodes/local/stacks/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)),
      row.click(),
    ]);
    await expect(row).toHaveClass(/bg-accent/, { timeout: 10_000 });
    await assertRowLayout(page, LONG_STACK, { expectTruncated: true });
  });

  test('bulk mode checkbox does not break truncation on long names', async ({ page }) => {
    const bulkToggle = page.locator('button[aria-pressed]').filter({ has: page.locator('.lucide-layout-list') });
    await bulkToggle.click();
    await expect(bulkToggle).toHaveAttribute('aria-pressed', 'true');

    const row = page.locator('[data-testid="stack-row"][data-bulk="true"]').filter({ hasText: LONG_STACK });
    await expect(row).toBeVisible();
    await expect(row.locator('[role="checkbox"]')).toBeVisible();

    await assertRowLayout(page, LONG_STACK, { expectTruncated: true });
  });

  test('all stack rows stay within the sidebar width', async ({ page }) => {
    const metrics = await page.evaluate(() => {
      const sidebar = document.querySelector('.bg-sidebar.border-r, .w-64.border-r');
      const sidebarRect = sidebar?.getBoundingClientRect();
      if (!sidebarRect) return { ok: false, offenders: ['sidebar-missing'] };

      const rows = Array.from(document.querySelectorAll('[data-testid="stack-row"]'));
      const offenders: string[] = [];
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.right > sidebarRect.right + 0.5) {
          offenders.push(row.textContent?.trim().slice(0, 40) ?? 'unknown-row');
        }
      }
      return { ok: offenders.length === 0, offenders };
    });

    expect(metrics.ok, `rows overflow sidebar: ${metrics.offenders.join(', ')}`).toBe(true);
  });

  test('ScrollArea block mode constrains list width', async ({ page }) => {
    const viewportUsesBlock = await page.evaluate(() => {
      const viewport = document.querySelector('[data-radix-scroll-area-viewport]');
      const inner = viewport?.firstElementChild as HTMLElement | null;
      if (!inner) return false;
      return getComputedStyle(inner).display === 'block';
    });
    expect(viewportUsesBlock).toBe(true);
  });

  test('mobile viewport keeps long names truncated', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/nodes/local/stacks');
    await waitForStacksLoaded(page);

    const metrics = await measureRow(page, LONG_STACK);
    expect(metrics.nameTruncated).toBe(true);
    expect(metrics.rowWithinSidebar).toBe(true);
  });
});
