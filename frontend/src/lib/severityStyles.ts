import type { ScanSummary, VulnSeverity } from '@/types/security';

export type SeverityKey = VulnSeverity | 'CLEAN' | 'FINDINGS';

/** Image-list filter value: any severity key, the "all" sentinel, or the
 *  phone-only FIXABLE pseudo-filter (images with at least one fixable finding). */
export type ImageFilterValue = 'all' | SeverityKey | 'FIXABLE';

/**
 * The display "key" for a scan summary: its highest vulnerability severity, or
 * `FINDINGS` when the scan has only secrets/misconfigurations (stored
 * highest_severity is derived from CVEs alone), or `CLEAN` when nothing was
 * found. Shared so the badge, sorting, and filtering all classify identically.
 */
export function getSeverityKey(summary: ScanSummary): SeverityKey {
  const hasNonVulnFindings = (summary.secret_count ?? 0) > 0 || (summary.misconfig_count ?? 0) > 0;
  return summary.highest_severity ?? (hasNonVulnFindings ? 'FINDINGS' : 'CLEAN');
}

export const SEVERITY_ROW_TINT: Record<VulnSeverity, string> = {
  CRITICAL: 'bg-destructive/10 border-l-[3px] border-destructive/70',
  HIGH: 'bg-warning/10 border-l-[3px] border-warning/70',
  MEDIUM: 'border-l-[3px] border-info/40',
  LOW: 'border-l-[3px] border-transparent',
  UNKNOWN: 'border-l-[3px] border-transparent',
};

/**
 * Border/background/text classes for a severity pill. `CLEAN` is the all-zero
 * state; `FINDINGS` is the amber "not clean but no vulnerability severity"
 * state for a scan that has secrets or misconfigurations but zero CVEs (the
 * stored highest_severity is derived from vulnerabilities only).
 */
export const SEVERITY_BADGE_CLASSES: Record<SeverityKey, string> = {
  CRITICAL: 'border-destructive/25 bg-destructive/8 text-destructive',
  HIGH: 'border-warning/25 bg-warning/8 text-warning',
  MEDIUM: 'border-warning/25 bg-warning/8 text-warning',
  LOW: 'border-border bg-muted/30 text-muted-foreground',
  UNKNOWN: 'border-border bg-muted/20 text-muted-foreground',
  CLEAN: 'border-success/25 bg-success/8 text-success',
  FINDINGS: 'border-warning/25 bg-warning/8 text-warning',
};

/** Leading state-dot color for a severity pill. */
export const SEVERITY_DOT_CLASSES: Record<SeverityKey, string> = {
  CRITICAL: 'bg-destructive',
  HIGH: 'bg-warning',
  MEDIUM: 'bg-warning',
  LOW: 'bg-muted-foreground/60',
  UNKNOWN: 'bg-muted-foreground/40',
  CLEAN: 'bg-success',
  FINDINGS: 'bg-warning',
};
