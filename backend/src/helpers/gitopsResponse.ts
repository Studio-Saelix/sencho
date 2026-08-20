import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { GitOpsStore } from '../services/gitops/store';
import { NOT_APPLICABLE_REVISION, projectApplication } from '../services/gitops/derive';
import type { GitOpsRevisionProjection } from '../services/gitops/types';

export { NOT_APPLICABLE_REVISION };

/**
 * Whether the health gate is switched off for this instance.
 *
 * Only the explicit `'0'` disables it, matching HealthGateService. The setting
 * is seeded to `'1'` at schema init, so an absent row means a database whose
 * seed did not run; reading that as enabled matches the seeded default.
 */
function healthGateDisabled(): boolean {
  return DatabaseService.getInstance().getGlobalSettings()['health_gate_enabled'] === '0';
}

/**
 * The Blueprint application that materialized a stack directory on this node.
 *
 * A Blueprint application is stored with `stack_name` NULL, because it
 * describes a Blueprint rather than one placement of it, so no lookup by stack
 * name can reach it. Meanwhile the reconciler materializes every Blueprint as a
 * real stack directory named after the Blueprint, on each node it targets. So
 * a stack-state surface asked about that directory has to bridge the two, or it
 * reports "no GitOps here" about a stack GitOps is actively managing.
 *
 * The deployment row is what makes the bridge safe, and it has to be the right
 * predicate rather than merely a present row. Blueprint names and stack names
 * share one namespace, and `name_conflict` is written *precisely* when a stack
 * of that name already exists on the node and Sencho does not own it. Treating
 * that row as ownership would hand the unrelated stack's operator this
 * Blueprint's repository, ref, and SHA pointers: the exact collision the bridge
 * exists to rule out. `last_deployed_at` being set is what proves this
 * Blueprint really did write that directory, and it also excludes `pending`,
 * `pending_state_review`, and a first deploy that failed. Same predicate the
 * delete and withdraw paths use.
 *
 * Only a live Blueprint application qualifies. A retired one has no stronger
 * claim on the directory than anything else, and the Blueprint surface still
 * reports it through projectBlueprintRevision.
 *
 * Known limit: this resolves on the instance holding the Blueprint rows, which
 * is the hub. A Blueprint deployed to a remote node is materialized there by a
 * file push, and the drift route for it executes on that remote, which has no
 * blueprint, deployment, or application row of its own. So a Blueprint-owned
 * stack on a remote node still projects not_applicable.
 */
function blueprintApplicationOwningStack(stackName: string, nodeId: number | undefined) {
  if (nodeId === undefined) return undefined;
  const db = DatabaseService.getInstance();
  const blueprint = db.getBlueprintByName(stackName);
  if (!blueprint) return undefined;
  const deployment = db.getDeployment(blueprint.id, nodeId);
  if (!deployment) return undefined;
  if (deployment.last_deployed_at == null) return undefined;
  if (deployment.status === 'name_conflict' || deployment.status === 'withdrawn') return undefined;
  return GitOpsStore.getInstance().getLiveBlueprintApplication(blueprint.id);
}

/**
 * The revision projection for a stack's own Direct Git attachment.
 *
 * The live application if there is one, otherwise a detached one, which can
 * still say what the stack was before it was detached: a different fact from
 * never having been modelled, and one the source deriver has a `not_live`
 * status for.
 *
 * A `deleted` application is deliberately not resolved here. Deletion means the
 * stack was removed, so any directory of that name now is a different stack,
 * and reporting the old application's repository and SHA against it would
 * disclose one stack's Git identity through another's name. `readAuth` excludes
 * `deleted` from stack-grant reads for that same reason.
 *
 * Used by the Git-source routes, which answer specifically about Direct
 * attachment. They must not be answered with some other application's identity,
 * so the Blueprint bridge below is deliberately not applied here.
 */
export function projectStackRevision(stackName: string): GitOpsRevisionProjection {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveDirectApplication(stackName) ?? store.getDetachedDirectApplication(stackName);
  if (!app) return NOT_APPLICABLE_REVISION;
  return projectApplication(app.id, healthGateDisabled());
}

/**
 * The revision projection for a stack's state, from whichever application
 * manages the directory on this node.
 *
 * Resolution order is precedence, not preference. A live Direct application is
 * the stack's own Git attachment and always wins. Failing that, a Blueprint may
 * have materialized the directory. Failing both, a detached Direct application
 * still describes what the stack was.
 *
 * Separate from projectStackRevision because the two answer different
 * questions. "What Git source is attached to this stack" must never be answered
 * with a Blueprint's identity; "what manages this stack" must be.
 */
export function projectManagedStackRevision(stackName: string, nodeId: number | undefined): GitOpsRevisionProjection {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveDirectApplication(stackName)
    ?? blueprintApplicationOwningStack(stackName, nodeId)
    ?? store.getDetachedDirectApplication(stackName);
  if (!app) return NOT_APPLICABLE_REVISION;
  return projectApplication(app.id, healthGateDisabled());
}

/**
 * The revision projection for a Blueprint's application.
 *
 * Mirrors projectStackRevision: the live application if there is one, otherwise
 * a detached one so a detached Blueprint reports what it was rather than
 * reading as one that never existed. A Blueprint that predates the model, or
 * one migration has not brought in, projects `not_applicable` rather than
 * throwing, so the catalog gets a uniform shape across rows.
 */
export function projectBlueprintRevision(blueprintId: number): GitOpsRevisionProjection {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveBlueprintApplication(blueprintId) ?? store.getDetachedBlueprintApplication(blueprintId);
  if (!app) return NOT_APPLICABLE_REVISION;
  return projectApplication(app.id, healthGateDisabled());
}

/**
 * Revisions for the Blueprints a mutation actually moved, `blueprintId` ascending.
 *
 * Sorted here rather than at each call site because the callers hand over ids
 * in the order their producer happened to visit them, which is a Map iteration
 * order, not a contract. Duplicates are collapsed: a caller that reports the
 * same Blueprint twice would otherwise put two copies of one projection on the
 * wire and let a consumer count the same move twice.
 */
export function projectBlueprintRevisions(blueprintIds: readonly number[]): GitOpsRevisionProjection[] {
  return [...new Set(blueprintIds)].sort((a, b) => a - b).map(projectBlueprintRevision);
}

/**
 * Revisions to decorate a mutation that has already committed.
 *
 * Best effort on purpose, and the one place in this file that swallows
 * anything. The write is done by the time this runs, so letting a projection
 * fault escape would land in the route's own catch and answer a successful
 * cordon, label, or node deletion with a 500. The operator would then retry a
 * deletion that already happened and be told the node does not exist, or retry
 * a create and be told the name is taken. A field the response can live without
 * must not be able to invert what the response means.
 *
 * The failure is logged with the operation that produced it rather than
 * dropped, and the field degrades to an empty list, which every consumer
 * already handles: it is what a mutation that moved nothing returns.
 *
 * Read routes deliberately do not use this. There the revision is part of the
 * answer, not a decoration on one, so a fault there should surface.
 */
export function projectCommittedRevisions(
  blueprintIds: readonly number[],
  operation: string,
): GitOpsRevisionProjection[] {
  try {
    return projectBlueprintRevisions(blueprintIds);
  } catch (error) {
    console.error('[GitOps] Revision projection failed after %s committed:', operation, error);
    return [];
  }
}

/**
 * One revision to decorate a mutation that has already committed.
 *
 * Same contract as projectCommittedRevisions, degrading to the not-applicable
 * shape so the response keeps one field shape across every mutation.
 */
export function projectCommittedRevision(
  blueprintId: number,
  operation: string,
): GitOpsRevisionProjection {
  try {
    return projectBlueprintRevision(blueprintId);
  } catch (error) {
    console.error('[GitOps] Revision projection failed after %s committed:', operation, error);
    return NOT_APPLICABLE_REVISION;
  }
}

/**
 * Stack directories that exist on this instance right now.
 *
 * Read once per request. The list and history routes share one probe across
 * every row; the per-stack route pays a full listing to answer a single
 * membership test, which is the same cost its existence check already paid.
 *
 * Deliberately the strict listing. This set is the evidence behind
 * `stackResourcePresent`, which decides whether a row can be authorized by a
 * stack grant and which travels to other instances as a positive claim about
 * the filesystem. The lenient variant answers a failed directory read with an
 * empty list, which here would read as "every stack is gone": every row would
 * silently fall to Admin and a scoped operator would receive an empty list and
 * an empty audit trail, indistinguishable from having none. A read failure is
 * raised so the caller can report it instead.
 */
export async function stackResourceSet(nodeId: number | undefined): Promise<Set<string>> {
  return new Set(await FileSystemService.getInstance(nodeId).getStacksStrict());
}
