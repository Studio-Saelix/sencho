import { useCallback } from 'react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { useLicense } from '@/context/LicenseContext';

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

export function useBulkStackActions() {
  const { isPaid } = useLicense();

  const runBulk = useCallback(async (
    action: BulkAction,
    files: string[],
    cbs?: BulkCallbacks,
  ) => {
    if (files.length === 0) return;
    if (action === 'update' && !isPaid) {
      toast.error('Bulk update requires a Skipper license.');
      return;
    }

    cbs?.onBefore?.(files);

    const stackNames = files.map(file => file.replace(/\.(yml|yaml)$/, ''));

    try {
      const response = await apiFetch('/stacks/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, stackNames }),
      });

      cbs?.onAfter?.(files);

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const errMsg = (errBody as { error?: string })?.error
          ?? `Bulk ${action} failed (HTTP ${response.status})`;
        toast.error(errMsg);
        return;
      }

      const payload = (await response.json()) as BulkResponse;
      const results = Array.isArray(payload.results) ? payload.results : [];
      const okCount = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok);

      if (failed.length === 0) {
        const noun = okCount === 1 ? 'stack' : 'stacks';
        toast.success(`${okCount} ${noun} ${pastTense[action]}`);
        return;
      }

      const failedNames = failed.map(r => r.stackName).join(', ');
      toast.error(
        `${okCount} of ${results.length} ${pastTense[action]}; ${failed.length} failed: ${failedNames}`,
      );
    } catch (err) {
      cbs?.onAfter?.(files);
      console.error('Bulk action failed:', err);
      toast.error(`Bulk ${action} failed: ${(err as Error).message}`);
    }
  }, [isPaid]);

  return { runBulk, isPaid };
}
