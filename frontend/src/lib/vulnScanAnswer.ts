/**
 * The one Answer for a vulnerability scan sheet: whether the scan finished,
 * whether it violates a policy, and how bad the findings are. Counts per
 * severity are the Answer's line; the total, fixable count and trigger live in
 * the sheet header, and the scan time in its footer, so none is stated twice.
 * Pure and side-effect free.
 */
import { formatPolicyReasons } from '@/lib/policyReasons';
import type { StatusTone } from '@/lib/statusTone';
import type { VulnerabilityScan } from '@/types/security';

export interface VulnScanAnswer {
  tone: StatusTone;
  title: string;
  line: string;
}

type CountedScan = Pick<VulnerabilityScan,
  'critical_count' | 'high_count' | 'medium_count' | 'low_count' | 'unknown_count' | 'total_vulnerabilities'>;

/** "2 critical, 5 high", leaving out any severity with none. UNKNOWN is counted, not dropped. */
export function severityCountsLine(scan: CountedScan): string {
  return ([
    [scan.critical_count, 'critical'],
    [scan.high_count, 'high'],
    [scan.medium_count, 'medium'],
    [scan.low_count, 'low'],
    [scan.unknown_count, 'unknown'],
  ] as const)
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(', ');
}

export function vulnScanAnswer(scan: VulnerabilityScan): VulnScanAnswer {
  // A scan that has not completed says so before any count: its numbers are partial or absent.
  if (scan.status === 'failed') {
    return { tone: 'destructive', title: 'scan failed', line: scan.error || 'The scan did not complete, so these results are not a verdict.' };
  }
  if (scan.status === 'in_progress') {
    return { tone: 'neutral', title: 'scanning', line: 'The scan is still running, so the counts so far are partial.' };
  }
  const counts = severityCountsLine(scan);
  const evaluation = scan.policy_evaluation;
  if (evaluation?.violated) {
    const reasons = evaluation.reasons.length > 0
      ? `: matched ${formatPolicyReasons(evaluation.reasons, evaluation.maxSeverity)}`
      : '';
    return {
      tone: 'destructive',
      title: 'policy violation',
      line: `This scan violates ${evaluation.policyName}${reasons}.${counts ? ` ${counts}.` : ''}`,
    };
  }
  if (scan.total_vulnerabilities === 0) {
    return { tone: 'success', title: 'no vulnerabilities', line: 'No vulnerabilities were found in this scan.' };
  }
  const tone: StatusTone = scan.critical_count > 0 ? 'destructive' : scan.high_count > 0 || scan.medium_count > 0 ? 'warning' : 'neutral';
  const title = scan.critical_count > 0 ? 'critical' : scan.high_count > 0 ? 'high' : scan.medium_count > 0 ? 'medium' : 'low';
  return { tone, title, line: counts || `${scan.total_vulnerabilities} findings.` };
}
