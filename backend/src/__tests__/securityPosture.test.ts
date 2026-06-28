import { describe, it, expect } from 'vitest';
import { deriveSecurityPosture, derivePostureReasons, type SecurityPostureFacts } from '../services/securityPosture';

function facts(o: Partial<SecurityPostureFacts> = {}): SecurityPostureFacts {
  return {
    scannerAvailable: true,
    hasCompletedScan: true,
    fixableCriticalHigh: 0,
    secrets: 0,
    dangerousCompose: 0,
    knownExploited: 0,
    publiclyExposed: 0,
    exposedBlocker: 0,
    exposedReview: 0,
    rawCritical: 0,
    rawHigh: 0,
    staleScans: 0,
    failedScans: 0,
    needsReview: 0,
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
    expect(deriveSecurityPosture(facts({ knownExploited: 1, fixableCriticalHigh: 0, rawCritical: 1 }))).toBe('Action needed');
  });

  it('is Action needed when exposedBlocker > 0 (KEV, fixable, or elevated EPSS on a public interface)', () => {
    expect(deriveSecurityPosture(facts({ exposedBlocker: 1 }))).toBe('Action needed');
  });

  it('is Monitoring when publiclyExposed > 0 but exposedBlocker is 0 (review-only exposure)', () => {
    expect(deriveSecurityPosture(facts({ publiclyExposed: 3, exposedReview: 3, rawCritical: 2 }))).toBe('Monitoring');
  });

  it('is Monitoring when Critical/High exist but nothing is actionable', () => {
    expect(deriveSecurityPosture(facts({ rawCritical: 3, rawHigh: 7 }))).toBe('Monitoring');
  });

  it('is Monitoring when only review/info reasons exist', () => {
    expect(deriveSecurityPosture(facts({ exposedReview: 1, needsReview: 2, staleScans: 1 }))).toBe('Monitoring');
  });

  it('is Secure when a scan completed and nothing is actionable or severe', () => {
    expect(deriveSecurityPosture(facts())).toBe('Secure');
  });
});

describe('derivePostureReasons', () => {
  it('returns an empty reason list and null primary action for a clean node', () => {
    const { reasons, primaryAction } = derivePostureReasons(facts());
    expect(reasons).toEqual([]);
    expect(primaryAction).toBeNull();
  });

  it('returns a blocker reason for fixable findings', () => {
    const { reasons } = derivePostureReasons(facts({ fixableCriticalHigh: 4 }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'fixable_cve', count: 4, severity: 'blocker' }));
  });

  it('returns a blocker reason for known-exploited findings', () => {
    const { reasons } = derivePostureReasons(facts({ knownExploited: 2 }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'known_exploited', count: 2, severity: 'blocker' }));
  });

  it('returns a blocker reason for secrets', () => {
    const { reasons } = derivePostureReasons(facts({ secrets: 3 }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'secret', count: 3, severity: 'blocker' }));
  });

  it('returns a blocker reason for dangerous Compose misconfigs', () => {
    const { reasons } = derivePostureReasons(facts({ dangerousCompose: 5 }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'dangerous_compose', count: 5, severity: 'blocker' }));
  });

  it('returns a blocker reason for exposedBlocker', () => {
    const { reasons } = derivePostureReasons(facts({ exposedBlocker: 1 }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'public_exposure', count: 1, severity: 'blocker' }));
  });

  it('returns a review reason for exposedReview', () => {
    const { reasons } = derivePostureReasons(facts({ exposedReview: 2 }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'public_exposure', count: 2, severity: 'review' }));
  });

  it('returns a review reason for needsReview', () => {
    const { reasons } = derivePostureReasons(facts({ needsReview: 7 }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'needs_review', count: 7, severity: 'review' }));
  });

  it('returns info reasons for stale and failed scans', () => {
    const { reasons } = derivePostureReasons(facts({ staleScans: 3, failedScans: 1 }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'stale_scan', count: 3, severity: 'info' }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'failed_scan', count: 1, severity: 'info' }));
  });

  it('returns ALL reasons regardless of posture state', () => {
    // Even with no scanner (Unknown posture), the facts produce reasons.
    const { reasons } = derivePostureReasons(facts({
      scannerAvailable: false,
      fixableCriticalHigh: 4,
      staleScans: 1,
    }));
    expect(reasons).toHaveLength(2);
    expect(reasons[0].kind).toBe('fixable_cve');
    expect(reasons[1].kind).toBe('stale_scan');
  });

  it('sets primaryAction to the first blocker (fixable_cve priority)', () => {
    const { primaryAction } = derivePostureReasons(facts({
      fixableCriticalHigh: 3,
      knownExploited: 1,
      secrets: 2,
    }));
    expect(primaryAction).toEqual({ label: 'Update affected images', targetTab: 'images', kind: 'fixable_cve' });
  });

  it('falls through to the next blocker when the first is absent', () => {
    const { primaryAction } = derivePostureReasons(facts({ secrets: 1 }));
    expect(primaryAction).toEqual({ label: 'Review detected secrets', targetTab: 'secrets', kind: 'secret' });
  });

  it('returns null primaryAction when no blockers exist', () => {
    const { primaryAction } = derivePostureReasons(facts({
      exposedReview: 1, needsReview: 2, staleScans: 1, failedScans: 0,
    }));
    expect(primaryAction).toBeNull();
  });

  it('each blocker reason has a targetTab matching a valid Security tab', () => {
    const validTabs = ['images', 'secrets', 'compose', 'history', 'suppressions', 'scanner'];
    const { reasons } = derivePostureReasons(facts({
      fixableCriticalHigh: 1, secrets: 1, dangerousCompose: 1,
      knownExploited: 1, exposedBlocker: 1,
    }));
    for (const r of reasons) {
      expect(validTabs).toContain(r.targetTab);
    }
  });

  // Invariant: Action needed posture always has at least one blocker reason.
  it('Action needed posture always has at least one blocker reason', () => {
    const f = facts({ fixableCriticalHigh: 1 });
    const posture = deriveSecurityPosture(f);
    const { reasons } = derivePostureReasons(f);
    if (posture === 'Action needed') {
      expect(reasons.some((r) => r.severity === 'blocker')).toBe(true);
    }
  });
});
