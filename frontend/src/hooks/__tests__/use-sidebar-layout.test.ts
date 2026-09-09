import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  SIDEBAR_MODE_KEY,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH,
  SIDEBAR_MODES,
  applySidebarModeValue,
  applySidebarWidthValue,
  currentSidebarMode,
  currentSidebarWidth,
  sanitizeSidebarWidth,
  useSidebarLayout,
} from '../use-sidebar-layout';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { subscribeToPreferenceWrites } from '@/lib/preferences/preferenceEvents';
import { PREFERENCE_CACHE_KEYS } from '@/lib/preferences/preferencesDocuments';

describe('sanitizeSidebarWidth', () => {
    it('keeps valid integers within bounds', () => {
        expect(sanitizeSidebarWidth(280)).toBe(280);
        expect(sanitizeSidebarWidth(SIDEBAR_WIDTH.min)).toBe(SIDEBAR_WIDTH.min);
        expect(sanitizeSidebarWidth(SIDEBAR_WIDTH.max)).toBe(SIDEBAR_WIDTH.max);
    });

    it('clamps out-of-range integers into bounds', () => {
        expect(sanitizeSidebarWidth(200)).toBe(SIDEBAR_WIDTH.min);
        expect(sanitizeSidebarWidth(500)).toBe(SIDEBAR_WIDTH.max);
    });

    it('rejects fractional, non-finite, and non-numeric values with the default', () => {
        expect(sanitizeSidebarWidth(280.5)).toBe(SIDEBAR_WIDTH.default);
        expect(sanitizeSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default);
        expect(sanitizeSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_WIDTH.default);
        expect(sanitizeSidebarWidth('320')).toBe(SIDEBAR_WIDTH.default);
        expect(sanitizeSidebarWidth(null)).toBe(SIDEBAR_WIDTH.default);
        expect(sanitizeSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH.default);
    });
});

describe('stored reads', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('returns the fixed/default values on an empty cache', () => {
        expect(currentSidebarMode()).toBe('fixed');
        expect(currentSidebarWidth()).toBe(SIDEBAR_WIDTH.default);
    });

    it('restores a numeric width string from localStorage', () => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '312');
        expect(currentSidebarWidth()).toBe(312);
    });

    it('treats blank, malformed, and fractional cached widths as the default', () => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '');
        expect(currentSidebarWidth()).toBe(SIDEBAR_WIDTH.default);
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '   ');
        expect(currentSidebarWidth()).toBe(SIDEBAR_WIDTH.default);
        localStorage.setItem(SIDEBAR_WIDTH_KEY, 'not-a-number');
        expect(currentSidebarWidth()).toBe(SIDEBAR_WIDTH.default);
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '300.7');
        expect(currentSidebarWidth()).toBe(SIDEBAR_WIDTH.default);
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '999');
        expect(currentSidebarWidth()).toBe(SIDEBAR_WIDTH.max);
    });

    it('falls back to fixed on an unknown mode value', () => {
        localStorage.setItem(SIDEBAR_MODE_KEY, 'float');
        expect(currentSidebarMode()).toBe('fixed');
    });
});

describe('apply* write path', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('persists values and broadcasts the settings-changed event without notifying the bus', () => {
        const notify = vi.fn();
        const unsub = subscribeToPreferenceWrites(notify);
        let changed = 0;
        const listener = () => { changed += 1; };
        window.addEventListener(SENCHO_SETTINGS_CHANGED, listener);

        applySidebarModeValue('resizable');
        applySidebarWidthValue(300);

        expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('resizable');
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('300');
        expect(changed).toBe(2);
        expect(notify).not.toHaveBeenCalled();

        window.removeEventListener(SENCHO_SETTINGS_CHANGED, listener);
        unsub();
    });

    it('skips the identical-value localStorage write and its broadcast', () => {
        applySidebarModeValue('fixed');
        let changed = 0;
        const listener = () => { changed += 1; };
        window.addEventListener(SENCHO_SETTINGS_CHANGED, listener);
        applySidebarModeValue('fixed');
        expect(changed).toBe(0);
        window.removeEventListener(SENCHO_SETTINGS_CHANGED, listener);
    });

    it('broadcasts once when the setter path changes storage (shell separator commit)', () => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '300');
        const { result } = renderHook(() => useSidebarLayout());
        let changed = 0;
        const listener = () => { changed += 1; };
        window.addEventListener(SENCHO_SETTINGS_CHANGED, listener);

        act(() => result.current.setSidebarWidth(352));
        // The writing instance keeps its own state; other mounted instances
        // re-read storage on this event and converge on the new width.
        expect(result.current.sidebarWidth).toBe(352);
        expect(changed).toBe(1);
        window.removeEventListener(SENCHO_SETTINGS_CHANGED, listener);
    });
});

describe('useSidebarLayout', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('round-trips mode and width through the setters', () => {
        const { result } = renderHook(() => useSidebarLayout());
        act(() => result.current.setSidebarMode('resizable'));
        act(() => result.current.setSidebarWidth(380));
        expect(result.current.sidebarMode).toBe('resizable');
        expect(result.current.sidebarWidth).toBe(380);
        expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('resizable');
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('380');
    });

    it('attributes each write to its own field', () => {
        const notify = vi.fn();
        const unsub = subscribeToPreferenceWrites(notify);
        const { result } = renderHook(() => useSidebarLayout());

        act(() => result.current.setSidebarMode('resizable'));
        expect(notify).toHaveBeenCalledWith('appearance', ['sidebarMode']);

        act(() => result.current.setSidebarWidth(300));
        expect(notify).toHaveBeenCalledWith('appearance', ['sidebarWidth']);
        unsub();
    });

    it('sanitizes the width on write', () => {
        const { result } = renderHook(() => useSidebarLayout());
        act(() => result.current.setSidebarWidth(500));
        expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH.max);
        act(() => result.current.setSidebarWidth(280.5));
        expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH.default);
    });

    it('a mode write never touches the stored width', () => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '340');
        const { result } = renderHook(() => useSidebarLayout());
        expect(result.current.sidebarWidth).toBe(340);
        act(() => result.current.setSidebarMode('fixed'));
        expect(result.current.sidebarWidth).toBe(340);
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('340');
    });

    it('re-reads localStorage on the settings-changed event', () => {
        const { result } = renderHook(() => useSidebarLayout());
        expect(result.current.sidebarMode).toBe('fixed');
        localStorage.setItem(SIDEBAR_MODE_KEY, 'resizable');
        act(() => {
            window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
        });
        expect(result.current.sidebarMode).toBe('resizable');
    });

    it('re-reads localStorage on cross-tab storage events for its keys', () => {
        const { result } = renderHook(() => useSidebarLayout());
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: SIDEBAR_WIDTH_KEY,
                newValue: '360',
            }));
        });
        expect(result.current.sidebarWidth).toBe(360);
    });

    it('ignores storage events for unrelated keys', () => {
        const { result } = renderHook(() => useSidebarLayout());
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'some-other-key',
                newValue: '360',
            }));
        });
        expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH.default);
    });

    it('registers both keys in the identity-clear cache key list', () => {
        expect(PREFERENCE_CACHE_KEYS).toContain(SIDEBAR_MODE_KEY);
        expect(PREFERENCE_CACHE_KEYS).toContain(SIDEBAR_WIDTH_KEY);
    });

    it('keeps the frontend mode enum in the documented shape for parity', () => {
        expect([...SIDEBAR_MODES]).toEqual(['fixed', 'resizable']);
    });

    it('notifies with dirty fields only after the local write lands', () => {
        const order: string[] = [];
        const unsub = subscribeToPreferenceWrites(() => { order.push('notify'); });
        const { result } = renderHook(() => useSidebarLayout());
        act(() => result.current.setSidebarMode('resizable'));
        expect(order).toEqual(['notify']);
        expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('resizable');
        unsub();
    });
});
