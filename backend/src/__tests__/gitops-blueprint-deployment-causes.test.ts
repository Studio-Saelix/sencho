/**
 * Blueprint deployment writes, recorded by cause.
 *
 * The cause has to be carried rather than inferred, because several land on the
 * same deployment status. A deploy that failed and a withdraw that failed both
 * read `failed`, and they mean opposite things about whether the deployment is
 * still on the node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService, type Blueprint } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { commitBlueprintCreate, commitBlueprintUpdate } from '../services/gitops/blueprintProducers';
import {
  commitBlueprintDeploymentCause,
  commitBlueprintDeploymentRemoved,
} from '../services/gitops/blueprintDeploymentProducers';

const NODE = 1;
const NEXT_COMPOSE = 'services:\n  web:\n    image: nginx:1.29\n';

describe('gitops blueprint deployment causes', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('creates the target on the first deploy and records what was requested', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-first');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    // A Blueprint application has no targets until something is sent somewhere.
    expect(store.getTarget(app.id, NODE)).toBeUndefined();

    deploying(blueprint);

    const target = store.getTarget(app.id, NODE)!;
    expect(target.active_operation_stage).toBe('blueprint_deploy_started');
    expect(target.active_intent_revision_id).toBe(app.intent_revision_id);
  });

  it('acknowledges the intent the node was actually sent', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-ack');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    deploying(blueprint);

    commitBlueprintDeploymentCause('deploy_ack', blueprint.id, NODE, {
      status: 'active', last_checked_at: Date.now(),
    }, 'tester');

    const target = store.getTarget(app.id, NODE)!;
    expect(target.intent_revision_id).toBe(app.intent_revision_id);
    expect(target.active_operation_stage).toBeNull();
  });

  it('records nothing when an observation repeats the state it already reported', () => {
    const store = GitOpsStore.getInstance();
    const db = DatabaseService.getInstance();
    const blueprint = create('dc-repeat');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    deploying(blueprint);
    commitBlueprintDeploymentCause('drift_observed', blueprint.id, NODE, {
      status: 'drifted', last_checked_at: Date.now(), drift_summary: 'moved',
    }, 'tester');
    const before = historyCount(db, app.id);

    // A reconciler tick re-asserting a state it already reported must not
    // append a second event describing the same fact.
    commitBlueprintDeploymentCause('drift_observed', blueprint.id, NODE, {
      status: 'drifted', last_checked_at: Date.now(), drift_summary: 'moved again',
    }, 'tester');
    expect(historyCount(db, app.id)).toBe(before);
  });

  it('supersedes a stuck deploy rather than answering the request it replaced', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-stuck');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    deploying(blueprint);
    const stale = store.getTarget(app.id, NODE)!.active_intent_revision_id;

    // The Blueprint changed while the row sat at `deploying`, so a redeploy is
    // asking for something new. The status does not move, and gating the start
    // on that would let the later acknowledgement answer the stale request.
    commitBlueprintUpdate(
      blueprint.id, { compose_content: NEXT_COMPOSE }, 'tester', () => [NODE],
    );
    const revised = store.getLiveBlueprintApplication(blueprint.id)!.intent_revision_id;
    expect(revised).not.toBe(stale);

    deploying(blueprint);
    expect(store.getTarget(app.id, NODE)!.active_intent_revision_id).toBe(revised);

    commitBlueprintDeploymentCause('deploy_ack', blueprint.id, NODE, {
      status: 'active', last_checked_at: Date.now(),
    }, 'tester');
    // Converged on what was actually asked for last, not on the superseded one.
    expect(store.getTarget(app.id, NODE)!.intent_revision_id).toBe(revised);
  });

  it('keeps a failed deploy distinct from a failed withdraw', () => {
    const store = GitOpsStore.getInstance();
    const failed = create('dc-deploy-fail');
    deploying(failed);
    commitBlueprintDeploymentCause('deploy_fail', failed.id, NODE, {
      status: 'failed', last_checked_at: Date.now(), last_error: 'boom',
    }, 'tester');
    const deployTarget = store.getTarget(store.getLiveBlueprintApplication(failed.id)!.id, NODE)!;
    expect(deployTarget.failure_stage).toBe('blueprint_deploy');
    expect(deployTarget.target_status).toBe('active');

    const withdrawn = create('dc-withdraw-fail');
    deploying(withdrawn);
    commitBlueprintDeploymentCause('deploy_ack', withdrawn.id, NODE, {
      status: 'active', last_checked_at: Date.now(),
    }, 'tester');
    commitBlueprintDeploymentCause('withdraw_start', withdrawn.id, NODE, {
      status: 'withdrawing', last_checked_at: Date.now(),
    }, 'tester');
    commitBlueprintDeploymentCause('withdraw_fail', withdrawn.id, NODE, {
      status: 'failed', last_checked_at: Date.now(), last_error: 'boom',
    }, 'tester');

    const withdrawTarget = store.getTarget(store.getLiveBlueprintApplication(withdrawn.id)!.id, NODE)!;
    // Same deployment status, opposite meaning: the deployment is still there.
    expect(withdrawTarget.failure_stage).toBe('blueprint_withdraw');
    expect(withdrawTarget.target_status).toBe('active');
  });

  it('classifies a name conflict as its own failure', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-conflict');
    deploying(blueprint);
    commitBlueprintDeploymentCause('name_conflict', blueprint.id, NODE, {
      status: 'name_conflict', last_checked_at: Date.now(), last_error: 'taken',
    }, 'tester');

    const target = store.getTarget(store.getLiveBlueprintApplication(blueprint.id)!.id, NODE)!;
    expect(target.failure_class).toBe('name_conflict');
  });

  it('tombstones the target when the deployment row is removed', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-removed');
    deploying(blueprint);
    commitBlueprintDeploymentCause('deploy_ack', blueprint.id, NODE, {
      status: 'active', last_checked_at: Date.now(),
    }, 'tester');
    commitBlueprintDeploymentCause('withdraw_start', blueprint.id, NODE, {
      status: 'withdrawing', last_checked_at: Date.now(),
    }, 'tester');

    commitBlueprintDeploymentRemoved(blueprint.id, NODE, 'tester');

    const target = store.getTarget(store.getLiveBlueprintApplication(blueprint.id)!.id, NODE)!;
    expect(target.target_status).toBe('tombstoned');
  });

  it('observes without acknowledging anything', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-observe');
    deploying(blueprint);

    commitBlueprintDeploymentCause('drift_observed', blueprint.id, NODE, {
      status: 'drifted', last_checked_at: Date.now(), drift_summary: 'image moved',
    }, 'tester');

    const target = store.getTarget(store.getLiveBlueprintApplication(blueprint.id)!.id, NODE)!;
    expect(target.latest_stage).toBe('blueprint_drifted');
    // An observation says what was seen, never what was agreed.
    expect(target.intent_revision_id).toBeNull();
  });

  it('records a stateful first placement, which happens before any deploy', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-first-placement');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    // No deploy has run, so there is no target: this is the case that used to
    // drop the observation and leave the hold unrecorded.
    expect(store.getTarget(app.id, NODE)).toBeUndefined();

    commitBlueprintDeploymentCause('await_state_review', blueprint.id, NODE, {
      status: 'pending_state_review', last_checked_at: Date.now(),
    }, 'tester');

    const target = store.getTarget(app.id, NODE)!;
    expect(target.latest_stage).toBe('blueprint_state_review');
    // First contact only. Nothing has been sent, applied or agreed.
    expect(target.intent_revision_id).toBeNull();
    expect(target.desired_generation_id).toBeNull();
    expect(target.active_operation_stage).toBeNull();
    // Unset rather than reachable: a node that has only been asked to hold
    // something has not been contacted, and claiming reachability here would
    // make the rollout facet answer for a node nobody has spoken to.
    expect(target.connectivity).toBeNull();
  });

  it('still drops an observation for a node with no target and no placement', () => {
    // Only the first-placement hold creates a target. A drift or evict report
    // for a node nothing was ever sent to describes a deployment this model
    // does not have, so it stays dropped.
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-observe-no-target');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    commitBlueprintDeploymentCause('drift_observed', blueprint.id, NODE, {
      status: 'drifted', last_checked_at: Date.now(), drift_summary: 'image moved',
    }, 'tester');

    expect(store.getTarget(app.id, NODE)).toBeUndefined();
  });
});

function historyCount(db: DatabaseService, applicationId: string): number {
  return (db.getDb()
    .prepare('SELECT COUNT(*) AS n FROM gitops_history WHERE application_id = ?')
    .get(applicationId) as { n: number }).n;
}

function deploying(blueprint: Blueprint): void {
  commitBlueprintDeploymentCause('deploy_start', blueprint.id, NODE, {
    status: 'deploying', last_checked_at: Date.now(),
  }, 'tester');
}

function create(name: string): Blueprint {
  return commitBlueprintCreate({
    name,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
    selector: { type: 'nodes', ids: [NODE] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  }, () => [NODE]);
}
