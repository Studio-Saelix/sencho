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
import type { HealthRolloutPolicy } from '@/types/gitops';

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

/** What the accept route prepared, and whether it started the rollout. */
export interface GitOpsSourceAcceptResult {
  ok: boolean;
  materialized: boolean;
  artifactResolved: boolean;
  dispatched: boolean;
  note: string | null;
}

/** Accept the waiting candidate generation as source content. */
export async function acceptGitOpsSource(
  applicationId: string,
  generationId: string,
): Promise<GitOpsSourceAcceptResult> {
  const payload = await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/source/accept`,
    { generationId },
    'Failed to accept the source revision',
  );
  return {
    ok: payload.ok === true,
    materialized: payload.materialized === true,
    artifactResolved: payload.artifactResolved === true,
    dispatched: payload.dispatched === true,
    note: typeof payload.note === 'string' && payload.note.length > 0 ? payload.note : null,
  };
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

/**
 * Set the health-and-rollout policy for an application.
 *
 * Takes effect at the next rollout authorization, not immediately: a rollout
 * already running keeps the policy it was authorized under, so changing this
 * cannot change what a fleet is doing halfway through.
 */
export async function setGitOpsHealthRolloutPolicy(
  applicationId: string,
  policy: HealthRolloutPolicy,
): Promise<void> {
  await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/rollout/health-policy`,
    { policy },
    'Failed to set the health rollout policy',
  );
}

/**
 * The three authority policies, as the wire spells them.
 *
 * Spelled here rather than imported from the projection's own union because
 * these are the values a write may send, and the projection's read types are
 * deliberately looser: a status that crossed the wire may belong to a
 * vocabulary this build has never seen, and a read type has to survive that.
 * A write cannot, because the server refuses what it does not recognize.
 */
export type GitOpsSourcePolicy = 'manual' | 'review' | 'automatic';
export type GitOpsPlacementPolicy = 'operator' | 'bounded_auto';
export type GitOpsRolloutAuthorizationPolicy = 'manual' | 'automatic';

/**
 * Set the placement policy: whether a placement change may be approved without
 * an operator.
 */
export async function setGitOpsPlacementPolicy(
  applicationId: string,
  policy: GitOpsPlacementPolicy,
): Promise<void> {
  await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/placement-policy`,
    { policy },
    'Failed to set the placement policy',
  );
}

/**
 * Set the rollout authorization policy: whether a rollout may be authorized
 * without an operator.
 */
export async function setGitOpsRolloutAuthorizationPolicy(
  applicationId: string,
  policy: GitOpsRolloutAuthorizationPolicy,
): Promise<void> {
  await postAuthorityAction(
    `/gitops/applications/${encodeURIComponent(applicationId)}/rollout/authorization-policy`,
    { policy },
    'Failed to set the rollout authorization policy',
  );
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
