import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLogChipColorMode, LOG_CHIP_COLOR_KEY } from '../use-log-chip-color-mode';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

describe('useLogChipColorMode', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('defaults to unified when no value is stored', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('unified');
    });

    it('returns per-service when the key is set to that value', () => {
        localStorage.setItem(LOG_CHIP_COLOR_KEY, 'per-service');
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('per-service');
    });

    it('falls back to unified on unrecognised values', () => {
        localStorage.setItem(LOG_CHIP_COLOR_KEY, 'garbage');
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('unified');
    });

    it('setter writes to localStorage and updates state', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        act(() => result.current[1]('per-service'));
        expect(result.current[0]).toBe('per-service');
        expect(localStorage.getItem(LOG_CHIP_COLOR_KEY)).toBe('per-service');
    });

    it('responds to SENCHO_SETTINGS_CHANGED by re-reading localStorage', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('unified');
        // Simulate another tab/component changing the value.
        localStorage.setItem(LOG_CHIP_COLOR_KEY, 'per-service');
        act(() => {
            window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
        });
        expect(result.current[0]).toBe('per-service');
    });

    it('responds to cross-tab storage events', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        expect(result.current[0]).toBe('unified');
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: LOG_CHIP_COLOR_KEY,
                newValue: 'per-service',
            }));
        });
        expect(result.current[0]).toBe('per-service');
    });

    it('ignores storage events for unrelated keys', () => {
        const { result } = renderHook(() => useLogChipColorMode());
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'some-other-key',
                newValue: 'per-service',
            }));
        });
        expect(result.current[0]).toBe('unified');
    });
});
