import { describe, expect, it } from 'vitest';
import { countedFindings, networkingDismissalKey, partitionNetworkingFindings } from './networkingDismissals';
import type { FindingDismissal } from '@/types/findingDismissal';
import type { NetworkingFinding } from '@/types/networking';

const NOW = 1_000_000;

function finding(overrides: Partial<NetworkingFinding> = {}): NetworkingFinding {
  return {
    id: 'exposure-all-interfaces|web|app||', kind: 'exposure-all-interfaces', severity: 'medium', title: 't', message: 'm',
    evidence: [], recommendedActions: [], sources: ['live'], doctorFindings: [], fingerprint: 'fp', count: 1, dismissPolicy: 'any',
    ...overrides,
  };
}

function dismissal(overrides: Partial<FindingDismissal> = {}): FindingDismissal {
  return {
    id: 1, nodeId: 3, surface: 'networking', findingKey: networkingDismissalKey(3, 'exposure-all-interfaces|web|app||'),
    fingerprint: 'fp', severity: 'medium', count: 1, mode: 'until_change', expiresAt: null, createdBy: 'alice', createdAt: 1,
    ...overrides,
  };
}

describe('partitionNetworkingFindings', () => {
  it('sets aside a finding whose key and fingerprint match and keeps every other active', () => {
    const other = finding({ id: 'shared-network|||backbone|' });
    const { active, dismissed } = partitionNetworkingFindings([finding(), other], [dismissal()], 3, NOW);
    expect(active).toEqual([other]);
    expect(dismissed.map(item => item.finding.id)).toEqual(['exposure-all-interfaces|web|app||']);
  });

  it('keeps a dismissal for another node from hiding this one', () => {
    const { active } = partitionNetworkingFindings([finding()], [dismissal({ findingKey: networkingDismissalKey(4, 'exposure-all-interfaces|web|app||') })], 3, NOW);
    expect(active).toHaveLength(1);
  });

  it('lifts when the fingerprint moves, the finding gets worse, or its count grows', () => {
    expect(partitionNetworkingFindings([finding({ fingerprint: 'other' })], [dismissal()], 3, NOW).active).toHaveLength(1);
    expect(partitionNetworkingFindings([finding({ severity: 'high' })], [dismissal()], 3, NOW).active).toHaveLength(1);
    expect(partitionNetworkingFindings([finding({ count: 2 })], [dismissal({ mode: 'forever' })], 3, NOW).active).toHaveLength(1);
  });

  it('does not lift when the finding got better', () => {
    expect(partitionNetworkingFindings([finding({ severity: 'info' })], [dismissal({ mode: 'forever' })], 3, NOW).active).toHaveLength(0);
  });

  it('honours a timed hold until its expiry', () => {
    const held = dismissal({ mode: 'days', expiresAt: NOW + 1000 });
    expect(partitionNetworkingFindings([finding()], [held], 3, NOW).active).toHaveLength(0);
    expect(partitionNetworkingFindings([finding()], [held], 3, NOW + 2000).active).toHaveLength(1);
  });

  it('never hides a finding the node cannot dismiss', () => {
    expect(partitionNetworkingFindings([finding({ dismissPolicy: 'none' })], [dismissal({ mode: 'forever' })], 3, NOW).active).toHaveLength(1);
  });

  it('never lets an until-it-changes dismissal hold a timed-only finding', () => {
    expect(partitionNetworkingFindings([finding({ dismissPolicy: 'timed' })], [dismissal()], 3, NOW).active).toHaveLength(1);
  });

  it('lists a Doctor-acknowledged card as dismissed without a dismissal, and leaves it out of the count', () => {
    const acknowledged = finding({ id: 'ack', sources: ['doctor'], acknowledged: true, dismissPolicy: 'none' });
    const { active, dismissed } = partitionNetworkingFindings([acknowledged], [], 3, NOW);
    expect(active).toEqual([]);
    expect(dismissed).toEqual([{ finding: acknowledged, dismissal: null }]);
    expect(countedFindings([acknowledged, finding()])).toHaveLength(1);
  });
});
