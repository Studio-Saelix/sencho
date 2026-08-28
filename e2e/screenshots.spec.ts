/**
 * Docs screenshot capture.
 *
 * Takes canonical screenshots of key UI views and writes them to docs/images/.
 * Run manually after a UI change that affects a documented view:
 *   npx playwright test --project=screenshots
 * Then review the diff under docs/images/ and commit on a chore branch.
 * The default `playwright test` invocation skips this spec via the
 * project-level testIgnore in playwright.config.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './helpers';

const DOCS_IMAGES = path.resolve(__dirname, '../docs/images');

test.use({
  viewport: { width: 1280, height: 800 },
  // Always capture - this spec exists solely to produce screenshots
  screenshot: 'on',
});

test.beforeAll(() => {
  fs.mkdirSync(DOCS_IMAGES, { recursive: true });
});

test('login page', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(DOCS_IMAGES, 'login.png'), fullPage: true });
});

test('dashboard', async ({ page }) => {
  await loginAs(page);
  // Wait for stats widgets to settle
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: path.join(DOCS_IMAGES, 'dashboard.png'), fullPage: true });
});

test('stacks', async ({ page }) => {
  await loginAs(page);
  await page.getByRole('button', { name: 'Create Stack' }).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: path.join(DOCS_IMAGES, 'stacks.png'), fullPage: true });
});

test('resources', async ({ page }) => {
  await loginAs(page);
  await page.getByRole('button', { name: /resources/i }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(DOCS_IMAGES, 'resources.png'), fullPage: true });
});

test('sso settings', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await loginAs(page);
  await page.getByRole('button', { name: /profile/i }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('SSO', { exact: true }).first().click();
  // The role-sync switch confirms the SSO panel (admin-only) has loaded; it
  // only renders once GET /sso/config/role-sync resolves, so wait for the
  // switch itself, not just the adjacent label text.
  const roleSyncSwitch = page.getByRole('switch', { name: 'IdP role synchronization' });
  await expect(roleSyncSwitch).toBeVisible();
  await roleSyncSwitch.scrollIntoViewIfNeeded();
  // The SSO panel lives in a fixed-height Radix scroll area, so a plain
  // fullPage capture clips content below the fold. Expand the viewport (and
  // its overflow-hidden root) so the whole panel, including the role-sync
  // control, is captured.
  await roleSyncSwitch.evaluate((el) => {
    const viewport = el.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!viewport) return;
    viewport.style.height = 'auto';
    viewport.style.overflow = 'visible';
    const root = viewport.parentElement;
    if (root) {
      root.style.height = 'auto';
      root.style.overflow = 'visible';
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(DOCS_IMAGES, 'sso', 'sso-settings.png'), fullPage: true });
});

function emptyCounts() {
  return {
    add: 0, modify: 0, delete: 0, rename: 0, unchanged: 0,
    localModified: 0, localMissing: 0, typeChanged: 0, unmanagedCollision: 0, invocation: 0,
  };
}

function linkedSource(stackName: string) {
  return {
    id: 1,
    stack_name: stackName,
    repo_url: 'https://github.com/example/compose.git',
    branch: 'main',
    compose_path: 'compose.yaml',
    compose_paths: ['compose.yaml'],
    sync_env: false,
    env_path: null,
    auth_type: 'none',
    has_token: false,
    auto_apply_on_webhook: false,
    auto_deploy_on_apply: false,
    last_applied_commit_sha: '1111111111111111111111111111111111111111',
    pending_commit_sha: null,
    pending_fetched_at: null,
    created_at: 0,
    updated_at: 0,
    manifest_state: 'active',
    manifest: null,
  };
}

async function createStack(page: Page, stackName: string) {
  await page.evaluate(async (name) => {
    await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    await fetch('/api/stacks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ stackName: name }),
    });
  }, stackName);
}

async function stubGitSourceAndPull(page: Page, stackName: string, pullBody: unknown) {
  await page.route('**/git-source/pull', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(pullBody),
    });
  });
  await page.route(new RegExp(`/api/stacks/${stackName}/git-source$`), async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(linkedSource(stackName)),
      });
      return;
    }
    await route.continue();
  });
}

async function openStubbedChangePlan(page: Page, stackName: string) {
  await page.getByRole('button', { name: 'Create Stack' }).waitFor({ timeout: 15_000 });
  await page.getByText(stackName).first().click();
  await page.getByRole('button', { name: /Git Source/i }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: /git source/i })).toBeVisible();
  await page.getByRole('button', { name: /Pull now/i }).click();
  await expect(page.getByTestId('git-plan-op').first()).toBeVisible({ timeout: 10_000 });
}

test.describe('classified change-plan docs screenshots', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('git-sources change plan dialog', async ({ page }) => {
    await loginAs(page);
    const stackName = 'demo-app';
    await createStack(page, stackName);
    await stubGitSourceAndPull(page, stackName, {
      commitSha: 'c0ffee12c0ffee12c0ffee12c0ffee12c0ffee12',
      validation: { ok: true },
      refusals: [],
      warnings: [],
      plan: {
        blocked: false,
        counts: { ...emptyCounts(), add: 1, modify: 1, delete: 1, unchanged: 2 },
        operations: [
          { path: 'added.conf', op: 'add', role: 'config' },
          { path: 'compose.yaml', op: 'modify', role: 'compose-primary' },
          { path: 'extra.conf', op: 'delete', role: 'config' },
        ],
        invocation: { candidateChanged: false, liveDiverged: false },
      },
      planFingerprint: 'fp-demo-docs',
    });
    await page.goto('/');
    await openStubbedChangePlan(page, stackName);
    const planDialog = page.getByRole('dialog').filter({ hasText: 'GIT · CHANGE PLAN' });
    await expect(planDialog).toBeVisible();
    await planDialog.screenshot({
      path: path.join(DOCS_IMAGES, 'git-sources', 'diff-dialog.png'),
    });
    await page.evaluate(async (name) => {
      await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, stackName);
  });

  test('tutorial pull change plan dialog', async ({ page }) => {
    await loginAs(page);
    const stackName = 'marketing-site';
    await createStack(page, stackName);
    await stubGitSourceAndPull(page, stackName, {
      commitSha: 'a1b2c3da1b2c3da1b2c3da1b2c3da1b2c3da1b2c',
      validation: { ok: true },
      refusals: [],
      warnings: [],
      plan: {
        blocked: false,
        counts: { ...emptyCounts(), modify: 1, unchanged: 0 },
        operations: [
          { path: 'compose.yaml', op: 'modify', role: 'compose-primary' },
        ],
        invocation: { candidateChanged: false, liveDiverged: false },
      },
      planFingerprint: 'fp-marketing-docs',
    });
    await page.goto('/');
    await openStubbedChangePlan(page, stackName);
    const planDialog = page.getByRole('dialog').filter({ hasText: 'GIT · CHANGE PLAN' });
    await expect(planDialog).toBeVisible();
    await planDialog.screenshot({
      path: path.join(DOCS_IMAGES, 'tutorials', 'connect-a-git-source', 'pull-preview-diff.png'),
    });
    await page.evaluate(async (name) => {
      await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, stackName);
  });
});

test.describe('resources prune confirm docs screenshot', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('prune confirm lists extra repository tags', async ({ page }) => {
    await page.route('**/system/prune/plan', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scope: 'managed',
          targets: ['images'],
          items: [{
            target: 'images',
            id: 'sha256:docs-prune-multi-tag',
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
          fingerprint: 'fp-docs-prune-confirm',
          createdAt: 1_700_000_000_000,
          nodeId: 1,
        }),
      });
    });

    await loginAs(page);
    await page.getByRole('button', { name: /resources/i }).click();
    await page.getByRole('button', { name: /Prune Unused Images/ }).click();
    const pruneDialog = page.getByRole('alertdialog').filter({ hasText: 'Prune Sencho-managed images' });
    await expect(pruneDialog).toBeVisible();
    await expect(pruneDialog.getByText('ghcr.io/example/app:latest')).toBeVisible();
    await pruneDialog.screenshot({
      path: path.join(DOCS_IMAGES, 'resources', 'resources-prune-confirm.png'),
    });
  });
});
