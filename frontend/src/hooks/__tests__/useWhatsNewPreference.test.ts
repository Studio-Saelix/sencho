import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/whats-new/entries', () => ({ latestWhatsNewEntryId: 'entry-b' }));

import { useWhatsNewPreference } from '../useWhatsNewPreference';

describe('useWhatsNewPreference', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults enabled to true when never set', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.enabled).toBe(true);
  });

  it('respects a stored disabled preference', () => {
    localStorage.setItem('sencho.whatsNew.enabled', '0');
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.enabled).toBe(false);
  });

  it('setEnabled persists and updates state', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    expect(localStorage.getItem('sencho.whatsNew.enabled')).toBe('0');
  });

  it('a fresh install (no stored watermark) silently catches up, so hasUnseen starts false', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(localStorage.getItem('sencho.whatsNew.lastSeenId')).toBe('entry-b');
    expect(result.current.hasUnseen).toBe(false);
  });

  it('a release that shipped with zero entries stamps a "" watermark, so the next release\'s first real entry is detected as unseen for an existing install', () => {
    // Simulates: release N had entries.json === [], the hook already ran once
    // on this install and (per the fixed initializer) stamped '' as the
    // watermark. Release N+1 now adds the first real entry. The install is
    // NOT fresh (a key already exists), so it must not silently catch up.
    localStorage.setItem('sencho.whatsNew.lastSeenId', '');
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.hasUnseen).toBe(true);
  });

  it('an existing watermark behind the latest entry reports hasUnseen true', () => {
    localStorage.setItem('sencho.whatsNew.lastSeenId', 'entry-a');
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.hasUnseen).toBe(true);
  });

  it('markSeen clears hasUnseen and persists the watermark', () => {
    localStorage.setItem('sencho.whatsNew.lastSeenId', 'entry-a');
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.hasUnseen).toBe(true);
    act(() => result.current.markSeen());
    expect(result.current.hasUnseen).toBe(false);
    expect(localStorage.getItem('sencho.whatsNew.lastSeenId')).toBe('entry-b');
  });

  it('a second hook instance picks up a change made by the first (window event sync)', () => {
    const a = renderHook(() => useWhatsNewPreference());
    const b = renderHook(() => useWhatsNewPreference());
    act(() => a.result.current.setEnabled(false));
    expect(b.result.current.enabled).toBe(false);
  });
});
