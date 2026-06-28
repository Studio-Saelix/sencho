/**
 * The Security masthead state word is the headline posture signal an operator
 * reads first, so its derivation is locked here. Posture is an action verdict
 * (Action needed / Monitoring / Secure / Unknown), not a raw severity count: a
 * page is never "Secure" merely because counts are non-zero, and never "Action
 * needed" merely because a Critical exists with nothing to do about it.
 */
import { it, expect } from 'vitest';
import { deriveMasthead } from '../securityMasthead';
import type { SecurityOverview } from '@/types/security';

function overview(o: Partial<SecurityOverview>): SecurityOverview {
  return {
    scannedImages: 1,
    critical: 0,
    high: 0,
    fixable: 0,
    secrets: 0,
    misconfigs: 0,
    staleScans: 0,
    failedScans: 0,
    // Default to "has completed a scan" so cases exercise posture, not Unknown.
    lastSuccessfulScanAt: 1700000000000,
    scanner: { available: true, version: '1', source: 'managed', autoUpdate: false },
    deployEnforcement: { honorSuppressionsOnDeploy: false, eligibleBlockPolicies: 0 },
    ...o,
  };
}

it('reads Unknown/idle when there is no overview or a load error', () => {
  expect(deriveMasthead(null, false)).toEqual({ state: 'Unknown', tone: 'idle' });
  expect(deriveMasthead(overview({ critical: 5 }), true)).toEqual({ state: 'Unknown', tone: 'idle' });
});

it('reads Unknown when the scanner is unavailable, even with no findings', () => {
  expect(
    deriveMasthead(overview({ scanner: { available: false, version: null, source: 'none', autoUpdate: false } }), false),
  ).toEqual({ state: 'Unknown', tone: 'idle' });
});

it('reads Unknown when no scan has ever completed', () => {
  expect(deriveMasthead(overview({ lastSuccessfulScanAt: null }), false)).toEqual({ state: 'Unknown', tone: 'idle' });
});

it('reads Action needed/error when a fix is available (even if counts look severe)', () => {
  expect(deriveMasthead(overview({ critical: 9, high: 9, fixable: 1 }), false)).toEqual({
    state: 'Action needed',
    tone: 'error',
  });
});

it('reads Action needed when a secret is detected', () => {
  expect(deriveMasthead(overview({ secrets: 1 }), false)).toEqual({ state: 'Action needed', tone: 'error' });
});

it('reads Action needed when a misconfiguration is detected', () => {
  expect(deriveMasthead(overview({ misconfigs: 1 }), false)).toEqual({ state: 'Action needed', tone: 'error' });
});

it('reads Monitoring/warn when criticals/highs exist but nothing is actionable', () => {
  expect(deriveMasthead(overview({ critical: 3, high: 7, fixable: 0 }), false)).toEqual({
    state: 'Monitoring',
    tone: 'warn',
  });
});

it('reads Secure/live when a scan completed and nothing is actionable or severe', () => {
  expect(deriveMasthead(overview({}), false)).toEqual({ state: 'Secure', tone: 'live' });
});

it('prefers the backend posture over the local bootstrap when present', () => {
  // Bootstrap from these facts would read Action needed (fixable > 0); the
  // authoritative backend verdict wins.
  expect(deriveMasthead(overview({ fixable: 5, posture: 'Monitoring' }), false)).toEqual({
    state: 'Monitoring',
    tone: 'warn',
  });
});

it('falls back to the local bootstrap when the node reports no posture', () => {
  expect(deriveMasthead(overview({ fixable: 1 }), false)).toEqual({ state: 'Action needed', tone: 'error' });
});
