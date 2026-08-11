import { describe, it, expect } from 'vitest';
import { deriveSecurityPosture, derivePostureReasons, type SecurityPostureFacts } from '../services/securityPosture';

function facts(o: Partial<SecurityPostureFacts> = {}): SecurityPostureFacts {
  return {
    scannerAvailable: true,
    hasCompletedScan: true,
    fixableCriticalHigh: 0,
    fixableWithImageUpdate: 0,
    fixableWaitingUpstream: 0,
    fixableUpdateUnknown: 0,
    updateChecksDisabled: false,
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

function allCopy(f: SecurityPostureFacts): string {
  const { reasons, primaryAction } = derivePostureReasons(f);
  return [
    ...reasons.map((r) => `${r.label} ${r.description}`),
    primaryAction?.label ?? '',
  ].join(' | ');
}

describe('deriveSecurityPosture', () => {
  it('is Unknown when the scanner is unavailable', () => {
    expect(deriveSecurityPosture(facts({ scannerAvailable: false, rawCritical: 9 }))).toBe('Unknown');
  });

  it('is Unknown when no scan has completed', () => {
    expect(deriveSecurityPosture(facts({ hasCompletedScan: false, rawCritical: 9 }))).toBe('Unknown');
  });

  it('is Monitoring when package-fix exists but no confirmed image update', () => {
    expect(deriveSecurityPosture(facts({
      fixableCriticalHigh: 4,
      fixableWaitingUpstream: 4,
      rawCritical: 5,
      rawHigh: 5,
    }))).toBe('Monitoring');
  });

  it('is Action needed when a confirmed image update is available', () => {
    expect(deriveSecurityPosture(facts({
      fixableCriticalHigh: 1,
      fixableWithImageUpdate: 1,
      rawCritical: 5,
    }))).toBe('Action needed');
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

  it('keeps Action needed for exposure even with authoritative no-update (R3)', () => {
    expect(deriveSecurityPosture(facts({
      fixableCriticalHigh: 2,
      fixableWaitingUpstream: 2,
      exposedBlocker: 1,
    }))).toBe('Action needed');
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

  it('does not emit fixable_cve blocker from package-fix alone', () => {
    const { reasons, primaryAction } = derivePostureReasons(facts({
      fixableCriticalHigh: 4,
      fixableWaitingUpstream: 4,
    }));
    expect(reasons.find((r) => r.kind === 'fixable_cve')).toBeUndefined();
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'waiting_upstream', count: 4, severity: 'info' }));
    expect(primaryAction).toBeNull();
  });

  it('returns a blocker reason for confirmed image updates', () => {
    const { reasons } = derivePostureReasons(facts({ fixableWithImageUpdate: 4, fixableCriticalHigh: 4 }));
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

  it('returns uncertain info reason for unknown remediation', () => {
    const { reasons } = derivePostureReasons(facts({
      fixableCriticalHigh: 2,
      fixableUpdateUnknown: 2,
    }));
    expect(reasons).toContainEqual(expect.objectContaining({ kind: 'update_check_uncertain', count: 2, severity: 'info' }));
  });

  it('explains disabled checks in uncertain description', () => {
    const { reasons } = derivePostureReasons(facts({
      fixableUpdateUnknown: 1,
      updateChecksDisabled: true,
    }));
    const uncertain = reasons.find((r) => r.kind === 'update_check_uncertain');
    expect(uncertain?.description).toMatch(/disabled/i);
  });

  it('returns ALL reasons regardless of posture state', () => {
    const { reasons } = derivePostureReasons(facts({
      scannerAvailable: false,
      fixableWithImageUpdate: 4,
      staleScans: 1,
    }));
    expect(reasons).toHaveLength(2);
    expect(reasons[0].kind).toBe('fixable_cve');
    expect(reasons[1].kind).toBe('stale_scan');
  });

  it('sets primaryAction to Review update when image update is confirmed', () => {
    const { primaryAction } = derivePostureReasons(facts({
      fixableWithImageUpdate: 3,
      knownExploited: 1,
      secrets: 2,
    }));
    expect(primaryAction).toEqual({ label: 'Review update', targetTab: 'images', kind: 'fixable_cve' });
  });

  it('falls through to KEV when only waiting upstream for package fixes', () => {
    const { primaryAction, reasons } = derivePostureReasons(facts({
      fixableCriticalHigh: 3,
      fixableWaitingUpstream: 3,
      knownExploited: 1,
    }));
    expect(primaryAction).toEqual({ label: 'Review exploited findings', targetTab: 'images', kind: 'known_exploited' });
    expect(reasons.some((r) => r.kind === 'waiting_upstream')).toBe(true);
  });

  it('R3: exposure primary action when waiting upstream, never Update affected images', () => {
    const { primaryAction, reasons } = derivePostureReasons(facts({
      fixableCriticalHigh: 2,
      fixableWaitingUpstream: 2,
      exposedBlocker: 1,
    }));
    expect(primaryAction).toEqual({ label: 'Review affected images', targetTab: 'images', kind: 'public_exposure' });
    expect(reasons.some((r) => r.label === 'Update affected images' || r.description.includes('Update affected images'))).toBe(false);
    expect(primaryAction?.label).not.toBe('Update affected images');
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

  it('never claims a security fix or that an update fixes findings', () => {
    const copy = allCopy(facts({
      fixableWithImageUpdate: 2,
      fixableWaitingUpstream: 1,
      fixableUpdateUnknown: 1,
    }));
    expect(copy.toLowerCase()).not.toContain('security fix available');
    expect(copy.toLowerCase()).not.toMatch(/fixes the/);
    expect(copy).not.toContain('Update affected images');
  });

  it('attaches targets to reasons and omits them when empty', () => {
    const { reasons, primaryAction } = derivePostureReasons(facts({
      exposedBlocker: 2,
      exposedBlockerTargets: [{ imageRef: 'a:1' }, { imageRef: 'b:1' }],
      exposedReview: 1,
      exposedReviewTargets: [{ imageRef: 'c:1' }],
      knownExploited: 3,
      knownExploitedTargets: ['kev:1'],
    }));
    const blocker = reasons.find((r) => r.kind === 'public_exposure' && r.severity === 'blocker');
    const review = reasons.find((r) => r.kind === 'public_exposure' && r.severity === 'review');
    const kev = reasons.find((r) => r.kind === 'known_exploited');
    expect(blocker?.targets).toEqual([{ imageRef: 'a:1' }, { imageRef: 'b:1' }]);
    expect(review?.targets).toEqual([{ imageRef: 'c:1' }]);
    expect(kev?.targets).toEqual([{ imageRef: 'kev:1' }]);
    expect(primaryAction?.kind).toBe('known_exploited');
    expect(primaryAction?.targets).toEqual([{ imageRef: 'kev:1' }]);
  });

  it('omits targets field when target arrays are empty', () => {
    const { reasons } = derivePostureReasons(facts({
      exposedBlocker: 1,
      exposedBlockerTargets: [],
    }));
    const blocker = reasons.find((r) => r.kind === 'public_exposure');
    expect(blocker?.targets).toBeUndefined();
  });

  it('primaryAction for public_exposure copies blocker targets, not review', () => {
    const { primaryAction } = derivePostureReasons(facts({
      exposedBlocker: 1,
      exposedBlockerTargets: [{ imageRef: 'block:1' }],
      exposedReview: 2,
      exposedReviewTargets: [{ imageRef: 'rev:1' }, { imageRef: 'rev:2' }],
    }));
    expect(primaryAction).toEqual({
      label: 'Review affected images',
      targetTab: 'images',
      kind: 'public_exposure',
      targets: [{ imageRef: 'block:1' }],
    });
  });

  it('uses network-exposed labels and never claims Internet reachability', () => {
    const { reasons, primaryAction } = derivePostureReasons(facts({
      exposedBlocker: 1,
      exposedBlockerTargets: [{
        imageRef: 'a:1',
        stackName: 'web',
        serviceName: 'api',
        intentStatus: 'set',
        exposureIntent: 'public',
      }],
    }));
    const blocker = reasons.find((r) => r.kind === 'public_exposure' && r.severity === 'blocker');
    expect(blocker?.label).toBe('Network-exposed affected images');
    expect(blocker?.description).toContain('beyond loopback');
    expect(blocker?.description.toLowerCase()).not.toContain('internet');
    expect(blocker?.description).toContain('intentionally classified');
    expect(primaryAction?.label).toBe('Review affected images');
  });

  it('adds conflict and unset sentences when present', () => {
    const conflict = derivePostureReasons(facts({
      exposedBlocker: 1,
      exposedBlockerTargets: [{
        imageRef: 'a:1',
        intentStatus: 'set',
        exposureIntent: 'internal',
        intentConflict: true,
      }],
    })).reasons.find((r) => r.kind === 'public_exposure');
    expect(conflict?.description).toContain('conflicts with configured exposure');

    const unset = derivePostureReasons(facts({
      exposedBlocker: 1,
      exposedBlockerTargets: [{ imageRef: 'a:1', intentStatus: 'unset' }],
    })).reasons.find((r) => r.kind === 'public_exposure');
    expect(unset?.description).toContain('not yet classified');
  });

  it('KEV plus intentional exposure still Action needed', () => {
    expect(deriveSecurityPosture(facts({
      knownExploited: 1,
      exposedBlocker: 1,
      exposedBlockerTargets: [{
        imageRef: 'a:1',
        intentStatus: 'set',
        exposureIntent: 'public',
      }],
    }))).toBe('Action needed');
  });

  it('unavailable intent does not add the unset classification sentence', () => {
    const { reasons } = derivePostureReasons(facts({
      exposedBlocker: 1,
      exposedBlockerTargets: [{ imageRef: 'a:1', stackName: 's', serviceName: 'a', intentStatus: 'unavailable' }],
    }));
    const blocker = reasons.find((r) => r.kind === 'public_exposure');
    expect(blocker?.description).not.toContain('not yet classified');
    expect(blocker?.description).toContain('beyond loopback');
    expect(blocker?.description).not.toContain('intentionally classified in Networking');
  });

  it('does not claim absolute intentional when one context is unavailable', () => {
    const { reasons } = derivePostureReasons(facts({
      exposedBlocker: 1,
      exposedBlockerTargets: [
        { imageRef: 'a:1', stackName: 's', serviceName: 'a', intentStatus: 'set', exposureIntent: 'public' },
        { imageRef: 'a:1', stackName: 's', serviceName: 'b', intentStatus: 'unavailable' },
      ],
    }));
    const blocker = reasons.find((r) => r.kind === 'public_exposure');
    expect(blocker?.description).not.toMatch(/Exposure is intentionally classified in Networking/);
    expect(blocker?.description).toContain('could not be verified');
  });
});
