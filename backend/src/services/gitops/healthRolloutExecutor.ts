import { GitOpsStore } from './store';
import { GitOpsTransitions, type TransitionResult } from './transitions';
import { restoreTargetToGeneration } from './rolloutRecovery';
import { ROLE_PERMISSIONS, type PermissionAction } from '../../middleware/permissions';
import { sanitizeForLog } from '../../utils/safeLog';

/** Every stack action an admin role confers, for a system-driven remote hop. */
const SYSTEM_STACK_ACTIONS: readonly PermissionAction[] = (ROLE_PERMISSIONS.admin ?? [])
  .filter((action) => action.startsWith('stack:'));

/**
 * What the executor is allowed to do with a rollout after a health verdict.
 *
 * Passed in rather than imported so this module never reaches back into the
 * health gate that produced the verdict, and so a test can drive the executor
 * without an armed poll timer.
 */
export type HealthRolloutExecutor = {
  /** Deploy the next target the frozen policy allows. */
  advance(applicationId: string, nodeId: number | null): Promise<void>;
  /**
   * Re-run the same accepted generation against the same target.
   *
   * The caller must not re-capture the target's recovery point: the retry exists
   * to try the same rollout again, and a fresh capture would replace the
   * pre-rollout generation with the half-applied state a rollback then has
   * nothing to restore from.
   */
  retry(applicationId: string, nodeId: number): Promise<void>;
};

export type HealthRolloutOutcome = {
  action: string;
  reason: string;
  detail?: string;
};

/**
 * Act on a health verdict, after the transition that recorded it has committed.
 *
 * Every branch here is async work that must not run inside the recording
 * transaction: advancing and retrying are applies under deploy locks, and a
 * rollback is an external restore. The transition stores the decision; this
 * carries it out. That ordering is what makes a decision impossible to observe
 * without the state that justified it, and what makes a crash in the middle
 * recoverable: the decision and its fence are already durable, so the
 * reconstruction path picks the target up from there.
 *
 * Never throws. A health gate is an observer, and a failure to carry out a
 * verdict must not change the verdict that was already written or crash the
 * process that observed it.
 */
export async function executeHealthRolloutDecision(args: {
  applicationId: string;
  nodeId: number;
  result: TransitionResult;
  executor: HealthRolloutExecutor;
  /** See HealthVerdictSink. */
  redrive?: boolean;
}): Promise<HealthRolloutOutcome> {
  const decision = args.result.healthDecision;
  if (!decision) {
    // A finished run that decided nothing still may have been the thing the live
    // rollout was waiting on, so the queue is driven again rather than left
    // queued behind a run that is over.
    if (args.redrive && args.executor) await args.executor.advance(args.applicationId, null);
    return { action: 'none', reason: args.redrive ? 'redriven' : 'not_health_gated' };
  }
  const store = GitOpsStore.getInstance();
  const transitions = GitOpsTransitions.getInstance();
  const envelope = {
    operationId: `health-rollout-${args.nodeId}-${Date.now()}`,
    actor: 'system:health-rollout-policy',
    trigger: 'health_rollout_policy',
    at: Date.now(),
  };

  try {
    switch (decision.action) {
      case 'none':
        return { action: decision.action, reason: decision.reason };

      case 'advance': {
        const application = store.getApplication(args.applicationId);
        const binding = application?.rollout_authorization_ref
          ? store.currentAuthorizationBinding(application)
          : null;
        if (!application || !binding) {
          // The rollout was superseded or paused between the verdict and here.
          // The verdict stands; there is simply nothing left to advance.
          return { action: 'none', reason: 'rollout_no_longer_authorized' };
        }
        await args.executor.advance(args.applicationId, args.nodeId);
        return { action: 'advance', reason: decision.reason };
      }

      case 'retry': {
        await args.executor.retry(args.applicationId, args.nodeId);
        return { action: 'retry', reason: decision.reason };
      }

      case 'pause': {
        holdRollout(args.applicationId, decision, envelope);
        return { action: 'pause', reason: decision.reason };
      }

      case 'stop': {
        // Stop restores nothing. The failed target keeps the generation it was
        // put on, which is what its `rollout_stopped` fence says: the policy is
        // finished with it, so a resume moves past it rather than re-applying the
        // generation that just failed. Only the application-wide pause is written
        // here, to hold the targets this rollout never reached.
        holdRollout(args.applicationId, decision, envelope);
        return { action: 'stop', reason: decision.reason };
      }

      case 'rollback': {
        const application = store.getApplication(args.applicationId);
        const target = store.getTarget(args.applicationId, args.nodeId);
        if (!application || !target) {
          return { action: 'rollback', reason: 'target_not_found' };
        }
        // The target's own captured pre-rollout generation, never the LKG. The
        // LKG is the newest generation that ever passed, which is a different
        // question from "what this node was running before this rollout", and
        // restoring it would put a workload back that the target never ran.
        const restoreGenerationId = target.recovery_generation_id;
        if (!restoreGenerationId) {
          // Nothing honest to restore, so the rollout holds instead of quietly
          // continuing: a target left failed and a queue still running would
          // report a rollback that never happened.
          holdRollout(args.applicationId, decision, envelope);
          return { action: 'rollback', reason: 'recovery_unavailable' };
        }
        const stackName = targetStackNameFor(application, target);
        if (!stackName) {
          holdRollout(args.applicationId, decision, envelope);
          return { action: 'rollback', reason: 'stack_name_unresolved' };
        }
        // An identity for this restore in the transition record, not a handle on
        // a recovery row: a policy-driven restore is driven by the generation
        // above, and there is no captured row on this node to point at.
        const recoveryRef = `health-rollout-rollback-${args.applicationId}-${args.nodeId}`;
        // The fence is already durable on the target, so opening the rollback
        // here is what a restart reconciles against. A refusal to open is
        // reported, not thrown: the operator sees an unfinished rollback rather
        // than a silent one.
        try {
          transitions.rollbackInProgress({
            applicationId: args.applicationId,
            nodeId: args.nodeId,
            recoveryRef,
            recoveryGenerationId: restoreGenerationId,
            envelope,
          });
        } catch (error) {
          // The target is fenced but the application is not, and a later
          // reconstruction skips a fenced target and deploys the next one. The
          // rollback is unfinished, so the rollout holds here as it does on the
          // branches that complete it.
          holdRollout(args.applicationId, decision, envelope);
          return {
            action: 'rollback',
            reason: 'rollback_not_recorded',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        const outcome = await restoreTargetToGeneration({
          app: application,
          stackName,
          nodeId: args.nodeId,
          generationId: restoreGenerationId,
          actor: envelope.actor,
          // A policy-driven restore has no user behind it: the authority is the
          // operator's policy selection, which the policy write and the rollout
          // authorization already gated on `stack:deploy`. The actor header
          // names that provenance so the leaf's audit says a policy ran, not a
          // person.
          role: 'admin',
          scopedActions: SYSTEM_STACK_ACTIONS,
        });
        if (outcome.ok) {
          transitions.rollbackCompleted({
            applicationId: args.applicationId,
            nodeId: args.nodeId,
            recoveryRef,
            recoveryGenerationId: restoreGenerationId,
            // What the restored generation was captured with. A generation this
            // application no longer owns restores without the pointers rather
            // than borrowing another generation's.
            capturedArtifactSetId: null,
            capturedSourceAcceptanceRef: null,
            envelope,
          });
          holdRollout(args.applicationId, decision, envelope);
          return { action: 'rollback', reason: decision.reason };
        }
        // Partial failure is reported as partial. Reporting a single target's
        // failed restore as a completed rollback would tell the operator the
        // fleet is back on the pre-rollout generation when it is not. Either way
        // the rollout stops: the target is no longer on the generation that
        // failed, and the ones after it were never authorized to run.
        transitions.rollbackPartialFailed({
          applicationId: args.applicationId,
          nodeId: args.nodeId,
          recoveryRef,
          failureClass: 'partial',
          envelope,
        });
        // Held for the same reason as a completed rollback: at least one target
        // is still on the generation that failed, and the ones after it were
        // never authorized to run.
        holdRollout(args.applicationId, decision, envelope);
        return { action: 'rollback_partial_failed', reason: outcome.error };
      }

      default:
        return { action: 'none', reason: 'unhandled_action' };
    }
  } catch (error) {
    console.error(
      '[GitOps] Health rollout decision could not be carried out for %s: %s',
      sanitizeForLog(args.applicationId),
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    return { action: 'failed', reason: decision.reason };
  }
}

/** The stack a target is deployed under, as the intent that placed it names. */
function targetStackNameFor(
  application: { id: string; intent_revision_id: string | null; configured_source_stack_name: string | null },
  target: { intent_revision_id: string | null },
): string {
  const store = GitOpsStore.getInstance();
  const targetIntent = target.intent_revision_id
    ? store.getIntentRevision(target.intent_revision_id)
    : undefined;
  const appIntent = application.intent_revision_id
    ? store.getIntentRevision(application.intent_revision_id)
    : undefined;
  return targetIntent?.deploy_stack_name
    ?? application.configured_source_stack_name
    ?? appIntent?.deploy_stack_name
    ?? '';
}

/**
 * Hold the rollout, through the one hold an operator already knows how to read
 * and clear.
 *
 * Every decision that ends advancement goes through here rather than through a
 * second flag, because a second flag would be invisible to the resume control
 * that clears it, and because a restart that finds only a target-level fence
 * would put the queue back to work.
 */
function holdRollout(
  applicationId: string,
  decision: { reason: string },
  envelope: { operationId: string; actor: string; trigger: string; at: number },
): void {
  if (GitOpsStore.getInstance().getApplication(applicationId)?.pause_at) return;
  GitOpsTransitions.getInstance().rolloutPaused(
    applicationId,
    null,
    `Held by the health rollout policy (${decision.reason.replace(/_/g, ' ')}).`,
    envelope,
  );
}

type HealthVerdictSink = (args: {
  applicationId: string;
  nodeId: number;
  result: TransitionResult;
  /**
   * Set when a run finished without a decision because it belonged to a rollout
   * the application has left. The run is released, so whatever was waiting on it
   * is now free, and the live rollout has to be driven again: nothing else would,
   * because a verdict with no decision produces no follow-up of its own.
   */
  redrive?: boolean;
}) => Promise<HealthRolloutOutcome>;

let verdictSink: HealthVerdictSink | null = null;

/**
 * Install the follow-up that carries out a health-gated verdict.
 *
 * The sink exists to keep the dependency one-directional. The health gate
 * produces verdicts; acting on one means dispatching the next target, which
 * needs the dispatch path, which needs the health gate to reserve its run. Wiring
 * that at startup rather than importing it keeps the cycle out of the module
 * graph, which matters because a cycle in this package has already produced one
 * silent defect.
 *
 * Startup installs the real follow-up next to the rollout reconstruction it
 * already runs. Tests install their own. With no sink installed, a verdict is
 * still recorded and the rollout still stops where the decision said to, which
 * is the safe outcome: nothing advances that should not have.
 */
export function setHealthVerdictSink(sink: HealthVerdictSink | null): void {
  verdictSink = sink;
}

export function reportHealthVerdict(args: {
  applicationId: string;
  nodeId: number;
  result: TransitionResult;
  /** See HealthVerdictSink. */
  redrive?: boolean;
}): void {
  const sink = verdictSink;
  if (!sink) return;
  void sink(args).catch((error) => {
    console.error(
      '[GitOps] Health rollout follow-up failed for %s:',
      sanitizeForLog(args.applicationId),
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
  });
}
