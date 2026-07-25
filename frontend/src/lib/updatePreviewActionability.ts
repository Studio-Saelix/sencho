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

/** Confirmed update or intentional rebuild that may be applied from Fleet. */
export function isActionableUpdatePreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  return !preview.summary.blocked
    && Boolean(preview.summary.has_update || preview.summary.rebuild_available);
}
