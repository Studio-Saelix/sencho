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
 * Bind a rollback point to the generation that is actually deployed on this
 * target. A generation that was applied but never deployed is not rollback
 * identity, so only `deployed_generation_id` is read.
 *
 * The acceptance reference prefers the one recorded on the target and
 * otherwise falls back to the newest acceptance *of that same generation*, so
 * an acceptance belonging to a later generation can never be captured. Any
 * candidate that does not resolve against the deployed generation is stored as
 * null rather than as a reference the restore path would have to trust.
 */
export function captureGitOpsRecoveryBinding(stackName: string, nodeId: number): GitOpsRecoveryCapture {
  const store = GitOpsStore.getInstance();
  const application = store.getLiveDirectApplication(stackName);
  if (!application) return { ...EMPTY_GITOPS_RECOVERY_CAPTURE };
  const target = store.getTarget(application.id, nodeId);
  const generationId = target?.deployed_generation_id ?? null;
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
