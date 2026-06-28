import { describe, it, expect } from 'vitest';
import { reasonImageFilter } from '../postureNavigation';
import type { PostureReasonKind } from '@/types/security';

describe('reasonImageFilter', () => {
  it('maps fixable findings to the FIXABLE image filter', () => {
    expect(reasonImageFilter('fixable_cve')).toBe('FIXABLE');
  });

  it('returns undefined for kinds with no per-image flag (opens Images unfiltered)', () => {
    const others: PostureReasonKind[] = [
      'known_exploited',
      'secret',
      'dangerous_compose',
      'public_exposure',
      'stale_scan',
      'failed_scan',
      'needs_review',
    ];
    for (const kind of others) {
      expect(reasonImageFilter(kind)).toBeUndefined();
    }
  });
});
