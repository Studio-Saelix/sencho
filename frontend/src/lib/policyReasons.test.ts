import { describe, it, expect } from 'vitest';
import { formatPolicyReasons } from './policyReasons';

describe('formatPolicyReasons', () => {
  it('names a KEV match without citing a severity ceiling', () => {
    expect(formatPolicyReasons(['kev'], 'HIGH')).toBe('a known-exploited CVE (KEV)');
  });

  it('names the configured ceiling for a severity match', () => {
    expect(formatPolicyReasons(['severity'], 'CRITICAL')).toBe('severity at or above CRITICAL');
  });

  it('joins every matched reason in order', () => {
    expect(formatPolicyReasons(['severity', 'kev', 'fixable'], 'HIGH')).toBe(
      'severity at or above HIGH, a known-exploited CVE (KEV), a fixable Critical/High',
    );
  });

  it('returns an empty string when no reason was recorded', () => {
    expect(formatPolicyReasons([], 'HIGH')).toBe('');
  });
});
