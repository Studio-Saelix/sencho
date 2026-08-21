/**
 * Node-side changes that move where Blueprints are allowed to run.
 *
 * A label is not a statement about any one Blueprint, but it changes which
 * nodes a selector matches, so it revises placement for whichever Blueprints
 * the change actually moved. That set is computed by comparing the desired
 * nodes before and after: a label nothing selects on moves nothing and records
 * nothing.
 *
 * A cordon goes through the same comparison and, as things stand, never moves
 * anything. It governs whether new placements may be made, not what a Blueprint
 * asks for, and the desired-node computation deliberately ignores it. The
 * comparison is still the right shape for it, so the caller gets a truthful
 * empty answer instead of a special case.
 *
 * As in the Blueprint producers, the desired-node computation is supplied by
 * the caller. The reconciler that knows how to do it reaches this layer, and
 * importing it back would close a module cycle.
 */
import { DatabaseService, type Blueprint } from '../DatabaseService';
import { sanitizeForLog } from '../../utils/safeLog';
import { GitOpsStore } from './store';
import { GitOpsTransitions } from './transitions';
import { candidateRowFor, envelopeFor, intentRowFor, recordableApplication } from './blueprintProducers';

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
    if (!recordableApplication(app)) continue;
    const blueprint = db.getBlueprint(blueprintId);
    if (!blueprint) {
      // Unlike the skip above, this one is a fault. A live application exists
      // for a Blueprint whose own row is gone, and with cascade off nothing
      // else will notice. The placement really did move, no intent or candidate
      // is minted for it, and the caller goes on to report that nothing moved.
      console.error(
        '[GitOps] Placement shift skipped: blueprint %s has a live application but no blueprint row.',
        sanitizeForLog(blueprintId),
      );
      continue;
    }

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
