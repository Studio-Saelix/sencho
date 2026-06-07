import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from './use-is-mobile';

function installMatchMedia(initialMatches: boolean) {
    let listener: ((e: MediaQueryListEvent) => void) | null = null;
    const mql = {
        matches: initialMatches,
        media: '',
        onchange: null,
        addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => { listener = cb; },
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    };
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
    return {
        emit(matches: boolean) {
            mql.matches = matches;
            listener?.({ matches } as MediaQueryListEvent);
        },
    };
}

describe('useIsMobile', () => {
    const original = window.matchMedia;
    afterEach(() => { window.matchMedia = original; });

    it('returns false at desktop widths', () => {
        installMatchMedia(false);
        const { result } = renderHook(() => useIsMobile());
        expect(result.current).toBe(false);
    });

    it('returns true below the breakpoint', () => {
        installMatchMedia(true);
        const { result } = renderHook(() => useIsMobile());
        expect(result.current).toBe(true);
    });

    it('updates when the media query crosses the breakpoint', () => {
        const mm = installMatchMedia(false);
        const { result } = renderHook(() => useIsMobile());
        expect(result.current).toBe(false);
        act(() => mm.emit(true));
        expect(result.current).toBe(true);
        act(() => mm.emit(false));
        expect(result.current).toBe(false);
    });
});
