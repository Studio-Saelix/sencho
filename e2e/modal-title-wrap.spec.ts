import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

// Prune-plan fixture so the confirmation dialog renders deterministically.
// The dialog is opened but never confirmed; the plan endpoint is a read-only
// plan computation, so this spec performs no Docker mutation.
const PRUNE_PLAN_FIXTURE = {
  scope: 'managed',
  targets: ['images'],
  items: [{
    target: 'images',
    id: 'sha256:title-wrap-fixture',
    name: 'ghcr.io/example/app:1.5.2',
    sizeBytes: 48234496,
    managed: true,
    reason: 'Image is not used by any container',
    image: {
      references: [
        'ghcr.io/example/app:1.5.2',
        'ghcr.io/example/app:latest',
      ],
    },
  }],
  reclaimableBytes: 48234496,
  fingerprint: 'fp-title-wrap',
  createdAt: 1_700_000_000_000,
  nodeId: 1,
};

// Geometry fixture for the shared confirm-dialog header at the sm width
// (max-w-sm = 384px; header padding px-6 pt-6 pb-4 pr-12, so the title box
// is 312px wide). No app dialog accepts an arbitrary long title, so the
// long-token and long-multi-word cases render the exact final CSS strategy
// the shared HeaderShell emits (overflow-wrap: break-word + text-wrap:
// balance) at that geometry. The component emitting these classes is
// asserted in the vitest suite, and the real-app prune dialog below asserts
// the computed styles end to end; this fixture validates the layout result.
const HEADER_GEOMETRY_FIXTURE = (title: string) => `
<div id="header" style="max-width:384px;padding:24px 48px 16px 24px;">
  <h2 id="title" style="margin-top:4px;font-size:28px;line-height:1.25;overflow-wrap:break-word;text-wrap:balance;">${title}</h2>
</div>
`;

test.describe('Modal title wrapping contract', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    await page.route('**/system/prune/plan', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PRUNE_PLAN_FIXTURE),
      });
    });
    await loginAs(page);
    await page.getByRole('button', { name: /resources/i }).click();
    await page.getByRole('button', { name: /Prune Unused Images/ }).click();
  });

  test('prune confirmation wraps on word boundaries with no orphaned letters', async ({ page }) => {
    const title = page.getByRole('heading', { name: 'Prune Sencho-managed images' });
    await expect(title).toBeVisible();
    const metrics = await title.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      wordBreak: getComputedStyle(el).wordBreak,
      overflowWrap: getComputedStyle(el).overflowWrap,
      textWrap: getComputedStyle(el).textWrap,
    }));
    expect(metrics.wordBreak).not.toBe('break-all');
    expect(metrics.overflowWrap).toBe('break-word');
    expect(metrics.textWrap).toBe('balance');
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  });

  test('dialog stays bounded with the confirm action reachable', async ({ page }) => {
    const dialog = page.getByRole('alertdialog').filter({ hasText: 'Prune Sencho-managed images' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Prune/ })).toBeVisible();
    const bounded = await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
    expect(bounded).toBe(true);
  });
});

test.describe('Header geometry: long titles', () => {
  test('long unbroken token does not overflow the title box', async ({ page }) => {
    await page.setContent(HEADER_GEOMETRY_FIXTURE('x'.repeat(200)));
    const metrics = await page.locator('#title').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  });

  test('long multi-word title wraps into balanced lines with no orphan', async ({ page }) => {
    await page.setContent(HEADER_GEOMETRY_FIXTURE('Prune Sencho-managed containers'));
    const metrics = await page.locator('#title').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      return {
        lineCount: rects.length,
        firstLineWidth: rects[0]?.width ?? 0,
        lastLineWidth: rects[rects.length - 1]?.width ?? 0,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
    expect(metrics.lineCount).toBeGreaterThanOrEqual(2);
    // Balanced wrapping: the shorter line is a substantial fraction of the
    // longer one, not a single orphaned letter hanging on its own line.
    const [longer, shorter] = [metrics.firstLineWidth, metrics.lastLineWidth].sort((a, b) => b - a);
    expect(shorter / longer).toBeGreaterThan(0.5);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  });
});
