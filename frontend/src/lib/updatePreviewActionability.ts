/** Shared Fleet/Anatomy gates for update-preview summaries. */

export interface UpdatePreviewActionSummary {
  has_update?: boolean;
  rebuild_available?: boolean;
  verification_failed?: boolean;
  blocked?: boolean;
}

export interface UpdatePreviewActionImage {
  has_update?: boolean;
  check_error?: string | null;
}

export interface UpdatePreviewActionInput {
  summary: UpdatePreviewActionSummary;
  /**
   * Per-image detail backing the summary. `has_update` and `check_error` are
   * independent per image (a tag-based update can be confirmed via the
   * registry's tag list even when that same image's own digest comparison
   * errored), so the stack-level `verification_failed` alone cannot say
   * whether the failure belongs to the confirmed image itself or to a
   * different one. Optional for callers that only have the aggregate summary
   * (falls back to the older, more conservative aggregate-only judgment).
   */
  images?: UpdatePreviewActionImage[];
}

/**
 * True when `verification_failed` is missing entirely, not merely false. The
 * current backend always includes this field (`true` or `false`) in every
 * update-preview response, so its absence after JSON parsing means the
 * response came from an older remote node that predates digest verification
 * reporting. That remote's clean-looking flags cannot be trusted as proof
 * there is nothing pending; a sticky fleet card must not be silently cleared
 * on the strength of a preview that never checked.
 */
export function isLegacyPreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  return preview.summary.verification_failed === undefined;
}

/** Digest verification failed with no confirmed update or rebuild. */
export function isVerificationOnlyPreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  const s = preview.summary;
  return Boolean(s.verification_failed) && !s.has_update && !s.rebuild_available;
}

/**
 * True when a full-stack apply would pull/recreate an image whose digest
 * verification failed as collateral of applying a DIFFERENT image's confirmed
 * update or a local rebuild. Excludes the case where the only verification
 * failure belongs to the very image whose update is confirmed (that image's
 * own stale-digest check does not block moving it to a newer tag).
 */
function hasUnverifiedOtherImage(preview: UpdatePreviewActionInput): boolean {
  const s = preview.summary;
  const images = preview.images;
  if (!images || images.length === 0) {
    // No per-image detail: fall back to the aggregate flags.
    return Boolean(s.verification_failed) && Boolean(s.has_update || s.rebuild_available);
  }
  // An image with its own check_error and no has_update cannot be the same
  // image as one that confirmed an update (has_update requires no error to
  // land in this bucket), so finding one proves a genuinely different image
  // is unverified.
  const hasPureFailureImage = images.some((i) => Boolean(i.check_error) && !i.has_update);
  if (!hasPureFailureImage) return false;
  return images.some((i) => Boolean(i.has_update)) || Boolean(s.rebuild_available);
}

/**
 * A confirmed update or rebuild exists, but another image in the same stack
 * failed digest verification. A full-stack or scheduled apply would pull and
 * recreate the unverified image as collateral, so it is held for review; a
 * service-scoped apply targeting only the confirmed image is unaffected by
 * this and uses its own per-image state instead.
 */
export function isReviewRequiredUpdatePreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  return hasUnverifiedOtherImage(preview);
}

/** Confirmed update or intentional rebuild that may be applied from Fleet. */
export function isActionableUpdatePreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  const s = preview.summary;
  return !s.blocked
    && Boolean(s.has_update || s.rebuild_available)
    && !hasUnverifiedOtherImage(preview);
}

/**
 * Fresh preview successfully proved there is nothing to apply, and the stack
 * is not held for major-bump review. Sticky fleet booleans must not keep these
 * cards pending.
 */
export function isClearedUpdatePreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  if (preview.summary.blocked) return false;
  if (isLegacyPreview(preview)) return false;
  if (isVerificationOnlyPreview(preview)) return false;
  if (isReviewRequiredUpdatePreview(preview)) return false;
  return !isActionableUpdatePreview(preview);
}
