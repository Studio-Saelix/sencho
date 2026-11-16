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
      .toMatchObject({ tone: 'destructive', title: 'critical', line: '1 critical, 2 high' });
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 2, high_count: 2 }))).toMatchObject({ tone: 'warning', title: 'high' });
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 4, medium_count: 4 }))).toMatchObject({ tone: 'warning', title: 'medium' });
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 1, low_count: 1 }))).toMatchObject({ tone: 'neutral', title: 'low' });
  });

  it('titles an unknown-only scan unknown, not low, and falls back to the counts line', () => {
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 2, unknown_count: 2 }))).toMatchObject({ tone: 'neutral', title: 'unknown', line: '2 unknown' });
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 3, low_count: 1, unknown_count: 2 }))).toMatchObject({ title: 'low', line: '1 low, 2 unknown' });
  });

  it('ranks high above medium and gives each answer its own icon', () => {
    const mixed = vulnScanAnswer(scan({ total_vulnerabilities: 2, high_count: 1, medium_count: 1 }));
    expect(mixed.title).toBe('high');
    expect(vulnScanAnswer(scan({ status: 'in_progress' })).icon).not.toBe(vulnScanAnswer(scan()).icon);
    expect(vulnScanAnswer(scan({ total_vulnerabilities: 1, critical_count: 1 })).icon).not.toBe(vulnScanAnswer(scan()).icon);
  });

  it('words a policy violation without reasons or counts without a stray fragment', () => {
    const bare = vulnScanAnswer(scan({ policy_evaluation: { policyId: 1, violated: true, policyName: 'prod-gate', reasons: [], maxSeverity: 'HIGH' } }));
    expect(bare.line).toBe('This scan violates prod-gate.');
  });

  it('does not claim a clean scan when secrets or misconfigs exist or could not be loaded', () => {
    expect(vulnScanAnswer(scan({ secret_count: 2 }))).toMatchObject({ tone: 'neutral', title: 'no vulnerabilities' });
    expect(vulnScanAnswer(scan({ misconfig_count: 1 })).line).toContain('1 secret or misconfig finding');
    expect(vulnScanAnswer(scan(), { evidencePartial: true })).toMatchObject({ tone: 'neutral' });
  });

  it('keeps the partial counts visible on a scan still running', () => {
    expect(vulnScanAnswer(scan({ status: 'in_progress', high_count: 2 })).line).toContain('2 high so far.');
  });

  it('puts a policy violation first, with the matched reasons and the counts', () => {
    const answer = vulnScanAnswer(scan({
      total_vulnerabilities: 1, high_count: 1,
      policy_evaluation: { policyId: 1, violated: true, policyName: 'prod-gate', reasons: ['kev'], maxSeverity: 'HIGH' },
    }));
    expect(answer).toMatchObject({ tone: 'destructive', title: 'policy violation' });
    expect(answer.line).toBe('This scan violates prod-gate: matched a known-exploited CVE (KEV). 1 high.');
  });

  it('never reads an unfinished scan as clean or as a verdict', () => {
    expect(vulnScanAnswer(scan({ status: 'in_progress' }))).toMatchObject({ tone: 'neutral', title: 'scanning' });
    expect(vulnScanAnswer(scan({ status: 'failed', error: 'trivy timed out' }))).toMatchObject({ tone: 'destructive', title: 'scan failed', line: expect.stringContaining('did not complete') });
    expect(vulnScanAnswer(scan({ status: 'failed' })).line).toContain('not a verdict');
  });

  it('does not read a config-only or secret-only scan as a clean vulnerability result', () => {
    for (const scanners_used of ['config', 'secret']) {
      const answer = vulnScanAnswer(scan({ scanners_used }));
      expect(answer).toMatchObject({ tone: 'neutral', title: 'not scanned for vulnerabilities' });
      expect(answer.line).toContain('No vulnerability scanner ran');
    }
    expect(vulnScanAnswer(scan({ scanners_used: 'config', misconfig_count: 2 })).line).toContain('2 secret or misconfig findings');
    // Both vulnerability-bearing sets still read clean.
    expect(vulnScanAnswer(scan({ scanners_used: 'vuln,secret' }))).toMatchObject({ tone: 'success' });
  });

  it('keeps a failed scan\'s Answer to one short sentence, whatever the error says', () => {
    const answer = vulnScanAnswer(scan({ status: 'failed', error: 'x'.repeat(1000) }));
    expect(answer.line.length).toBeLessThan(100);
    expect(answer.line).not.toContain('xxx');
  });
});
