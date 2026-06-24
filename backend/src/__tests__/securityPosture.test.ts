import { describe, it, expect } from 'vitest';
import { deriveSecurityPosture, type SecurityPostureFacts } from '../services/securityPosture';

function facts(o: Partial<SecurityPostureFacts>): SecurityPostureFacts {
  return {
    scannerAvailable: true,
    hasCompletedScan: true,
    fixableCriticalHigh: 0,
    secrets: 0,
    dangerousCompose: 0,
    knownExploited: 0,
    publiclyExposed: 0,
    rawCritical: 0,
    rawHigh: 0,
    ...o,
  };
}

describe('deriveSecurityPosture', () => {
  it('is Unknown when the scanner is unavailable', () => {
    expect(deriveSecurityPosture(facts({ scannerAvailable: false, rawCritical: 9 }))).toBe('Unknown');
  });

  it('is Unknown when no scan has completed', () => {
    expect(deriveSecurityPosture(facts({ hasCompletedScan: false, rawCritical: 9 }))).toBe('Unknown');
  });

  it('is Action needed when a Critical/High is fixable', () => {
    expect(deriveSecurityPosture(facts({ fixableCriticalHigh: 1, rawCritical: 5, rawHigh: 5 }))).toBe('Action needed');
  });

  it('is Action needed for a detected secret', () => {
    expect(deriveSecurityPosture(facts({ secrets: 1 }))).toBe('Action needed');
  });

  it('is Action needed for a dangerous Compose misconfiguration', () => {
    expect(deriveSecurityPosture(facts({ dangerousCompose: 1 }))).toBe('Action needed');
  });

  it('is Action needed when a finding is known-exploited even if unfixable', () => {
    // KEV escalates: no fix available, but exploited in the wild.
    expect(deriveSecurityPosture(facts({ knownExploited: 1, fixableCriticalHigh: 0, rawCritical: 1 }))).toBe('Action needed');
  });

  it('is Action needed when an affected service is publicly exposed', () => {
    expect(deriveSecurityPosture(facts({ publiclyExposed: 1 }))).toBe('Action needed');
  });

  it('is Monitoring when Critical/High exist but nothing is actionable', () => {
    expect(deriveSecurityPosture(facts({ rawCritical: 3, rawHigh: 7 }))).toBe('Monitoring');
  });

  it('is Secure when a scan completed and nothing is actionable or severe', () => {
    expect(deriveSecurityPosture(facts({}))).toBe('Secure');
  });
});
