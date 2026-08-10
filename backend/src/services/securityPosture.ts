/**
 * Single source of truth for the Security page's action posture and the
 * "why" breakdown that explains it.
 *
 * The overview route gathers the facts (suppression-, acknowledgement-, and
 * intel-aware) and this module buckets them into a product verb plus a list of
 * structured posture reasons so the masthead and Overview tab can answer "what
 * should I do first?" rather than merely stating a state word.
 *
 * Keeping the bucketing here, separate from storage, means copy or threshold
 * changes never require a schema migration, and the same verdict can be reused
 * by other surfaces (action queue, per-stack blast radius).
 *
 * Posture is deliberately NOT raw severity: a page is never "Secure" merely
 * because counts are zero-weighted, and never "Action needed" merely because a
 * Critical exists with nothing to do about it. "Secure" means nothing is
 * actionable right now, not a claim that no vulnerabilities exist.
 *
 * Package fix availability (Trivy fixed_version) and container-image update
 * availability (canonical ImageUpdateService) are distinct facts. A package
 * fix alone never produces an "Update affected images" instruction.
 */

import {
  allTargetsIntentionallyClassified,
  anyTargetIntentConflict,
  anyTargetIntentUnset,
} from './securityExposureTargets';
import type { ExposureIntent } from './network/types';

/** EPSS score at or above this is treated as an elevated exploitation
 *  likelihood, matching the frontend threshold in SecurityCharts.tsx. */
export const HIGH_EPSS_THRESHOLD = 0.1;

/** Max target rows attached to one posture reason (overview payload).
 *  For exposure reasons rows are per stack/service and may repeat imageRef;
 *  reason.count stays a distinct-image count and can diverge from targets.length. */
export const POSTURE_TARGET_CAP = 200;

export type SecurityPostureState = 'Action needed' | 'Monitoring' | 'Secure' | 'Unknown';

/** Valid Security tab targets for a posture reason CTA. Mirrors the frontend
 *  SecurityTab union (frontend/src/lib/events.ts). */
export type SecurityPostureTargetTab =
  | 'images'
  | 'secrets'
  | 'compose'
  | 'history'
  | 'suppressions'
  | 'scanner';

export type PostureReasonKind =
  | 'fixable_cve'
  | 'waiting_upstream'
  | 'update_check_uncertain'
  | 'known_exploited'
  | 'secret'
  | 'dangerous_compose'
  | 'public_exposure'
  | 'stale_scan'
  | 'failed_scan'
  | 'needs_review';

export type PostureReasonSeverity = 'blocker' | 'review' | 'info';

/**
 * Image identity behind a posture reason (raw scan image_ref).
 * Exposure reasons may enrich with stack, service, and Networking intent;
 * other reasons are typically imageRef-only.
 */
export interface PostureTarget {
  imageRef: string;
  /** Stack with configured beyond-loopback or host-network exposure. */
  stackName?: string;
  /** Service within that stack. */
  serviceName?: string;
  exposureReason?: 'published-port' | 'host-network' | null;
  /** Effective intent when context is available and set; omit when unset. */
  exposureIntent?: ExposureIntent;
  /**
   * Intent resolution for this service.
   * unavailable is distinct from unset (DB/context failure vs no classification).
   */
  intentStatus?: 'set' | 'unset' | 'unavailable';
  /** True when intent is internal/same-node but configured exposure is beyond loopback. */
  intentConflict?: boolean;
}

export interface PostureReason {
  kind: PostureReasonKind;
  count: number;
  severity: PostureReasonSeverity;
  /** Short label for the reason row (e.g. "Fixable findings"). */
  label: string;
  /** One-sentence explanation visible under the label. */
  description: string;
  /** Which Security tab the CTA navigates to. */
  targetTab: SecurityPostureTargetTab;
  /** Optional Open-button label; when omitted the UI derives from targetTab. */
  actionLabel?: string;
  /**
   * Target rows for this reason (image-only, or per stack/service for exposure).
   * May repeat imageRef. Omitted when empty or unknown.
   */
  targets?: PostureTarget[];
}

export interface PostureAction {
  label: string;
  targetTab: SecurityPostureTargetTab;
  /** The reason kind that produced this action, so the UI can target the
   *  affected items precisely (e.g. filter Images to fixable findings). */
  kind: PostureReasonKind;
  /** Same targets as the reason that produced this action, when available. */
  targets?: PostureTarget[];
}

export interface SecurityPostureFacts {
  /** The scanner is installed and usable on this node. */
  scannerAvailable: boolean;
  /** At least one scan has completed (a freshly installed node has none). */
  hasCompletedScan: boolean;
  /** Critical/High findings with a package fix available, net of suppressions. */
  fixableCriticalHigh: number;
  /**
   * Subset of package-fix Crit/High findings whose managed image has a
   * confirmed applicable image update (hasUpdate + checkStatus ok).
   */
  fixableWithImageUpdate: number;
  /**
   * Package-fix Crit/High on managed images where every checkable match is an
   * authoritative negative (ok, no update, fresh).
   */
  fixableWaitingUpstream: number;
  /**
   * Package-fix Crit/High where update availability could not be established
   * (partial, failed, stale, disabled, not_checkable, no stack match, etc.).
   */
  fixableUpdateUnknown: number;
  /** When true, uncertain rows should explain disabled checks (no Check again). */
  updateChecksDisabled: boolean;
  /** Detected secrets (not suppressible in the current model). */
  secrets: number;
  /** High-severity Compose misconfigurations, net of acknowledgements. */
  dangerousCompose: number;
  /** Known-exploited (CISA KEV) findings among non-suppressed Critical/High. */
  knownExploited: number;
  /** Total affected services published to a non-loopback address (legacy;
   *  exposedBlocker + exposedReview is the authoritative split). */
  publiclyExposed: number;
  /** Exposed images with KEV, fixable, or elevated-EPSS findings (blocker). */
  exposedBlocker: number;
  /** Exposed images without KEV, fix, or elevated EPSS (review only). */
  exposedReview: number;
  /** Raw Critical scanner detections (for the Monitoring fallback). */
  rawCritical: number;
  /** Raw High scanner detections (for the Monitoring fallback). */
  rawHigh: number;
  /** Images whose latest scan is older than the stale threshold. */
  staleScans: number;
  /** Scans that terminated with an error. */
  failedScans: number;
  /** Findings with triage_status = 'needs_review' (not dismissed, not accepted). */
  needsReview: number;
  /** Raw image_refs for Images-bound reasons (optional; omit when unknown). */
  fixableWithImageUpdateTargets?: string[];
  fixableWaitingUpstreamTargets?: string[];
  fixableUpdateUnknownTargets?: string[];
  knownExploitedTargets?: string[];
  /** Per-service exposure targets (may repeat imageRef across stack/service). */
  exposedBlockerTargets?: PostureTarget[];
  exposedReviewTargets?: PostureTarget[];
}

/** Cap and convert raw refs to PostureTarget[]. Returns truncated=true when capped. */
export function capPostureTargets(refs: string[] | undefined): {
  targets: PostureTarget[] | undefined;
  truncated: boolean;
} {
  if (!refs || refs.length === 0) return { targets: undefined, truncated: false };
  return {
    targets: refs.slice(0, POSTURE_TARGET_CAP).map((imageRef) => ({ imageRef })),
    truncated: refs.length > POSTURE_TARGET_CAP,
  };
}

/** Cap enriched target rows (imageRef+stack+service). */
export function capPostureTargetRows(rows: PostureTarget[] | undefined): {
  targets: PostureTarget[] | undefined;
  truncated: boolean;
} {
  if (!rows || rows.length === 0) return { targets: undefined, truncated: false };
  return {
    targets: rows.slice(0, POSTURE_TARGET_CAP),
    truncated: rows.length > POSTURE_TARGET_CAP,
  };
}

function attachCappedTargets(
  reason: PostureReason,
  capped: { targets: PostureTarget[] | undefined; truncated: boolean },
): { reason: PostureReason; truncated: boolean } {
  if (!capped.targets) return { reason, truncated: false };
  return { reason: { ...reason, targets: capped.targets }, truncated: capped.truncated };
}

/** Default CTA label when a reason omits actionLabel. */
const DEFAULT_ACTION_LABEL: Partial<Record<PostureReasonKind, string>> = {
  fixable_cve: 'Review update',
  known_exploited: 'Review exploited findings',
  secret: 'Review detected secrets',
  dangerous_compose: 'Review Compose risks',
  public_exposure: 'Review affected images',
};

function actionFrom(reason: PostureReason): PostureAction {
  const action: PostureAction = {
    label: reason.actionLabel ?? DEFAULT_ACTION_LABEL[reason.kind] ?? 'Open',
    targetTab: reason.targetTab,
    kind: reason.kind,
  };
  if (reason.targets) action.targets = reason.targets;
  return action;
}

/**
 * Derive the structured reasons behind the current security posture.
 *
 * Called by `deriveSecurityPosture` so the posture word and its explanation
 * can never drift: the same blocker input that turns the masthead red is the
 * blocker that appears in the reason list.
 *
 * All reasons (blocker, review, info) are returned regardless of posture
 * state. The caller decides which subset to surface.
 */
const VIEW_FINDINGS_LABEL = 'View findings';
const REVIEW_AFFECTED_IMAGES_LABEL = 'Review affected images';

function networkExposureDescription(
  mode: 'blocker' | 'review',
  targets: PostureTarget[] | undefined,
): string {
  const parts = [
    mode === 'blocker'
      ? 'Images with fixable, known-exploited, or elevated-EPSS findings are configured beyond loopback or with host networking.'
      : 'Images configured beyond loopback or with host networking have no fix, no KEV, and no elevated EPSS.',
  ];
  if (allTargetsIntentionallyClassified(targets)) {
    parts.push('Exposure is intentionally classified in Networking; that does not remove the vulnerability risk.');
  }
  if (anyTargetIntentConflict(targets)) {
    parts.push('At least one service intent conflicts with configured exposure (internal or same-node while published beyond loopback).');
  }
  if (anyTargetIntentUnset(targets)) {
    parts.push('Some services are not yet classified; set exposure intent in Networking.');
  }
  return parts.join(' ');
}

export function derivePostureReasons(f: SecurityPostureFacts): {
  reasons: PostureReason[];
  primaryAction: PostureAction | null;
  /** True when any attached target list was capped at POSTURE_TARGET_CAP. */
  targetsTruncated: boolean;
} {
  const reasons: PostureReason[] = [];
  let primaryAction: PostureAction | null = null;
  let targetsTruncated = false;

  const pushCapped = (
    base: PostureReason,
    capped: { targets: PostureTarget[] | undefined; truncated: boolean },
  ): void => {
    const { reason, truncated } = attachCappedTargets(base, capped);
    if (truncated) targetsTruncated = true;
    reasons.push(reason);
    if (!primaryAction && reason.severity === 'blocker') {
      primaryAction = actionFrom(reason);
    }
  };

  const push = (base: PostureReason, refs?: string[]): void => {
    pushCapped(base, capPostureTargets(refs));
  };

  const pushRows = (base: PostureReason, rows?: PostureTarget[]): void => {
    pushCapped(base, capPostureTargetRows(rows));
  };

  // Blockers. Each of these can keep the masthead red.

  if (f.fixableWithImageUpdate > 0) {
    push({
      kind: 'fixable_cve',
      count: f.fixableWithImageUpdate,
      severity: 'blocker',
      label: 'Newer image available',
      description: 'Critical or High findings have a newer image available to review. This does not prove the candidate removes the findings.',
      targetTab: 'images',
      actionLabel: 'Review update',
    }, f.fixableWithImageUpdateTargets);
  }

  if (f.knownExploited > 0) {
    push({
      kind: 'known_exploited',
      count: f.knownExploited,
      severity: 'blocker',
      label: 'Known-exploited findings',
      description: 'Findings in the CISA Known Exploited Vulnerabilities catalog.',
      targetTab: 'images',
    }, f.knownExploitedTargets);
  }

  if (f.secrets > 0) {
    push({
      kind: 'secret',
      count: f.secrets,
      severity: 'blocker',
      label: 'Detected secrets',
      description: 'Images with exposed credentials or keys. Review on the Secrets tab.',
      targetTab: 'secrets',
    });
  }

  if (f.dangerousCompose > 0) {
    push({
      kind: 'dangerous_compose',
      count: f.dangerousCompose,
      severity: 'blocker',
      label: 'Unacknowledged Compose risks',
      description: 'High-severity misconfigurations that have not been acknowledged.',
      targetTab: 'compose',
    });
  }

  if (f.exposedBlocker > 0) {
    pushRows({
      kind: 'public_exposure',
      count: f.exposedBlocker,
      severity: 'blocker',
      label: 'Network-exposed affected images',
      description: networkExposureDescription('blocker', f.exposedBlockerTargets),
      targetTab: 'images',
      actionLabel: REVIEW_AFFECTED_IMAGES_LABEL,
    }, f.exposedBlockerTargets);
  }

  // Review items. These appear in-page but do not force a red masthead.

  if (f.exposedReview > 0) {
    pushRows({
      kind: 'public_exposure',
      count: f.exposedReview,
      severity: 'review',
      label: 'Network-exposed images (monitoring)',
      description: networkExposureDescription('review', f.exposedReviewTargets),
      targetTab: 'images',
      actionLabel: VIEW_FINDINGS_LABEL,
    }, f.exposedReviewTargets);
  }

  if (f.needsReview > 0) {
    push({
      kind: 'needs_review',
      count: f.needsReview,
      severity: 'review',
      label: 'Findings needing review',
      description: 'Findings awaiting a triage decision on the Suppressions tab.',
      targetTab: 'suppressions',
    });
  }

  // Info items. Context only, never red.

  if (f.fixableWaitingUpstream > 0) {
    push({
      kind: 'waiting_upstream',
      count: f.fixableWaitingUpstream,
      severity: 'info',
      label: 'Waiting for upstream image',
      description: 'Package fixes exist for findings in this image, but Sencho cannot currently identify a newer image to apply under its latest authoritative check.',
      targetTab: 'images',
      actionLabel: VIEW_FINDINGS_LABEL,
    }, f.fixableWaitingUpstreamTargets);
  }

  if (f.fixableUpdateUnknown > 0) {
    push({
      kind: 'update_check_uncertain',
      count: f.fixableUpdateUnknown,
      severity: 'info',
      label: 'Update availability unknown',
      description: f.updateChecksDisabled
        ? 'Package fixes exist, but image update checks are disabled on this node, so Sencho cannot tell whether a newer image is available.'
        : 'Package fixes exist, but Sencho could not establish whether an applicable image update is available (partial, failed, stale, not checkable, or unmatched image).',
      targetTab: 'images',
      actionLabel: VIEW_FINDINGS_LABEL,
    }, f.fixableUpdateUnknownTargets);
  }

  if (f.staleScans > 0) {
    push({
      kind: 'stale_scan',
      count: f.staleScans,
      severity: 'info',
      label: 'Stale scans',
      description: 'Images whose latest scan is older than 7 days.',
      targetTab: 'history',
    });
  }

  if (f.failedScans > 0) {
    push({
      kind: 'failed_scan',
      count: f.failedScans,
      severity: 'info',
      label: 'Failed scans',
      description: 'Scans that terminated with an error. Inspect on the History tab.',
      targetTab: 'history',
    });
  }

  return { reasons, primaryAction, targetsTruncated };
}

/**
 * Bucket the security facts into one of four product verbs.
 *
 * Calls `derivePostureReasons` internally so the posture word and its
 * explanation are derived from the same inputs: if the masthead is red,
 * there is always at least one blocker reason in the reason list.
 */
export function deriveSecurityPosture(f: SecurityPostureFacts): SecurityPostureState {
  if (!f.scannerAvailable || !f.hasCompletedScan) return 'Unknown';
  const { reasons } = derivePostureReasons(f);
  if (reasons.some((r) => r.severity === 'blocker')) return 'Action needed';
  if (f.rawCritical > 0 || f.rawHigh > 0 || reasons.length > 0) return 'Monitoring';
  return 'Secure';
}
