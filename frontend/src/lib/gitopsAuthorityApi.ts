/**
 * The decomposed authority actions for a Git-managed Blueprint application.
 *
 * Keyed by the same portfolio id the read model uses (`bp:<blueprintId>`), so
 * the surfaces that render an application's authority are also the ones that
 * can act on it without a second identity. All three are hub-owned writes:
 * the application, its approvals, and its rollout generations live on the hub.
 */
import { apiFetch } from './api';
import type { PreviewAction } from './blueprintsApi';

/** The portfolio identity of a Blueprint-backed application. */
export function blueprintApplicationId(blueprintId: number): string {
  return `bp:${blueprintId}`;
}

export type RolloutAuthorizationResult = {
  /** Whether the sequential rollout actually started. */
  dispatched: boolean;
  /** Why a granted authorization did not dispatch; null when it started. */
  note: string | null;
};

/** An authority-action failure, carrying the server's status and any fresh preview. */
export type GitOpsAuthorityError = Error & {
  status?: number;
  preview?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function postAuthorityAction(
  endpoint: string,
  body: unknown,
  fallbackMessage: string,
): Promise<Record<string, unknown>> {
  const res = await apiFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
    localOnly: true,
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : fallbackMessage;
    const error = new Error(message) as GitOpsAuthorityError;
    error.status = res.status;
    if (isRecord(payload) && payload.preview !== undefined) error.preview = payload.preview;
    throw error;
  }
  return isRecord(payload) ? payload : { ok: true };
}

/** Accept the waiting candidate generation as source content. */
export async function acceptGitOpsSource(applicationId: string, generationId: string): Promise<void> {
  await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/source/accept`,
    { generationId },
    'Failed to accept the source revision',
  );
}

/** Approve the reviewed placement plan for the current intent and candidate. */
export async function approveGitOpsPlacement(
  applicationId: string,
  confirm: {
    planFingerprint: string;
    actions: Array<{ nodeId: number; action: PreviewAction }>;
  },
): Promise<void> {
  await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/placement/approve`,
    confirm,
    'Failed to record the placement approval',
  );
}

/** Record the rollout authorization and start the sequential rollout. */
export async function authorizeGitOpsRollout(applicationId: string): Promise<RolloutAuthorizationResult> {
  const payload = await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/rollout/authorize`,
    {},
    'Failed to authorize the rollout',
  );
  return {
    dispatched: payload.dispatched === true,
    note: typeof payload.note === 'string' ? payload.note : null,
  };
}

/** Which targets a rollback recovers. */
export type RolloutRollbackScope =
  | { kind: 'target'; nodeId: number }
  | { kind: 'failed' }
  | { kind: 'all_changed' };

export type RolloutRollbackTargetResult = {
  nodeId: number;
  status: 'restored' | 'failed';
  error?: string;
};

export type RolloutRollbackResult = {
  /** True only when every in-scope target restored. */
  ok: boolean;
  results: RolloutRollbackTargetResult[];
};

/** Pause the rollout application-wide. */
export async function pauseGitOpsRollout(applicationId: string, options: { reason: string }): Promise<void> {
  await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/rollout/pause`,
    options,
    'Failed to pause the rollout',
  );
}

/** Resume a paused rollout and continue the queue when one is authorized. */
export async function resumeGitOpsRollout(applicationId: string): Promise<RolloutAuthorizationResult> {
  const payload = await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/rollout/resume`,
    {},
    'Failed to resume the rollout',
  );
  return {
    dispatched: payload.dispatched === true,
    note: typeof payload.note === 'string' ? payload.note : null,
  };
}

/** Re-derive placement for the current Blueprint and open a fresh review. */
export async function replanGitOpsRollout(applicationId: string): Promise<void> {
  await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/rollout/replan`,
    {},
    'Failed to replan the rollout',
  );
}

/** Withdraw the live rollout authorization. */
export async function supersedeGitOpsRollout(applicationId: string): Promise<void> {
  await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/rollout/supersede`,
    {},
    'Failed to supersede the rollout',
  );
}

/** Restore the selected application generation on the requested target scope. */
export async function rollbackGitOpsRollout(
  applicationId: string,
  confirm: { generationId: string; scope: RolloutRollbackScope },
): Promise<RolloutRollbackResult> {
  const payload = await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/rollout/rollback`,
    confirm,
    'Failed to roll back the rollout',
  );
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results: RolloutRollbackTargetResult[] = [];
  for (const entry of rawResults) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { nodeId, status, error } = entry as { nodeId?: unknown; status?: unknown; error?: unknown };
    if (typeof nodeId !== 'number' || (status !== 'restored' && status !== 'failed')) continue;
    results.push({
      nodeId,
      status,
      ...(typeof error === 'string' ? { error } : {}),
    });
  }
  return { ok: payload.ok === true, results };
}
