/**
 * Digest drift on a real Blueprint deployment.
 *
 * A tag is a promise, not an identity, so the drift this exercises is created
 * the way it happens in the field: the compose pins an approved image digest,
 * the running containers are then replaced with different content under the same
 * project, and Sencho must report the per-service digest difference, show both
 * digests on the Drift tab, and leave the approved identity where it was instead
 * of adopting whatever now answers to the tag.
 *
 * The image lives under a tag unique to this run, so the test never retags
 * anything another spec could be using, and the compose pins the digest the
 * runner already has locally, so the approved side needs no registry round trip.
 *
 * Needs the Docker CLI and Compose plugin, because making a running workload
 * diverge is a Docker operation. Skips only outside CI: in CI the runner is
 * required to have them, and a silent skip there would hide a broken environment.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function imageDigest(image: string): string {
  const digest = execFileSync('docker', ['image', 'inspect', image, '--format', '{{index .RepoDigests 0}}'], {
    stdio: 'pipe',
  })
    .toString()
    .trim();
  const at = digest.indexOf('@');
  if (at < 0) throw new Error(`${image} has no repo digest`);
  return digest.slice(at + 1);
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
    // A 204 carries no body, so parse defensively rather than failing cleanup
    // on the response shape.
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }, { url, method: init.method ?? 'GET', payload: init.body === undefined ? null : init.body });
}

interface NodeRow {
  id: number;
  type: string;
  compose_dir: string;
}

interface ServiceEvidence {
  serviceName: string;
  platformDigest: string | null;
}

interface DeploymentRow {
  status: string;
}

interface BlueprintDetail {
  deployments: DeploymentRow[];
  gitopsRevision?: { targets?: TargetRow[] } | null;
}

interface TargetRow {
  observedArtifactIdentity?: { kind: string; services?: ServiceEvidence[] };
  artifact?: { expected?: { services?: ServiceEvidence[] } | null } | null;
}

interface DriftPayload {
  gitopsRevision?: {
    targets?: TargetRow[];
  } | null;
}

test.describe('GitOps digest drift', () => {
  // Skips only outside CI. In CI a missing Docker or Compose is a broken
  // environment, and a skipped test would report as passing, so beforeAll is
  // left to fail loudly there instead.
  test.skip(!dockerAvailable() && !process.env.CI, 'Docker with the Compose plugin is not available');

  // Two reconciler passes are the slowest this can be: the first observation
  // after the deploy, and the one that sees the replaced workload. Each is up
  // to a minute, and the suite is serial, so this is wall clock, not CPU.
  test.setTimeout(420_000);

  const stamp = Date.now();
  const blueprintName = `e2e-digest-${stamp}`;
  // A tag of this run's own, so moving it cannot affect any other spec. The
  // approved content is nginx:alpine and the moved content is a different image
  // published under another tag: the alpine and mainline tags can resolve to the
  // same manifest, which would make the moved-tag scenario a no-op.
  const probeImage = `e2e-digest-probe:${stamp}`;
  const approvedImage = 'nginx:alpine';
  const movedImage = 'nginx:1.27';
  const overrideFile = `/tmp/e2e-digest-override-${stamp}.yaml`;
  let blueprintId: number | null = null;

  test.beforeAll(() => {
    execFileSync('docker', ['pull', '--quiet', approvedImage], { stdio: 'pipe' });
    execFileSync('docker', ['pull', '--quiet', movedImage], { stdio: 'pipe' });
    execFileSync('docker', ['tag', approvedImage, probeImage], { stdio: 'pipe' });
  });

  test.afterAll(() => {
    rmSync(overrideFile, { force: true });
    // Best effort by nature: the tag is this run's own, so a failure here leaves
    // nothing a later spec can collide with, and the next run tags a new name.
    try {
      execFileSync('docker', ['image', 'rm', '--force', probeImage], { stdio: 'pipe' });
    } catch {
      // already gone
    }
  });

  test('a replaced image digest is reported per service with both digests, and the approved identity holds', async ({ page }) => {
    await loginAs(page);

    const pinned = imageDigest(probeImage);
    const compose = `services:\n  web:\n    image: ${probeImage}@${pinned}\n`;

    const nodes = await jsonRequest<NodeRow[]>(page, '/api/nodes');
    expect(nodes.status).toBe(200);
    const local = nodes.body.find((node) => node.type === 'local');
    expect(local, 'expected a local node to target').toBeTruthy();
    const stackDir = `${local!.compose_dir}/${blueprintName}`;

    const created = await jsonRequest<{ id?: number; error?: string }>(page, '/api/blueprints', {
      method: 'POST',
      body: {
        name: blueprintName,
        compose_content: compose,
        selector: { type: 'nodes', ids: [local!.id] },
        drift_mode: 'observe',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    blueprintId = created.body.id as number;

    // Confirming a plan is a two-step dance against a live blueprint: the tick
    // can re-save the row between the preview and the confirm, which the server
    // refuses as stale. The UI refreshes and confirms again, so the spec does
    // the same rather than racing the tick.
    let applied: { status: number; body: { error?: string } } | null = null;
    for (let attempt = 0; attempt < 4 && applied?.status !== 200; attempt += 1) {
      const preview = await jsonRequest<{
        planFingerprint: string;
        gitopsFingerprint: string | null;
        executorActions: unknown[];
      }>(page, `/api/blueprints/${blueprintId}/preview`);
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      applied = await jsonRequest<{ error?: string }>(page, `/api/blueprints/${blueprintId}/apply`, {
        method: 'POST',
        body: {
          planFingerprint: preview.body.planFingerprint,
          // The apply confirms the authority evidence the preview displayed, so
          // the digest it showed has to be echoed back with the plan.
          ...(preview.body.gitopsFingerprint ? { gitopsFingerprint: preview.body.gitopsFingerprint } : {}),
          actions: preview.body.executorActions,
        },
      });
    }
    expect(applied?.status, JSON.stringify(applied?.body)).toBe(200);

    // The approved per-service digest exists once the deploy resolved it. The
    // approved value is read back from the projection rather than from the tag,
    // because the model compares against the digest it recorded, not against
    // whatever the tag resolves to at read time.
    let approved: string | null = null;
    await expect.poll(async () => {
      const detail = await jsonRequest<BlueprintDetail>(page, `/api/blueprints/${blueprintId}`);
      const active = detail.body.deployments.some((row) => row.status === 'active');
      const services = detail.body.gitopsRevision?.targets?.[0]?.artifact?.expected?.services;
      const digest = services?.length ? services[0]?.platformDigest ?? null : null;
      approved = digest;
      return active && digest ? digest : null;
    }, { timeout: 120_000, intervals: [1_000] }).toMatch(/^sha256:[0-9a-f]{64}$/i);
    if (approved === null) throw new Error('the approved digest was never recorded');

    // Replace the running workload with different content under the same
    // project. The compose on disk still pins the approved digest, so the only
    // thing that changed is what is actually running.
    execFileSync('docker', ['tag', movedImage, probeImage], { stdio: 'pipe' });
    writeFileSync(overrideFile, `services:\n  web:\n    image: ${probeImage}\n`);
    execFileSync(
      'docker',
      [
        'compose', '-p', blueprintName,
        '-f', `${stackDir}/compose.yaml`,
        '-f', overrideFile,
        'up', '-d', '--force-recreate', '--pull', 'never',
      ],
      { stdio: 'pipe' },
    );
    // The reconciler observes the replaced workload on its next pass, up to a
    // minute out, and records the deployment as drifted when the running digest
    // no longer matches the approved one.
    let projected: DriftPayload['gitopsRevision'] = null;
    let deploymentStatus: string | null = null;
    await expect.poll(async () => {
      const drift = await jsonRequest<DriftPayload>(page, `/api/stacks/${blueprintName}/drift`);
      projected = drift.body.gitopsRevision;
      const observed = projected?.targets?.[0]?.observedArtifactIdentity?.services?.[0]?.platformDigest;
      const detail = await jsonRequest<BlueprintDetail>(page, `/api/blueprints/${blueprintId}`);
      deploymentStatus = detail.body.deployments[0]?.status ?? null;
      return Boolean(observed && observed !== approved && deploymentStatus === 'drifted');
    }, { timeout: 180_000, intervals: [2_000] }).toBe(true);

    const expectedServices = projected?.targets?.[0]?.artifact?.expected?.services ?? [];
    const observedServices = projected?.targets?.[0]?.observedArtifactIdentity?.services ?? [];
    expect(expectedServices.length, 'expected per-service digests in the projection').toBeGreaterThan(0);
    expect(observedServices.length, 'expected observed per-service digests in the projection').toBeGreaterThan(0);
    // The approved identity did not move: only what is running did. The canonical
    // drift list does not carry this case today; the deployment row and the
    // per-service comparison are where it is reported.
    const running = observedServices[0]?.platformDigest ?? null;
    if (running === null) throw new Error('the observation recorded no digest to compare');
    expect(expectedServices[0]?.platformDigest).toBe(approved);
    expect(running).not.toBe(approved);
    expect(deploymentStatus).toBe('drifted');

    // The Drift tab shows the same comparison, per service, with both digests.
    await page.goto(`/nodes/local/stacks/${blueprintName}`);
    await page.getByRole('tab', { name: 'Anatomy' }).click();
    await page.getByRole('tab', { name: 'Drift' }).click();
    const digestRow = page.getByTestId('gitops-digest-row').first();
    await expect(digestRow).toBeVisible({ timeout: 20_000 });
    await expect(digestRow).toHaveAttribute('data-state', 'drifted');
    await expect(digestRow).toContainText('approved');
    await expect(digestRow).toContainText('running');
    const short = (digest: string) => digest.slice('sha256:'.length, 'sha256:'.length + 12);
    await expect(digestRow).toContainText(short(approved));
    await expect(digestRow).toContainText(short(running));

    // The moved image is reported, never adopted: the tag answering differently
    // does not become the expectation anywhere in the projection.
    const afterUi = await jsonRequest<DriftPayload>(page, `/api/stacks/${blueprintName}/drift`);
    const stillApproved = afterUi.body.gitopsRevision?.targets?.[0]?.artifact?.expected?.services?.[0]?.platformDigest;
    expect(stillApproved).toBe(approved);
  });

  test.afterEach(async ({ page }) => {
    if (blueprintId === null) return;
    const id = blueprintId;
    blueprintId = null;
    // Asserted rather than swallowed: a Blueprint left behind keeps its stack
    // and its reconciler row alive for every spec that runs after this one.
    const deleted = await jsonRequest<unknown>(page, `/api/blueprints/${id}`, { method: 'DELETE' });
    expect([200, 204]).toContain(deleted.status);
  });
});
