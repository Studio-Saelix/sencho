import type { PostureReasonKind } from '@/types/security';
import type { ImageFilterValue } from '@/lib/severityStyles';

/** The Images severity filter that best isolates the affected images when a
 *  posture reason has no targets (older remote node). With targets present,
 *  Images uses reason targeting instead. waiting_upstream /
 *  update_check_uncertain open Images unfiltered via View findings when
 *  targets are absent rather than inventing a severity dimension. */
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
