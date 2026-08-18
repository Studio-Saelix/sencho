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
import type { Blueprint } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import {
  commitBlueprintDeploymentCause,
  commitBlueprintDeploymentRemoved,
} from '../services/gitops/blueprintDeploymentProducers';

const NODE = 1;

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

  it('records nothing when the status has not moved', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('dc-repeat');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    deploying(blueprint);
    const first = store.getTarget(app.id, NODE)!.active_operation_id;

    // A reconciler tick re-asserting a state it already reported must not
    // append a second event describing the same fact.
    deploying(blueprint);
    expect(store.getTarget(app.id, NODE)!.active_operation_id).toBe(first);
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
});

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
