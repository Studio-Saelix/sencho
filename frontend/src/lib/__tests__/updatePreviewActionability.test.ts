import { describe, expect, it } from 'vitest';
import {
  isActionableUpdatePreview,
  isServiceApplyActionable,
} from '../updatePreviewActionability';

describe('update preview actionability with a checks-off sibling', () => {
  const preview = {
    summary: {
      has_update: true,
      check_status: 'ok' as const,
      verification_failed: true,
      update_kind: 'digest' as const,
      blocked: false,
    },
    images: [
      {
        service: 'web', has_update: true, digest_update: true, tag_update: false,
        check_status: 'ok' as const, check_error: null, digest_error: null,
      },
      {
        service: 'cache', has_update: false, digest_update: false, tag_update: false,
        check_status: 'failed' as const, check_error: 'inspect failed', digest_error: 'inspect failed',
      },
    ],
  };

  it('keeps a service-scoped apply on the service whose own evidence is complete', () => {
    expect(isServiceApplyActionable(preview, 'web')).toBe(true);
    expect(isServiceApplyActionable(preview, 'cache')).toBe(false);
  });

  it('still holds a full-stack apply for the unverified sibling', () => {
    expect(isActionableUpdatePreview(preview)).toBe(false);
  });

  it('allows the service whose own evidence is complete while the stack summary is partial', () => {
    const partial = { ...preview, summary: { ...preview.summary, check_status: 'partial' as const } };
    expect(isServiceApplyActionable(partial, 'web')).toBe(true);
    expect(isActionableUpdatePreview(partial)).toBe(false);
  });

  it('does not apply a service whose own current digest was never verified', () => {
    const own = {
      summary: {
        has_update: true, check_status: 'ok' as const, verification_failed: true,
        update_kind: 'digest' as const, blocked: false,
      },
      images: [{
        service: 'web', has_update: true, digest_update: true, tag_update: false,
        check_status: 'ok' as const, check_error: null, digest_error: 'digest lookup failed',
      }],
    };
    expect(isServiceApplyActionable(own, 'web')).toBe(false);
    expect(isActionableUpdatePreview(own)).toBe(false);
  });
});
