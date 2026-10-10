import { formatAgeShort } from '@/lib/relativeTime';
import type { FindingDismissal } from '@/types/findingDismissal';

/** "dismissed by alice 3d ago · until it changes", the line a dismissed finding carries. */
export function describeDismissal(dismissal: FindingDismissal, now: number): string {
  const hold = dismissal.mode === 'forever'
    ? 'permanently'
    : dismissal.mode === 'days' && dismissal.expiresAt !== null
      ? `until ${new Date(dismissal.expiresAt).toLocaleDateString()}`
      : 'until it changes';
  return `dismissed by ${dismissal.createdBy} ${formatAgeShort(now - dismissal.createdAt)} ago · ${hold}`;
}
