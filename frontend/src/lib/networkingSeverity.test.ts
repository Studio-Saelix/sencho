import { describe, it, expect } from 'vitest';
import { findingSourceLabel, groupFindings, rankFindings } from './networkingSeverity';
import type { NetworkingFinding } from '@/types/networking';

function finding(overrides: Partial<NetworkingFinding> = {}): NetworkingFinding {
  return {
    id: overrides.id ?? Math.random().toString(36),
    kind: 'network-mode-host',
    severity: 'medium',
    title: 't',
    message: 'm',
    evidence: [],
    recommendedActions: [],
    sources: ['live'],
    doctorFindings: [],
    ...overrides,
  };
}

describe('groupFindings', () => {
  it('groups critical and high into needs-action, medium into review, info into informational', () => {
    const groups = groupFindings([
      finding({ id: 'a', severity: 'critical' }),
      finding({ id: 'b', severity: 'high' }),
      finding({ id: 'c', severity: 'medium' }),
      finding({ id: 'd', severity: 'info' }),
    ]);
    expect(groups['needs-action'].map((f) => f.id)).toEqual(['a', 'b']);
    expect(groups['review-recommended'].map((f) => f.id)).toEqual(['c']);
    expect(groups.informational.map((f) => f.id)).toEqual(['d']);
  });
});

describe('rankFindings', () => {
  it('ranks live ahead of doctor-only at equal severity', () => {
    const live = finding({ id: 'live', severity: 'high', sources: ['live'] });
    const doctorOnly = finding({ id: 'doctor', severity: 'high', sources: ['doctor'] });
    const ranked = rankFindings([doctorOnly, live]);
    expect(ranked.map((f) => f.id)).toEqual(['live', 'doctor']);
  });

  it('ranks strictly by severity first', () => {
    const low = finding({ id: 'low', severity: 'info' });
    const high = finding({ id: 'high', severity: 'critical' });
    expect(rankFindings([low, high]).map((f) => f.id)).toEqual(['high', 'low']);
  });
});

describe('findingSourceLabel', () => {
  it('labels a merged card as Live plus Doctor', () => {
    const merged = finding({ sources: ['live', 'doctor'], doctorFindings: [{ ruleId: 'r', ranAt: new Date().toISOString(), title: 't', message: 'm', severity: 'high' }] });
    expect(findingSourceLabel(merged)).toBe('Live · also found by Doctor');
  });

  it('labels a Doctor-only card with its last-run timestamp', () => {
    const ranAt = new Date('2026-01-01T00:00:00Z').toISOString();
    const doctorOnly = finding({ sources: ['doctor'], doctorFindings: [{ ruleId: 'r', ranAt, title: 't', message: 'm', severity: 'high' }] });
    expect(findingSourceLabel(doctorOnly)).toContain('Last Doctor run');
  });

  it('returns null for a live-only finding', () => {
    expect(findingSourceLabel(finding({ sources: ['live'] }))).toBeNull();
  });
});
