/**
 * Node-side placement recording.
 *
 * A label or a cordon is not a statement about any one Blueprint, so what
 * matters is which Blueprints the change actually moved. Reacting to the event
 * instead of comparing the resulting sets would invalidate every
 * acknowledgement in the fleet whenever someone labelled a node nothing selects
 * on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { Blueprint } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import {
  recordPlacementShift,
  snapshotPlacementWith,
  type PlacementSnapshot,
} from '../services/gitops/nodePlacementProducers';

describe('gitops node placement recording', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('revises only the Blueprints whose desired nodes moved', () => {
    const store = GitOpsStore.getInstance();
    const moved = create('np-moved');
    const still = create('np-still');
    const movedBefore = store.getLiveBlueprintApplication(moved.id)!;
    const stillBefore = store.getLiveBlueprintApplication(still.id)!;

    const before: PlacementSnapshot = new Map([[moved.id, [1]], [still.id, [1]]]);
    const after: PlacementSnapshot = new Map([[moved.id, [1, 2]], [still.id, [1]]]);

    expect(recordPlacementShift(before, after, 'tester', 'node_label_add')).toEqual([moved.id]);

    expect(store.getLiveBlueprintApplication(moved.id)!.intent_revision_id)
      .not.toBe(movedBefore.intent_revision_id);
    // The Blueprint the label did not move keeps the acknowledgement it had.
    expect(store.getLiveBlueprintApplication(still.id)!.intent_revision_id)
      .toBe(stillBefore.intent_revision_id);
  });

  it('records nothing when the same nodes come back in a different order', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('np-reorder');
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    const before: PlacementSnapshot = new Map([[blueprint.id, [1, 2, 3]]]);
    const after: PlacementSnapshot = new Map([[blueprint.id, [3, 1, 2]]]);

    expect(recordPlacementShift(before, after, 'tester', 'node_cordon')).toEqual([]);
    expect(store.getLiveBlueprintApplication(blueprint.id)!.intent_revision_id)
      .toBe(app.intent_revision_id);
  });

  it('opens the revision as a roster change, not a content change', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('np-provenance');

    recordPlacementShift(
      new Map([[blueprint.id, [1]]]),
      new Map([[blueprint.id, [2]]]),
      'tester',
      'node_cordon',
    );

    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    const candidate = store.getRolloutCandidate(app.rollout_candidate_id!)!;
    expect(candidate.provenance).toBe('roster_change');
    expect(JSON.parse(candidate.required_targets_json)).toEqual({ nodeIds: [2] });
  });

  it('leaves a Blueprint that predates the model alone', () => {
    // No application, so nothing to revise. Migration brings it in; inventing a
    // first intent here would claim a starting point nobody reconciled.
    const before: PlacementSnapshot = new Map([[99999, [1]]]);
    const after: PlacementSnapshot = new Map([[99999, [1, 2]]]);
    expect(recordPlacementShift(before, after, 'tester', 'node_label_add')).toEqual([]);
  });

  it('snapshots every Blueprint it is given', () => {
    const a = create('np-snap-a');
    const b = create('np-snap-b');
    const snapshot = snapshotPlacementWith(
      (blueprint) => (blueprint.name === 'np-snap-a' ? [1] : [2, 3]),
      [a, b],
    );
    expect(snapshot.get(a.id)).toEqual([1]);
    expect(snapshot.get(b.id)).toEqual([2, 3]);
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
  }, () => [1]);
}
