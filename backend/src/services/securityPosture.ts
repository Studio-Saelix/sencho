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
 */

/** EPSS score at or above this is treated as an elevated exploitation
 *  likelihood, matching the frontend threshold in SecurityCharts.tsx. */
export const HIGH_EPSS_THRESHOLD = 0.1;

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
  | 'known_exploited'
  | 'secret'
  | 'dangerous_compose'
  | 'public_exposure'
  | 'stale_scan'
  | 'failed_scan'
  | 'needs_review';

export type PostureReasonSeverity = 'blocker' | 'review' | 'info';

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
}

export interface PostureAction {
  label: string;
  targetTab: SecurityPostureTargetTab;
  /** The reason kind that produced this action, so the UI can target the
   *  affected items precisely (e.g. filter Images to fixable findings). */
  kind: PostureReasonKind;
}

export interface SecurityPostureFacts {
  /** The scanner is installed and usable on this node. */
  scannerAvailable: boolean;
  /** At least one scan has completed (a freshly installed node has none). */
  hasCompletedScan: boolean;
  /** Critical/High findings with a fix available, net of suppressions. */
  fixableCriticalHigh: number;
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
export function derivePostureReasons(f: SecurityPostureFacts): {
  reasons: PostureReason[];
  primaryAction: PostureAction | null;
} {
  const reasons: PostureReason[] = [];
  let primaryAction: PostureAction | null = null;

  // Blockers. Each of these can keep the masthead red.

  if (f.fixableCriticalHigh > 0) {
    const r: PostureReason = {
      kind: 'fixable_cve',
      count: f.fixableCriticalHigh,
      severity: 'blocker',
      label: 'Fixable findings',
      description: 'Critical or High findings with an available fix.',
      targetTab: 'images',
    };
    reasons.push(r);
    if (!primaryAction) primaryAction = { label: 'Update affected images', targetTab: r.targetTab, kind: r.kind };
  }

  if (f.knownExploited > 0) {
    const r: PostureReason = {
      kind: 'known_exploited',
      count: f.knownExploited,
      severity: 'blocker',
      label: 'Known-exploited findings',
      description: 'Findings in the CISA Known Exploited Vulnerabilities catalog.',
      targetTab: 'images',
    };
    reasons.push(r);
    if (!primaryAction) primaryAction = { label: 'Review exploited findings', targetTab: r.targetTab, kind: r.kind };
  }

  if (f.secrets > 0) {
    const r: PostureReason = {
      kind: 'secret',
      count: f.secrets,
      severity: 'blocker',
      label: 'Detected secrets',
      description: 'Images with exposed credentials or keys. Review on the Secrets tab.',
      targetTab: 'secrets',
    };
    reasons.push(r);
    if (!primaryAction) primaryAction = { label: 'Review detected secrets', targetTab: r.targetTab, kind: r.kind };
  }

  if (f.dangerousCompose > 0) {
    const r: PostureReason = {
      kind: 'dangerous_compose',
      count: f.dangerousCompose,
      severity: 'blocker',
      label: 'Unacknowledged Compose risks',
      description: 'High-severity misconfigurations that have not been acknowledged.',
      targetTab: 'compose',
    };
    reasons.push(r);
    if (!primaryAction) primaryAction = { label: 'Review Compose risks', targetTab: r.targetTab, kind: r.kind };
  }

  if (f.exposedBlocker > 0) {
    const r: PostureReason = {
      kind: 'public_exposure',
      count: f.exposedBlocker,
      severity: 'blocker',
      label: 'Publicly exposed affected images',
      description: 'Images with fixable, known-exploited, or elevated-EPSS findings published on a public interface.',
      targetTab: 'images',
    };
    reasons.push(r);
    if (!primaryAction) primaryAction = { label: 'Review public exposure', targetTab: r.targetTab, kind: r.kind };
  }

  // Review items. These appear in-page but do not force a red masthead.

  if (f.exposedReview > 0) {
    reasons.push({
      kind: 'public_exposure',
      count: f.exposedReview,
      severity: 'review',
      label: 'Exposed images (monitoring)',
      description: 'Images published on a public interface with no fix, no KEV, and no elevated EPSS.',
      targetTab: 'images',
    });
  }

  if (f.needsReview > 0) {
    reasons.push({
      kind: 'needs_review',
      count: f.needsReview,
      severity: 'review',
      label: 'Findings needing review',
      description: 'Findings awaiting a triage decision on the Suppressions tab.',
      targetTab: 'suppressions',
    });
  }

  // Info items. Context only, never red.

  if (f.staleScans > 0) {
    reasons.push({
      kind: 'stale_scan',
      count: f.staleScans,
      severity: 'info',
      label: 'Stale scans',
      description: 'Images whose latest scan is older than 7 days.',
      targetTab: 'history',
    });
  }

  if (f.failedScans > 0) {
    reasons.push({
      kind: 'failed_scan',
      count: f.failedScans,
      severity: 'info',
      label: 'Failed scans',
      description: 'Scans that terminated with an error. Inspect on the History tab.',
      targetTab: 'history',
    });
  }

  return { reasons, primaryAction };
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
