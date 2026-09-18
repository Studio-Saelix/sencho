import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

/**
 * Node-scoped image-update refresh. Confirm via toast; do not refetch overview
 * immediately (the check runs in the background).
 *
 * `useTargetScanner` selects the endpoint: on inspect-v1 remotes the target's
 * own scanner backs Security rechecks, so the target-local alias
 * `/recheck-target` is used and never writes the hub overlay; local and
 * mixed-version nodes keep `/refresh`.
 */
export async function triggerNodeImageUpdateCheck(useTargetScanner = false): Promise<void> {
  const res = await apiFetch(useTargetScanner ? '/image-updates/recheck-target' : '/image-updates/refresh', { method: 'POST' });
  const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
  if (res.status === 429) {
    toast.warning(body.error || 'Rate limited. Please wait before checking again.');
    return;
  }
  if (res.status === 409) {
    toast.warning(body.error || 'Image update detection is disabled for this node.');
    return;
  }
  if (!res.ok) {
    throw new Error(body.error || 'Failed to start image update check');
  }
  toast.success(body.message || 'Image update check started in background.');
}
