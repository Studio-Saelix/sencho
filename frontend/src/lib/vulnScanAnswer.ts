/**
 * The one Answer for a vulnerability scan sheet: whether the scan finished,
 * whether it violates a policy, and how bad the findings are. A completed scan
 * carries its per-severity counts in the line (after the policy sentence on a
 * violation); a scan that has not completed says so instead of a verdict. The
 * total, fixable count and trigger live in the sheet header, and the scan time
 * in its footer, so none is stated twice. Pure and side-effect free.
 */
import { AlertTriangle, ShieldAlert, ShieldCheck, ShieldQuestion, type LucideIcon } from 'lucide-react';
import { formatPolicyReasons } from '@/lib/policyReasons';
import type { StatusPathAnswer } from '@/components/ui/status-path';
import type { StatusTone } from '@/lib/statusTone';
import type { VulnerabilityScan } from '@/types/security';

export type VulnScanAnswer = Pick<StatusPathAnswer, 'tone' | 'title' | 'line'> & { icon: LucideIcon };

type CountedScan = Pick<VulnerabilityScan,
  'critical_count' | 'high_count' | 'medium_count' | 'low_count' | 'unknown_count'>;

/** Worst first. The first severity with findings sets the Answer's title and tone. */
const SEVERITY_LADDER: ReadonlyArray<{ key: keyof CountedScan; word: string; tone: StatusTone; icon: LucideIcon }> = [
  { key: 'critical_count', word: 'critical', tone: 'destructive', icon: ShieldAlert },
  { key: 'high_count', word: 'high', tone: 'warning', icon: ShieldAlert },
  { key: 'medium_count', word: 'medium', tone: 'warning', icon: AlertTriangle },
  { key: 'low_count', word: 'low', tone: 'neutral', icon: ShieldCheck },
  { key: 'unknown_count', word: 'unknown', tone: 'neutral', icon: ShieldQuestion },
];

/** "2 critical, 5 high", leaving out any severity with none. UNKNOWN is counted, not dropped. */
export function severityCountsLine(scan: CountedScan): string {
  return SEVERITY_LADDER
    .filter(({ key }) => scan[key] > 0)
    .map(({ key, word }) => `${scan[key]} ${word}`)
    .join(', ');
}

export interface VulnScanAnswerOptions {
  /** The secrets or misconfigs list did not load, so a clean result cannot be claimed. */
  evidencePartial?: boolean;
}

/** True when the scan's scanner set includes the vulnerability scanner (`vuln`, `vuln,secret`). */
export function ranVulnerabilityScanner(scan: Pick<VulnerabilityScan, 'scanners_used'>): boolean {
  return (scan.scanners_used ?? 'vuln').split(',').map((s) => s.trim()).includes('vuln');
}

export function vulnScanAnswer(scan: VulnerabilityScan, options: VulnScanAnswerOptions = {}): VulnScanAnswer {
  const counts = severityCountsLine(scan);
  // A scan that has not completed says so before any verdict: its numbers are partial or absent.
  if (scan.status === 'failed') {
    return {
      tone: 'destructive', icon: ShieldAlert, title: 'scan failed',
      // The raw error (Trivy stderr, often a thousand characters) belongs in the sheet's
      // collapsed detail, never in the Answer's one sentence.
      line: 'The scan did not complete, so these results are not a verdict.',
    };
  }
  if (scan.status === 'in_progress') {
    return {
      tone: 'neutral', icon: ShieldQuestion, title: 'scanning',
      line: `The scan is still running, so the counts so far are partial.${counts ? ` ${counts} so far.` : ''}`,
    };
  }
  const evaluation = scan.policy_evaluation;
  if (evaluation?.violated) {
    const reasons = evaluation.reasons.length > 0
      ? `: matched ${formatPolicyReasons(evaluation.reasons, evaluation.maxSeverity)}`
      : '';
    return {
      tone: 'destructive', icon: ShieldAlert, title: 'policy violation',
      line: `This scan violates ${evaluation.policyName}${reasons}.${counts ? ` ${counts}.` : ''}`,
    };
  }
  const worst = SEVERITY_LADDER.find(({ key }) => scan[key] > 0);
  if (!worst && !ranVulnerabilityScanner(scan)) {
    // A config-only or secret-only scan never read package vulnerabilities, so zero
    // counts say nothing about them.
    const otherFindings = (scan.secret_count ?? 0) + (scan.misconfig_count ?? 0);
    return {
      tone: 'neutral', icon: ShieldQuestion, title: 'not scanned for vulnerabilities',
      line: `No vulnerability scanner ran for this scan, so it says nothing about vulnerabilities.${otherFindings > 0 ? ` It reports ${otherFindings} secret or misconfig ${otherFindings === 1 ? 'finding' : 'findings'}.` : ''}`,
    };
  }
  if (!worst) {
    // No vulnerabilities is only a clean result when nothing else was found or left unread.
    const otherFindings = (scan.secret_count ?? 0) + (scan.misconfig_count ?? 0);
    if (otherFindings > 0) {
      return {
        tone: 'neutral', icon: ShieldQuestion, title: 'no vulnerabilities',
        line: `No vulnerabilities were found, but the scan reports ${otherFindings} secret or misconfig ${otherFindings === 1 ? 'finding' : 'findings'}.`,
      };
    }
    if (options.evidencePartial) {
      return {
        tone: 'neutral', icon: ShieldQuestion, title: 'no vulnerabilities',
        line: 'No vulnerabilities were found, but the secrets or misconfigs could not be loaded, so this is not a clean result.',
      };
    }
    return { tone: 'success', icon: ShieldCheck, title: 'no vulnerabilities', line: 'No vulnerabilities were found in this scan.' };
  }
  return { tone: worst.tone, icon: worst.icon, title: worst.word, line: counts };
}
