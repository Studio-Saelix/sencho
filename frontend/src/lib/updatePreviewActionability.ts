/** Shared Fleet/Anatomy gates for update-preview summaries. */

export interface UpdatePreviewActionSummary {
  has_update?: boolean;
  rebuild_available?: boolean;
  verification_failed?: boolean;
  blocked?: boolean;
}

export interface UpdatePreviewActionInput {
  summary: UpdatePreviewActionSummary;
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
  const s = preview.summary;
  return Boolean(s.verification_failed) && Boolean(s.has_update || s.rebuild_available);
}

/** Confirmed update or intentional rebuild that may be applied from Fleet. */
export function isActionableUpdatePreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  const s = preview.summary;
  return !s.blocked && !s.verification_failed && Boolean(s.has_update || s.rebuild_available);
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
  if (isVerificationOnlyPreview(preview)) return false;
  if (isReviewRequiredUpdatePreview(preview)) return false;
  return !isActionableUpdatePreview(preview);
}
