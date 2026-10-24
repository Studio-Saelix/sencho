/**
 * A drifted Inline deployment must be re-examined until it converges.
 *
 * The reconciler writes `correcting` before it attempts a drift repair, so every
 * repair path that refuses without writing a terminal status used to strand the
 * row there: `computeDecision` skips in-flight states and the projection renders
 * them informational, so no later tick re-checked, no repair was retried, and a
 * workload running the wrong image sat unrepaired behind a single alert.
 *
 * These drive the real tick. What is under test is what the reconciler does with
 * a refused repair, so the repair preconditions are left real where they can be
 * (the digest pin builder genuinely refuses) and stubbed only where the refusal
 * is the thing under test (lock contention).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { intentFingerprint, serializeApprovedBlast } from '../services/blueprintApproval';
import type { Blueprint, Node } from '../services/DatabaseService';
import type { ReconcileDecision } from '../services/BlueprintReconciler';

type ReconcilerWithCompute = {
  computeDecision: (blueprint: Blueprint, allNodes: Node[]) => ReconcileDecision;
};

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let NotificationService: typeof import('../services/NotificationService').NotificationService;
let buildBlueprintPreview: typeof import('../services/blueprintPreviewProjection').buildBlueprintPreview;
let counter = 0;

const DRIFT_REASON = 'runtime artifact identity differs from the expected artifact set';
const PIN_REFUSAL = 'approved digest unavailable for digest repair';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ BlueprintService } = await import('../services/BlueprintService'));
  ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));
  ({ NotificationService } = await import('../services/NotificationService'));
  ({ buildBlueprintPreview } = await import('../services/blueprintPreviewProjection'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM blueprint_deployments').run();
  db.prepare('DELETE FROM blueprints').run();
  db.prepare('DELETE FROM node_labels').run();
  db.prepare("DELETE FROM nodes WHERE is_default = 0").run();
  counter += 1;
});

function seedNode(): Node {
  counter += 1;
  const nodeId = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`retry-node-${counter}`, Date.now()).lastInsertRowid as number;
  return DatabaseService.getInstance().getNode(nodeId)!;
}

function seedDriftBlueprint(node: Node, driftMode: 'enforce' | 'suggest' = 'enforce'): Blueprint {
  counter += 1;
  return DatabaseService.getInstance().createBlueprint({
    name: `retry-bp-${counter}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:alpine\n',
    selector: { type: 'nodes', ids: [node.id] },
    drift_mode: driftMode,
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  });
}

/** Approve the place outcome the operator confirmed, as Confirm persists it. */
function approvePlace(blueprint: Blueprint, nodeId: number): void {
  DatabaseService.getInstance().setBlueprintApproval(blueprint.id, {
    intentFingerprint: intentFingerprint(blueprint),
    blastJson: serializeApprovedBlast([{ nodeId, outcome: 'place' }]),
    approvedBy: 'tester',
  });
}

function writeRow(blueprint: Blueprint, nodeId: number, status: string, extra: Record<string, unknown> = {}): void {
  DatabaseService.getInstance().upsertDeployment({
    blueprint_id: blueprint.id,
    node_id: nodeId,
    status,
    applied_revision: blueprint.revision,
    last_deployed_at: Date.now(),
    drift_summary: DRIFT_REASON,
    last_drift_at: Date.now(),
    ...extra,
  } as Parameters<typeof DatabaseService.prototype.upsertDeployment>[0]);
}

/** The drift a digest mismatch produces, counted so a retry is observable. */
function countDriftChecks(): { calls: () => number } {
  let calls = 0;
  vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockImplementation(async () => {
    calls += 1;
    return { kind: 'drifted', reason: DRIFT_REASON, cause: 'digest' };
  });
  return { calls: () => calls };
}

function countAlerts(): { categories: () => string[] } {
  const categories: string[] = [];
  vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockImplementation(async (_level, category) => {
    categories.push(category);
    return { persisted: true };
  });
  return { categories: () => categories };
}

describe('a refused drift repair does not strand the deployment', () => {
  it('keeps the row drifted and retries on the next tick when the approved digest is unavailable', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    const checks = countDriftChecks();
    const alerts = countAlerts();
    // The real digest repair, with no comparable approved artifact set behind
    // it: it refuses before it can touch the node, which is the shape of every
    // refusal that writes no status of its own.
    const repair = vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair');

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    const afterFirst = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);

    expect(afterFirst?.status).toBe('drifted');
    expect(afterFirst?.drift_summary).toBe(DRIFT_REASON);
    expect(afterFirst?.last_error).toBeTruthy();
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);
    expect(repair).toHaveBeenCalledTimes(1);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    // The next tick re-checks and re-attempts rather than skipping a row it
    // believes is still in flight.
    expect(checks.calls()).toBe(2);
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it('returns the row to drifted when another operation holds the deploy lock', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    const checks = countDriftChecks();
    const alerts = countAlerts();
    // Lock contention answers pending without writing anything: the attempt was
    // never made, so the drift is still owed.
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair').mockResolvedValue({ status: 'pending' } as never);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    const afterFirst = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
    expect(afterFirst?.status).toBe('drifted');
    // Losing the lock for a moment is a deferral, not a failure, and it carries
    // no message of its own. The row is left saying whatever it last actually
    // failed with, because that text is the replay key, and the operator is not
    // paged about a race they cannot act on.
    expect(afterFirst?.last_error, 'a deferral does not overwrite what the row last failed with').toBeFalsy();
    expect(alerts.categories()).toEqual([]);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    expect(checks.calls()).toBe(2);
    expect(alerts.categories(), 'still silent on the retry').toEqual([]);
  });

  it('settles a container-level refusal, which takes the other repair path', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    const alerts = countAlerts();
    // A stopped container is the other drift cause, and it repairs through
    // deployToNode rather than the digest path, so a refusal has to settle the
    // same way whichever method ran.
    const message = 'service "web" exited with code 1';
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode')
      .mockResolvedValue({ status: 'failed', error: message } as never);
    let checks = 0;
    vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockImplementation(async () => {
      checks += 1;
      return { kind: 'drifted', reason: 'no containers running for this blueprint', cause: 'container' };
    });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    const afterFirst = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);

    expect(deploy, 'a container-level drift repairs through the deploy path').toHaveBeenCalledTimes(1);
    expect(afterFirst?.status).toBe('drifted');
    expect(afterFirst?.last_error).toBe(message);
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    expect(checks, 'the retry re-checks the node').toBe(2);
    expect(deploy, 'and re-attempts the repair').toHaveBeenCalledTimes(2);
    expect(alerts.categories(), 'and does not page about the same refusal twice').toEqual([
      'blueprint_drift_correction_failed',
    ]);
  });

  it('alerts on the first failure a deploy recorded itself, because that failure is new', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    const checks = countDriftChecks();
    const alerts = countAlerts();
    // What a repair that reaches a deploy actually does when compose fails: it
    // writes its own terminal status and its own last_error, and it returns the
    // very same string. Reading the row afterwards would therefore find the
    // failure already sitting there and mistake a new incident for a repeat.
    const message = 'service "web" failed to start: port 80 is already allocated';
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair').mockImplementation(async () => {
      writeRow(blueprint, node.id, 'failed', { drift_summary: null, last_error: message });
      return { status: 'failed', error: message } as never;
    });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status).toBe('failed');
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);

    // The row is the deploy bucket's now, so the drift path is not re-entered.
    // One alert for the incident is the whole promise, not one per tick.
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);
    expect(checks.calls(), 'a failed row is retried as a deploy, not as a drift check').toBe(1);
  });

  it('alerts once for a name conflict and does not re-repair the blocked row', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    const alerts = countAlerts();
    const repair = vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair').mockImplementation(async () => {
      writeRow(blueprint, node.id, 'name_conflict', {
        drift_summary: null,
        last_error: 'A stack named this already exists on this node and is not managed by Sencho.',
      });
      return { status: 'name_conflict', error: 'name_conflict' } as never;
    });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status).toBe('name_conflict');
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);
    // A name conflict is in-flight as far as the decision is concerned, so the
    // second tick never reaches the repair again and cannot alert again.
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('leaves a name conflict the repair already recorded alone', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    const alerts = countAlerts();
    // A deploy that reaches the name check writes name_conflict itself, so the
    // row is already the blocker and must not be rewritten back to drifted.
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair').mockImplementation(async () => {
      writeRow(blueprint, node.id, 'name_conflict', {
        drift_summary: null,
        last_error: 'A stack named this already exists on this node and is not managed by Sencho.',
      });
      return { status: 'name_conflict', error: 'name_conflict' } as never;
    });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status).toBe('name_conflict');
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);
  });

  it('settles a repair that throws, which is a refusal that reached no deploy', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    const checks = countDriftChecks();
    const alerts = countAlerts();
    // Resolving a remote node's platform label is a network call made before any
    // deploy, so a repair can throw with nothing written at all. Left unhandled
    // the throw escapes to the per-blueprint catch with the row still correcting.
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair')
      .mockRejectedValue(new Error('getaddrinfo ENOTFOUND leaf.example.test'));

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    const afterFirst = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);

    expect(afterFirst?.status).toBe('drifted');
    expect(afterFirst?.last_error).toMatch(/ENOTFOUND/);
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    expect(checks.calls(), 'the tick after a thrown repair still re-checks').toBe(2);
    expect(alerts.categories(), 'and the same throw is not reported twice').toEqual([
      'blueprint_drift_correction_failed',
    ]);
  });

  it('alerts again when the same failure returns after the drift converged', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    const alerts = countAlerts();
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair')
      .mockResolvedValue({ status: 'failed', error: PIN_REFUSAL } as never);
    const drift = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift')
      .mockResolvedValue({ kind: 'drifted', reason: DRIFT_REASON, cause: 'digest' });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    // The cause clears on its own, so the next check finds the target matching
    // and the row goes back to active. That has to forget the failure: it is
    // repaired, and a later failure of the same kind is a new incident.
    drift.mockResolvedValue({ kind: 'matched' });
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    const converged = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
    expect(converged?.status).toBe('active');
    expect(converged?.last_error, 'a converged row carries no failure').toBeNull();

    // The same refusal happens again later on a fresh drift.
    writeRow(blueprint, node.id, 'drifted');
    drift.mockResolvedValue({ kind: 'drifted', reason: DRIFT_REASON, cause: 'digest' });
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(alerts.categories()).toEqual([
      'blueprint_drift_correction_failed',
      'blueprint_drift_correction_failed',
    ]);
  });

  it('does not report an already-reported failure again just because a lock was lost in between', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    const alerts = countAlerts();
    const repair = vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair')
      .mockResolvedValue({ status: 'failed', error: PIN_REFUSAL } as never);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);

    // A concurrent operation takes the deploy lock for one tick.
    repair.mockResolvedValue({ status: 'pending' } as never);
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    const deferred = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
    expect(deferred?.status).toBe('drifted');
    expect(alerts.categories(), 'a lost lock race is not news').toEqual([
      'blueprint_drift_correction_failed',
    ]);

    // The same refusal comes back. It is the failure already reported, so the
    // note about the race must not have displaced it from the row.
    repair.mockResolvedValue({ status: 'failed', error: PIN_REFUSAL } as never);
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);
  });

  it('names the directory in the alert when a name conflict blocks the repair for good', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    const messages: string[] = [];
    vi.spyOn(NotificationService.getInstance(), 'dispatchAlert')
      .mockImplementation(async (_level, _category, message) => {
        messages.push(message);
        return { persisted: true };
      });
    // The real name-conflict path returns the bare shorthand but writes the
    // sentence onto the row, and the row then stays blocked for good.
    const sentence = 'A stack named "retry-bp" already exists on this node and is not managed by Sencho.';
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair').mockImplementation(async () => {
      writeRow(blueprint, node.id, 'name_conflict', { drift_summary: null, last_error: sentence });
      return { status: 'name_conflict', error: 'name_conflict' } as never;
    });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(messages).toHaveLength(1);
    expect(messages[0], 'the one alert this operator gets has to be actionable').toContain(sentence);
  });

  it('stays silent when the target converged while the repair was in flight', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    const alerts = countAlerts();
    // Someone else converged the target while this tick's repair was running, so
    // there is no drift left for this failure to be about.
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair').mockImplementation(async () => {
      writeRow(blueprint, node.id, 'active', { drift_summary: null, last_drift_at: null });
      return { status: 'failed', error: 'service "web" failed to start' } as never;
    });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status).toBe('active');
    expect(alerts.categories(), 'a healthy target is not paged about a stale failure').toEqual([]);
  });

  it('settles a refusal on a Git-managed blueprint, which repairs by reapplying the generation', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    DatabaseService.getInstance().updateBlueprintContentOrigin(blueprint.id, 'git', 'app-git-managed');
    const gitBlueprint = DatabaseService.getInstance().getBlueprint(blueprint.id)!;
    approvePlace(gitBlueprint, node.id);
    writeRow(gitBlueprint, node.id, 'drifted');
    const alerts = countAlerts();
    // Container drift, not a frozen-image disagreement, so the dispatch reaches
    // the Git-managed branch. Git-managed content has no authored compose to
    // deploy, so its repair is the authorized reapply, and it has to settle the
    // same way or a Git-managed target strands exactly like an Inline one.
    vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({
      kind: 'drifted', reason: 'no containers running for this blueprint', cause: 'container',
    });
    const reapply = vi.spyOn(BlueprintService.getInstance(), 'reapplyAuthorizedMaterialization')
      .mockResolvedValue({ status: 'failed', error: 'acknowledged generation missing for authorized reapply' } as never);
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode');

    await BlueprintReconciler.getInstance().reconcileOne(gitBlueprint.id);

    expect(reapply, 'a Git-managed drift repairs by reapplying, not by deploying authored compose').toHaveBeenCalledTimes(1);
    expect(deploy).not.toHaveBeenCalled();
    const after = DatabaseService.getInstance().getDeployment(gitBlueprint.id, node.id);
    expect(after?.status).toBe('drifted');
    expect(after?.last_error).toMatch(/acknowledged generation missing/);
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);
  });

  it('keeps the original drift timestamp when a later tick re-observes the same drift', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    countAlerts();
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair')
      .mockResolvedValue({ status: 'failed', error: PIN_REFUSAL } as never);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    const firstSeen = DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.last_drift_at;
    expect(firstSeen, 'the first observation stamps when the drift began').toBeTruthy();

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    // The drift episode began at the first observation. Restamping on every tick
    // made a drift that outlived one tick report itself as just found, forever,
    // which is the one thing the drift age on the row exists to say.
    const dep = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
    expect(dep?.last_drift_at).toBe(firstSeen);
  });

  it('alerts once for a failure that persists instead of once per tick', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    const alerts = countAlerts();
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair').mockResolvedValue({
      status: 'failed',
      error: PIN_REFUSAL,
    } as never);

    for (let tick = 0; tick < 3; tick++) {
      await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    }

    // Retrying every tick is the point; paging the operator every tick is not.
    expect(alerts.categories()).toEqual(['blueprint_drift_correction_failed']);
    expect(DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status).toBe('drifted');
  });

  it('alerts again when the failure changes, because a different refusal needs a different fix', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    const alerts = countAlerts();
    const repair = vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair')
      .mockResolvedValue({ status: 'failed', error: PIN_REFUSAL } as never);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    repair.mockResolvedValue({ status: 'failed', error: 'compose up failed' } as never);
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(alerts.categories()).toEqual([
      'blueprint_drift_correction_failed',
      'blueprint_drift_correction_failed',
    ]);
  });

  it('leaves a successful repair to the deploy path that already wrote the row', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'drifted');
    countDriftChecks();
    const alerts = countAlerts();
    // What a successful repair does: the deploy writes active and clears drift.
    vi.spyOn(BlueprintService.getInstance(), 'enforceDigestRepair').mockImplementation(async () => {
      writeRow(blueprint, node.id, 'active', {
        drift_summary: null,
        last_drift_at: null,
        last_error: null,
      });
      return { status: 'active' } as never;
    });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    const dep = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
    expect(dep?.status).toBe('active');
    expect(dep?.drift_summary).toBeNull();
    expect(alerts.categories()).toEqual([]);
  });
});

describe('a drifted row is a drift-check target in its own right', () => {
  it('enters the drift-check bucket when its applied revision still matches', () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    writeRow(blueprint, node.id, 'drifted');

    const decision = (BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute)
      .computeDecision(blueprint, DatabaseService.getInstance().getNodes());

    expect(decision.check.map((n) => n.id)).toContain(node.id);
    expect(decision.deploy).toEqual([]);
    expect(decision.withdraw).toEqual([]);
  });

  it('keeps an in-flight row out of every bucket', () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    writeRow(blueprint, node.id, 'correcting');

    const decision = (BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute)
      .computeDecision(blueprint, DatabaseService.getInstance().getNodes());

    expect(decision.check).toEqual([]);
    expect(decision.deploy).toEqual([]);
    expect(decision.withdraw).toEqual([]);
  });

  it('projects one drift check for a drifted row, not one per path that mentions it', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node);
    writeRow(blueprint, node.id, 'drifted');

    const preview = await buildBlueprintPreview(blueprint.id);
    const forNode = (preview?.changes ?? []).filter((c) => c.nodeId === node.id);

    expect(forNode).toHaveLength(1);
    expect(forNode[0]?.action).toBe('check_enforce');
    // The whole projected row is pinned, not just the action name. A drifted row
    // already reached the projection through the status fallback before the
    // decision bucket learned about it, so what must not change is the shape an
    // operator confirms against: one row, this severity, this kind, and the same
    // executor action the apply executes.
    expect(forNode[0]).toMatchObject({ severity: 'warning', kind: 'executor', detail: expect.any(String) });
    expect(preview?.executorActions).toEqual([{ nodeId: node.id, action: 'check_enforce' }]);
    expect(preview?.confirmableActions).toEqual([{ nodeId: node.id, action: 'check_enforce' }]);
  });
});

describe('a Suggest-mode drift episode is announced once', () => {
  it('announces a persistent drift once, not once per tick', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node, 'suggest');
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'active');
    countDriftChecks();
    const alerts = countAlerts();

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(
      DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status,
      'the drift is still real after the repeat checks',
    ).toBe('drifted');
    expect(
      alerts.categories().filter((category) => category === 'blueprint_drift_detected'),
      'one episode, one alert',
    ).toHaveLength(1);
  });

  it('announces again when the drift clears and returns', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node, 'suggest');
    approvePlace(blueprint, node.id);
    writeRow(blueprint, node.id, 'active');
    let checks = 0;
    vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockImplementation(async () => {
      checks += 1;
      // The second check finds the workload converged; the third finds the
      // drift again, which is a new episode rather than a repeat.
      return checks === 2
        ? { kind: 'matched' }
        : { kind: 'drifted', reason: DRIFT_REASON, cause: 'digest' };
    });
    const alerts = countAlerts();

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    expect(
      DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status,
      'the returned drift is back on the row',
    ).toBe('drifted');
    expect(
      alerts.categories().filter((category) => category === 'blueprint_drift_detected'),
      'a new episode is announced',
    ).toHaveLength(2);
  });

  it('treats a held target as the same episode when the check resumes', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node, 'suggest');
    approvePlace(blueprint, node.id);
    const firstSeen = Date.now() - 60_000;
    writeRow(blueprint, node.id, 'repair_held', { last_drift_at: firstSeen });
    countDriftChecks();
    const alerts = countAlerts();

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    const dep = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
    expect(dep?.status).toBe('drifted');
    expect(dep?.last_drift_at, 'the episode keeps its start time through a hold').toBe(firstSeen);
    expect(
      alerts.categories().filter((category) => category === 'blueprint_drift_detected'),
      'a hold is a decision about the repair, not a new episode',
    ).toHaveLength(0);
  });

  it('stamps the episode start when a hold began it and the drift resumes', async () => {
    const node = seedNode();
    const blueprint = seedDriftBlueprint(node, 'enforce');
    approvePlace(blueprint, node.id);
    // A deployed row carries no drift start until something drifts.
    writeRow(blueprint, node.id, 'active', { last_drift_at: null, drift_summary: null });
    const alerts = countAlerts();
    let checks = 0;
    vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockImplementation(async () => {
      checks += 1;
      // The first check carries an evidence block, so Enforce holds the target
      // before any drift write; the second finds the block cleared while the
      // drift is still there.
      return checks === 1
        ? {
            kind: 'drifted',
            reason: DRIFT_REASON,
            cause: 'digest',
            repairBlock: { reason: 'evidence_incomplete', detail: 'the marker names no generation' },
          }
        : { kind: 'drifted', reason: DRIFT_REASON, cause: 'digest' };
    });

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    const held = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
    expect(held?.status).toBe('repair_held');
    expect(held?.last_drift_at, 'a hold carries no drift start of its own').toBeNull();

    // The operator moves to Suggest, where a resumed drift would be announced
    // if it counted as a new episode, then the hold clears.
    DatabaseService.getInstance().updateBlueprint(blueprint.id, { drift_mode: 'suggest' });
    const switched = DatabaseService.getInstance().getBlueprint(blueprint.id)!;
    approvePlace(switched, node.id);

    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);

    const resumed = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
    expect(resumed?.status).toBe('drifted');
    expect(resumed?.last_drift_at, 'the episode start is recorded when the drift resumes').not.toBeNull();
    expect(
      alerts.categories().filter((category) => category === 'blueprint_drift_detected'),
      'the hold began the episode, so the resumed drift is not a new one',
    ).toHaveLength(0);
  });
});
