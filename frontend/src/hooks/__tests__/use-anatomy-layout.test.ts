import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  ANATOMY_MODE_KEY,
  ANATOMY_WIDTH_KEY,
  ANATOMY_WIDTH,
  ANATOMY_MODES,
  currentAnatomyMode,
  currentAnatomyWidth,
  sanitizeAnatomyWidth,
  useAnatomyLayout,
} from '../use-anatomy-layout';
import { subscribeToPreferenceWrites } from '@/lib/preferences/preferenceEvents';
import { PREFERENCE_CACHE_KEYS } from '@/lib/preferences/preferencesDocuments';

describe('useAnatomyLayout', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('uses the fixed mode and canonical width by default', () => {
    expect(currentAnatomyMode()).toBe('fixed');
    expect(currentAnatomyWidth()).toBe(ANATOMY_WIDTH.default);
    expect([...ANATOMY_MODES]).toEqual(['fixed', 'resizable']);
  });

  it('sanitizes preferred widths at the Anatomy bounds', () => {
    expect(sanitizeAnatomyWidth(ANATOMY_WIDTH.min - 1)).toBe(ANATOMY_WIDTH.min);
    expect(sanitizeAnatomyWidth(ANATOMY_WIDTH.max + 1)).toBe(ANATOMY_WIDTH.max);
    expect(sanitizeAnatomyWidth(640.5)).toBe(ANATOMY_WIDTH.default);
  });

  it('persists mode and width as separate appearance fields', () => {
    const notify = vi.fn();
    const unsubscribe = subscribeToPreferenceWrites(notify);
    const { result } = renderHook(() => useAnatomyLayout());

    act(() => result.current.setAnatomyWidth(720));
    act(() => result.current.setAnatomyMode('resizable'));

    expect(result.current.anatomyWidth).toBe(720);
    expect(result.current.anatomyMode).toBe('resizable');
    expect(localStorage.getItem(ANATOMY_WIDTH_KEY)).toBe('720');
    expect(localStorage.getItem(ANATOMY_MODE_KEY)).toBe('resizable');
    expect(notify).toHaveBeenCalledWith('appearance', ['anatomyWidth']);
    expect(notify).toHaveBeenCalledWith('appearance', ['anatomyMode']);
    unsubscribe();
  });

  it('registers both fields for identity cache clearing', () => {
    expect(PREFERENCE_CACHE_KEYS).toContain(ANATOMY_MODE_KEY);
    expect(PREFERENCE_CACHE_KEYS).toContain(ANATOMY_WIDTH_KEY);
  });
});
