/**
 * Covers dirty counting, the load (reset) vs save-success (markSaved) split, and
 * the in-flight case: markSaved moves only the baseline, so an edit made while a
 * PATCH is in flight is preserved.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSettingsDirty } from '../useSettingsDirty';

type Fields = Record<'a' | 'b', string>;

const INITIAL: Fields = { a: '1', b: '1' };

describe('useSettingsDirty', () => {
    it('starts clean', () => {
        const { result } = renderHook(() => useSettingsDirty<Fields>(INITIAL));
        expect(result.current.dirtyCount).toBe(0);
        expect(result.current.hasChanges).toBe(false);
    });

    it('counts changed fields against the baseline', () => {
        const { result } = renderHook(() => useSettingsDirty<Fields>(INITIAL));
        act(() => result.current.setSettings(prev => ({ ...prev, a: '2' })));
        expect(result.current.dirtyCount).toBe(1);
        expect(result.current.hasChanges).toBe(true);
        act(() => result.current.setSettings(prev => ({ ...prev, b: '2' })));
        expect(result.current.dirtyCount).toBe(2);
    });

    it('reset adopts both current values and baseline, and edits count against the new baseline', () => {
        const { result } = renderHook(() => useSettingsDirty<Fields>(INITIAL));
        act(() => result.current.reset({ a: '9', b: '9' }));
        expect(result.current.settings).toEqual({ a: '9', b: '9' });
        expect(result.current.hasChanges).toBe(false);
        // An edit after reset is measured against the freshly adopted baseline.
        act(() => result.current.setSettings(prev => ({ ...prev, a: '8' })));
        expect(result.current.dirtyCount).toBe(1);
    });

    it('markSaved clears dirty without touching current settings', () => {
        const { result } = renderHook(() => useSettingsDirty<Fields>(INITIAL));
        act(() => result.current.setSettings(prev => ({ ...prev, a: '2' })));
        const submitted = result.current.settings;
        act(() => result.current.markSaved(submitted));
        expect(result.current.settings).toEqual({ a: '2', b: '1' });
        expect(result.current.hasChanges).toBe(false);
    });

    it('keeps an edit made after the submitted snapshot dirty (in-flight save)', () => {
        const { result } = renderHook(() => useSettingsDirty<Fields>(INITIAL));
        // User changes a, "submits", then changes b before the save resolves.
        act(() => result.current.setSettings(prev => ({ ...prev, a: '2' })));
        const submitted = result.current.settings; // { a: '2', b: '1' }
        act(() => result.current.setSettings(prev => ({ ...prev, b: '2' })));
        // Save resolves: baseline adopts the submitted snapshot only.
        act(() => result.current.markSaved(submitted));
        // b was changed after submitting, so the section stays dirty on b.
        expect(result.current.settings).toEqual({ a: '2', b: '2' });
        expect(result.current.dirtyCount).toBe(1);
        expect(result.current.hasChanges).toBe(true);
    });
});
