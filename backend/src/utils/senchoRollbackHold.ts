/**
 * Sencho rollback-hold image identity.
 *
 * Full-stack recovery tags images as `sencho-rb/<generation>/<service>:hold`.
 * Those refs are Sencho-internal recovery state, not operator inventory or
 * Security scan targets. Shared so Resources, Trivy, and Security agree.
 */

export const SENCHO_ROLLBACK_HOLD_PREFIX = 'sencho-rb/';

/** SQLite LIKE pattern matching any Sencho rollback-hold image_ref. */
export const SENCHO_ROLLBACK_HOLD_SQL_LIKE = `${SENCHO_ROLLBACK_HOLD_PREFIX}%`;

/** True when an image reference is a Sencho synthetic rollback-hold tag. */
export function isSenchoRollbackHoldRef(imageRef: string): boolean {
  return imageRef.startsWith(SENCHO_ROLLBACK_HOLD_PREFIX);
}

/**
 * True when every visible RepoTag is a synthetic hold tag (hold-only image).
 * Dual-tagged images (registry tag + hold) return false so they stay visible
 * under the real tag.
 */
export function isFullySyntheticHoldImage(repoTags: string[]): boolean {
  return repoTags.length > 0 && repoTags.every((tag) => isSenchoRollbackHoldRef(tag));
}
