/**
 * The GitOps converge journey on a Direct node, end to end against real Docker.
 *
 * Attach, converge, and recover are each covered by service-level tests and by
 * narrower specs, but nothing drove the whole sequence an operator relies on
 * with the real pipeline underneath it. This spec does: a repository is
 * attached and deployed, a second commit is pushed into the served bare
 * repository (the same thing a developer's `git push` does to a hosted remote),
 * a signed generic CI webhook delivers it, and the change is staged as a
 * reviewable candidate that has not touched the running workload. The operator
 * then applies the exact plan they were shown, the workload is redeployed and
 * health-verified, the GitOps application reports the new commit as converged,
 * and a rollback puts the previous authored project and runtime back.
 *
 * The second commit changes every kind of file operation at once (a modified
 * compose file, a modified env file, an added config, and a deleted config), so
 * the per-file classification and the on-disk result are checked together
 * instead of one operation at a time.
 *
 * Source policy is `review` on purpose: it is the policy under which the
 * trigger, the candidate, and the operator's acceptance are three separate
 * steps, so each one is observable. Under `automatic` the webhook would apply
 * in one motion and the staged candidate would never be visible.
 *
 * Fixture services run with `network_mode: none` so the spec does not depend on
 * a free Docker address pool, and use a tiny image that is already on every
 * runner the deploy specs run on.
 *
 * The final test pins a defect this journey found rather than hiding it: a
 * rollback restores the files and the workload but never opens a health run of
 * its own, so the application keeps reading "health pending" and cannot reach
 * a converged posture. It is marked as an expected failure so it flips to a
 * hard failure the moment the behavior is fixed, which is the cue to remove the
 * marker.
 *
 * Needs git and the Docker CLI with the Compose plugin. A machine with neither
 * skips outside CI; in CI both are required so a broken runner never reads as a
 * pass.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';
import { buildFixtureRepo, gitAvailable, pushFixtureCommit, serveRepos } from './gitServer.helper';

const DOCKER_TIMEOUT_MS = 60_000;
const IMAGE = 'busybox:stable';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' });
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    // Present but unusable is an environment fault, not a reason to skip.
    throw error;
  }
}

function composeFor(revision: string, configFile: string): string {
  return [
    'services:',
    '  app:',
    `    image: ${IMAGE}`,
    '    command: sleep 3600',
    '    network_mode: none',
    '    env_file: app.env',
    '    configs: [conf]',
    '    labels:',
    `      e2e.revision: ${revision}`,
    'configs:',
    '  conf:',
    `    file: ${configFile}`,
    '',
  ].join('\n');
}

/** The revision label on the stack's one running container, read from the daemon. */
function runningRevision(project: string): string {
  const ids = execFileSync(
    'docker',
    [
      'ps',
      '--filter', `label=com.docker.compose.project=${project.toLowerCase()}`,
      '--filter', 'label=com.docker.compose.service=app',
      '--filter', 'status=running',
      '--format', '{{.ID}}',
    ],
    { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' },
  )
    .toString()
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  // Exactly one, so a stray duplicate can never be read as the workload.
  if (ids.length !== 1) throw new Error(`expected one running app container for ${project}, found ${ids.length}`);
  return execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "e2e.revision"}}', ids[0] as string], {
    timeout: DOCKER_TIMEOUT_MS,
    stdio: 'pipe',
  })
    .toString()
    .trim();
}

interface ApiResult<T = unknown> {
  status: number;
  json: T;
}

async function api<T = unknown>(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ p, o }) => {
      const res = await fetch(p, {
        method: o?.method ?? 'GET',
        headers: o?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: o?.body !== undefined ? JSON.stringify(o.body) : undefined,
        credentials: 'include',
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* empty or non-JSON body */
      }
      return { status: res.status, json };
    },
    { p: path, o: init },
  ) as Promise<ApiResult<T>>;
}

interface GitSourceView {
  last_applied_commit_sha: string | null;
  pending_commit_sha: string | null;
  pending_plan: {
    fingerprint: string;
    blocked: boolean;
    counts: Record<string, number>;
  } | null;
  gitopsRevision: { applicationId: string };
  manifest: { managedCount: number } | null;
}

interface ApplicationView {
  application: {
    desiredCommitSha: string | null;
    healthStatus: string;
    runtimeStatus: string;
    posture: string;
    drift: { count: number };
  };
}

interface HistoryItem {
  stage: string;
  trigger: string;
  outcome: string;
}

interface HealthGateView {
  id: string | null;
  status: string;
}

test.describe.serial('GitOps converge journey on a Direct node (local git server)', () => {
  test.skip(!gitAvailable(), 'system git binary is not available');
  test.skip(!dockerAvailable(), 'Docker CLI with the Compose plugin is not available');

  // Real deploys with a health-gate window and a wall-clock rollback: one
  // scenario, so it gets its own budget instead of the suite default.
  test.setTimeout(240_000);

  const stackName = `e2e-converge-${Date.now()}`;
  let server: { url: string; close: () => void };
  let repos: Record<string, string>;
  let appId = '';
  let previousGateWindow = '90';

  async function appRow(page: Page): Promise<ApplicationView['application']> {
    const res = await api<ApplicationView>(page, `/api/gitops/applications/${encodeURIComponent(`1:${appId}`)}`);
    expect(res.status).toBe(200);
    return res.json.application;
  }

  async function sourceView(page: Page): Promise<GitSourceView> {
    const res = await api<GitSourceView>(page, `/api/stacks/${stackName}/git-source`);
    expect(res.status).toBe(200);
    return res.json;
  }

  async function history(page: Page): Promise<HistoryItem[]> {
    const res = await api<{ items: HistoryItem[] }>(page, `/api/stacks/${stackName}/git-source/history?limit=100`);
    expect(res.status).toBe(200);
    return res.json.items;
  }

  /** Wait for a health run to leave `observing`, then return its verdict. */
  async function settledGate(page: Page, gateId?: string): Promise<HealthGateView> {
    const query = gateId ? `?gateId=${gateId}` : '';
    let last: HealthGateView = { id: null, status: 'never-run' };
    await expect
      .poll(
        async () => {
          last = (await api<HealthGateView>(page, `/api/stacks/${stackName}/health-gate${query}`)).json;
          return last.status;
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .not.toMatch(/^(observing|never-run)$/);
    return last;
  }

  test.beforeAll(async () => {
    repos = {
      app: buildFixtureRepo({
        'compose.yaml': composeFor('v1', 'config/legacy.conf'),
        'app.env': 'MODE=one\n',
        'config/legacy.conf': 'legacy\n',
      }),
    };
    server = await serveRepos(repos);
  });

  test.afterAll(async ({ browser }) => {
    server?.close();
    const page = await browser.newPage();
    try {
      await loginAs(page);
      await api(page, `/api/stacks/${stackName}/git-source`, { method: 'DELETE' });
      await api(page, `/api/stacks/${stackName}`, { method: 'DELETE' });
      await api(page, '/api/settings', {
        method: 'PATCH',
        body: { health_gate_window_seconds: Number(previousGateWindow) },
      });
    } finally {
      await page.close();
    }
  });

  test('a pushed commit is staged by a signed webhook, applied as shown, health-verified, and rolled back', async ({ page }) => {
    await loginAs(page);

    // The smallest window the settings API accepts, so the post-deploy verdict
    // arrives in seconds. Restored in afterAll so the box is left as found.
    const settings = await api<{ health_gate_window_seconds?: string }>(page, '/api/settings');
    previousGateWindow = settings.json.health_gate_window_seconds ?? previousGateWindow;
    expect((await api(page, '/api/settings', { method: 'PATCH', body: { health_gate_window_seconds: 15 } })).status).toBe(200);

    const repoDir = repos.app as string;
    const bareDir = repos['app.git'] as string;
    const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();

    // 1. Attach: the repository becomes the stack, pinned to an exact commit,
    //    with every file the compose project references in its manifest.
    const created = await api<{ commitSha: string }>(page, '/api/stacks/from-git', {
      method: 'POST',
      body: {
        stack_name: stackName,
        repo_url: `${server.url}/app.git`,
        branch: 'main',
        compose_paths: ['compose.yaml'],
        auth_type: 'none',
        source_policy: 'review',
        auto_deploy_on_apply: false,
      },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json.commitSha).toBe(firstSha);
    const attached = await sourceView(page);
    appId = attached.gitopsRevision.applicationId;
    expect(attached.last_applied_commit_sha).toBe(firstSha);
    expect(attached.pending_commit_sha).toBeNull();
    // compose.yaml, app.env, and config/legacy.conf.
    expect(attached.manifest?.managedCount).toBe(3);

    // 2. Deploy it and take the verdict of the health run that deploy opened.
    const deployed = await api<{ healthGateId: string }>(page, `/api/stacks/${stackName}/deploy`, {
      method: 'POST',
      body: {},
    });
    expect(deployed.status, JSON.stringify(deployed.json)).toBe(200);
    expect((await settledGate(page, deployed.json.healthGateId)).status).toBe('passed');
    expect(runningRevision(stackName)).toBe('v1');
    expect((await appRow(page)).healthStatus).toBe('passed');

    // 3. Push a second commit that modifies two files, adds one, and deletes one.
    const secondSha = pushFixtureCommit(repoDir, bareDir, {
      write: {
        'compose.yaml': composeFor('v2', 'config/new.conf'),
        'app.env': 'MODE=two\n',
        'config/new.conf': 'new\n',
      },
      remove: ['config/legacy.conf'],
      message: 'second revision',
    });
    expect(secondSha).not.toBe(firstSha);

    // 4. A generic CI webhook with a valid HMAC signature delivers it.
    const webhook = await api<{ id: number; secret: string }>(page, '/api/webhooks', {
      method: 'POST',
      body: { name: `e2e-${stackName}`, stack_name: stackName, action: 'git-pull' },
    });
    expect(webhook.status).toBe(201);
    const rawBody = JSON.stringify({ ref: 'refs/heads/main' });
    const signature = `sha256=${createHmac('sha256', webhook.json.secret).update(rawBody).digest('hex')}`;
    const deliveryId = randomUUID();
    const deliver = (headers: Record<string, string>) =>
      page.request.post(`/api/webhooks/${webhook.json.id}/trigger`, {
        data: rawBody,
        headers: { 'content-type': 'application/json', 'x-github-delivery': deliveryId, ...headers },
      });

    // A delivery with a signature made under the wrong secret is refused
    // outright and moves nothing.
    const forged = await deliver({
      'x-webhook-signature': `sha256=${createHmac('sha256', 'not-the-secret').update(rawBody).digest('hex')}`,
    });
    expect(forged.status()).toBe(404);
    expect((await sourceView(page)).pending_commit_sha).toBeNull();

    const accepted = await deliver({ 'x-webhook-signature': signature });
    expect(accepted.status()).toBe(202);

    // 5. Under `review` the delivery stages a candidate and stops. The
    //    candidate is pinned to the pushed commit, classified per file, and
    //    the running workload and the applied commit are untouched.
    await expect.poll(async () => (await sourceView(page)).pending_commit_sha, { timeout: 30_000, intervals: [500] }).toBe(secondSha);
    const staged = await sourceView(page);
    expect(staged.last_applied_commit_sha).toBe(firstSha);
    expect(staged.pending_plan?.blocked).toBe(false);
    expect(staged.pending_plan?.counts).toMatchObject({ add: 1, modify: 2, delete: 1 });
    expect(runningRevision(stackName)).toBe('v1');
    const rows = await history(page);
    expect(rows).toContainEqual(expect.objectContaining({ stage: 'source_reconcile_started', trigger: 'webhook' }));
    expect(rows).toContainEqual(expect.objectContaining({ stage: 'candidate_ready' }));
    expect(rows.some((r) => r.stage === 'applied' && r.trigger === 'webhook')).toBe(false);

    // The delivery id is the idempotency key: redelivering the same push is
    // acknowledged and does not fetch a second time. The wait is past the
    // source's 10 second webhook debounce, so the debounce cannot be what
    // swallows the redelivery and only the delivery id can.
    const fetchedBefore = rows.filter((r) => r.stage === 'fetched').length;
    await page.waitForTimeout(11_000);
    expect((await deliver({ 'x-webhook-signature': signature })).status()).toBe(202);
    await page.waitForTimeout(2_000);
    expect((await history(page)).filter((r) => r.stage === 'fetched').length).toBe(fetchedBefore);

    // 6. Acceptance is bound to the plan the operator was shown: a stale
    //    fingerprint is refused and nothing is applied.
    const stale = await api(page, `/api/stacks/${stackName}/git-source/apply`, {
      method: 'POST',
      body: { commitSha: secondSha, planFingerprint: '0'.repeat(64), deploy: true },
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect((await sourceView(page)).last_applied_commit_sha).toBe(firstSha);
    expect(runningRevision(stackName)).toBe('v1');

    // 7. Applying the exact plan and deploying converges the application.
    const fingerprint = staged.pending_plan?.fingerprint as string;
    const applied = await api<{ applied: boolean; deployed: boolean; deployError?: string }>(
      page,
      `/api/stacks/${stackName}/git-source/apply`,
      { method: 'POST', body: { commitSha: secondSha, planFingerprint: fingerprint, deploy: true } },
    );
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(applied.json).toMatchObject({ applied: true, deployed: true });
    expect(applied.json.deployError).toBeUndefined();
    expect((await settledGate(page)).status).toBe('passed');
    expect(runningRevision(stackName)).toBe('v2');

    const converged = await sourceView(page);
    expect(converged.last_applied_commit_sha).toBe(secondSha);
    expect(converged.pending_commit_sha).toBeNull();
    await expect.poll(async () => (await appRow(page)).posture, { timeout: 30_000, intervals: [1_000] }).toBe('converged_qualified');
    const row = await appRow(page);
    expect(row).toMatchObject({
      desiredCommitSha: secondSha,
      runtimeStatus: 'synced_and_healthy',
      healthStatus: 'passed',
    });
    expect(row.drift.count).toBe(0);

    // The authored project on disk is exactly the pushed one: both modified
    // files updated, the added file present, the deleted file gone.
    const fileText = async (path: string) => {
      const res = await api<{ content?: string }>(page, `/api/stacks/${stackName}/files/content?path=${encodeURIComponent(path)}`);
      return res.status === 200 ? (res.json.content ?? '') : null;
    };
    expect(await fileText('compose.yaml')).toContain('e2e.revision: v2');
    expect(await fileText('app.env')).toBe('MODE=two\n');
    expect(await fileText('config/new.conf')).toBe('new\n');
    expect(await fileText('config/legacy.conf')).toBeNull();

    // 8. Roll back: the previous authored project and its workload return.
    const rolledBack = await api<{ gitopsGenerationId: string | null }>(page, `/api/stacks/${stackName}/rollback`, {
      method: 'POST',
      body: {},
    });
    expect(rolledBack.status, JSON.stringify(rolledBack.json)).toBe(200);
    expect(rolledBack.json.gitopsGenerationId).toBeTruthy();
    expect(runningRevision(stackName)).toBe('v1');
    expect(await fileText('compose.yaml')).toContain('e2e.revision: v1');
    expect(await fileText('app.env')).toBe('MODE=one\n');
    expect(await fileText('config/legacy.conf')).toBe('legacy\n');
    expect(await fileText('config/new.conf')).toBeNull();
    const stages = (await history(page)).map((r) => r.stage);
    expect(stages).toContain('recovery_started');
    expect(stages).toContain('recovery_succeeded');
  });

  test('a rollback is health-verified like any other deploy', async ({ page }) => {
    // Expected to fail today: the rollback above restores the files and the
    // workload, but it never opens a health run of its own, so the application
    // keeps reading "health pending" and never reaches a converged posture.
    // Remove this marker when that is fixed; the assertion below is the
    // behavior to restore.
    test.fail(true, 'a rollback opens no health run, so the application health stays pending');
    await loginAs(page);
    await expect
      .poll(async () => (await appRow(page)).healthStatus, { timeout: 30_000, intervals: [2_000] })
      .toBe('passed');
  });
});
