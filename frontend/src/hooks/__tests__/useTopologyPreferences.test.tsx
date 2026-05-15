import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTopologyPreferences } from '../useTopologyPreferences';

const PREFS_KEY = 'sencho-topology-preferences';

describe('useTopologyPreferences', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('defaults to hub mode with no positions when storage is empty', () => {
        const { result } = renderHook(() => useTopologyPreferences());
        expect(result.current.prefs.mode).toBe('hub');
        expect(result.current.prefs.positions).toEqual({});
    });

    it('setMode persists to localStorage', () => {
        const { result } = renderHook(() => useTopologyPreferences());
        act(() => result.current.setMode('grouped'));
        expect(result.current.prefs.mode).toBe('grouped');
        const stored = JSON.parse(window.localStorage.getItem(PREFS_KEY)!);
        expect(stored.mode).toBe('grouped');
    });

    it('setPositions persists positions and survives a fresh render', () => {
        const positions = { '7': { x: 12, y: 34 }, '8': { x: 56, y: 78 } };
        const first = renderHook(() => useTopologyPreferences());
        act(() => first.result.current.setPositions(positions));
        expect(first.result.current.prefs.positions).toEqual(positions);

        const second = renderHook(() => useTopologyPreferences());
        expect(second.result.current.prefs.positions).toEqual(positions);
    });

    it('falls back to defaults when stored JSON is corrupt', () => {
        window.localStorage.setItem(PREFS_KEY, '{not-json');
        const { result } = renderHook(() => useTopologyPreferences());
        expect(result.current.prefs.mode).toBe('hub');
        expect(result.current.prefs.positions).toEqual({});
    });

    it('rejects an invalid mode and uses the default instead', () => {
        window.localStorage.setItem(
            PREFS_KEY,
            JSON.stringify({ mode: 'something-else', positions: {} }),
        );
        const { result } = renderHook(() => useTopologyPreferences());
        expect(result.current.prefs.mode).toBe('hub');
    });

    it('rejects malformed positions and uses an empty object instead', () => {
        window.localStorage.setItem(
            PREFS_KEY,
            JSON.stringify({ mode: 'free', positions: { '1': 'oops' } }),
        );
        const { result } = renderHook(() => useTopologyPreferences());
        expect(result.current.prefs.mode).toBe('free');
        expect(result.current.prefs.positions).toEqual({});
    });

    it('updatePositions applies an updater function', () => {
        const { result } = renderHook(() => useTopologyPreferences());
        act(() => result.current.setPositions({ '1': { x: 0, y: 0 } }));
        act(() => result.current.updatePositions(prev => ({ ...prev, '2': { x: 1, y: 2 } })));
        expect(result.current.prefs.positions).toEqual({
            '1': { x: 0, y: 0 },
            '2': { x: 1, y: 2 },
        });
    });
});
