import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

export type SourceControllerAction = 'suspend' | 'resume' | 'retry';

const SUCCESS_COPY: Record<SourceControllerAction, string> = {
  suspend: 'Reconciliation suspended',
  resume: 'Reconciliation resumed',
  retry: 'Retry started',
};

/**
 * Outcomes that mean a Retry or Resume ran and the source settled with
 * nothing to report. A 2xx alone is not enough: the routes answer 200 for a
 * refusal that leaves the source exactly as it was.
 */
const SETTLED_OUTCOMES: ReadonlySet<string> = new Set([
  'converged',
  'no_source_change',
  'candidate_already_fetched',
  'pending_review',
  'superseded',
]);

interface ControllerFeedback {
  tone: 'success' | 'warning';
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Append the server's own sentence when it supplied one. */
function withReason(message: string, reason: string): string {
  return reason.length > 0 ? `${message} ${reason}` : message;
}

/**
 * What the operator hears, decided by the outcome the server reported rather
 * than by the HTTP status. Each action states what it needs its answer to
 * say: a Suspend needs `suspended`, a Resume needs anything but, and a Retry
 * needs a settled outcome. A Retry that failed leaves the previous deployment
 * intact, which is the fact that must reach the operator instead of a
 * success line.
 */
function sourceControllerFeedback(
  stackName: string,
  action: SourceControllerAction,
  outcome: string,
  reason: string,
): ControllerFeedback {
  const success: ControllerFeedback = {
    tone: 'success',
    message: `${SUCCESS_COPY[action]} for ${stackName}`,
  };
  const refused = (message: string): ControllerFeedback => ({
    tone: 'warning',
    message: withReason(`${stackName}: ${message}`, reason),
  });

  if (action === 'suspend') {
    return outcome === 'suspended' ? success : refused('the source was not suspended.');
  }
  if (action === 'resume') {
    if (outcome === 'suspended') return refused('the source did not resume.');
    if (outcome === 'unknown') return refused('could not confirm the source resumed.');
    if (SETTLED_OUTCOMES.has(outcome)) return success;
    return refused('reconciliation resumed, but the source still needs attention.');
  }
  if (SETTLED_OUTCOMES.has(outcome)) return success;
  if (outcome === 'failed_previous_intact') {
    return refused('retry failed, the previous deployment was left as it was.');
  }
  // Every other refusing answer already carries an operator-ready sentence
  // (suspended, blocked, recovery_required, retry_scheduled, unknown), so the
  // reason is the message. A body without one still says the retry did not run.
  return {
    tone: 'warning',
    message: withReason(`${stackName}:`, reason || 'the retry did not start.'),
  };
}

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
 * queue lists many. Returns whether the server answered without an HTTP
 * failure, which is also when the views are told to refresh. A 2xx can still
 * report a refusal that left the source as it was, so the toast reads the
 * outcome and only a success-shaped answer claims the action took effect. A
 * failure is reported here and never thrown.
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
    const payload: unknown = await res.json().catch(() => null);
    const answer = isRecord(payload) ? payload : {};
    const outcome = typeof answer.outcome === 'string' ? answer.outcome : null;
    const reason = typeof answer.reason === 'string' ? answer.reason.trim() : '';
    // A node that predates the outcome contract answers with no outcome; the
    // accepted request keeps the action's success line there.
    const feedback = outcome === null
      ? { tone: 'success' as const, message: `${SUCCESS_COPY[action]} for ${stackName}` }
      : sourceControllerFeedback(stackName, action, outcome, reason);
    if (feedback.tone === 'success') toast.success(feedback.message);
    else toast.warning(feedback.message);
    raiseGitOpsStateInvalidate(nodeId);
    return true;
  } catch (e) {
    console.error(`Git source ${action} failed for ${stackName}:`, e);
    toast.error(`${stackName}: ${(e as Error)?.message || 'network error'}`);
    return false;
  }
}
