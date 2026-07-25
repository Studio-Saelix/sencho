import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { recommendedQuickLinkIds } from '@/lib/navigation/appNavRegistry';
import type { ActiveView } from '@/lib/router/routeTypes';
import {
  useTopNavQuickLinks,
  TOP_NAV_QUICK_LINKS_KEY,
  parseStoredQuickLinks,
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
];

describe('useTopNavQuickLinks', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('uses registry recommended defaults when the key is missing', () => {
    const { result } = renderHook(() => useTopNavQuickLinks());
    expect(result.current.persistedIds).toEqual([...recommendedQuickLinkIds]);
  });

  it('uses registry recommended defaults for malformed JSON', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, '{not-json');
    expect(parseStoredQuickLinks(localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY))).toEqual([
      ...recommendedQuickLinkIds,
    ]);
  });

  it('keeps a valid empty array empty', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, '[]');
    const { result } = renderHook(() => useTopNavQuickLinks());
    expect(result.current.persistedIds).toEqual([]);
  });

  it('sanitizes unknown, ineligible, and duplicate IDs and caps at seven', () => {
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
    expect(sanitizeQuickLinkIds([...maxedPins, 'auto-updates']).length).toBe(MAX_QUICK_LINKS);
  });

  it('reset writes recommendedQuickLinkIds', () => {
    localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, '[]');
    const { result } = renderHook(() => useTopNavQuickLinks());
    act(() => result.current.resetQuickLinks());
    expect(result.current.persistedIds).toEqual([...recommendedQuickLinkIds]);
    expect(JSON.parse(localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY)!)).toEqual([
      ...recommendedQuickLinkIds,
    ]);
  });

  it('remove can clear all pins without repopulating', () => {
    const { result } = renderHook(() => useTopNavQuickLinks());
    act(() => {
      for (const id of [...result.current.persistedIds]) {
        result.current.removeQuickLink(id);
      }
    });
    expect(result.current.persistedIds).toEqual([]);
    expect(JSON.parse(localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY)!)).toEqual([]);
  });

  it('add refuses beyond the persisted max of seven', () => {
    const { result } = renderHook(() => useTopNavQuickLinks());
    act(() => result.current.setPersistedIds(maxedPins));
    act(() => result.current.addQuickLink('auto-updates'));
    expect(result.current.persistedIds).toEqual(maxedPins);
  });

  it('syncs a second hook in the same tab', () => {
    const a = renderHook(() => useTopNavQuickLinks());
    const b = renderHook(() => useTopNavQuickLinks());
    act(() => a.result.current.setPersistedIds(['networking']));
    expect(b.result.current.persistedIds).toEqual(['networking']);
  });
});
