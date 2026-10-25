/**
 * A Git-managed deploy that fails its health gate, end to end on a real
 * deployment.
 *
 * The deploy itself succeeds, so no source status marks the source as failed.
 * The Git Source sheet still has to offer Retry, because retrying resumes the
 * deploy of the generation that was applied. The unit tests cover the
 * projection against seeded rows; this one produces the state the way an
 * operator would hit it: a local Git server, a workload that outlives the
 * post-deploy probe and then crashes, and a short health-gate window.
 *
 * Needs a Docker daemon and a system git binary.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';
import { gitAvailable, buildFixtureRepo, serveRepos } from './gitServer.helper';

// The post-deploy probe looks 3 seconds after compose up and fails the deploy
// itself on a container that has already crashed. This one survives that look,
// so the deploy succeeds and the health gate is what judges it.
const EXITING_COMPOSE = `services:
  web:
    image: alpine:3
    command: ["sh", "-c", "sleep 8; exit 1"]
`;

test.describe('Git source Retry after a health-gate failure (local git server)', () => {
  test.skip(!gitAvailable(), 'system git binary is not available');
  // Pull, apply, a real deploy, and the health window run back to back.
  test.setTimeout(240_000);

  let server: { url: string; close: () => void };
  let stackName: string;
  let previousGate: { health_gate_enabled?: string; health_gate_window_seconds?: string } = {};

  test.beforeAll(async () => {
    server = await serveRepos({ unhealthy: buildFixtureRepo({ 'compose.yaml': EXITING_COMPOSE }) });
  });

  test.afterAll(() => {
    server?.close();
  });

  async function api(page: Page, path: string, init?: { method?: string; body?: unknown }) {
    return page.evaluate(async ({ p, opts }) => {
      const res = await fetch(p, {
        method: opts?.method ?? 'GET',
        headers: opts?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        credentials: 'include',
      });
      let json: unknown = null;
      try { json = await res.json(); } catch { /* empty or non-JSON body */ }
      return { status: res.status, json };
    }, { p: path, opts: init });
  }

  async function availableActions(page: Page): Promise<string[]> {
    const res = await api(page, `/api/stacks/${stackName}/git-source`);
    const revision = (res.json as { gitopsRevision?: { availableActions?: string[] } } | null)?.gitopsRevision;
    return revision?.availableActions ?? [];
  }

  test('the sheet offers Retry once the applied generation fails its health gate', async ({ page }) => {
    await loginAs(page);
    stackName = `e2e-health-retry-${Date.now()}`;

    // Gate the deploy on a short window, and put the settings back afterwards
    // so the scenario never changes the box it ran on.
    const settings = (await api(page, '/api/settings')).json as typeof previousGate;
    previousGate = {
      health_gate_enabled: settings.health_gate_enabled,
      health_gate_window_seconds: settings.health_gate_window_seconds,
    };
    expect((await api(page, '/api/settings', {
      method: 'PATCH',
      body: { health_gate_enabled: '1', health_gate_window_seconds: '15' },
    })).status).toBe(200);

    try {
      expect((await api(page, '/api/stacks', { method: 'POST', body: { stackName } })).status).toBe(200);
      const saved = await api(page, `/api/stacks/${stackName}/git-source`, {
        method: 'PUT',
        body: {
          repo_url: `${server.url}/unhealthy.git`,
          branch: 'main',
          compose_paths: ['compose.yaml'],
          context_dir: null,
          sync_env: false,
          auth_type: 'none',
          auto_apply_on_webhook: false,
          auto_deploy_on_apply: false,
        },
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);

      const pulled = await api(page, `/api/stacks/${stackName}/git-source/pull`, { method: 'POST' });
      expect(pulled.status, JSON.stringify(pulled.json)).toBe(200);
      const { commitSha, planFingerprint } = pulled.json as { commitSha: string; planFingerprint: string };

      // Until the deploy has been judged there is nothing to retry.
      expect(await availableActions(page)).not.toContain('retry');

      const applied = await api(page, `/api/stacks/${stackName}/git-source/apply`, {
        method: 'POST',
        body: { commitSha, planFingerprint, deploy: true },
      });
      expect(applied.status, JSON.stringify(applied.json)).toBe(200);

      // The workload crashes inside the gate's window, so the gate finalizes as failed.
      await expect.poll(() => availableActions(page), { timeout: 120_000, intervals: [2_000] }).toContain('retry');

      await page.reload();
      await expect(page.locator('[data-stacks-loaded="true"]')).toBeAttached({ timeout: 15_000 });
      await page.getByText(stackName).first().click();
      const gitButton = page.getByRole('button', { name: /Git Source/i });
      await expect(gitButton).toBeVisible({ timeout: 10_000 });
      await gitButton.click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: /git source/i })).toBeVisible({ timeout: 5_000 });

      await expect(page.getByRole('dialog').getByRole('button', { name: /^retry$/i })).toBeVisible({ timeout: 10_000 });
    } finally {
      await api(page, `/api/stacks/${stackName}/git-source`, { method: 'DELETE' }).catch(() => {});
      await api(page, `/api/stacks/${stackName}`, { method: 'DELETE' }).catch(() => {});
      await api(page, '/api/settings', {
        method: 'PATCH',
        body: {
          health_gate_enabled: previousGate.health_gate_enabled ?? '0',
          health_gate_window_seconds: previousGate.health_gate_window_seconds ?? '60',
        },
      }).catch(() => {});
    }
  });
});
