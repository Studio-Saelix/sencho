import type { PostureReasonKind } from '@/types/security';
import type { ImageFilterValue } from '@/lib/severityStyles';

/** The Images filter that best isolates the affected images for a posture reason.
 *  Only fixable findings map to a data-backed filter; known-exploited and
 *  public-exposure have no per-image flag in the summaries, so they open Images
 *  unfiltered rather than mis-hiding the affected images. */
export function reasonImageFilter(kind: PostureReasonKind): ImageFilterValue | undefined {
  return kind === 'fixable_cve' ? 'FIXABLE' : undefined;
}
