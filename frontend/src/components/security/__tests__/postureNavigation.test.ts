import { describe, it, expect } from 'vitest';
import { reasonImageFilter, defaultReasonActionLabel } from '../postureNavigation';
import type { PostureReasonKind } from '@/types/security';

describe('reasonImageFilter', () => {
  it('maps confirmed image-update findings to the FIXABLE image filter', () => {
    expect(reasonImageFilter('fixable_cve')).toBe('FIXABLE');
  });

  it('returns undefined for kinds with no per-image flag (opens Images unfiltered)', () => {
    const others: PostureReasonKind[] = [
      'waiting_upstream',
      'update_check_uncertain',
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

describe('defaultReasonActionLabel', () => {
  it('labels common security tabs', () => {
    expect(defaultReasonActionLabel('images')).toBe('Open Images');
    expect(defaultReasonActionLabel('compose')).toBe('Open Compose risks');
    expect(defaultReasonActionLabel('secrets')).toBe('Open Secrets');
  });
});
