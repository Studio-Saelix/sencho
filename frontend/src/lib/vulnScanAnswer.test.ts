import { describe, it, expect } from 'vitest';
import { severityCountsLine, vulnScanAnswer } from './vulnScanAnswer';
import type { VulnerabilityScan } from '@/types/security';

function scan(over: Partial<VulnerabilityScan> = {}): VulnerabilityScan {
  return {
    id: 1, node_id: 1, image_ref: 'img:1', image_digest: null, scanned_at: 0,
    total_vulnerabilities: 0, critical_count: 0, high_count: 0, medium_count: 0, low_count: 0, unknown_count: 0,
    fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln', highest_severity: null,
    os_info: null, trivy_version: null, scan_duration_ms: 1, triggered_by: 'manual', status: 'completed',
    error: null, stack_context: null, policy_evaluation: null, ...over,
  } as VulnerabilityScan;
}

describe('vulnScanAnswer', () => {
  it('lists only the severities that have findings and counts UNKNOWN', () => {
    expect(severityCountsLine(scan({ critical_count: 2, high_count: 0, medium_count: 3, unknown_count: 1 }))).toBe('2 critical, 3 medium, 1 unknown');
  });

  it('reads a clean completed scan as success', () => {
    expect(vulnScanAnswer(scan())).toMatchObject({ tone: 'success', title: 'no vulnerabilities' });
  });

  it('tones by the worst severity and states the counts once', () => {
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 3, critical_count: 1, high_count: 2 })))
      .toEqual({ tone: 'destructive', title: 'critical', line: '1 critical, 2 high' });
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 2, high_count: 2 }))).toMatchObject({ tone: 'warning', title: 'high' });
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 4, medium_count: 4 }))).toMatchObject({ tone: 'warning', title: 'medium' });
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 1, low_count: 1 }))).toMatchObject({ tone: 'neutral', title: 'low' });
  });

  it('puts a policy violation first, with the matched reasons and the counts', () => {
    const answer = vulnScanAnswer(scan({
      total_vulnerabilities: 1, high_count: 1,
      policy_evaluation: { violated: true, policyName: 'prod-gate', reasons: ['kev'], maxSeverity: 'HIGH' } as VulnerabilityScan['policy_evaluation'],
    }));
    expect(answer).toMatchObject({ tone: 'destructive', title: 'policy violation' });
    expect(answer.line).toBe('This scan violates prod-gate: matched a known-exploited CVE (KEV). 1 high.');
  });

  it('never reads an unfinished scan as clean or as a verdict', () => {
    expect(vulnScanAnswer(scan({ status: 'in_progress' }))).toMatchObject({ tone: 'neutral', title: 'scanning' });
    expect(vulnScanAnswer(scan({ status: 'failed', error: 'trivy timed out' }))).toEqual({ tone: 'destructive', title: 'scan failed', line: 'trivy timed out' });
    expect(vulnScanAnswer(scan({ status: 'failed' })).line).toContain('not a verdict');
  });
});
