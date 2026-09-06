import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ActiveView } from '@/lib/router/routeTypes';
import {
  useTopNavQuickLinks,
  TOP_NAV_QUICK_LINKS_KEY,
  parseStoredState,
  sanitizeQuickLinkIds,
  MAX_QUICK_LINKS,
} from '../use-top-nav-quick-links';

/** A full pin list: eligible IDs, spelled out so the cap value stays pinned independently. */
const maxedPins: ActiveView[] = [
  'dashboard',
  'fleet',
  'security',
  'resources',
  'networking',
  'templates',
  'global-observability',
  'auto-updates',
];

describe('useTopNavQuickLinks', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('starts empty when the key is missing and no defaultEligibleIds are given', () => {
    const { result } = renderHook(() => useTopNavQuickLinks());
    expect(result.current.persistedIds).toEqual([]);
  });

  it('seeds settled default eligibility once, when the key is missing', () => {
    const eligible: ActiveView[] = ['dashboard', 'fleet'];
    const { result, rerender } = renderHook<
      ReturnType<typeof useTopNavQuickLinks>,
      { ids: ActiveView[] | null }
    >(
      ({ ids }) => useTopNavQuickLinks(ids),
      { initialProps: { ids: null } },
    );
    expect(result.current.persistedIds).toEqual([]);
    rerender({ ids: eligible });
    expect(result.current.persistedIds).toEqual(eligible);
    expect(JSON.parse(localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY)!)).toEqual(eligible);
  });

  it('parseStoredState treats malformed JSON as unset, not raw defaults', () => {
    expect(parseStoredState('{not-json')).toEqual({ status: 'unset' });
    expect(parseStoredState(null)).toEqual({ status: 'unset' });
    expect(parseStoredState('{"not":"an array"}')).toEqual({ status: 'unset' });
  });

  it('the hook also starts empty for malformed JSON, not raw unfiltered defaults', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, '{not-json');
    const { result } = renderHook(() => useTopNavQuickLinks());
    expect(result.current.persistedIds).toEqual([]);
  });

  it('keeps a valid empty array empty', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, '[]');
    const { result } = renderHook(() => useTopNavQuickLinks(['dashboard', 'fleet']));
    expect(result.current.persistedIds).toEqual([]);
  });

  it('sanitizes unknown, ineligible, and duplicate IDs and caps at eight', () => {
    expect(
      sanitizeQuickLinkIds([
        'dashboard',
        'dashboard',
        'settings',
        'not-a-view',
        'fleet',
        'security',
        'resources',
        'networking',
        'templates',
        'global-observability',
        'auto-updates',
        'scheduled-ops',
      ]),
    ).toEqual(maxedPins);
    expect(sanitizeQuickLinkIds([...maxedPins, 'scheduled-ops']).length).toBe(MAX_QUICK_LINKS);
  });

  it('reset writes the given defaultEligibleIds, not the raw recommended list', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, '[]');
    const eligible: ActiveView[] = ['dashboard', 'resources'];
    const { result } = renderHook(() => useTopNavQuickLinks(eligible));
    act(() => result.current.resetQuickLinks());
    expect(result.current.persistedIds).toEqual(eligible);
    expect(JSON.parse(localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY)!)).toEqual(eligible);
  });

  it('reset persists a settled, confirmed-empty eligibility list as valid []', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, JSON.stringify(['dashboard']));
    const { result } = renderHook(() => useTopNavQuickLinks([]));
    expect(result.current.canReset).toBe(true);
    act(() => result.current.resetQuickLinks());
    expect(result.current.persistedIds).toEqual([]);
    expect(JSON.parse(localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY)!)).toEqual([]);
  });

  it('reset no-ops and canReset is false when defaultEligibleIds is not settled', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, JSON.stringify(['dashboard']));
    const { result } = renderHook(() => useTopNavQuickLinks(null));
    expect(result.current.canReset).toBe(false);
    act(() => result.current.resetQuickLinks());
    expect(result.current.persistedIds).toEqual(['dashboard']);
  });

  it('remove can clear all pins without repopulating', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, JSON.stringify(['dashboard', 'fleet']));
    const { result } = renderHook(() => useTopNavQuickLinks());
    act(() => {
      for (const id of [...result.current.persistedIds]) {
        result.current.removeQuickLink(id);
      }
    });
    expect(result.current.persistedIds).toEqual([]);
    expect(JSON.parse(localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY)!)).toEqual([]);
  });

  it('remove applied across consecutive calls in one batch clears every pin, not just the last', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, JSON.stringify(maxedPins));
    const { result } = renderHook(() => useTopNavQuickLinks());
    act(() => {
      result.current.removeQuickLink(maxedPins[0]);
      result.current.removeQuickLink(maxedPins[1]);
      result.current.removeQuickLink(maxedPins[2]);
    });
    expect(result.current.persistedIds).toEqual(maxedPins.slice(3));
  });

  it('add applied across consecutive calls in one batch keeps every addition, in order', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, JSON.stringify(['dashboard']));
    const { result } = renderHook(() => useTopNavQuickLinks());
    act(() => {
      result.current.addQuickLink('fleet');
      result.current.addQuickLink('resources');
    });
    expect(result.current.persistedIds).toEqual(['dashboard', 'fleet', 'resources']);
  });

  it('add refuses beyond the persisted max of eight', () => {
    const { result } = renderHook(() => useTopNavQuickLinks());
    act(() => result.current.setPersistedIds(maxedPins));
    act(() => result.current.addQuickLink('scheduled-ops'));
    expect(result.current.persistedIds).toEqual(maxedPins);
  });

  it('syncs a second hook in the same tab', () => {
    const a = renderHook(() => useTopNavQuickLinks());
    const b = renderHook(() => useTopNavQuickLinks());
    act(() => a.result.current.setPersistedIds(['networking']));
    expect(b.result.current.persistedIds).toEqual(['networking']);
  });

  it('a malformed storage write synced from another tab lands as unset, not raw defaults', () => {
    const { result } = renderHook(() => useTopNavQuickLinks());
    act(() => result.current.setPersistedIds(['dashboard']));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: TOP_NAV_QUICK_LINKS_KEY,
        newValue: '{not-json',
      }));
    });
    expect(result.current.persistedIds).toEqual([]);
  });
});
