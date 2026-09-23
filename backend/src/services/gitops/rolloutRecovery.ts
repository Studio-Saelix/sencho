/**
 * Rollout-scoped recovery execution for Blueprint targets.
 *
 * The GitOps model owns the decision state (which generation, which targets),
 * and the node owns the restore evidence: its captured recovery point is what
 * proves the node was running the generation a rollback selects. This module
 * therefore never decides what to restore. It selects the recovery point that
 * names the requested application generation and asks the owning node to
 * compensate from it, then reports what actually happened per target.
 *
 * A local target is restored in-process under the same stack operation lock
 * the stacks rollback route holds. A remote target is restored through that
 * node's own `POST /api/stacks/:stackName/rollback` with the same
 * generation-selection contract, so both paths enforce identical evidence
 * rules.
 */
import axios from 'axios';
import type { PermissionAction } from '../../middleware/permissions';
import { DatabaseService } from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import { LicenseService } from '../LicenseService';
import { StackUpdateRecoveryService } from '../StackUpdateRecoveryService';
import { StackOpLockService } from '../StackOpLockService';
import { ComposeService } from '../ComposeService';
import { sanitizeForLog } from '../../utils/safeLog';
import { safeAxiosTransport } from '../../utils/outboundTarget';
import { formatScopedStackActionsHeader } from '../../helpers/stackRouteAuth';
import {
  PROXY_DEPLOY_ACTOR_HEADER,
  PROXY_DEPLOY_SOURCE_HEADER,
  PROXY_ROLE_HEADER,
  PROXY_SCOPED_STACK_ACTIONS_HEADER,
  PROXY_SCOPED_STACK_NAME_HEADER,
  PROXY_TIER_HEADER,
} from '../license-headers';
import type { PolicyEnforcementOptions } from '../PolicyEnforcement';
import type { GitOpsApplicationRow, GitOpsTargetCurrentRow } from './types';
import { GitOpsStore } from './store';
import { decodeGitOpsRequiredTargetsJson } from './json';

const REMOTE_ROLLBACK_TIMEOUT_MS = 10 * 60_000;

export type RolloutRollbackScope =
  | { kind: 'target'; nodeId: number }
  | { kind: 'failed' }
  | { kind: 'all_changed' };

export type RolloutRollbackTargetResult = {
  nodeId: number;
  status: 'restored' | 'failed';
  error?: string;
};

export type RestoreTargetOutcome =
  | { ok: true }
  | { ok: false; code: string; error: string };

/**
 * The frozen target set the current rollout was authorized against.
 *
 * The live authorization binding is authoritative while it resolves. A
 * superseded generation whose pointer is still on the application keeps
 * naming the set the operator reviewed, so a rollback can act on the targets
 * that actually moved. An invalidation clears the pointer, and then there is
 * no set to recover.
 */
export function rolloutTargetSet(app: GitOpsApplicationRow): {
  nodeIds: number[];
  acceptedGenerationId: string | null;
} | null {
  const store = GitOpsStore.getInstance();
  const binding = store.currentAuthorizationBinding(app);
  if (binding) {
    return { nodeIds: [...binding.requiredNodeIds], acceptedGenerationId: binding.acceptedGenerationId };
  }
  if (!app.rollout_generation_id) return null;
  const generation = store.getRolloutGeneration(app.rollout_generation_id);
  if (!generation) return null;
  try {
    return {
      nodeIds: decodeGitOpsRequiredTargetsJson(generation.required_targets_json).nodeIds,
      acceptedGenerationId: generation.accepted_generation_id,
    };
  } catch (error) {
    console.error(
      '[GitOps recovery] Rollout generation required set is unreadable:',
      sanitizeForLog(app.id),
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

/** Targets whose last recorded state names a failure rather than a result. */
function isFailedTarget(target: GitOpsTargetCurrentRow): boolean {
  return target.failure_stage === 'blueprint_deploy'
    || target.recovery_phase === 'failed'
    || target.connectivity === 'unreachable'
    || target.connectivity === 'stale';
}

/**
 * Prior application generations a rollback can select, from the hub's own
 * rollout-generation history.
 *
 * The newest first, excluding the generation the application currently asks
 * for: there is nothing to restore when a target already runs it. A lifecycle
 * that only ever authorized one generation has no candidates, which is the
 * truthful answer for a first rollout.
 */
export function rollbackCandidatesForApplication(applicationId: string): Array<{
  generationId: string;
  rolloutGenerationId: string;
  createdAt: number;
}> {
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(applicationId);
  if (!app || app.target_mode !== 'blueprint') return [];
  // No frozen set means the backend would refuse every rollback, so offering
  // the generations would only produce a 409.
  if (!rolloutTargetSet(app)) return [];
  const seen = new Set<string>();
  if (app.accepted_generation_id) seen.add(app.accepted_generation_id);
  const candidates: Array<{ generationId: string; rolloutGenerationId: string; createdAt: number }> = [];
  for (const generation of store.listRolloutGenerationsForApplication(applicationId)) {
    const generationId = generation.accepted_generation_id;
    if (!generationId || seen.has(generationId)) continue;
    seen.add(generationId);
    candidates.push({
      generationId,
      rolloutGenerationId: generation.id,
      createdAt: generation.created_at,
    });
    if (candidates.length >= 10) break;
  }
  return candidates;
}

/**
 * Resolve the requested scope against the frozen set.
 *
 * Returns the node ids in the order the frozen set lists them, so a sequential
 * restore follows the same order the rollout did. A target already running the
 * generation the rollback selects is not a recovery, so it is not in scope.
 */
export function resolveRollbackTargets(
  app: GitOpsApplicationRow,
  scope: RolloutRollbackScope,
  restoreGenerationId: string,
): { ok: true; nodeIds: number[] } | { ok: false; code: string; error: string } {
  const store = GitOpsStore.getInstance();
  const frozen = rolloutTargetSet(app);
  if (!frozen || frozen.nodeIds.length === 0) {
    return {
      ok: false,
      code: 'ROLLBACK_UNAVAILABLE',
      error: 'There is no current rollout target set to recover.',
    };
  }
  const live = frozen.nodeIds
    .map((nodeId) => store.getTarget(app.id, nodeId))
    .filter((target): target is GitOpsTargetCurrentRow => !!target
      && target.target_status === 'active'
      && target.applied_generation_id !== restoreGenerationId);

  if (scope.kind === 'target') {
    const match = live.find((target) => target.node_id === scope.nodeId);
    if (!match) {
      const targetRow = store.getTarget(app.id, scope.nodeId);
      const isActive = !!targetRow && targetRow.target_status === 'active';
      if (isActive && frozen.nodeIds.includes(scope.nodeId)) {
        return {
          ok: false,
          code: 'TARGET_ALREADY_CURRENT',
          error: `Node ${scope.nodeId} already runs the selected generation.`,
        };
      }
      return {
        ok: false,
        code: 'TARGET_NOT_IN_ROLLOUT',
        error: `Node ${scope.nodeId} is not an active target of the current rollout.`,
      };
    }
    return { ok: true, nodeIds: [scope.nodeId] };
  }

  if (scope.kind === 'failed') {
    const failed = live.filter(isFailedTarget).map((target) => target.node_id);
    if (failed.length === 0) {
      return {
        ok: false,
        code: 'NO_FAILED_TARGETS',
        error: 'No target in the current rollout is recorded as failed, unreachable, or stale.',
      };
    }
    return { ok: true, nodeIds: frozen.nodeIds.filter((nodeId) => failed.includes(nodeId)) };
  }

  const changed = frozen.nodeIds.filter((nodeId) => live.some((target) => target.node_id === nodeId));
  if (changed.length === 0) {
    return {
      ok: false,
      code: 'ROLLBACK_UNAVAILABLE',
      error: 'No live target in the current rollout needs the selected generation.',
    };
  }
  return { ok: true, nodeIds: changed };
}

function policyOptions(actor: string | null, applicationId: string): PolicyEnforcementOptions {
  return {
    bypass: false,
    actor: actor ?? 'system:gitops-rollback',
    auditMethod: 'POST',
    auditPath: `/api/gitops/applications/${applicationId}/rollout/rollback`,
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'ROLLBACK_FAILED';
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'The restore did not complete.';
}

function restoreLocal(args: {
  nodeId: number;
  stackName: string;
  generationId: string;
  app: GitOpsApplicationRow;
  actor: string | null;
}): Promise<RestoreTargetOutcome> {
  return StackOpLockService.getInstance()
    .runExclusive(args.nodeId, args.stackName, 'rollback', args.actor ?? 'system', async () => {
      const recovery = StackUpdateRecoveryService.getInstance();
      const current = recovery.getCurrent(args.nodeId, args.stackName);
      if (!current) {
        return {
          ok: false as const,
          code: 'NO_RECOVERY_POINT',
          error: `The node holds no recovery point for "${args.stackName}".`,
        };
      }
      if (current.gitops_generation_id !== args.generationId) {
        return {
          ok: false as const,
          code: 'RECOVERY_POINT_MISMATCH',
          error: 'The recovery point on this node restores a different generation than the one selected.',
        };
      }
      try {
        const rolledBack = await recovery.compensateWithCandidate(
          current.id,
          (overridePath, invocation, overlay) => ComposeService.getInstance(args.nodeId)
            .composeUpWithRecoveryOverride(args.stackName, overridePath, undefined, invocation, overlay),
          policyOptions(args.actor, args.app.id),
        );
        if (!rolledBack) {
          return {
            ok: false as const,
            code: 'ROLLBACK_FAILED',
            error: 'The restore did not complete.',
          };
        }
        return { ok: true as const };
      } catch (error) {
        console.error(
        '[GitOps recovery] Local restore failed for %s:',
        sanitizeForLog(args.stackName),
        sanitizeForLog(error instanceof Error ? error.message : String(error)),
      );
        return { ok: false as const, code: errorCode(error), error: errorText(error) };
      }
    })
    .then((result) => {
      if (!result.ran) {
        return {
          ok: false as const,
          code: 'STACK_BUSY',
          error: `Another operation is already running on "${args.stackName}".`,
        };
      }
      return result.result;
    });
}

async function restoreRemote(args: {
  nodeId: number;
  stackName: string;
  generationId: string;
  actor: string | null;
  role: string;
  scopedActions: readonly PermissionAction[];
}): Promise<RestoreTargetOutcome> {
  const target = NodeRegistry.getInstance().getProxyTarget(args.nodeId);
  if (!target) {
    return { ok: false, code: 'NODE_UNREACHABLE', error: 'The owning node is unreachable.' };
  }
  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const headers: Record<string, string> = {
    [PROXY_TIER_HEADER]: LicenseService.getInstance().getProxyHeaders().tier,
    [PROXY_ROLE_HEADER]: args.role,
    [PROXY_DEPLOY_SOURCE_HEADER]: 'manual',
    [PROXY_SCOPED_STACK_NAME_HEADER]: args.stackName,
    [PROXY_SCOPED_STACK_ACTIONS_HEADER]: formatScopedStackActionsHeader(args.scopedActions),
  };
  if (args.actor) headers[PROXY_DEPLOY_ACTOR_HEADER] = args.actor;
  if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;

  try {
    const res = await axios.post(
      `${baseUrl}/api/stacks/${encodeURIComponent(args.stackName)}/rollback`,
      { expectedGitopsGenerationId: args.generationId },
      {
        ...safeAxiosTransport(target.trustedLoopback),
        headers,
        timeout: REMOTE_ROLLBACK_TIMEOUT_MS,
        validateStatus: () => true,
      },
    );
    const body = res.data as { error?: unknown; code?: unknown; gitopsGenerationId?: unknown } | null;
    if (res.status >= 200 && res.status < 300) {
      // The node must confirm the restored generation. A node that does not
      // know the guard (an older build) would ignore it and answer 200 for
      // whatever its current recovery point is, so an absent or different
      // echo fails closed rather than claiming the requested restore.
      if (body?.gitopsGenerationId !== args.generationId) {
        return {
          ok: false,
          code: 'RECOVERY_POINT_MISMATCH',
          error: 'The node did not confirm restoring the requested application generation.',
        };
      }
      return { ok: true };
    }
    const code = typeof body?.code === 'string' && body.code.length > 0
      ? body.code
      : res.status === 403 ? 'PERMISSION_DENIED' : 'ROLLBACK_FAILED';
    const message = typeof body?.error === 'string' && body.error.length > 0
      ? body.error
      : `The node answered HTTP ${res.status} to the restore request.`;
    return { ok: false, code, error: message };
  } catch (error) {
    console.error(
      '[GitOps recovery] Remote restore request failed for node %s:',
      args.nodeId,
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    return { ok: false, code: 'NODE_UNREACHABLE', error: 'The restore request to the owning node failed.' };
  }
}

/**
 * Restore one target to the selected application generation.
 *
 * `role` and `scopedActions` are the acting user's credential for the remote
 * hop; the local path runs under the same stack operation lock a local
 * operator's rollback would hold.
 */
export async function restoreTargetToGeneration(args: {
  app: GitOpsApplicationRow;
  stackName: string;
  nodeId: number;
  generationId: string;
  actor: string | null;
  role: string;
  scopedActions: readonly PermissionAction[];
}): Promise<RestoreTargetOutcome> {
  const node = DatabaseService.getInstance().getNode(args.nodeId);
  if (node?.type === 'local') {
    return restoreLocal(args);
  }
  return restoreRemote(args);
}
