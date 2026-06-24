/**
 * Single source of truth for the Security page's action posture.
 *
 * The overview route gathers the facts (suppression-, acknowledgement-, and
 * intel-aware) and this function buckets them into one of four product verbs.
 * Keeping the bucketing here, separate from storage, means copy or threshold
 * changes never require a schema migration, and the same verdict can be reused
 * by other surfaces (action queue, per-stack blast radius).
 *
 * Posture is deliberately NOT raw severity: a page is never "Secure" merely
 * because counts are zero-weighted, and never "Action needed" merely because a
 * Critical exists with nothing to do about it. "Secure" means nothing is
 * actionable right now, not a claim that no vulnerabilities exist.
 */
export type SecurityPostureState = 'Action needed' | 'Monitoring' | 'Secure' | 'Unknown';

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
  /** Affected services published to a non-loopback address. */
  publiclyExposed: number;
  /** Raw Critical scanner detections (for the Monitoring fallback). */
  rawCritical: number;
  /** Raw High scanner detections (for the Monitoring fallback). */
  rawHigh: number;
}

export function deriveSecurityPosture(f: SecurityPostureFacts): SecurityPostureState {
  if (!f.scannerAvailable || !f.hasCompletedScan) return 'Unknown';
  if (
    f.fixableCriticalHigh > 0
    || f.secrets > 0
    || f.dangerousCompose > 0
    || f.knownExploited > 0
    || f.publiclyExposed > 0
  ) {
    return 'Action needed';
  }
  if (f.rawCritical > 0 || f.rawHigh > 0) return 'Monitoring';
  return 'Secure';
}
