import type { PermissionAction } from '@/context/AuthContext';
import type { ReadinessFinding } from '@/types/readiness';

/** The verbs that resolve a finding where it is listed. Everything else is a named navigation. */
export type ReadinessVerbId =
  | 'test-connection'
  | 'start-stack'
  | 'start-services'
  | 'check-again'
  | 'review-update'
  | 'capture-recovery'
  | 'take-snapshot'
  | 'scan-node'
  | 'install-scanner'
  | 'reanchor';

/** What the backend route behind a verb checks, so the button is hidden rather than left to 403. */
export type VerbRequirement =
  | { kind: 'none' }
  | { kind: 'admin' }
  | { kind: 'permission'; action: PermissionAction; scope: 'stack' | 'node' | 'global' };

export interface ReadinessVerb {
  id: ReadinessVerbId;
  label: string;
  /** Clicks to resolve: 1 runs in place, 2 goes through an overlay that previews or confirms first. */
  clicks: 1 | 2;
  requires: VerbRequirement;
}

const NONE: VerbRequirement = { kind: 'none' };
const ADMIN: VerbRequirement = { kind: 'admin' };
const deploy: VerbRequirement = { kind: 'permission', action: 'stack:deploy', scope: 'stack' };
const manageNode: VerbRequirement = { kind: 'permission', action: 'node:manage', scope: 'node' };
// `scan-node` and `reset-anchor` check the global role, not a grant scoped to one node.
const manageNodeGlobally: VerbRequirement = { kind: 'permission', action: 'node:manage', scope: 'global' };

const VERBS: Record<ReadinessVerbId, ReadinessVerb> = {
  'test-connection': { id: 'test-connection', label: 'Test connection', clicks: 1, requires: manageNode },
  'start-stack': { id: 'start-stack', label: 'Start stack', clicks: 1, requires: deploy },
  'start-services': { id: 'start-services', label: 'Start stopped services', clicks: 1, requires: deploy },
  'check-again': { id: 'check-again', label: 'Check again', clicks: 1, requires: NONE },
  'review-update': { id: 'review-update', label: 'Review update', clicks: 2, requires: deploy },
  'capture-recovery': { id: 'capture-recovery', label: 'Capture recovery point', clicks: 1, requires: deploy },
  'take-snapshot': { id: 'take-snapshot', label: 'Take fleet snapshot', clicks: 1, requires: ADMIN },
  'scan-node': { id: 'scan-node', label: 'Scan node', clicks: 1, requires: manageNodeGlobally },
  'install-scanner': { id: 'install-scanner', label: 'Install scanner', clicks: 2, requires: ADMIN },
  // The route needs node management and an admin; admin implies both.
  reanchor: { id: 'reanchor', label: 'Re-anchor to this hub', clicks: 2, requires: ADMIN },
};

/**
 * The verb that resolves a finding in place, or null when its work lives on
 * another surface (the row then keeps its named navigation).
 *
 * Decided from the finding's structured facts only, never its wording. A peer
 * that predates `topReasonId` and `hasUpdate` sends neither, and every verb that
 * depends on them is then withheld rather than guessed.
 */
export function resolveVerb(finding: ReadinessFinding): ReadinessVerb | null {
  const id = verbIdFor(finding);
  return id === null ? null : VERBS[id];
}

function verbIdFor(finding: ReadinessFinding): ReadinessVerbId | null {
  switch (finding.code) {
    case 'node_unreachable':
    case 'probe_timeout':
    case 'contact_stale':
      return 'test-connection';
    case 'workloads_exited':
      return finding.stack === null ? null : 'start-stack';
    case 'workloads_partial':
      return finding.stack === null ? null : 'start-services';
    case 'workloads_unknown':
    case 'stacks_unknown':
    case 'summary_stale':
    case 'status_evidence_degraded':
    case 'status_evidence_stale':
      return 'check-again';
    case 'update_review_required':
    case 'update_ready_with_warnings':
    case 'update_blocked':
      // An update verdict exists for every stack, so offering the review on one
      // with nothing to update would pull and recreate it for nothing. A blocked
      // verdict is fixed at its cause, not pushed past.
      return finding.stack !== null
        && finding.hasUpdate === true
        && finding.verdict?.value !== 'blocked'
        ? 'review-update'
        : null;
    case 'rollback_not_ready':
    case 'rollback_partial':
      return finding.stack !== null && finding.topReasonId === 'compose_source' ? 'capture-recovery' : null;
    case 'snapshot_failed':
      return 'take-snapshot';
    case 'scans_never_completed':
    case 'scans_stale':
      return 'scan-node';
    case 'scanner_unavailable':
      return 'install-scanner';
    case 'control_paused':
      return 'reanchor';
    default:
      return null;
  }
}

type CanFn = (
  action: PermissionAction,
  resourceType?: string,
  resourceId?: string,
  nodeId?: number | null,
) => boolean;

/** Whether this account may run the verb on the finding, mirroring the route's own check. */
export function canRunVerb(can: CanFn, isAdmin: boolean, verb: ReadinessVerb, finding: Pick<ReadinessFinding, 'stack' | 'nodeId'>): boolean {
  const { requires } = verb;
  switch (requires.kind) {
    case 'none':
      return true;
    case 'admin':
      return isAdmin;
    case 'permission':
      if (requires.scope === 'stack') {
        return finding.stack !== null && can(requires.action, 'stack', finding.stack, finding.nodeId);
      }
      if (requires.scope === 'node') return can(requires.action, 'node', String(finding.nodeId));
      return can(requires.action);
  }
}
