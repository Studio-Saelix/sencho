/**
 * Blueprint digest drift, end to end.
 *
 * Places an Inline Blueprint on the local node, waits for its approved
 * artifact set to freeze to an exact digest, then recreates the service from a
 * different image so the runtime digest no longer matches. The Enforce-mode
 * reconciler records the digest drift on the deployment row and repairs the
 * target from the pinned approved digest (never a pull of a tag), and the
 * target reconverges: the Drift tab shows the approved digest as matching.
 *
 * The Blueprint authors its image by digest so the approved set freezes to an
 * exact identity without a registry round trip. Requires a Docker daemon on
 * the host; if the approved set still cannot be frozen to an exact or
 * qualified identity, the spec skips rather than asserting against an
 * unverified expectation.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect, Page } from '@playwright/test';
import { loginAs, waitForStacksLoaded } from './helpers';

const COMPOSE_DIR = process.env.E2E_COMPOSE_DIR ?? process.env.COMPOSE_DIR ?? '/tmp/compose';
const APPROVED_TAG = 'busybox:1.36';
const DRIFT_IMAGE = 'busybox:1.37';
// The reconciler ticks once a minute; each phase may need a full tick plus the
// deploy it triggers.
const TICK_WAIT_MS = 150_000;

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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

type ObservedIdentity = { kind: string; identity?: string };
type DriftTarget = {
  nodeId: number;
  runtime: { status: string };
  artifact: { status: string; expected?: { qualification: string; identity: string | null } | null };
  observedArtifactIdentity: ObservedIdentity;
};
type DriftReport = {
  gitopsRevision?: {
    targets?: DriftTarget[];
    };
};

async function localTarget(page: Page, stack: string): Promise<DriftTarget | null> {
  const res = await jsonRequest<DriftReport>(page, `/api/stacks/${stack}/drift`);
  if (res.status !== 200) return null;
  return res.body.gitopsRevision?.targets?.[0] ?? null;
}

function runningImageId(stack: string): string {
  const id = execFileSync('docker', [
    'ps', '-q',
    '--filter', `label=com.docker.compose.project=${stack.toLowerCase()}`,
    '--filter', 'label=com.docker.compose.service=app',
  ]).toString().trim().split('\n')[0];
  if (!id) return '';
  return execFileSync('docker', ['inspect', '--format', '{{.Image}}', id]).toString().trim();
}

function imageId(ref: string): string {
  return execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref]).toString().trim();
}

/**
 * Recreate the Blueprint's service from another image under the same Compose
 * project, leaving the Blueprint marker and revision untouched, so the only
 * divergence the reconciler can find is the runtime digest.
 */
function induceDigestDrift(stack: string): void {
  const stackDir = path.join(COMPOSE_DIR, stack);
  const composeFile = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']
    .map((f) => path.join(stackDir, f))
    .find((f) => fs.existsSync(f));
  if (!composeFile) throw new Error(`no compose file under ${stackDir}`);
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-digest-drift-'));
  const override = path.join(overrideDir, 'override.yaml');
  fs.writeFileSync(override, `services:\n  app:\n    image: ${DRIFT_IMAGE}\n`);
  try {
    execFileSync('docker', [
      'compose', '-p', stack.toLowerCase(), '--project-directory', stackDir,
      '-f', composeFile, '-f', override, 'up', '-d', '--force-recreate', 'app',
    ], { stdio: 'ignore' });
  } finally {
    fs.rmSync(overrideDir, { recursive: true, force: true });
  }
}

async function openDriftTab(page: Page, stack: string): Promise<void> {
  await page.reload();
  await waitForStacksLoaded(page);
  await page.getByText(stack, { exact: true }).first().click();
  await page.getByRole('tab', { name: 'Drift' }).click();
  await expect(page.getByTestId('drift-panel')).toBeVisible();
}

test.describe('Blueprint digest drift', () => {
  test.skip(!dockerAvailable(), 'Docker daemon is not available');

  let blueprintName: string;
  let blueprintId: number | null = null;
  // `busybox@sha256:...`, the repo digest of the approved tag on this host.
  let approvedRef: string;

  test.beforeAll(() => {
    execFileSync('docker', ['pull', '-q', APPROVED_TAG], { stdio: 'ignore' });
    execFileSync('docker', ['pull', '-q', DRIFT_IMAGE], { stdio: 'ignore' });
    approvedRef = execFileSync('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', APPROVED_TAG])
      .toString().trim();
  });

  test.beforeEach(async ({ page }) => {
    blueprintName = `e2e-bp-digest-${Date.now()}`;
    blueprintId = null;
    await loginAs(page);
  });

  test.afterEach(async ({ page }) => {
    if (blueprintId === null) return;
    await page.evaluate(async ({ id }) => {
      await fetch(`/api/blueprints/${id}/withdraw/1`, { method: 'POST', credentials: 'include' }).catch(() => {});
      await fetch(`/api/blueprints/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    }, { id: blueprintId });
    try {
      execFileSync('docker', ['compose', '-p', blueprintName.toLowerCase(), 'down', '--remove-orphans'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  });

  test('drift appears, Enforce repairs from the pinned digest, and the target reconverges', async ({ page }) => {
    test.setTimeout(8 * 60_000);

    const nodes = await jsonRequest<Array<{ id: number; type: string }>>(page, '/api/nodes');
    const local = nodes.body.find((n) => n.type === 'local');
    expect(local, 'a local node exists').toBeTruthy();

    const created = await jsonRequest<{ id: number }>(page, '/api/blueprints', {
      method: 'POST',
      body: {
        name: blueprintName,
        compose_content: `services:\n  app:\n    image: ${approvedRef}\n    command: ["sleep", "3600"]\n`,
        selector: { type: 'nodes', ids: [local!.id] },
        drift_mode: 'enforce',
      },
    });
    expect(created.status).toBe(201);
    blueprintId = created.body.id;

    const preview = await jsonRequest<{
      planFingerprint: string;
      gitopsFingerprint: string | null;
      confirmableActions: Array<{ nodeId: number; action: string }>;
    }>(page, `/api/blueprints/${blueprintId}/preview`);
    expect(preview.status).toBe(200);
    const applied = await jsonRequest<{ outcomeSummary: { ok: number } }>(page, `/api/blueprints/${blueprintId}/apply`, {
      method: 'POST',
      body: {
        planFingerprint: preview.body.planFingerprint,
        gitopsFingerprint: preview.body.gitopsFingerprint,
        actions: preview.body.confirmableActions,
      },
    });
    expect(applied.status).toBe(200);
    expect(applied.body.outcomeSummary.ok).toBe(1);

    // The approved set freezes after the first deploy. Until it holds an exact
    // or qualified identity, a digest comparison would be unverifiable.
    let expectedIdentity: string | null = null;
    const freezeDeadline = Date.now() + 90_000;
    while (expectedIdentity === null && Date.now() < freezeDeadline) {
      const target = await localTarget(page, blueprintName);
      const expected = target?.artifact.expected ?? null;
      if (expected && (expected.qualification === 'exact' || expected.qualification === 'qualified')) {
        expectedIdentity = expected.identity;
        break;
      }
      await page.waitForTimeout(2_000);
    }
    test.skip(expectedIdentity === null, 'approved digest could not be frozen on this host');

    const approvedImageId = imageId(APPROVED_TAG);
    expect(runningImageId(blueprintName)).toBe(approvedImageId);

    // 1. Drift appears: the running digest is no longer the approved one.
    const inducedAt = Date.now();
    induceDigestDrift(blueprintName);
    expect(runningImageId(blueprintName)).toBe(imageId(DRIFT_IMAGE));

    // 2. Enforce records the digest drift and repairs from the pinned digest.
    await expect.poll(async () => {
      const bp = await jsonRequest<{ deployments?: Array<{ node_id: number; last_drift_at: number | null; drift_summary: string | null }> }>(
        page, `/api/blueprints/${blueprintId}`,
      );
      const row = bp.body.deployments?.find((d) => d.node_id === local!.id);
      return row && row.last_drift_at !== null && row.last_drift_at >= inducedAt ? row.drift_summary : null;
    }, { timeout: TICK_WAIT_MS, intervals: [5_000] }).toMatch(/runtime artifact identity differs/);
    await expect.poll(() => runningImageId(blueprintName), { timeout: TICK_WAIT_MS, intervals: [5_000] })
      .toBe(approvedImageId);

    // The authored compose on disk is unchanged: the repair pins, it does not rewrite.
    const composeOnDisk = fs.readdirSync(path.join(COMPOSE_DIR, blueprintName))
      .filter((f) => /compose\.ya?ml$/.test(f))
      .map((f) => fs.readFileSync(path.join(COMPOSE_DIR, blueprintName, f), 'utf-8'))
      .join('\n');
    expect(composeOnDisk).toContain(approvedRef);
    expect(composeOnDisk).not.toContain(DRIFT_IMAGE);

    // 3. The target reconverges on the approved identity.
    await expect.poll(async () => {
      const target = await localTarget(page, blueprintName);
      if (!target) return 'missing';
      return target.observedArtifactIdentity.identity === expectedIdentity ? 'converged' : target.observedArtifactIdentity.kind;
    }, { timeout: TICK_WAIT_MS, intervals: [5_000] }).toBe('converged');

    await openDriftTab(page, blueprintName);
    await expect(page.getByTestId('gitops-target-digest').first()).toHaveAttribute('data-verdict', 'matches');
  });
});
