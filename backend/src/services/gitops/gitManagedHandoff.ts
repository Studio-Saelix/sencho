/**
 * The one handoff for a prepared Git-managed generation.
 *
 * Three callers reach the same decision from different directions: the operator
 * route after an accept, the SourceController after an automatic acceptance,
 * and the reconciler after a preparation retry. Keeping the gate in one place
 * is what stops them from disagreeing about whether the configured policy,
 * the Blueprint's enabled state, a pause, or a suspension lets the rollout
 * start, which is exactly the drift a second and third copy of the sequence
 * produced.
 */
import { GitOpsStore } from './store';
import { DatabaseService } from '../DatabaseService';
import { GitSourceService } from '../GitSourceService';
import { buildAcceptedGeneration, holdBlockedRolloutDispatch, sourceConfirmationHoldReason } from './handoff';
import type { ReconcileTrigger } from './triggers';
import { sanitizeForLog } from '../../utils/safeLog';

export interface GitManagedDispatchOutcome {
  status: 'dispatched' | 'blocked' | 'skipped';
  reason: string | null;
}

/**
 * The skip reason for a handoff whose accepted generation has no resolved
 * artifact identity. Exported so post-accept reporting can suppress this
 * skip when preparation already recorded an unresolved artifact.
 */
export const GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON = 'the artifact identity is not resolved yet';

/**
 * Dispatch an accepted, prepared generation under the configured policies.
 *
 * `skipped` means a gate withheld the handoff (the generation moved on, the
 * source is suspended, the rollout is paused, the policy requires an operator,
 * the Blueprint is disabled, the artifact identity is not resolved, or the
 * operator's confirmation no longer describes this application); `blocked` means
 * the handoff was refused and, when the refusal is durable, the rollout was held
 * with the reason (a dispatch refusal, or an unfinished rollback). The caller
 * owns logging and the response.
 *
 * The acceptance stored the operator's confirmation, when there was one.
 * Preparation is the asynchronous step before this point, so this is the last
 * place a changed placement or a newly armed rollout policy can still be
 * caught before anything is dispatched to a node. The stored claim is what
 * this reads, including a re-drive that has no request left. Authorize and
 * Resume update that claim, so a request body from the acceptance must not
 * be checked again here.
 *
 * A stored confirmation that no longer describes the application is held
 * rather than merely skipped. The hold is what puts the reason on the row.
 * The stored claim is what stops the next automatic re-drive from minting.
 */
export async function dispatchPreparedGitManagedGeneration(args: {
  applicationId: string;
  generationId: string;
  actor: string;
  trigger: ReconcileTrigger;
}): Promise<GitManagedDispatchOutcome> {
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(args.applicationId);
  if (!app || app.target_mode !== 'blueprint' || app.accepted_generation_id !== args.generationId) {
    return { status: 'skipped', reason: 'the generation is no longer the accepted one' };
  }
  if (app.suspended_at) return { status: 'skipped', reason: 'the source is suspended' };
  if (app.pause_at) return { status: 'skipped', reason: 'the rollout is paused' };
  if (app.rollout_authorization_policy !== 'automatic') {
    return { status: 'skipped', reason: 'the rollout authorization policy requires an operator' };
  }
  // Below the policy gate on purpose. A manual policy cannot dispatch from
  // here at all, and its Authorize is the operator's own decision against the
  // placement as it stands, so holding the rollout over a confirmation this
  // handoff could never have acted on would add a resume step and nothing else.
  // Once the policy does authorize on its own, the stored claim is enforced.
  // A manual policy returned above, so this read does not run for it.
  const holdReason = sourceConfirmationHoldReason(app);
  if (holdReason) {
    // Held, not skipped, for the same reason an unfinished rollback is. The
    // acceptance stands and the rollout does not move, so the row alone has
    // to say why. `operator` origin, because only a person may clear it: a
    // `system` hold is released by the next source acceptance, and on an
    // automatic source that is the next poll. No live binding is required,
    // since nothing has been authorized yet and the reason is about the
    // application rather than about a rollout that exists.
    holdBlockedRolloutDispatch(app.id, { reason: holdReason, holdable: true }, {
      requireLiveBinding: false,
      origin: 'operator',
    });
    return { status: 'skipped', reason: holdReason };
  }
  const blueprint = app.blueprint_id !== null
    ? DatabaseService.getInstance().getBlueprint(app.blueprint_id)
    : undefined;
  if (!blueprint?.enabled) return { status: 'skipped', reason: 'the Blueprint is disabled' };
  // A target whose rollback never finished must not be deployed over by any
  // handoff. The dispatch's own fence guard is scoped to the live generation,
  // so an older fence is invisible there; this shared gate is what keeps the
  // accept route, the controller and the reconciler from crossing it. Retired
  // rows do not count: their rollback can never be finished.
  const rollbackPending = store.listTargets(app.id).some(
    (target) => target.target_status === 'active' && target.health_stop_reason === 'rollback_pending',
  );
  if (rollbackPending) {
    // Held, not skipped: the refusal is durable and operator-visible. A skip
    // would leave the application reading normally with no reason, the accept
    // note would not mention it, and the reconciler would warn on every floor
    // interval. The hold records the reason once and stops the automatic policy
    // until the rollback is finished. No live binding is required: this state
    // has already cleared the authorization, and the reason is about the
    // application rather than about a rollout that exists.
    const blocked = {
      status: 'blocked' as const,
      reason: 'a target has an unfinished rollback; finish it, then resume the rollout',
      holdable: true,
    };
    holdBlockedRolloutDispatch(app.id, blocked, { requireLiveBinding: false });
    return { status: 'blocked', reason: blocked.reason };
  }
  const genRow = store.getGeneration(args.generationId);
  if (!genRow) return { status: 'skipped', reason: 'the accepted generation could not be read' };
  // Authorization needs resolved executable artifact evidence, so an unresolved
  // set skips here rather than dispatching into a pre-mint refusal. One gate for
  // all three callers: the route, the controller, and the reconciler.
  const artifact = app.artifact_set_id ? store.getArtifactSet(app.artifact_set_id) : undefined;
  if (!artifact || (artifact.qualification !== 'exact' && artifact.qualification !== 'qualified')) {
    return { status: 'skipped', reason: GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON };
  }

  try {
    const result = await GitSourceService.getInstance().dispatchAcceptedGeneration(
      buildAcceptedGeneration(genRow),
      GitSourceService.dispatchContextFor(app),
      { trigger: args.trigger, actor: args.actor },
    );
    if (result.status === 'blocked') {
      holdBlockedRolloutDispatch(app.id, result);
      return { status: 'blocked', reason: result.reason };
    }
    return { status: 'dispatched', reason: null };
  } catch (err) {
    // A throw past the entry guards is a store or transport failure before any
    // reservation, so nothing is settled and the reason is reported rather than
    // held: there is no durable attempt to point at.
    console.error(
      '[GitOps] Git-managed dispatch failed for %s: %s',
      sanitizeForLog(app.id),
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return { status: 'blocked', reason: 'the dispatch failed before it could start' };
  }
}
