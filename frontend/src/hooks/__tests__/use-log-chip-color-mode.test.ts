import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLogChipColorMode, LOG_CHIP_COLOR_KEY } from '../use-log-chip-color-mode';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

describe('useLogChipColorMode', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('defaults to per-service when no value is stored', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('per-service');
    });

    it('returns unified when the key is set to that value', () => {
        localStorage.setItem(LOG_CHIP_COLOR_KEY, 'unified');
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('unified');
    });

    it('falls back to per-service on unrecognised values', () => {
        localStorage.setItem(LOG_CHIP_COLOR_KEY, 'garbage');
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('per-service');
    });

    it('setter writes to localStorage and updates state', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        act(() => result.current[1]('unified'));
        expect(result.current[0]).toBe('unified');
        expect(localStorage.getItem(LOG_CHIP_COLOR_KEY)).toBe('unified');
    });

    it('responds to SENCHO_SETTINGS_CHANGED by re-reading localStorage', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('per-service');
        // Simulate another tab/component changing the value.
        localStorage.setItem(LOG_CHIP_COLOR_KEY, 'unified');
        act(() => {
            window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
        });
        expect(result.current[0]).toBe('unified');
    });

    it('responds to cross-tab storage events', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('per-service');
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: LOG_CHIP_COLOR_KEY,
                newValue: 'unified',
            }));
        });
        expect(result.current[0]).toBe('unified');
    });

    it('ignores storage events for unrelated keys', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'some-other-key',
                newValue: 'unified',
            }));
        });
        expect(result.current[0]).toBe('per-service');
    });
});
