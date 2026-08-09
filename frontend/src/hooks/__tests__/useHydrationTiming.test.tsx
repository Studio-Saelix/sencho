import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

type Store = typeof import('../../lib/hydrationTiming');

/** Fresh module instance so the module-scoped store starts clean. */
async function loadStore(): Promise<Store> {
  vi.resetModules();
  return import('../../lib/hydrationTiming');
}

describe('useHydrationTiming', () => {
  it('stays stable without new events (no store emit)', async () => {
    await loadStore();
    const { useHydrationTiming } = await import('../useHydrationTiming');
    const { result } = renderHook(() => useHydrationTiming());

    expect(result.current.listVisibleMs).toBeNull();
    expect(result.current.listAnchor).toBeNull();
    const firstSnapshot = result.current.snapshot;

    // No store mutation, so no coalesced emit: the snapshot identity and chip
    // value must remain stable over time.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(result.current.snapshot).toBe(firstSnapshot);
    expect(result.current.listVisibleMs).toBeNull();
    expect(result.current.listAnchor).toBeNull();
  });

  it('re-renders with the attempt anchor when a list attempt commits while mounted', async () => {
    const store = await loadStore();
    const { useHydrationTiming } = await import('../useHydrationTiming');
    const { result } = renderHook(() => useHydrationTiming());
    expect(result.current.listAnchor).toBeNull();

    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);

    await waitFor(() => expect(result.current.listAnchor).toBe('attempt'));
    expect(result.current.listVisibleMs).not.toBeNull();
  });

  it('falls back to the session anchor when no foreground attempt exists', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    for (let i = 0; i < 200; i++) store.newAttemptId(); // evict `a` from the attempt map

    // Wait for a coalesced emit to rebuild the snapshot with the session
    // anchor; the initial snapshot already has lastAttempt null.
    await waitFor(() => {
      expect(store.getSnapshot().nodeSessionStartAt).not.toBeNull();
      expect(store.getSnapshot().lastAttempt).toBeNull();
    });
    const { useHydrationTiming } = await import('../useHydrationTiming');
    const { result } = renderHook(() => useHydrationTiming());
    expect(result.current.listAnchor).toBe('session');
    expect(result.current.listVisibleMs).not.toBeNull();
  });
});
