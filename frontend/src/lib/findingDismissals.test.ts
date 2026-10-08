import { describe, expect, it } from 'vitest';
import type { FindingDismissal } from '@/types/findingDismissal';
import { READINESS_SEVERITY_SCALE as SCALE, isDismissalActive, partitionFindings } from './findingDismissals';

const NOW = 1_000_000;

function finding(overrides: Partial<{ id: string; fingerprint: string; severity: string; count: number }> = {}) {
  return { id: 'workloads:1:web:workloads_partial', fingerprint: 'fp', severity: 'degraded', count: 1, ...overrides };
}

function dismissal(overrides: Partial<FindingDismissal> = {}): FindingDismissal {
  return {
    id: 1, nodeId: 1, surface: 'readiness', findingKey: 'workloads:1:web:workloads_partial',
    fingerprint: 'fp', severity: 'degraded', count: 1, mode: 'until_change', expiresAt: null,
    createdBy: 'alice', createdAt: 1, ...overrides,
  };
}

describe('isDismissalActive', () => {
  it('holds an until_change dismissal while the fingerprint is the same', () => {
    expect(isDismissalActive(finding(), dismissal(), NOW, SCALE)).toBe(true);
  });

  it('lifts an until_change dismissal when the fingerprint moves', () => {
    expect(isDismissalActive(finding({ fingerprint: 'other' }), dismissal(), NOW, SCALE)).toBe(false);
  });

  it('lifts any mode when the severity rises', () => {
    for (const mode of ['until_change', 'days', 'forever'] as const) {
      const d = dismissal({ mode, expiresAt: NOW + 1000 });
      expect(isDismissalActive(finding({ severity: 'attention' }), d, NOW, SCALE)).toBe(false);
    }
  });

  it('lifts a permanent dismissal when a verified finding falls into unknown', () => {
    expect(isDismissalActive(finding({ severity: 'unknown' }), dismissal({ mode: 'forever' }), NOW, SCALE)).toBe(false);
    expect(isDismissalActive(finding({ severity: 'unavailable' }), dismissal({ mode: 'forever' }), NOW, SCALE)).toBe(false);
  });

  it('keeps a dismissal while the finding stays in the same state', () => {
    const d = dismissal({ mode: 'forever', severity: 'unknown' });
    expect(isDismissalActive(finding({ severity: 'unknown' }), d, NOW, SCALE)).toBe(true);
  });

  it('lifts when incomplete evidence becomes no evidence at all', () => {
    const d = dismissal({ mode: 'forever', severity: 'unknown' });
    expect(isDismissalActive(finding({ severity: 'unavailable' }), d, NOW, SCALE)).toBe(false);
  });

  it('lifts when the count grows but not when it shrinks', () => {
    expect(isDismissalActive(finding({ count: 2 }), dismissal({ mode: 'forever' }), NOW, SCALE)).toBe(false);
    expect(isDismissalActive(finding({ count: 1 }), dismissal({ mode: 'forever', count: 3 }), NOW, SCALE)).toBe(true);
  });

  it('holds a days dismissal until it expires, whatever the fingerprint does', () => {
    const d = dismissal({ mode: 'days', expiresAt: NOW + 1 });
    expect(isDismissalActive(finding({ fingerprint: 'other' }), d, NOW, SCALE)).toBe(true);
    expect(isDismissalActive(finding(), d, NOW + 1, SCALE)).toBe(false);
  });

  it('lifts when the finding\'s policy no longer allows the mode it was dismissed under', () => {
    expect(isDismissalActive({ ...finding(), dismissPolicy: 'none' }, dismissal({ mode: 'forever' }), NOW, SCALE)).toBe(false);
    expect(isDismissalActive({ ...finding(), dismissPolicy: 'timed' }, dismissal({ mode: 'forever' }), NOW, SCALE)).toBe(false);
    expect(isDismissalActive({ ...finding(), dismissPolicy: 'timed' }, dismissal({ mode: 'until_change' }), NOW, SCALE)).toBe(false);
    expect(isDismissalActive({ ...finding(), dismissPolicy: 'timed' }, dismissal({ mode: 'days', expiresAt: NOW + 1 }), NOW, SCALE)).toBe(true);
    expect(isDismissalActive({ ...finding(), dismissPolicy: 'any' }, dismissal({ mode: 'forever' }), NOW, SCALE)).toBe(true);
  });

  it('never hides a finding behind a mode or severity word it does not know', () => {
    expect(isDismissalActive(finding(), dismissal({ mode: 'someday' as FindingDismissal['mode'] }), NOW, SCALE)).toBe(false);
    expect(isDismissalActive(finding({ severity: 'novel' }), dismissal({ mode: 'forever' }), NOW, SCALE)).toBe(false);
  });
});

describe('partitionFindings', () => {
  it('moves covered findings aside without dropping them', () => {
    const a = finding({ id: 'a' });
    const b = finding({ id: 'b' });
    const result = partitionFindings([a, b], [dismissal({ findingKey: 'a' })], NOW, SCALE);
    expect(result.active).toEqual([b]);
    expect(result.dismissed.map(item => item.finding.id)).toEqual(['a']);
  });

  it('shows a finding again once its dismissal no longer covers it', () => {
    const a = finding({ id: 'a', fingerprint: 'changed' });
    const result = partitionFindings([a], [dismissal({ findingKey: 'a' })], NOW, SCALE);
    expect(result.active).toEqual([a]);
    expect(result.dismissed).toEqual([]);
  });

  it('ignores a dismissal for a finding that is not listed', () => {
    const result = partitionFindings([finding({ id: 'a' })], [dismissal({ findingKey: 'gone' })], NOW, SCALE);
    expect(result.active).toHaveLength(1);
    expect(result.dismissed).toEqual([]);
  });
});
