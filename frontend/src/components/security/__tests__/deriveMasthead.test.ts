/**
 * The Security masthead state word is the headline posture signal an operator
 * reads first, so its derivation is locked here. Critical must beat High.
 */
import { it, expect } from 'vitest';
import { deriveMasthead } from '../securityMasthead';
import type { SecurityOverview } from '@/types/security';

function overview(o: Partial<SecurityOverview>): SecurityOverview {
  return {
    scannedImages: 0,
    critical: 0,
    high: 0,
    fixable: 0,
    secrets: 0,
    misconfigs: 0,
    staleScans: 0,
    failedScans: 0,
    lastSuccessfulScanAt: null,
    scanner: { available: true, version: '1', source: 'managed', autoUpdate: false },
    deployEnforcement: { honorSuppressionsOnDeploy: false, eligibleBlockPolicies: 0 },
    ...o,
  };
}

it('reads Unknown/idle when there is no overview or a load error', () => {
  expect(deriveMasthead(null, false)).toEqual({ state: 'Unknown', tone: 'idle' });
  expect(deriveMasthead(overview({ critical: 5 }), true)).toEqual({ state: 'Unknown', tone: 'idle' });
});

it('reads Critical/error when any critical finding exists (critical wins over high)', () => {
  expect(deriveMasthead(overview({ critical: 1, high: 9 }), false)).toEqual({ state: 'Critical', tone: 'error' });
});

it('reads At risk/warn when there are highs but no criticals', () => {
  expect(deriveMasthead(overview({ critical: 0, high: 2 }), false)).toEqual({ state: 'At risk', tone: 'warn' });
});

it('reads Secure/live when there are no critical or high findings', () => {
  expect(deriveMasthead(overview({ critical: 0, high: 0 }), false)).toEqual({ state: 'Secure', tone: 'live' });
});
