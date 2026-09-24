/**
 * Digest drift on a real Blueprint deployment.
 *
 * A tag is a promise, not an identity, so the drift this exercises is created
 * the way it happens in the field: the compose pins an approved image digest,
 * the running containers are then replaced with a different image, and Sencho
 * must report the per-service digest difference, show both digests on the Drift
 * tab, and leave the approved identity where it was instead of adopting whatever
 * is actually running.
 *
 * The approved digest is discovered from `nginx:alpine` and the digest the
 * workload is moved to is discovered from `nginx:1.27`, both of them real
 * upstream tags of one repository. A locally invented repository cannot work
 * here, for a reason that showed up as a CI-only failure: the observation
 * filters the running image's repo digests by the authored repository, so an
 * invented repository never yields an observed digest at all, and a reference no
 * registry knows can only be satisfied by whatever the local Docker version
 * feels like doing with it. Pinning a real repository by digest keeps the
 * approved side resolvable from the local content store without a registry call,
 * and keeps the moved side a real digest difference rather than an unresolved
 * one.
 *
 * Needs the Docker CLI and Compose plugin, because making a running workload
 * diverge is a Docker operation. A machine with no `docker` executable at all
 * skips the spec outside CI only: in CI the runner is required to have it, and a
 * silent skip there would hide a broken environment. A Docker that is installed
 * but unusable, including a missing Compose plugin, fails loudly instead of
 * skipping, so a broken environment never reads as a pass.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers';

const DOCKER_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' });
    execFileSync('docker', ['compose', 'version'], { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' });
    return true;
  } catch (error) {
    if (isMissingExecutable(error)) return false;
    // Present but unusable is an environment fault, not a reason to skip.
    throw error;
  }
}

function imageRepository(image: string): string {
  const withoutDigest = image.split('@')[0] ?? image;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

/**
 * Every repo digest the local image carries for its own repository. The backend
 * selects observed digests the same way, by repository, so the spec reads them
 * the same way instead of trusting Docker's ordering.
 */
function repoDigests(image: string): string[] {
  const repo = imageRepository(image);
  const raw = execFileSync(
    'docker',
    ['image', 'inspect', image, '--format', '{{json .RepoDigests}}'],
    { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' },
  )
    .toString()
    .trim();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${image} reported no repo digests`);
  const digests: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const at = entry.indexOf('@');
    if (at < 0) continue;
    const entryRepo = imageRepository(entry.slice(0, at));
    const digest = entry.slice(at + 1);
    if (entryRepo !== repo || !DIGEST_RE.test(digest) || digests.includes(digest)) continue;
    digests.push(digest);
  }
  if (digests.length === 0) throw new Error(`${image} has no repo digest for ${repo}`);
  return digests;
}

/**
 * The image reference the project's running container was created from, read
 * from the daemon. Compose normalizes the reference it stores, so callers match
 * on the digest rather than on the whole string.
 */
function containerImageReference(project: string, service: string): string {
  const containers = execFileSync(
    'docker',
    [
      'ps',
      '--filter', `label=com.docker.compose.project=${project.toLowerCase()}`,
      '--filter', `label=com.docker.compose.service=${service}`,
      '--filter', 'status=running',
      '--format', '{{.ID}}',
    ],
    { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' },
  )
    .toString()
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  // Exactly one, so a stray duplicate or a one-off container can never be
  // mistaken for the workload this compose file defines.
  if (containers.length !== 1) {
    throw new Error(
      `expected one running ${service} container for project ${project}, found ${containers.length}`,
    );
  }
  const [container] = containers;
  if (container === undefined) {
    throw new Error(`expected one running ${service} container for project ${project}, found none`);
  }
  return execFileSync('docker', ['inspect', '--format', '{{.Config.Image}}', container], {
    timeout: DOCKER_TIMEOUT_MS,
    stdio: 'pipe',
  })
    .toString()
    .trim();
}

async function jsonRequest<T>(
  page: Page,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ url, method, payload, timeout }) => {
      const res = await fetch(url, {
        method,
        credentials: 'include',
        signal: AbortSignal.timeout(timeout),
        ...(payload === null
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      });
      // A 204 carries no body, so parse defensively rather than failing cleanup
      // on the response shape.
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    },
    { url, method: init.method ?? 'GET', payload: init.body === undefined ? null : init.body, timeout: REQUEST_TIMEOUT_MS },
  );
}

/** Reads a 200 or the test fails with the server's own words, not a timeout. */
function expectOk<T>(response: { status: number; body: T }, what: string): T {
  expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
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

interface PreviewPayload {
  planFingerprint: string;
  gitopsFingerprint: string | null;
  confirmableActions: unknown[];
}

interface ApplyPayload {
  error?: string;
  code?: string;
}

interface BlueprintDetail {
  deployments: DeploymentRow[];
  gitopsRevision?: { targets?: TargetRow[] } | null;
}

interface TargetRow {
  observedArtifactIdentity?: { kind: string; services?: ServiceEvidence[] } | null;
  artifact?: { expected?: { services?: ServiceEvidence[] } | null } | null;
}

interface DriftPayload {
  gitopsRevision?: {
    targets?: TargetRow[];
  } | null;
}

test.describe('GitOps digest drift', () => {
  test.skip(!dockerAvailable() && !process.env.CI, 'Docker with the Compose plugin is not available');

  // The reconciler ticks once a minute, so the drift poll covers a tick and the
  // observation that follows it, and the baseline poll covers the compose run.
  // These are ceilings rather than expected durations: the happy path takes about
  // half a minute, and the CI job has a whole-suite budget to protect.
  test.setTimeout(360_000);

  const stamp = Date.now();
  const blueprintName = `e2e-digest-${stamp}`;
  // Two real tags of one repository, pinned by digest and then swapped, so the
  // approved reference resolves locally and the observed digest matches the
  // authored repository. The digests themselves are read from the daemon, never
  // assumed, because either tag can move.
  const approvedImage = 'nginx:alpine';
  const movedImage = 'nginx:1.27';
  const overrideFile = `/tmp/e2e-digest-override-${stamp}.yaml`;
  let blueprintId: number | null = null;

  test.beforeAll(() => {
    execFileSync('docker', ['pull', '--quiet', approvedImage], { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' });
    execFileSync('docker', ['pull', '--quiet', movedImage], { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' });
  });

  test.afterAll(() => {
    rmSync(overrideFile, { force: true });
  });

  test('a replaced image digest is reported per service with both digests, and the approved identity holds', async ({ page }) => {
    await loginAs(page);

    const approvedDigests = repoDigests(approvedImage);
    const movedDigests = repoDigests(movedImage);
    const [pinned] = approvedDigests;
    if (pinned === undefined) throw new Error(`${approvedImage} reported no repo digest`);
    const shared = movedDigests.filter((digest) => approvedDigests.includes(digest));
    // Two tags of one repository can resolve to the same manifest, which would
    // make the moved-image scenario a no-op. Failing here names the cause
    // instead of leaving it to surface as a poll timeout.
    expect(
      shared,
      `${approvedImage} and ${movedImage} resolve to the same digest, so nothing would drift`,
    ).toEqual([]);
    const approvedRef = `nginx@${pinned}`;
    const compose = `services:\n  web:\n    image: ${approvedRef}\n`;

    const nodes = expectOk(await jsonRequest<NodeRow[]>(page, '/api/nodes'), 'listing nodes');
    const local = nodes.find((node) => node.type === 'local');
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
    expect(created.status, `creating the blueprint: ${JSON.stringify(created.body)}`).toBe(201);
    if (typeof created.body.id !== 'number') {
      throw new Error(`the create response carried no blueprint id: ${JSON.stringify(created.body)}`);
    }
    blueprintId = created.body.id;

    // Confirming a plan is a two-step dance against a live blueprint: the tick
    // can re-save the row between the preview and the confirm, which the server
    // refuses with PREVIEW_STALE. That one case is worth retrying with a fresh
    // preview, because the UI asks the operator to confirm again. Any other
    // failure is reported as it is, since retrying it would only repeat it.
    let applied: { status: number; body: ApplyPayload } | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const preview = expectOk(
        await jsonRequest<PreviewPayload>(page, `/api/blueprints/${blueprintId}/preview`),
        'previewing the plan',
      );
      const result = await jsonRequest<ApplyPayload>(page, `/api/blueprints/${blueprintId}/apply`, {
        method: 'POST',
        body: {
          planFingerprint: preview.planFingerprint,
          // The apply confirms the authority evidence the preview displayed, so
          // what it showed has to be echoed back with the plan.
          ...(preview.gitopsFingerprint ? { gitopsFingerprint: preview.gitopsFingerprint } : {}),
          actions: preview.confirmableActions,
        },
      });
      applied = result;
      if (result.status === 200) break;
      if (result.status !== 409 || result.body.code !== 'PREVIEW_STALE') break;
    }
    expect(applied?.status, `applying the plan: ${JSON.stringify(applied?.body)}`).toBe(200);

    // Only the projection is read after its poll, so it is the only field that
    // needs to outlive the callbacks that fill it.
    const state: { projected: DriftPayload['gitopsRevision'] } = { projected: null };

    // The baseline has to be proven, not assumed, because a deployment row goes
    // active before any drift check runs, and a mismatch that was already there
    // at deploy time would otherwise be credited to the override below.
    //
    // The proof is read from the daemon rather than from the projection on
    // purpose. The projection's runtime observation is only recorded on a
    // reconciler tick, so waiting for it would spend a whole extra minute to
    // learn something the daemon already knows, and the CI job has a whole-suite
    // budget to protect. What the container was actually created from is the
    // ground truth for "what is running", and it is one fast call.
    await expect
      .poll(
        async () => {
          const detail = expectOk(
            await jsonRequest<BlueprintDetail>(page, `/api/blueprints/${blueprintId}`),
            'reading the blueprint',
          );
          const approved =
            detail.gitopsRevision?.targets?.[0]?.artifact?.expected?.services?.[0]?.platformDigest ?? null;
          return approved === pinned && detail.deployments.some((row) => row.status === 'active');
        },
        { timeout: 150_000, intervals: [1_000] },
      )
      .toBe(true);

    const runningBefore = containerImageReference(blueprintName, 'web');
    expect(
      runningBefore,
      'the deploy must run the approved reference, or the override proves nothing',
    ).toContain(`nginx@${pinned}`);

    // Replace the running workload under the same project. The compose on disk
    // still pins the approved digest, so the only thing that changed is what is
    // actually running.
    writeFileSync(overrideFile, `services:\n  web:\n    image: ${movedImage}\n`);
    execFileSync(
      'docker',
      [
        'compose', '-p', blueprintName,
        '-f', `${stackDir}/compose.yaml`,
        '-f', overrideFile,
        'up', '-d', '--force-recreate', '--pull', 'never',
      ],
      { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' },
    );
    // The reconciler observes the replaced workload on its next pass, up to a
    // minute out, and records the deployment as drifted when the running digest
    // no longer matches the approved one.
    await expect
      .poll(
        async () => {
          const drift = expectOk(
            await jsonRequest<DriftPayload>(page, `/api/stacks/${blueprintName}/drift`),
            'reading drift',
          );
          state.projected = drift.gitopsRevision;
          const observed =
            state.projected?.targets?.[0]?.observedArtifactIdentity?.services?.[0]?.platformDigest
            ?? null;
          const detail = expectOk(
            await jsonRequest<BlueprintDetail>(page, `/api/blueprints/${blueprintId}`),
            'reading the blueprint',
          );
          const drifted = detail.deployments.some((row) => row.status === 'drifted');
          return observed !== null && movedDigests.includes(observed) && drifted;
        },
        { timeout: 150_000, intervals: [2_000] },
      )
      .toBe(true);

    const expectedServices = state.projected?.targets?.[0]?.artifact?.expected?.services ?? [];
    const observedServices =
      state.projected?.targets?.[0]?.observedArtifactIdentity?.services ?? [];
    expect(expectedServices.length, 'expected per-service digests in the projection').toBeGreaterThan(0);
    expect(observedServices.length, 'expected observed per-service digests in the projection').toBeGreaterThan(0);
    // The approved identity did not move: only what is running did. The
    // canonical drift list does not carry this case today; the deployment row
    // and the per-service comparison are where it is reported.
    const running = observedServices[0]?.platformDigest ?? null;
    if (running === null) throw new Error('the observation recorded no digest to compare');
    expect(expectedServices[0]?.platformDigest, 'the expectation never moved').toBe(pinned);
    expect(running, 'the report names the digest that is actually running').not.toBe(pinned);

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
    await expect(digestRow).toContainText(short(pinned));
    await expect(digestRow).toContainText(short(running));

    // The moved image is reported, never adopted: the expectation stays pinned to
    // the digest the compose declared, so the running image cannot become the
    // approved identity anywhere in the projection.
    const afterUi = expectOk(
      await jsonRequest<DriftPayload>(page, `/api/stacks/${blueprintName}/drift`),
      'reading drift after the UI check',
    );
    const stillApproved =
      afterUi.gitopsRevision?.targets?.[0]?.artifact?.expected?.services?.[0]?.platformDigest;
    expect(stillApproved, 'reading the expectation must not adopt the running image').toBe(pinned);
  });

  test.afterEach(async ({ page }) => {
    if (blueprintId === null) return;
    const id = blueprintId;
    // Asserted rather than swallowed, and the id is only cleared once the delete
    // is confirmed, so a failed teardown cannot quietly leave a live stack and a
    // reconciler row behind for every spec that runs after this one.
    const deleted = await jsonRequest<unknown>(page, `/api/blueprints/${id}`, { method: 'DELETE' });
    expect([200, 204], `deleting the blueprint: ${JSON.stringify(deleted.body)}`).toContain(
      deleted.status,
    );
    blueprintId = null;
    // The API reports success even when Compose teardown did not, so the
    // containers are checked directly rather than trusting the status alone.
    const remaining = execFileSync(
      'docker',
      [
        'ps', '-a',
        '--filter', `label=com.docker.compose.project=${blueprintName.toLowerCase()}`,
        '--format', '{{.Names}}',
      ],
      { timeout: DOCKER_TIMEOUT_MS, stdio: 'pipe' },
    )
      .toString()
      .trim();
    expect(remaining, 'the deleted blueprint left containers behind').toBe('');
  });
});
