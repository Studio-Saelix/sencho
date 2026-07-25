/**
 * Shared Fleet/Anatomy gates for update-preview summaries.
 * Tag-only availability is advisory: Compose pull does not rewrite pins.
 */

export interface UpdatePreviewActionImage {
  service?: string;
  has_update?: boolean;
  digest_update?: boolean;
  tag_update?: boolean;
  check_status?: string | null;
}

export interface UpdatePreviewActionSummary {
  has_update?: boolean;
  rebuild_available?: boolean;
  blocked?: boolean;
  check_status?: string | null;
  /** Present on current nodes; used for older remotes without digest/tag flags. */
  update_kind?: string | null;
}

export interface UpdatePreviewActionInput {
  images?: UpdatePreviewActionImage[];
  summary: UpdatePreviewActionSummary;
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

/** Confirmed update or rebuild that may be applied from Fleet. */
export function isActionableUpdatePreview(
  preview: UpdatePreviewActionInput | null | undefined,
): boolean {
  if (!preview) return false;
  if (preview.summary.blocked) return false;
  if (!summaryCheckOk(preview.summary)) return false;
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

export function isPreviewUncertain(preview: UpdatePreviewActionInput | null | undefined): boolean {
  if (!preview) return false;
  const status = preview.summary.check_status;
  return status === 'partial' || status === 'failed';
}
