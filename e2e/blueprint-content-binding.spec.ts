/**
 * Convert a live Direct Git source onto a Blueprint, then detach.
 *
 * Soft-skips when the system git binary is unavailable. Uses the local
 * fixture Git server so the suite does not depend on network egress.
 */
import { test, expect, Page } from '@playwright/test';
import { loginAs } from './helpers';
import { gitAvailable, buildFixtureRepo, serveRepos } from './gitServer.helper';

async function jsonRequest<T>(
  page: Page,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ url, method, payload }) => {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      ...(payload === null
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
    return { status: res.status, body: await res.json() as T };
  }, { url, method: init.method ?? 'GET', payload: init.body === undefined ? null : init.body });
}

test.describe('Blueprint Git-managed content binding', () => {
  test.skip(!gitAvailable(), 'system git binary is not available');

  let server: { url: string; close: () => void };
  let stackName: string;
  let blueprintName: string;
  let blueprintId: number | null = null;

  test.beforeAll(async () => {
    server = await serveRepos({
      app: buildFixtureRepo({ 'compose.yaml': 'services:\n  web:\n    image: nginx:alpine\n' }),
    });
  });

  test.afterAll(() => {
    server?.close();
  });

  test.beforeEach(async () => {
    const stamp = Date.now();
    stackName = `e2e-bp-src-${stamp}`;
    blueprintName = `e2e-bp-bind-${stamp}`;
    blueprintId = null;
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async ({ bpId, stack }) => {
      if (bpId !== null) {
        await fetch(`/api/blueprints/${bpId}/content-binding`, {
          method: 'DELETE',
          credentials: 'include',
        }).catch(() => {});
        await fetch(`/api/blueprints/${bpId}`, {
          method: 'DELETE',
          credentials: 'include',
        }).catch(() => {});
      }
      await fetch(`/api/stacks/${stack}/git-source`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
      await fetch(`/api/stacks/${stack}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, { bpId: blueprintId, stack: stackName });
  });

  async function seedDirectSourceAndBlueprint(page: Page): Promise<{ applicationId: string; blueprintId: number }> {
    const createStack = await jsonRequest(page, '/api/stacks', {
      method: 'POST',
      body: { stackName },
    });
    expect(createStack.status).toBe(200);

    const saveStatus = await jsonRequest(page, `/api/stacks/${stackName}/git-source`, {
      method: 'PUT',
      body: {
        repo_url: `${server.url}/app.git`,
        branch: 'main',
        compose_paths: ['compose.yaml'],
        sync_env: false,
        auth_type: 'none',
        auto_apply_on_webhook: false,
        auto_deploy_on_apply: false,
      },
    });
    expect(saveStatus.status, JSON.stringify(saveStatus.body)).toBe(200);

    let applicationId: string | null = null;
    await expect.poll(async () => {
      const revision = await jsonRequest<{ gitopsRevision?: { applicationId?: string | null } }>(
        page,
        `/api/stacks/${stackName}/git-source`,
      );
      applicationId = revision.body.gitopsRevision?.applicationId ?? null;
      return applicationId;
    }, { timeout: 2_500, intervals: [250] }).toBeTruthy();
    if (!applicationId) {
      throw new Error('Direct GitOps application should exist after save');
    }

    const created = await jsonRequest<{ id?: number; error?: string }>(page, '/api/blueprints', {
      method: 'POST',
      body: {
        name: blueprintName,
        compose_content: 'services:\n  app:\n    image: nginx:alpine\n',
        selector: { type: 'labels', any: [], all: [] },
        drift_mode: 'observe',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.id).toEqual(expect.any(Number));
    return { applicationId, blueprintId: created.body.id as number };
  }

  async function openBlueprintSheet(page: Page, name: string) {
    await page.getByRole('button', { name: 'Fleet', exact: true }).click();
    await page.getByRole('tab', { name: /Deployments/i }).click();
    const card = page.getByRole('button', { name: new RegExp(name) });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();
    await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10_000 });
  }

  test('convert makes the editor read-only and blocked, detach restores Inline editing', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page);
    const seeded = await seedDirectSourceAndBlueprint(page);
    blueprintId = seeded.blueprintId;

    const convert = await jsonRequest(page, `/api/blueprints/${seeded.blueprintId}/content-binding`, {
      method: 'PUT',
      body: { applicationId: seeded.applicationId },
    });
    expect(convert.status, JSON.stringify(convert.body)).toBe(200);

    await openBlueprintSheet(page, blueprintName);
    await expect(page.getByText('Git-managed', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply now' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Detach Git' })).toBeVisible();

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Git-managed source')).toBeVisible();
    await expect(page.getByText("This Blueprint's content is Git-managed, so it cannot deploy from the stored snapshot.")).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Detach Git' }).click();
    await expect(page.getByRole('heading', { name: 'Detach Git-managed content' })).toBeVisible();
    await expect(page.getByText('Detach restores the frozen Inline snapshot')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Detach', exact: true }).click();

    await expect(page.getByText('Inline', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Convert to Git' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply now' })).toBeVisible();
  });
});
