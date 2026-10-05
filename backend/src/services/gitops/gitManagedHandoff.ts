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
import { buildAcceptedGeneration, holdBlockedRolloutDispatch } from './handoff';
import type { ReconcileTrigger } from './triggers';
import { sanitizeForLog } from '../../utils/safeLog';

export interface GitManagedDispatchOutcome {
  status: 'dispatched' | 'blocked' | 'skipped';
  reason: string | null;
}

/**
 * Dispatch an accepted, prepared generation under the configured policies.
 *
 * `skipped` means a gate withheld the handoff (the generation moved on, the
 * source is suspended, the rollout is paused, the policy requires an operator,
 * or the Blueprint is disabled); `blocked` means the dispatch itself was
 * refused and, when the refusal is durable, the rollout was held with the
 * reason. The caller owns logging and the response.
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
  const blueprint = app.blueprint_id !== null
    ? DatabaseService.getInstance().getBlueprint(app.blueprint_id)
    : undefined;
  if (!blueprint?.enabled) return { status: 'skipped', reason: 'the Blueprint is disabled' };
  const genRow = store.getGeneration(args.generationId);
  if (!genRow) return { status: 'skipped', reason: 'the accepted generation could not be read' };
  // Authorization needs resolved executable artifact evidence, so an unresolved
  // set skips here rather than dispatching into a pre-mint refusal. One gate for
  // all three callers: the route, the controller, and the reconciler.
  const artifact = app.artifact_set_id ? store.getArtifactSet(app.artifact_set_id) : undefined;
  if (!artifact || (artifact.qualification !== 'exact' && artifact.qualification !== 'qualified')) {
    return { status: 'skipped', reason: 'the artifact identity is not resolved yet' };
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
