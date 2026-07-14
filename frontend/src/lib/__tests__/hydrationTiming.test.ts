import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';

// Each test gets a fresh module instance so the module-scoped boot session and
// event buffer start clean. Resetting modules re-runs the boot_start init.
type Store = typeof import('../hydrationTiming');

async function loadStore(setup?: () => void): Promise<Store> {
  vi.resetModules();
  setup?.();
  return import('../hydrationTiming');
}

/** Stub `performance` with a caller-controlled clock so durations are exact. */
function stubClock(getT: () => number): void {
  vi.stubGlobal('performance', {
    now: () => getT(),
    mark: vi.fn(),
    measure: vi.fn(),
    clearMarks: vi.fn(),
    clearMeasures: vi.fn(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hydrationTiming store', () => {
  it('records boot_start once and dedupes one-shot milestones (StrictMode)', async () => {
    const store = await loadStore();
    // Simulate a StrictMode double invocation plus an explicit re-mark.
    store.markMilestone('boot_start');
    store.markMilestone('boot_start', { oneShot: true });
    store.markMilestone('auth_resolved');
    store.markMilestone('auth_resolved');

    const phases = store.getHydrationReport().phases.map((p) => p.phase);
    expect(phases.filter((p) => p === 'boot_start')).toHaveLength(1);
    expect(phases.filter((p) => p === 'auth_resolved')).toHaveLength(1);
  });

  it('evicts the oldest events beyond the 200-event cap (FIFO)', async () => {
    const store = await loadStore();
    for (let i = 0; i < 250; i++) {
      const handle = store.beginSpan('fetch_headers');
      store.endSpan(handle);
    }
    const report = store.getHydrationReport();
    expect(report.phases).toHaveLength(200);
    // boot_start was the very first event, so it has been evicted.
    expect(report.phases.some((p) => p.phase === 'boot_start')).toBe(false);
  });

  it('never completes a superseded or aborted attempt', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const superseded = store.newAttemptId();
    store.beginNodeSession(2); // supersedes node session 1's attempts
    store.commitMilestone('list_visible', superseded);
    expect(store.getHydrationReport().phases.some((p) => p.phase === 'list_visible')).toBe(false);

    const aborted = store.newAttemptId();
    store.abortAttempt(aborted);
    store.commitMilestone('detail_hydrated', aborted);
    expect(store.getHydrationReport().phases.some((p) => p.phase === 'detail_hydrated')).toBe(false);

    // A live attempt for the current node session still commits.
    const live = store.newAttemptId();
    store.commitMilestone('list_visible', live);
    expect(store.getHydrationReport().phases.some((p) => p.phase === 'list_visible')).toBe(true);
  });

  it('marks unknown attempts as no-ops for commit milestones', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    store.commitMilestone('list_visible', 'attempt-does-not-exist');
    expect(store.getHydrationReport().phases.some((p) => p.phase === 'list_visible')).toBe(false);
  });

  it('falls back to Date.now when performance is unavailable', async () => {
    const store = await loadStore(() => vi.stubGlobal('performance', undefined));
    expect(() => store.markMilestone('auth_resolved')).not.toThrow();
    expect(store.getHydrationReport().clock).toBe('date.now-fallback');
  });

  it('tolerates a performance object missing mark and measure', async () => {
    const store = await loadStore(() => vi.stubGlobal('performance', { now: () => 5 }));
    expect(() => {
      store.beginNodeSession(1);
      const a = store.newAttemptId();
      store.commitMilestone('list_visible', a);
      const handle = store.beginSpan('body_decode', { attemptId: a });
      store.endSpan(handle);
    }).not.toThrow();
    expect(store.getHydrationReport().clock).toBe('performance.now');
  });

  it('clears node session events but keeps boot markers', async () => {
    const store = await loadStore();
    store.markMilestone('auth_resolved');
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);

    store.clearReport();

    const phases = store.getHydrationReport().phases.map((p) => p.phase);
    expect(phases).toContain('boot_start');
    expect(phases).toContain('auth_resolved');
    expect(phases).not.toContain('list_visible');
  });

  it('reports list_visible elapsed from boot_start', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    t = 1200;
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    expect(store.getListVisibleMs()).toBe(1200);
    expect(store.getHydrationReport().listVisibleMs).toBe(1200);
  });

  it('returns null list_visible timing before it commits', async () => {
    const store = await loadStore();
    expect(store.getListVisibleMs()).toBeNull();
  });

  it('records span duration between begin and end', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    t = 10;
    const handle = store.beginSpan('fetch_headers', { attemptId: a });
    t = 35;
    store.endSpan(handle);
    const span = store.getHydrationReport().phases.find((p) => p.phase === 'fetch_headers');
    expect(span?.durationMs).toBe(25);
  });

  it('fires an empty->empty commit once per attempt via completion token', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a, { completionToken: 'empty' });
    store.commitMilestone('list_visible', a, { completionToken: 'empty' });

    const listVisible = store.getHydrationReport().phases.filter((p) => p.phase === 'list_visible');
    expect(listVisible).toHaveLength(1);
    expect(listVisible[0].detail?.completionToken).toBe('empty');

    // Without a token, a repeat commit for the same attempt still dedupes.
    const b = store.newAttemptId();
    store.commitMilestone('list_hydrated', b);
    store.commitMilestone('list_hydrated', b);
    expect(store.getHydrationReport().phases.filter((p) => p.phase === 'list_hydrated')).toHaveLength(1);
  });

  it('classifies background phases as non-critical', async () => {
    const store = await loadStore();
    expect(store.classifyCritical('list_visible')).toBe(true);
    expect(store.classifyCritical('notifications_ready')).toBe(false);
    expect(store.classifyCritical('image_updates_ready')).toBe(false);
  });

  it('keeps snapshots referentially stable until an emit fires', async () => {
    const store = await loadStore();
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);

    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.markMilestone('auth_resolved');

    await waitFor(() => expect(listener).toHaveBeenCalled());

    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.events.some((e) => e.phase === 'auth_resolved')).toBe(true);
    unsubscribe();
  });
});
