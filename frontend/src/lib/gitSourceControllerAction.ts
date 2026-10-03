import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

export type SourceControllerAction = 'suspend' | 'resume' | 'retry';

const SUCCESS_COPY: Record<SourceControllerAction, string> = {
  suspend: 'Reconciliation suspended',
  resume: 'Reconciliation resumed',
  retry: 'Retry started',
};

/**
 * Tell every GitOps view that a change just happened on a node, in the shape the
 * server's announcement uses (`scope` plus `nodeId`): the GitOps views listen on
 * the `gitops` channel, and the dashboard's per-node hooks also need the node.
 */
export function raiseGitOpsStateInvalidate(nodeId: number | null | undefined): void {
  window.dispatchEvent(new CustomEvent('sencho:state-invalidate', {
    detail: { scope: 'gitops', ...(typeof nodeId === 'number' ? { nodeId } : {}) },
  }));
}

/**
 * Suspend, resume, or retry one stack's Git source on the node that owns it.
 *
 * The single handler behind every affordance for these actions (the Git source
 * sheet and the attention queue's Retry and Resume), so the request, the toasts,
 * and the refresh signal cannot drift apart. Toasts name the stack because the
 * queue lists many. Returns whether the server accepted it. A failure is
 * reported here and never thrown, so a caller only decides what to do after a
 * success.
 */
export async function runSourceControllerAction(
  stackName: string,
  nodeId: number | null | undefined,
  action: SourceControllerAction,
  body?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/${action}`, {
      nodeId,
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`${stackName}: ${err.error || `could not ${action} this Git source`}`);
      return false;
    }
    toast.success(`${SUCCESS_COPY[action]} for ${stackName}`);
    raiseGitOpsStateInvalidate(nodeId);
    return true;
  } catch (e) {
    console.error(`Git source ${action} failed for ${stackName}:`, e);
    toast.error(`${stackName}: ${(e as Error)?.message || 'network error'}`);
    return false;
  }
}
