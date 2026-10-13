import { liveSourceFacet } from '@/lib/gitopsState';
import type { PermissionAction } from '@/context/AuthContext';
import type { GitOpsRevisionProjection } from '@/types/gitops';

export type SourceActionCan = (
  action: PermissionAction,
  resourceType?: string,
  resourceId?: string,
  nodeId?: number | null,
) => boolean;

const PULL_BLOCKED = new Set([
  'source_suspended',
  'applying',
  'checking_fetching',
  'recovery_required',
  'recovery_failed',
]);

export function pullSourceVisible(
  projection: GitOpsRevisionProjection,
  can: SourceActionCan | undefined,
  sourceNodeId: number | null,
): boolean {
  if (projection.targetMode !== 'blueprint' || sourceNodeId == null) return false;
  const sourceStack = projection.configuredSourceStackName;
  if (!sourceStack || can?.('stack:edit', 'stack', sourceStack, sourceNodeId) !== true) return false;
  const source = liveSourceFacet(projection);
  return source !== null && !PULL_BLOCKED.has(source.status);
}

export function acceptSourceVisible(
  projection: GitOpsRevisionProjection,
  can: SourceActionCan | undefined,
): boolean {
  if (projection.targetMode !== 'blueprint' || can?.('stack:create') !== true) return false;
  const source = liveSourceFacet(projection);
  if (!source) return false;
  return (source.status === 'candidate_ready' || source.status === 'source_review_pending')
    && source.candidateGenerationId !== null;
}
