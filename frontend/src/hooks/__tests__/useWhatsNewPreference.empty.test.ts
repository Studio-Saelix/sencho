import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { vi } from 'vitest';

// This file exists separately from useWhatsNewPreference.test.ts purely to mock
// a different module state: latestWhatsNewEntryId === null, which is what ships
// whenever entries.json is still empty. That is the branch running in
// production today, so it needs its own coverage rather than relying on the
// sibling file's non-null mock.
vi.mock('@/whats-new/entries', () => ({ latestWhatsNewEntryId: null }));

import { useWhatsNewPreference } from '../useWhatsNewPreference';

const LAST_SEEN_KEY = 'sencho.whatsNew.lastSeenId';

describe('useWhatsNewPreference with no entries authored yet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stamps an empty-string watermark on a fresh install so the next release is detected', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    // The write itself is the point: without it, a later release adding its
    // first entry would still see `stored === null` and silently catch up,
    // swallowing the very first unseen signal on an existing install.
    expect(localStorage.getItem(LAST_SEEN_KEY)).toBe('');
    expect(result.current.hasUnseen).toBe(false);
  });

  it('reports nothing unseen and leaves the preference enabled by default', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.hasUnseen).toBe(false);
    expect(result.current.enabled).toBe(true);
  });

  it('markSeen is a no-op that does not overwrite the watermark', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    act(() => { result.current.markSeen(); });
    expect(localStorage.getItem(LAST_SEEN_KEY)).toBe('');
    expect(result.current.hasUnseen).toBe(false);
  });

  it('still honours an explicit opt-out', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    act(() => { result.current.setEnabled(false); });
    expect(result.current.enabled).toBe(false);
  });
});
