import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

/** Node-scoped image-update refresh. Confirm via toast; do not refetch overview
 *  immediately (the check runs in the background). */
export async function triggerNodeImageUpdateCheck(): Promise<void> {
  const res = await apiFetch('/image-updates/refresh', { method: 'POST' });
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
