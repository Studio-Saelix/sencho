import type { PostureReasonKind } from '@/types/security';
import type { ImageFilterValue } from '@/lib/severityStyles';

/** The Images filter that best isolates the affected images for a posture reason.
 *  fixable_cve (confirmed newer image) maps to FIXABLE, a package-fixable
 *  superset. waiting_upstream / update_check_uncertain open Images unfiltered
 *  via View findings rather than inventing a new filter dimension. */
export function reasonImageFilter(kind: PostureReasonKind): ImageFilterValue | undefined {
  return kind === 'fixable_cve' ? 'FIXABLE' : undefined;
}

/** Default Open-button label for a reason when actionLabel is omitted. */
export function defaultReasonActionLabel(targetTab: string): string {
  if (targetTab === 'compose') return 'Open Compose risks';
  if (targetTab === 'suppressions') return 'Open Suppressions';
  if (targetTab === 'secrets') return 'Open Secrets';
  if (targetTab === 'history') return 'Open History';
  if (targetTab === 'scanner') return 'Open Scanner setup';
  return 'Open Images';
}
