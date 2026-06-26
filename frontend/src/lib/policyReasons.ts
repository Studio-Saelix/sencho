import type { PolicyBlockReason, VulnSeverity } from '@/types/security';

/**
 * Human-readable description of the policy inputs that matched, for the scan
 * detail banner. Echoes the deploy-gate dialog's phrasing (PolicyBlockDialog)
 * so the banner and the block dialog read consistently, and names the
 * configured severity ceiling so the severity input stays specific. Returns an
 * empty string when no reason was recorded (evaluations persisted before
 * reason tracking).
 */
export function formatPolicyReasons(
  reasons: PolicyBlockReason[],
  maxSeverity: VulnSeverity,
): string {
  return reasons
    .map((reason) => {
      switch (reason) {
        case 'severity':
          return `severity at or above ${maxSeverity}`;
        case 'kev':
          return 'a known-exploited CVE (KEV)';
        case 'fixable':
          return 'a fixable Critical/High';
      }
    })
    .join(', ');
}
