import { useCallback } from 'react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';

export type BulkAction = 'start' | 'stop' | 'restart' | 'update';

const pastTense: Record<BulkAction, string> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
  update: 'updated',
};

interface BulkCallbacks {
  onBefore?: (files: string[]) => void;
  onAfter?: (files: string[]) => void;
}

interface BulkResultItem {
  stackName: string;
  ok: boolean;
  error?: string;
  code?: string;
}

interface BulkResponse {
  action: BulkAction;
  results: BulkResultItem[];
}

/** Codes a bulk request can carry instead of per-stack results, with the server's own sentence. */
const NODE_REFUSAL_CODES: ReadonlySet<string> = new Set(['capability_unavailable', 'node_unreachable']);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function useBulkStackActions() {
  const runBulk = useCallback(async (
    action: BulkAction,
    files: string[],
    cbs?: BulkCallbacks,
  ) => {
    if (files.length === 0) return;

    cbs?.onBefore?.(files);

    const stackNames = files.map(file => file.replace(/\.(yml|yaml)$/, ''));

    try {
      const response = await apiFetch('/stacks/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, stackNames }),
      });

      cbs?.onAfter?.(files);

      if (!response.ok) {
        const errBody: unknown = await response.json().catch(() => null);
        const serverError = isRecord(errBody) && typeof errBody.error === 'string' && errBody.error.trim()
          ? errBody.error
          : null;
        const serverCode = isRecord(errBody) && typeof errBody.code === 'string' ? errBody.code : null;
        // A node that predates the contract, or one that is unreachable, refuses
        // the whole batch before any stack runs; the server's own sentence names
        // the cause, with a fallback that says what to do when it does not.
        const fallback = serverCode !== null && NODE_REFUSAL_CODES.has(serverCode)
          ? (serverCode === 'capability_unavailable'
            ? 'This node does not support this bulk action from this Sencho version. Update Sencho on the node.'
            : 'The node is unreachable. Check that it is online and try again.')
          : `Bulk ${action} failed (HTTP ${response.status})`;
        toast.error(serverError ?? fallback);
        return;
      }

      const payload = (await response.json()) as BulkResponse;
      const results = Array.isArray(payload.results) ? payload.results : [];
      const okCount = results.filter(r => r.ok).length;
      // A policy skip is an unattended decision, not a failure: the operator
      // declared that this stack is not to be updated automatically.
      const skipped = results.filter(r => !r.ok && r.code === 'update_policy_skipped');
      const failed = results.filter(r => !r.ok && r.code !== 'update_policy_skipped');

      if (skipped.length === 0 && failed.length === 0) {
        const noun = okCount === 1 ? 'stack' : 'stacks';
        toast.success(`${okCount} ${noun} ${pastTense[action]}`);
        return;
      }

      const skippedNote = skipped.length > 0
        ? `${skipped.length} skipped by update policy`
        : null;

      if (failed.length === 0) {
        toast.warning(`${okCount} ${pastTense[action]}, ${skippedNote}`);
        return;
      }

      const failedNames = failed.map(r => r.stackName).join(', ');
      const summary = [
        `${okCount} of ${results.length} ${pastTense[action]}`,
        skippedNote,
        `${failed.length} failed: ${failedNames}`,
      ].filter(Boolean).join('; ');
      toast.error(summary);
    } catch (err) {
      cbs?.onAfter?.(files);
      console.error('Bulk action failed:', err);
      toast.error(`Bulk ${action} failed: ${(err as Error).message}`);
    }
  }, []);

  return { runBulk };
}
