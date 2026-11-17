import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

export type SourceControllerAction = 'suspend' | 'resume' | 'retry';

const SUCCESS_COPY: Record<SourceControllerAction, string> = {
  suspend: 'Reconciliation suspended',
  resume: 'Reconciliation resumed',
  retry: 'Retry started',
};

/**
 * Outcomes that mean a Retry or Resume ran and the source settled without a
 * failure or a block. A 2xx alone is not enough: the routes answer 200 for a
 * refusal, not only for a completed action.
 */
const SETTLED_OUTCOMES: ReadonlySet<string> = new Set([
  'converged',
  'no_source_change',
  'candidate_already_fetched',
  'pending_review',
  'superseded',
]);

/** What to say when a 2xx carries no outcome this build can read. */
const UNCONFIRMED_COPY: Record<SourceControllerAction, string> = {
  suspend: 'could not confirm the source was suspended.',
  resume: 'could not confirm the source resumed.',
  retry: 'could not confirm the retry started.',
};

interface ControllerFeedback {
  tone: 'success' | 'warning';
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Append the server's own sentence when it supplied one. */
function withReason(message: string, reason: string): string {
  return reason.length > 0 ? `${message} ${reason}` : message;
}

/**
 * What the operator hears, decided by the outcome the server reported rather
 * than by the HTTP status. Each action states what it needs its answer to
 * say: a Suspend needs `suspended`, and a Retry needs a settled outcome. A
 * Resume needs a settled outcome too, with a warning when the suspension
 * cleared but the source still needs attention. `failed_previous_intact`
 * is the one outcome that reports the previous deployment as intact, which
 * must reach the operator instead of a success line.
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
    // A refused suspend throws, so a 2xx normally means the write took. The
    // projection still reports recovery or an interruption ahead of the
    // suspended facet, which is why the confirmation is not assumed.
    return outcome === 'suspended' ? success : refused('the suspension could not be confirmed.');
  }
  if (action === 'resume') {
    if (outcome === 'suspended') return refused('the source did not resume.');
    if (outcome === 'unknown') {
      return refused("could not confirm the source's state after the resume.");
    }
    if (SETTLED_OUTCOMES.has(outcome)) return success;
    if (outcome === 'failed_previous_intact') {
      return refused('reconciliation resumed, but the source still needs attention: the previous deployment was left as it was.');
    }
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
 * queue lists many. Returns whether the action took effect (a success-shaped
 * outcome). Every 2xx raises the refresh signal, including a refusal, because
 * the server may have recorded evidence the views should show. A 2xx whose
 * body cannot be read is reported as unconfirmed, never as a success. A
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
    // The routes always answer with a ReconcileResult, so a 2xx without an
    // outcome is unreadable evidence, not an accepted action.
    const feedback = outcome === null
      ? {
          tone: 'warning' as const,
          message: withReason(`${stackName}: ${UNCONFIRMED_COPY[action]}`, reason),
        }
      : sourceControllerFeedback(stackName, action, outcome, reason);
    if (feedback.tone === 'success') toast.success(feedback.message);
    else toast.warning(feedback.message);
    raiseGitOpsStateInvalidate(nodeId);
    return feedback.tone === 'success';
  } catch (e) {
    console.error(`Git source ${action} failed for ${stackName}:`, e);
    toast.error(`${stackName}: ${(e as Error)?.message || 'network error'}`);
    return false;
  }
}
