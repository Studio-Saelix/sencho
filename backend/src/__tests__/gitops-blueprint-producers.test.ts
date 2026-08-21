/**
 * Blueprint source-mutation producers.
 *
 * These are the seam between the Blueprint routes and the revision state, and
 * the question they exist to answer is when an edit invalidates what the fleet
 * already acknowledged. Renaming or re-selecting does; rewording a description
 * does not, and minting an intent for the latter would make every node's
 * acknowledgement read as stale over a change no node can observe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService, type Blueprint } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import {
  classifyBlueprintChange,
  commitBlueprintCreate,
  commitBlueprintDelete,
  commitBlueprintPin,
  commitBlueprintUpdate,
} from '../services/gitops/blueprintProducers';

const DESIRED = [1];
const desiredNodeIdsFor = (): number[] => DESIRED;

describe('gitops blueprint producers', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('creates the Blueprint, its application, and the first intent and candidate together', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-create');

    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    expect(app.target_mode).toBe('inline_blueprint');
    expect(app.lifecycle_status).toBe('active');
    // No Git identity: an Inline Blueprint has no generations to point at.
    expect(app.stack_name).toBeNull();
    expect(app.configured_repo_url).toBeNull();

    const intent = store.getIntentRevision(app.intent_revision_id!)!;
    expect(intent.blueprint_id).toBe(blueprint.id);
    expect(intent.deploy_stack_name).toBe('bp-create');

    const candidate = store.getRolloutCandidate(app.rollout_candidate_id!)!;
    expect(candidate.intent_revision_id).toBe(intent.id);
    expect(JSON.parse(candidate.required_targets_json)).toEqual({ nodeIds: DESIRED });

    // History starts where the application does. Beginning at the first intent
    // would describe an application nothing records coming into existence.
    const stages = DatabaseService.getInstance().getDb().prepare(
      'SELECT stage FROM gitops_history WHERE application_id = ? ORDER BY rowid ASC',
    ).all(app.id) as Array<{ stage: string }>;
    expect(stages.map(row => row.stage))
      .toEqual(['application_activated', 'intent_revised', 'rollout_candidate_opened']);

    // No targets until something is deployed somewhere.
    expect(store.listTargets(app.id)).toEqual([]);
  });

  it('refuses a second live application for the same Blueprint', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-single');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    const tx = GitOpsTransitions.getInstance();

    expect(() => tx.activateInlineBlueprint({
      application: { ...app, id: 'second-app' },
      envelope: { operationId: 'op-dup', actor: 'tester', trigger: 'manual', at: Date.now() },
    })).toThrow(/already exists/);
  });

  it('mints nothing when an edit changes no value', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-noop');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    const result = commitBlueprintUpdate(
      blueprint.id, { name: 'bp-noop', drift_mode: blueprint.drift_mode }, 'tester', desiredNodeIdsFor,
    );

    expect(result.change).toBe('none');
    const after = store.getLiveBlueprintApplication(blueprint.id)!;
    expect(after.intent_revision_id).toBe(app.intent_revision_id);
    expect(after.rollout_candidate_id).toBe(app.rollout_candidate_id);
  });

  it('leaves the acknowledged intent alone when only the description changes', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-meta');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    const result = commitBlueprintUpdate(
      blueprint.id, { description: 'now with a longer explanation' }, 'tester', desiredNodeIdsFor,
    );

    expect(result.change).toBe('metadata_only');
    expect(result.blueprint?.description).toBe('now with a longer explanation');
    // The source row moved and the intent did not: no node's acknowledgement
    // became stale because someone reworded the description.
    const after = store.getLiveBlueprintApplication(blueprint.id)!;
    expect(after.intent_revision_id).toBe(app.intent_revision_id);
  });

  it('mints a new intent and candidate when the deployed content changes', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-op');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    const result = commitBlueprintUpdate(
      blueprint.id, { compose_content: 'services:\n  web:\n    image: nginx:1.29\n' }, 'tester', desiredNodeIdsFor,
    );

    expect(result.change).toBe('operational');
    const after = store.getLiveBlueprintApplication(blueprint.id)!;
    expect(after.intent_revision_id).not.toBe(app.intent_revision_id);
    expect(after.rollout_candidate_id).not.toBe(app.rollout_candidate_id);
    const intent = store.getIntentRevision(after.intent_revision_id!)!;
    expect(intent.compose_content_sha256).not.toBe(
      store.getIntentRevision(app.intent_revision_id!)!.compose_content_sha256,
    );
  });

  it('treats a pin as a placement change, and re-pinning the same node as nothing', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-pin');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    const pinned = commitBlueprintPin(blueprint.id, 1, 'tester', desiredNodeIdsFor);
    expect(pinned.changed).toBe(true);
    const afterPin = store.getLiveBlueprintApplication(blueprint.id)!;
    expect(afterPin.intent_revision_id).not.toBe(app.intent_revision_id);
    expect(store.getRolloutCandidate(afterPin.rollout_candidate_id!)?.provenance).toBe('roster_change');

    const again = commitBlueprintPin(blueprint.id, 1, 'tester', desiredNodeIdsFor);
    expect(again.changed).toBe(false);
    expect(store.getLiveBlueprintApplication(blueprint.id)?.intent_revision_id)
      .toBe(afterPin.intent_revision_id);
  });

  it('records the required set in a canonical order so a reorder is not a change', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-order');
    commitBlueprintUpdate(blueprint.id, { name: 'bp-order-2' }, 'tester', () => [3, 1, 2]);

    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    expect(JSON.parse(store.getRolloutCandidate(app.rollout_candidate_id!)!.required_targets_json))
      .toEqual({ nodeIds: [1, 2, 3] });
  });

  it('retires the application when the Blueprint is deleted', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-delete');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    expect(commitBlueprintDelete(blueprint.id, 'tester')).toBe(true);

    // The live slot has to be released, or the Blueprint name cannot be used
    // again while a record of a deleted one still claims it.
    expect(store.getLiveBlueprintApplication(blueprint.id)).toBeUndefined();
    expect(store.getApplication(app.id)?.lifecycle_status).toBe('deleted');
  });

  it('does not bump the revision or void approval when only the description changed', () => {
    const db = DatabaseService.getInstance();
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-full-save');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    const intentBefore = store.getIntentRevision(app.intent_revision_id!)!;

    // What the editor actually sends: every field, every save. The source layer
    // decides what to invalidate from which keys are present, so submitting an
    // unchanged compose body used to advance the revision past the one the
    // current intent describes, and clear the approval, while this layer
    // classified it as metadata and minted nothing.
    const result = commitBlueprintUpdate(blueprint.id, {
      name: blueprint.name,
      description: 'reworded',
      compose_content: blueprint.compose_content,
      selector: blueprint.selector,
      drift_mode: blueprint.drift_mode,
      enabled: blueprint.enabled,
      bumpRevision: true,
    }, 'tester', desiredNodeIdsFor);

    expect(result.change).toBe('metadata_only');
    const after = db.getBlueprint(blueprint.id)!;
    expect(after.description).toBe('reworded');
    expect(after.revision).toBe(blueprint.revision);
    expect(after.approval_status).toBe(blueprint.approval_status);
    // The intent still describes the revision that is actually stored.
    expect(store.getIntentRevision(app.intent_revision_id!)!.blueprint_revision).toBe(after.revision);
    expect(store.getLiveBlueprintApplication(blueprint.id)!.intent_revision_id).toBe(intentBefore.id);
  });

  it('treats a reordered selector naming the same nodes as no change', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-reorder');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    const result = commitBlueprintUpdate(
      blueprint.id, { selector: { type: 'nodes', ids: [1] } }, 'tester', desiredNodeIdsFor,
    );

    expect(result.change).toBe('none');
    expect(store.getLiveBlueprintApplication(blueprint.id)!.intent_revision_id).toBe(app.intent_revision_id);
  });

  it('rolls the Blueprint back when recording it fails', () => {
    const db = DatabaseService.getInstance();
    const applicationsBefore = (db.getDb()
      .prepare("SELECT COUNT(*) AS n FROM gitops_applications WHERE target_mode = 'inline_blueprint'")
      .get() as { n: number }).n;

    // The source write and its record commit together or not at all, so a
    // Blueprint can never exist with nothing describing what it means.
    expect(() => commitBlueprintCreate({
      name: 'bp-rollback',
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [1] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    }, () => { throw new Error('placement lookup failed'); })).toThrow(/placement lookup failed/);

    expect(db.getBlueprintByName('bp-rollback')).toBeUndefined();
    // And no orphan application survived the rolled-back source write.
    expect(db.getDb()
      .prepare("SELECT COUNT(*) AS n FROM gitops_applications WHERE target_mode = 'inline_blueprint'")
      .get() as { n: number }).toEqual({ n: applicationsBefore });
  });

  it('leaves every other Blueprint untouched when one is edited', () => {
    const store = GitOpsStore.getInstance();
    const other = create('bp-bystander');
    const edited = create('bp-edited');
    const otherBefore = store.getLiveBlueprintApplication(other.id)!;

    commitBlueprintUpdate(edited.id, { name: 'bp-edited-2' }, 'tester', desiredNodeIdsFor);

    const otherAfter = store.getLiveBlueprintApplication(other.id)!;
    expect(otherAfter.intent_revision_id).toBe(otherBefore.intent_revision_id);
    expect(otherAfter.rollout_candidate_id).toBe(otherBefore.rollout_candidate_id);
    expect(store.getIntentRevision(otherAfter.intent_revision_id!)!.deploy_stack_name).toBe('bp-bystander');
  });

  it('classifies each field without touching the database', () => {
    const before = {
      name: 'a', description: 'd', compose_content: 'c', selector: { type: 'nodes', ids: [1] },
      drift_mode: 'suggest', enabled: true, classification: 'stateless', classification_reasons: [],
    } as unknown as Blueprint;

    expect(classifyBlueprintChange(before, {})).toBe('none');
    expect(classifyBlueprintChange(before, { name: 'a' })).toBe('none');
    expect(classifyBlueprintChange(before, { description: 'd' })).toBe('none');
    expect(classifyBlueprintChange(before, { description: 'other' })).toBe('metadata_only');
    expect(classifyBlueprintChange(before, { name: 'b' })).toBe('operational');
    expect(classifyBlueprintChange(before, { enabled: false })).toBe('operational');
    // Selector equality is by value: the same set written again is not a change.
    expect(classifyBlueprintChange(before, { selector: { type: 'nodes', ids: [1] } })).toBe('none');
    expect(classifyBlueprintChange(before, { selector: { type: 'nodes', ids: [2] } })).toBe('operational');
    // An operational change alongside a metadata one is still operational.
    expect(classifyBlueprintChange(before, { name: 'b', description: 'other' })).toBe('operational');
  });

  describe('an application that is not yet active', () => {
    // The live-slot lookup answers with `active` or `creating`, because its
    // other callers ask whether the slot is taken. The transitions that mint
    // intents accept only `active` and reject anything else by throwing, inside
    // the caller's own transaction, so a `creating` row reaching one would fail
    // the operator's edit and roll the Blueprint write back with it.
    //
    // The state is written directly here because no production path creates a
    // Blueprint-mode application in `creating`: they all go through
    // `blankInlineApplication`, which hardcodes `active`. These cases pin a
    // deliberately defensive guard rather than a reachable behaviour, and are
    // marked as such so nobody later reads them as live coverage. The Git
    // backed `blueprint` mode is what makes the state producible.
    const toCreating = (blueprintId: number): void => {
      DatabaseService.getInstance().getDb()
        .prepare('UPDATE gitops_applications SET lifecycle_status = ? WHERE blueprint_id = ?')
        .run('creating', blueprintId);
    };

    it('lets an edit through without minting an intent', () => {
      const store = GitOpsStore.getInstance();
      const blueprint = create('bp-creating-update');
      const app = store.getLiveBlueprintApplication(blueprint.id)!;
      const intentBefore = app.intent_revision_id;
      toCreating(blueprint.id);

      const result = commitBlueprintUpdate(blueprint.id, { name: 'bp-creating-renamed' }, 'tester', desiredNodeIdsFor);

      expect(result.blueprint?.name).toBe('bp-creating-renamed');
      expect(store.getLiveBlueprintApplication(blueprint.id)!.intent_revision_id).toBe(intentBefore);
    });

    it('lets a pin through without minting an intent', () => {
      const store = GitOpsStore.getInstance();
      const blueprint = create('bp-creating-pin');
      const app = store.getLiveBlueprintApplication(blueprint.id)!;
      const intentBefore = app.intent_revision_id;
      toCreating(blueprint.id);

      const result = commitBlueprintPin(blueprint.id, 1, 'tester', desiredNodeIdsFor);

      expect(result.changed).toBe(true);
      expect(result.blueprint?.pinned_node_id).toBe(1);
      expect(store.getLiveBlueprintApplication(blueprint.id)!.intent_revision_id).toBe(intentBefore);
    });
  });
});

function create(name: string): Blueprint {
  return commitBlueprintCreate({
    name,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
    selector: { type: 'nodes', ids: [1] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  }, desiredNodeIdsFor);
}
