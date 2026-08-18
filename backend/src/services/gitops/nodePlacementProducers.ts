/**
 * Node-side changes that move where Blueprints are allowed to run.
 *
 * A label and a cordon are not statements about any one Blueprint, but both
 * change which nodes a selector matches, so they revise placement for whichever
 * Blueprints the change actually moved. That set is computed by comparing the
 * desired nodes before and after: a label nothing selects on, or a cordon on a
 * node no Blueprint wanted, moves nothing and records nothing.
 *
 * As in the Blueprint producers, the desired-node computation is supplied by
 * the caller. The reconciler that knows how to do it reaches this layer, and
 * importing it back would close a module cycle.
 */
import { DatabaseService, type Blueprint } from '../DatabaseService';
import { GitOpsStore } from './store';
import { GitOpsTransitions } from './transitions';
import { candidateRowFor, envelopeFor, intentRowFor } from './blueprintProducers';

/** Desired node ids per Blueprint id, as placement currently resolves them. */
export type PlacementSnapshot = Map<number, number[]>;

/** Takes a snapshot of what every enabled Blueprint currently wants. */
export type SnapshotPlacement = () => PlacementSnapshot;

function sameNodeSet(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, index) => value === right[index]);
}

/**
 * Revise placement for every Blueprint whose desired node set actually moved.
 *
 * Comparing sets rather than reacting to the event is what keeps this honest.
 * Labelling a node no selector mentions changes nothing a Blueprint wants, and
 * minting an intent for it would invalidate every acknowledgement in the fleet
 * over an edit that moved nothing.
 */
export function recordPlacementShift(
  before: PlacementSnapshot,
  after: PlacementSnapshot,
  actor: string | null,
  trigger: string,
): number[] {
  const db = DatabaseService.getInstance();
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  const moved: number[] = [];

  for (const [blueprintId, desired] of after) {
    if (sameNodeSet(before.get(blueprintId), desired)) continue;
    const app = store.getLiveBlueprintApplication(blueprintId);
    // A Blueprint that predates the model has no application yet. Migration
    // brings it in rather than this path inventing a first intent for it.
    if (!app) continue;
    const blueprint = db.getBlueprint(blueprintId);
    if (!blueprint) continue;

    const envelope = envelopeFor(actor, trigger);
    const intent = intentRowFor(app.id, blueprint, envelope.operationId, actor, envelope.at);
    tx.intentRevised({ applicationId: app.id, intent, envelope });
    tx.rolloutCandidateOpened({
      applicationId: app.id,
      candidate: candidateRowFor(app.id, intent, desired, 'roster_change', envelope.operationId, envelope.at),
      envelope,
    });
    moved.push(blueprintId);
  }
  return moved;
}

/** Placement as it currently resolves, for every Blueprint. */
export function snapshotPlacementWith(
  desiredNodeIdsFor: (blueprint: Blueprint) => number[],
  blueprints: Blueprint[],
): PlacementSnapshot {
  const snapshot: PlacementSnapshot = new Map();
  for (const blueprint of blueprints) {
    snapshot.set(blueprint.id, desiredNodeIdsFor(blueprint));
  }
  return snapshot;
}
