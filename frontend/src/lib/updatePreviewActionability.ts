/**
 * Shared Fleet/Anatomy gates for update-preview summaries.
 * Tag-only availability is advisory: Compose pull does not rewrite pins.
 */

/** Tooltip for digest-rebuild surfaces: what the badge means, and why an
 *  update may not clear it (daemon-side causes behind a persistent badge). */
export const DIGEST_REBUILD_HINT =
  'Same tag, newer content. If Update does not clear this, your Docker daemon may be pulling through a mirror or the container may still be on the previous image. Check your daemon configuration.';

export interface UpdatePreviewActionImage {
  service?: string;
  has_update?: boolean;
  digest_update?: boolean;
  tag_update?: boolean;
  check_status?: string | null;
  check_error?: string | null;
  /**
   * This image's own digest-comparison failure reason, independent of
   * check_error: a confirmed tag-based update on the SAME image resolves
   * check_status to 'ok' and nulls check_error, but digest_error stays set
   * since the image's current tag content was never actually verified.
   */
  digest_error?: string | null;
}

export interface UpdatePreviewActionSummary {
  has_update?: boolean;
  rebuild_available?: boolean;
  verification_failed?: boolean;
  blocked?: boolean;
  check_status?: string | null;
  /** Present on current nodes; used for older remotes without digest/tag flags. */
  update_kind?: string | null;
}

export interface UpdatePreviewActionInput {
  summary: UpdatePreviewActionSummary;
  /**
   * Per-image detail backing the summary. `has_update` and `digest_error` are
   * independent per image (a tag-based update can be confirmed via the
   * registry's tag list even when that same image's own digest comparison
   * errored), so the stack-level `verification_failed` alone cannot say
   * whether the failure belongs to the confirmed image itself or to a
   * different one. Optional for callers that only have the aggregate summary
   * (falls back to the older, more conservative aggregate-only judgment).
   */
  images?: UpdatePreviewActionImage[];
}

function summaryCheckOk(summary: UpdatePreviewActionSummary): boolean {
  return (summary.check_status ?? 'ok') === 'ok';
}

function imageParityFlagsPresent(images: UpdatePreviewActionImage[]): boolean {
  return images.some((i) => i.digest_update !== undefined || i.tag_update !== undefined);
}

/** True when the stack has a Compose-executable update (digest drift or rebuild). */
export function hasExecutableUpdate(preview: UpdatePreviewActionInput | null | undefined): boolean {
  if (!preview) return false;
  if (preview.summary.rebuild_available) return true;
  const images = preview.images ?? [];
  if (images.some((i) => i.digest_update === true)) return true;
  // Older remotes omit digest_update/tag_update; fall back to update_kind.
  if (!imageParityFlagsPresent(images)) {
    return Boolean(preview.summary.has_update && preview.summary.update_kind !== 'tag');
  }
  return false;
}

/** True when only newer tags exist (no digest/rebuild action Compose can apply). */
export function isTagOnlyAdvisory(preview: UpdatePreviewActionInput | null | undefined): boolean {
  if (!preview?.summary.has_update) return false;
  if (preview.summary.rebuild_available) return false;
  const images = preview.images ?? [];
  if (images.some((i) => i.digest_update === true)) return false;
  if (images.some((i) => i.tag_update === true)) return true;
  if (!imageParityFlagsPresent(images)) {
    return preview.summary.update_kind === 'tag';
  }
  return images.some((i) => i.has_update === true);
}

/**
 * True when `check_status` is missing entirely, not merely absent from a
 * checked field. The current backend always includes this field on every
 * update-preview response, so its absence after JSON parsing means the
 * response came from an older remote node that predates check-status
 * reporting. That remote's clean-looking flags cannot be trusted as proof
 * there is nothing pending; a sticky fleet card must not be silently cleared
 * on the strength of a preview that never checked.
 */
export function isLegacyPreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  return preview.summary.check_status === undefined;
}

/** Digest verification failed with no confirmed update or rebuild. */
export function isVerificationOnlyPreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  const s = preview.summary;
  return Boolean(s.verification_failed) && !s.has_update && !s.rebuild_available;
}

/** True when the last check did not complete authoritatively (partial or failed). */
export function isPreviewUncertain(preview: UpdatePreviewActionInput | null | undefined): boolean {
  if (!preview) return false;
  const status = preview.summary.check_status;
  return status === 'partial' || status === 'failed';
}

/**
 * True when a full-stack apply would pull/recreate an image whose digest
 * content was never verified, as collateral of applying a DIFFERENT image's
 * confirmed update or a local rebuild. Reads digest_error, not check_error:
 * a confirmed tag-based update on the SAME image resolves check_status to
 * 'ok' and nulls check_error, but a full-stack apply still re-pulls that
 * image's current tag, whose digest_error means its content was never
 * confirmed.
 */
function hasUnverifiedOtherImage(preview: UpdatePreviewActionInput): boolean {
  const s = preview.summary;
  const images = preview.images;
  if (!images || images.length === 0) {
    // No per-image detail: fall back to the aggregate flags.
    return Boolean(s.verification_failed) && Boolean(s.has_update || s.rebuild_available);
  }
  const hasUnverifiedImage = images.some((i) => Boolean(i.digest_error));
  if (!hasUnverifiedImage) return false;
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

/** Confirmed update or rebuild that may be applied from Fleet. */
export function isActionableUpdatePreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  if (preview.summary.blocked) return false;
  if (!summaryCheckOk(preview.summary)) return false;
  if (hasUnverifiedOtherImage(preview)) return false;
  return hasExecutableUpdate(preview);
}

/** Per-service Apply: digest update for that service. */
export function isServiceApplyActionable(
  preview: UpdatePreviewActionInput | null | undefined,
  serviceName: string,
): boolean {
  if (!preview) return false;
  if (preview.summary.blocked) return false;
  if (!summaryCheckOk(preview.summary)) return false;
  const match = (preview.images ?? []).find((i) => i.service === serviceName);
  if (!match) return false;
  if (match.digest_update === true) return true;
  if (match.digest_update !== undefined || match.tag_update !== undefined) return false;
  return Boolean(match.has_update && preview.summary.update_kind !== 'tag');
}

/**
 * Fresh preview successfully proved there is nothing pending (no digest
 * rebuild, no higher-tag advisory). Tag-only advisories set has_update and
 * must not clear: Fleet keeps showing them even though Apply is disabled.
 */
export function isClearedUpdatePreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  if (preview.summary.blocked) return false;
  if (isLegacyPreview(preview)) return false;
  if (isPreviewUncertain(preview)) return false;
  if (isVerificationOnlyPreview(preview)) return false;
  if (isReviewRequiredUpdatePreview(preview)) return false;
  if (preview.summary.has_update || preview.summary.rebuild_available) return false;
  return summaryCheckOk(preview.summary);
}
