import { useCallback, useState } from 'react';

import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { GITOPS_SOURCE_CONTROLLER_CAPABILITY } from '@/lib/capabilities';
import { attentionLabel } from '@/lib/gitopsPortfolio';
import type { GitOpsAttentionReason, GitOpsPortfolioRow } from '@/types/gitopsPortfolio';
import { attentionNextStep, type AttentionStep, type SourceControl } from './portfolioNavigation';

/** Failures read as louder than waiting decisions, so the first reason shown is the one to look at first. */
export function byUrgency(a: GitOpsAttentionReason, b: GitOpsAttentionReason): number {
  const rank = (reason: GitOpsAttentionReason) => (attentionLabel(reason).tone === 'destructive' ? 0 : 1);
  return rank(a) - rank(b);
}

/**
 * What this session may do to a Direct application's Git source from a list:
 * for a controller verb, the server must offer it, the session must be able to
 * edit the stack, and the owning node must run the source controller. Anything
 * else falls back to opening the surface, so a button never promises what would
 * be refused.
 */
function useSourceControl(): (row: GitOpsPortfolioRow) => SourceControl {
  const { can } = useAuth();
  const { nodeMeta } = useNodes();
  return (row) => {
    if (row.nodeId === null || row.stackName === null) {
      return { can: () => false, canReview: () => false };
    }
    const meta = nodeMeta.get(row.nodeId);
    // Optimistic while the node's capabilities are unknown, as the Git source sheet is; a refusal still toasts.
    const capable = meta ? meta.capabilities.includes(GITOPS_SOURCE_CONTROLLER_CAPABILITY) : true;
    const mayWrite = capable && can('stack:edit', 'stack', row.stackName, row.nodeId);
    return {
      can: (action) => mayWrite && row.availableActions.includes(action),
      // Reviewing pulls the waiting commit, the same stack:edit write as a
      // controller verb. The projection carries no review verb to consult, so
      // edit access and the controller capability are the whole gate.
      canReview: () => mayWrite,
    };
  };
}

/**
 * The one step that resolves an application's most urgent attention reason,
 * shared by the desktop queue and the phone list so both run the same verb
 * through the same handler. `run` keeps one pending flag per row, so a second
 * click on another row cannot end the first one's busy state early.
 */
export function useAttentionSteps() {
  const controlFor = useSourceControl();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const setPending = useCallback((rowId: string, pending: boolean) => setPendingIds(current => {
    const next = new Set(current);
    if (pending) next.add(rowId); else next.delete(rowId);
    return next;
  }), []);

  const run = async (rowId: string, step: () => void | Promise<void>) => {
    setPending(rowId, true);
    try {
      await step();
    } finally {
      setPending(rowId, false);
    }
  };

  const stepFor = (row: GitOpsPortfolioRow, reason: GitOpsAttentionReason): AttentionStep =>
    attentionNextStep(reason, row, controlFor(row));

  return { stepFor, run, isPending: (rowId: string) => pendingIds.has(rowId) };
}
