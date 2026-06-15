/**
 * getSeverityKey is the single classifier shared by the severity badge, the
 * Images severity sort, and the Images severity filter. Lock its mapping so the
 * three consumers can never disagree: a CVE severity wins, a secret/misconfig-only
 * scan is FINDINGS (not a false "Clean"), and an all-zero scan is CLEAN.
 */
import { it, expect } from 'vitest';
import { getSeverityKey } from '../severityStyles';
import type { ScanSummary } from '@/types/security';

function summary(o: Partial<ScanSummary>): ScanSummary {
  return {
    image_ref: 'x:1',
    highest_severity: null,
    scanned_at: 1,
    scan_id: 1,
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    fixable: 0,
    secret_count: 0,
    misconfig_count: 0,
    ...o,
  };
}

it('returns the highest CVE severity when present', () => {
  expect(getSeverityKey(summary({ highest_severity: 'CRITICAL' }))).toBe('CRITICAL');
  expect(getSeverityKey(summary({ highest_severity: 'LOW' }))).toBe('LOW');
});

it('returns FINDINGS for a secret- or misconfig-only scan with no CVE severity', () => {
  expect(getSeverityKey(summary({ highest_severity: null, secret_count: 1 }))).toBe('FINDINGS');
  expect(getSeverityKey(summary({ highest_severity: null, misconfig_count: 2 }))).toBe('FINDINGS');
});

it('returns CLEAN when there are no findings of any kind', () => {
  expect(getSeverityKey(summary({ highest_severity: null }))).toBe('CLEAN');
});
