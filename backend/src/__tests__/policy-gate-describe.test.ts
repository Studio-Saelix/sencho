/**
 * The shared block message must name the inputs that actually matched, so a
 * KEV-driven block never reads as a severity-threshold block.
 */
import { describe, it, expect } from 'vitest';
import { describePolicyBlock } from '../helpers/policyGate';
import type { PolicyViolation } from '../services/PolicyEnforcement';
import type { ScanPolicy } from '../services/DatabaseService';

const policy = { name: 'prod-gate', max_severity: 'CRITICAL' } as ScanPolicy;
const violation = (over: Partial<PolicyViolation>): PolicyViolation => ({
  imageRef: 'nginx:1.14', severity: 'LOW', criticalCount: 0, highCount: 0,
  kevCount: 0, fixableCount: 0, reasons: [], scanId: 1, ...over,
});

describe('describePolicyBlock', () => {
  it('names KEV without mentioning a severity threshold', () => {
    const msg = describePolicyBlock(policy, [violation({ kevCount: 1, reasons: ['kev'] })]);
    expect(msg).toContain('known-exploited');
    expect(msg).not.toContain('CRITICAL');
  });

  it('joins multiple distinct reasons across violations', () => {
    const msg = describePolicyBlock(policy, [
      violation({ reasons: ['kev'] }),
      violation({ imageRef: 'redis:7', reasons: ['fixable'] }),
    ]);
    expect(msg).toContain('known-exploited');
    expect(msg).toContain('fixable');
  });

  it('de-duplicates a reason shared by multiple violations', () => {
    const msg = describePolicyBlock(policy, [
      violation({ reasons: ['kev'] }),
      violation({ imageRef: 'redis:7', reasons: ['kev'] }),
    ]);
    expect(msg.match(/known-exploited/g)).toHaveLength(1);
    expect(msg).toContain('2 image(s)');
  });

  it('uses the supplied action verb and a generic phrase when no reason is set', () => {
    const msg = describePolicyBlock(policy, [violation({})], 'update');
    expect(msg).toContain('blocked update');
    expect(msg).toContain('scan policy conditions');
  });
});
