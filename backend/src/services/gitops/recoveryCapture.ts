import type { GitOpsApplicationRow, GitOpsTargetCurrentRow } from './types';
import { GitOpsStore } from './store';

export type GitOpsRecoveryCapture = {
  gitops_generation_id: string | null;
  gitops_artifact_set_id: string | null;
  gitops_source_acceptance_ref: string | null;
};

export const EMPTY_GITOPS_RECOVERY_CAPTURE: GitOpsRecoveryCapture = {
  gitops_generation_id: null,
  gitops_artifact_set_id: null,
  gitops_source_acceptance_ref: null,
};

/**
 * Bind a recovery point to the generation the node is actually running.
 *
 * Direct mode reads `deployed_generation_id`, because a generation that was
 * applied but never deployed is not rollback identity there. Blueprint mode
 * has no deploy-bound writer (nothing resolves a Direct application for a
 * Blueprint-managed stack), so the ack's `applied_generation_id` is the
 * pointer that names what the node acknowledged running.
 *
 * The acceptance reference prefers the one recorded on the target and
 * otherwise falls back to the newest acceptance *of that same generation*, so
 * an acceptance belonging to a later generation can never be captured. Any
 * candidate that does not resolve against that generation is stored as null
 * rather than as a reference the restore path would have to trust.
 */
export function recoveryBindingForTarget(
  application: GitOpsApplicationRow,
  target: GitOpsTargetCurrentRow | undefined,
): GitOpsRecoveryCapture {
  const store = GitOpsStore.getInstance();
  const generationId = application.target_mode === 'direct'
    ? (target?.deployed_generation_id ?? null)
    : (target?.applied_generation_id ?? null);
  if (!generationId) return { ...EMPTY_GITOPS_RECOVERY_CAPTURE };

  let artifactSetId: string | null = null;
  if (target?.expected_artifact_set_id) {
    const artifact = store.getArtifactSet(target.expected_artifact_set_id);
    if (artifact && artifact.generation_id === generationId) {
      artifactSetId = artifact.id;
    }
  }

  const expected = {
    kind: 'source_acceptance' as const,
    applicationId: application.id,
    generationId,
  };
  let sourceAcceptanceRef: string | null = null;
  if (target?.source_acceptance_ref && store.resolveApprovalRef(target.source_acceptance_ref, expected)) {
    sourceAcceptanceRef = target.source_acceptance_ref;
  } else {
    const newest = store.newestSourceAcceptanceId(application.id, generationId);
    if (newest && store.resolveApprovalRef(newest, expected)) {
      sourceAcceptanceRef = newest;
    }
  }

  return {
    gitops_generation_id: generationId,
    gitops_artifact_set_id: artifactSetId,
    gitops_source_acceptance_ref: sourceAcceptanceRef,
  };
}

/**
 * The binding for the stack a node reports, resolved from the application that
 * owns it.
 *
 * Both modes resolve: a Direct stack by its own name, and a Blueprint-managed
 * stack through the live application whose current intent deploys it. A
 * Blueprint target's rollback point has to name the generation the node was
 * running before the deploy, or a rollout rollback cannot select it.
 */
export function captureGitOpsRecoveryBinding(stackName: string, nodeId: number): GitOpsRecoveryCapture {
  const store = GitOpsStore.getInstance();
  const application = store.getLiveDirectApplication(stackName)
    ?? store.getLiveBlueprintApplicationByDeployStack(stackName);
  if (!application) return { ...EMPTY_GITOPS_RECOVERY_CAPTURE };
  return recoveryBindingForTarget(application, store.getTarget(application.id, nodeId));
}
