import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
    useFleetTabLayout, applyFleetTabLayoutValue, currentFleetTabLayout, isFleetTabLayout,
    FLEET_TAB_LAYOUT_KEY, DEFAULT_FLEET_TAB_LAYOUT,
} from '../use-fleet-tab-layout';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { subscribeToPreferenceWrites } from '@/lib/preferences/preferenceEvents';
import { PREFERENCE_CACHE_KEYS } from '@/lib/preferences/preferencesDocuments';

/** A storage event as another tab would raise it, without the two-argument StorageEvent constructor. */
function storageEvent(key: string | null, newValue: string | null): Event {
    return Object.assign(new Event('storage'), { key, newValue });
}

describe('useFleetTabLayout', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('defaults to flat when nothing is stored', () => {
        const { result } = renderHook(() => useFleetTabLayout());
        expect(result.current[0]).toBe('flat');
        expect(DEFAULT_FLEET_TAB_LAYOUT).toBe('flat');
    });

    it.each(['flat', 'compact'] as const)('reads a stored %s layout', (layout) => {
        localStorage.setItem(FLEET_TAB_LAYOUT_KEY, layout);
        expect(renderHook(() => useFleetTabLayout()).result.current[0]).toBe(layout);
    });

    it('falls back to flat on an unrecognised stored value, including the retired grouped layout', () => {
        localStorage.setItem(FLEET_TAB_LAYOUT_KEY, 'tabs');
        expect(renderHook(() => useFleetTabLayout()).result.current[0]).toBe('flat');
        expect(isFleetTabLayout('tabs')).toBe(false);
        expect(isFleetTabLayout('grouped')).toBe(false);
    });

    it('the setter stores the value, updates state, and attributes the write to its field', () => {
        const writes: unknown[] = [];
        const unsubscribe = subscribeToPreferenceWrites((domain, fields) => writes.push([domain, fields]));
        const { result } = renderHook(() => useFleetTabLayout());
        act(() => result.current[1]('compact'));
        unsubscribe();
        expect(result.current[0]).toBe('compact');
        expect(localStorage.getItem(FLEET_TAB_LAYOUT_KEY)).toBe('compact');
        expect(writes).toEqual([['appearance', ['fleetTabLayout']]]);
    });

    it('applying a value (hydration) stores it, tells mounted readers, and does not notify the sync bus', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeToPreferenceWrites(listener);
        const { result } = renderHook(() => useFleetTabLayout());
        act(() => applyFleetTabLayoutValue('compact'));
        unsubscribe();
        expect(result.current[0]).toBe('compact');
        expect(currentFleetTabLayout()).toBe('compact');
        expect(listener).not.toHaveBeenCalled();
    });

    it('re-reads when the settings-changed event fires', () => {
        const { result } = renderHook(() => useFleetTabLayout());
        localStorage.setItem(FLEET_TAB_LAYOUT_KEY, 'compact');
        act(() => { window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED)); });
        expect(result.current[0]).toBe('compact');
    });

    it('follows another tab through the storage event, and ignores unrelated keys', () => {
        const { result } = renderHook(() => useFleetTabLayout());
        act(() => { window.dispatchEvent(storageEvent(FLEET_TAB_LAYOUT_KEY, 'compact')); });
        expect(result.current[0]).toBe('compact');
        act(() => { window.dispatchEvent(storageEvent('other', 'flat')); });
        expect(result.current[0]).toBe('compact');
        act(() => { window.dispatchEvent(storageEvent(FLEET_TAB_LAYOUT_KEY, null)); });
        expect(result.current[0]).toBe('flat');
    });

    it('is cleared with the rest of the preference cache when another account claims the browser', () => {
        expect(PREFERENCE_CACHE_KEYS).toContain(FLEET_TAB_LAYOUT_KEY);
    });

    it('survives localStorage being unavailable', () => {
        const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        expect(renderHook(() => useFleetTabLayout()).result.current[0]).toBe('flat');
        spy.mockRestore();
    });
});
