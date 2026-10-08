import { describe, expect, it } from 'vitest';
import type { FindingDismissal } from '@/types/findingDismissal';
import { describeDismissal } from './describeDismissal';

const NOW = 1_700_000_000_000;

function dismissal(over: Partial<FindingDismissal>): FindingDismissal {
  return {
    id: 1, nodeId: 1, surface: 'readiness', findingKey: 'k', fingerprint: 'fp', severity: 'degraded', count: 1,
    mode: 'until_change', expiresAt: null, createdBy: 'alice', createdAt: NOW - 3 * 3_600_000, ...over,
  };
}

describe('describeDismissal', () => {
  it('names who dismissed it, how long ago, and that it holds until the finding changes', () => {
    expect(describeDismissal(dismissal({}), NOW)).toBe('dismissed by alice 3h ago · until it changes');
  });

  it('says a permanent dismissal is permanent', () => {
    expect(describeDismissal(dismissal({ mode: 'forever' }), NOW)).toContain('permanently');
  });

  it('names the date a timed dismissal runs until', () => {
    const expiresAt = NOW + 7 * 86_400_000;
    expect(describeDismissal(dismissal({ mode: 'days', expiresAt }), NOW)).toContain(`until ${new Date(expiresAt).toLocaleDateString()}`);
  });

  it('falls back to "until it changes" for a timed dismissal with no date, rather than inventing one', () => {
    expect(describeDismissal(dismissal({ mode: 'days', expiresAt: null }), NOW)).toContain('until it changes');
  });
});
