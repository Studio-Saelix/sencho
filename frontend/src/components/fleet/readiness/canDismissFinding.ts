import type { PermissionAction } from '@/context/AuthContext';
import type { ReadinessFinding } from '@/types/readiness';

type CanFn = (
  action: PermissionAction,
  resourceType?: string,
  resourceId?: string,
  nodeId?: number | null,
) => boolean;

/**
 * Whether this account may dismiss a readiness finding, mirroring the server's
 * rule so Dismiss never shows for a request that would 403: Control findings
 * need an admin, a stack finding needs deploy on that stack, and a node-level
 * finding needs node management of that node.
 */
export function canDismissFinding(can: CanFn, isAdmin: boolean, finding: Pick<ReadinessFinding, 'domain' | 'stack' | 'nodeId'>): boolean {
  if (finding.domain === 'control') return isAdmin;
  if (finding.stack !== null) return can('stack:deploy', 'stack', finding.stack, finding.nodeId);
  return can('node:manage', 'node', String(finding.nodeId));
}
