/**
 * Updates view: a service's changelog link and the Copy skip label verb.
 *
 * The preview reports a same-tag rebuild for one service that declares
 * `io.sencho.update.changelog`. The card shows the link (new tab, no opener)
 * and Copy skip label copies the exact Compose line that skips the rebuild.
 * Without a changelog label, no changelog text is printed at all. Checked on
 * the desktop Cards view and on the phone card.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';

const STACK = 'qp-skip-label';
const DIGEST = `sha256:${'5'.repeat(64)}`;
const CHANGELOG = 'https://github.com/example/app/releases';

async function localNodeId(page: Page): Promise<number> {
  const nodes = await page.evaluate(async () => {
    const res = await fetch('/api/nodes', { credentials: 'include' });
    return (await res.json()) as Array<{ id: number; type: string }>;
  });
  const local = nodes.find(n => n.type === 'local');
  if (!local) throw new Error('no local node in /api/nodes');
  return local.id;
}

async function mockReadiness(page: Page, nodeId: number, changelogUrl: string | null): Promise<void> {
  const now = Date.now();
  await page.route('**/api/image-updates/fleet**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/fleet/detail')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ [String(nodeId)]: { [STACK]: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: now } } }),
      });
      return;
    }
    if (url.pathname.endsWith('/fleet')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ [String(nodeId)]: { [STACK]: true } }) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/scheduled-tasks**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(`**/api/stacks/${STACK}/update-preview`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stack_name: STACK,
        images: [{
          service: 'app',
          image: 'ghcr.io/example/app:latest',
          current_tag: 'latest',
          next_tag: 'latest',
          has_update: true,
          digest_update: true,
          tag_update: false,
          semver_bump: 'patch',
          check_status: 'ok',
          candidate_digest: DIGEST,
          ...(changelogUrl ? { changelog_url: changelogUrl } : {}),
        }],
        summary: {
          has_update: true,
          primary_image: 'ghcr.io/example/app:latest',
          current_tag: 'latest',
          next_tag: 'latest',
          semver_bump: 'patch',
          update_kind: 'digest',
          blocked: false,
          blocked_reason: null,
          rebuild_available: false,
          verification_failed: false,
          verification_error: null,
          check_status: 'ok',
        },
        build_services: [],
        rollback_target: null,
        changelog: null,
      }),
    });
  });
}

async function openUpdates(page: Page, changelogUrl: string | null, desktop: boolean) {
  await loginAs(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockReadiness(page, await localNodeId(page), changelogUrl);
  await page.goto('/nodes/local/updates');
  if (desktop) await page.getByRole('radio', { name: 'Cards' }).click();
  const card = page.getByTestId(desktop ? 'readiness-card' : 'mobile-readiness-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card;
}

for (const { name, width, height, desktop } of [
  { name: 'desktop Cards view', width: 1440, height: 900, desktop: true },
  { name: 'phone card', width: 390, height: 844, desktop: false },
]) {
  test.describe(`Updates ${name}`, () => {
    test('links the service changelog and copies the exact skip label', async ({ page }) => {
      await page.setViewportSize({ width, height });
      const card = await openUpdates(page, CHANGELOG, desktop);

      const link = card.getByTestId('update-changelog-link');
      await expect(link).toHaveAttribute('href', CHANGELOG);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

      await card.getByTestId('update-copy-skip-label').click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(`io.sencho.update.ignore: "${DIGEST}"`);
      await expect(page.getByText(/Skip label copied/)).toBeVisible();
    });

    test('prints no changelog text when the service declares no link', async ({ page }) => {
      await page.setViewportSize({ width, height });
      const card = await openUpdates(page, null, desktop);
      await expect(card.getByTestId('update-copy-skip-label')).toBeVisible();
      await expect(card.getByTestId('update-changelog-link')).toHaveCount(0);
      await expect(card.getByText(/changelog/i)).toHaveCount(0);
    });
  });
}
