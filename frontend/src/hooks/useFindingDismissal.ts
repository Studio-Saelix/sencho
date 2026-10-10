import { useCallback, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { DismissalMode, DismissalSurface, FindingDismissal } from '@/types/findingDismissal';

/** The server's own `{ error }` sentence when it sent one, else the fallback. */
async function serverMessage(res: Response, fallback: string): Promise<{ message: string; code: string | null }> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return { message: fallback, code: null };
  const record = body as { error?: unknown; code?: unknown };
  return {
    message: typeof record.error === 'string' ? record.error : fallback,
    code: typeof record.code === 'string' ? record.code : null,
  };
}

/** The dismissal in a create reply, or null when the reply is not shaped like one. */
function readDismissal(body: unknown): FindingDismissal | null {
  if (typeof body !== 'object' || body === null || !('dismissal' in body)) return null;
  const dismissal = (body as { dismissal: unknown }).dismissal;
  if (typeof dismissal !== 'object' || dismissal === null) return null;
  const candidate = dismissal as Partial<FindingDismissal>;
  const valid = typeof candidate.id === 'number'
    && typeof candidate.findingKey === 'string'
    && typeof candidate.createdBy === 'string';
  return valid ? candidate as FindingDismissal : null;
}

/** The finding as the operator saw it, so a dismissal never covers a state they did not see. */
interface DismissTarget {
  id: string;
  fingerprint: string;
  count: number;
}

interface UseFindingDismissalOptions {
  /** Which surface's store the dismissal goes to (`/fleet/dismissals/<surface>`). */
  surface: DismissalSurface;
  /** A dismissal was created or already existed; the list updates from it without a refetch. */
  onUpsert: (dismissal: FindingDismissal) => void;
  /** A dismissal was removed. */
  onRemove: (id: number) => void;
  /** The finding vanished before it could be dismissed, so the list should be re-read. */
  onGone?: () => void;
}

/**
 * Dismiss and restore findings for the team. One handler for every affordance:
 * a row's Dismiss, the Undo on its toast, and the Restore in the dismissed
 * list all run through here, so the request, the toast, and the busy state
 * cannot drift apart.
 *
 * Hub-owned, so every call is addressed to this instance whatever node is active.
 */
export function useFindingDismissal({ surface, onUpsert, onRemove, onGone }: UseFindingDismissalOptions) {
  const [pending, setPending] = useState<ReadonlySet<string | number>>(() => new Set());

  const track = useCallback(async (key: string | number, run: () => Promise<void>) => {
    setPending(prev => new Set(prev).add(key));
    try {
      await run();
    } finally {
      setPending(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const restore = useCallback(async (id: number, options: { quiet?: boolean } = {}) => {
    await track(id, async () => {
      try {
        const res = await apiFetch(`/fleet/dismissals/${id}`, { method: 'DELETE', localOnly: true });
        // A 404 means it is already gone (restored elsewhere, or retired by a later
        // check): the end state is the one asked for.
        if (!res.ok && res.status !== 404) {
          const { message } = await serverMessage(res, 'Could not restore the finding.');
          console.error('[FindingDismissal] restore refused:', res.status);
          toast.error(message);
          return;
        }
        onRemove(id);
        if (!options.quiet) toast.success(res.status === 404 ? 'It was already restored.' : 'Restored. It is back in the list.');
      } catch (error) {
        console.error('[FindingDismissal] restore failed:', error);
        toast.error('Could not restore the finding.');
      }
    });
  }, [onRemove, track]);

  const dismiss = useCallback(async (finding: DismissTarget, mode: DismissalMode, days?: number) => {
    await track(finding.id, async () => {
      try {
        const res = await apiFetch(`/fleet/dismissals/${surface}`, {
          method: 'POST',
          localOnly: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            findingId: finding.id,
            fingerprint: finding.fingerprint,
            count: finding.count,
            mode,
            ...(days === undefined ? {} : { days }),
          }),
        });
        if (!res.ok) {
          const { message, code } = await serverMessage(res, 'Could not dismiss the finding.');
          console.error('[FindingDismissal] dismiss refused:', res.status, code);
          if (code === 'FINDING_GONE') {
            toast.info('That finding is already resolved.');
            onGone?.();
          } else if (code === 'FINDING_CHANGED') {
            toast.info('That finding just changed, so it was not dismissed.');
            onGone?.();
          } else {
            toast.error(message);
          }
          return;
        }
        const body: unknown = await res.json().catch(() => null);
        const dismissal = readDismissal(body);
        if (dismissal === null) {
          // The server accepted it but the reply is unreadable, so the list is re-read
          // rather than guessed at, and the operator is not told it failed.
          toast.info('Dismissed. Refreshing the list.');
          onGone?.();
          return;
        }
        onUpsert(dismissal);
        if ((body as { kept?: unknown }).kept === true) {
          toast.info(`Already dismissed by ${dismissal.createdBy}.`);
          return;
        }
        toast.success(mode === 'until_change' ? 'Dismissed. It returns if it changes.' : 'Dismissed.', {
          action: { label: 'Undo', onClick: () => { void restore(dismissal.id, { quiet: true }); } },
          duration: 8000,
        });
      } catch (error) {
        console.error('[FindingDismissal] dismiss failed:', error);
        toast.error('Could not dismiss the finding.');
      }
    });
  }, [surface, onUpsert, onGone, restore, track]);

  const isPending = useCallback((key: string | number) => pending.has(key), [pending]);
  return { dismiss, restore, isPending };
}
