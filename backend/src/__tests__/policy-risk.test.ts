/**
 * Pins the pure risk-decision helper shared by the pre-deploy gate and the
 * informational post-scan evaluation. KEV membership is supplied as a test
 * predicate, so these cases stay free of DB and intel-cache setup.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluatePolicyRisk,
  describeReason,
  describePolicyInputs,
  type PolicyRiskInputs,
  type RiskFinding,
} from '../utils/policy-risk';

const noKev = () => false;
const finding = (over: Partial<RiskFinding> = {}): RiskFinding => ({
  vulnerability_id: 'CVE-2026-0001',
  severity: 'HIGH',
  fixed_version: null,
  ...over,
});

const inputs = (over: Partial<PolicyRiskInputs> = {}): PolicyRiskInputs => ({
  blockOnSeverity: false,
  blockOnKev: false,
  blockOnFixable: false,
  maxSeverity: 'HIGH',
  ...over,
});

describe('evaluatePolicyRisk', () => {
  it('matches severity only when the highest finding meets the threshold', () => {
    const high = evaluatePolicyRisk([finding({ severity: 'HIGH' })], noKev, inputs({ blockOnSeverity: true, maxSeverity: 'HIGH' }));
    expect(high.reasons).toEqual(['severity']);

    const low = evaluatePolicyRisk([finding({ severity: 'LOW' })], noKev, inputs({ blockOnSeverity: true, maxSeverity: 'HIGH' }));
    expect(low.reasons).toEqual([]);
  });

  it('matches KEV when a finding is known-exploited, regardless of severity', () => {
    const isKev = (id: string) => id === 'CVE-2026-9999';
    const out = evaluatePolicyRisk(
      [finding({ vulnerability_id: 'CVE-2026-9999', severity: 'LOW' })],
      isKev,
      inputs({ blockOnKev: true }),
    );
    expect(out.reasons).toEqual(['kev']);
    expect(out.kevCount).toBe(1);
  });

  it('counts a Critical/High finding with a fix as fixable, but not one without', () => {
    const fixable = evaluatePolicyRisk([finding({ severity: 'CRITICAL', fixed_version: '1.2.3' })], noKev, inputs({ blockOnFixable: true }));
    expect(fixable.reasons).toEqual(['fixable']);
    expect(fixable.fixableCount).toBe(1);

    const noFix = evaluatePolicyRisk([finding({ severity: 'CRITICAL', fixed_version: null })], noKev, inputs({ blockOnFixable: true }));
    expect(noFix.reasons).toEqual([]);

    const lowFix = evaluatePolicyRisk([finding({ severity: 'MEDIUM', fixed_version: '1.0' })], noKev, inputs({ blockOnFixable: true }));
    expect(lowFix.reasons).toEqual([]);
  });

  it('reports every input that matches, in display order', () => {
    const isKev = () => true;
    const out = evaluatePolicyRisk(
      [finding({ severity: 'CRITICAL', fixed_version: '2.0' })],
      isKev,
      inputs({ blockOnSeverity: true, blockOnKev: true, blockOnFixable: true, maxSeverity: 'HIGH' }),
    );
    expect(out.reasons).toEqual(['severity', 'kev', 'fixable']);
  });

  it('returns no reasons when no input is enabled', () => {
    const out = evaluatePolicyRisk([finding({ severity: 'CRITICAL' })], () => true, inputs());
    expect(out.reasons).toEqual([]);
  });
});

describe('describeReason / describePolicyInputs', () => {
  it('labels each reason', () => {
    expect(describeReason('severity')).toContain('severity');
    expect(describeReason('kev')).toContain('KEV');
    expect(describeReason('fixable')).toContain('fixable');
  });

  it('lists active inputs and notes when none are active', () => {
    expect(describePolicyInputs(inputs({ blockOnSeverity: true, maxSeverity: 'HIGH' }))).toContain('severity>=HIGH');
    expect(describePolicyInputs(inputs({ blockOnKev: true, blockOnFixable: true }))).toBe('KEV, fixable Critical/High');
    expect(describePolicyInputs(inputs())).toBe('no active inputs');
  });
});
