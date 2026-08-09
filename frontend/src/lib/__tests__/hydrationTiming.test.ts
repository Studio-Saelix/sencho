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

/** Push 250 span pairs so the oldest events evict past the 200-event cap. */
function evictOldestEvents(store: Store): void {
  for (let i = 0; i < 250; i++) {
    const handle = store.beginSpan('fetch_headers');
    store.endSpan(handle);
  }
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
    evictOldestEvents(store);
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

  it('reports list_visible elapsed from boot_start (compat) and session/attempt anchors', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    t = 1200;
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    expect(store.getListVisibleMs()).toBe(1200);
    const report = store.getHydrationReport();
    expect(report.listVisibleMs).toBe(1200);
    expect(report.schemaVersion).toBe(2);
    expect(report.sessionListVisibleMs).toBe(0);
    expect(report.lastAttemptListVisibleMs).toBe(0);
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

  it('reports a late node-session list_visible relative to the session, not boot', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    t = 600_000; // page has been alive for ten minutes before the node session
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    t = 600_010;
    store.commitMilestone('list_visible', a);
    const report = store.getHydrationReport();
    // The foreground hydration duration is 10 ms, never the 600 s boot age.
    expect(report.lastAttemptListVisibleMs).toBe(10);
    expect(report.sessionListVisibleMs).toBe(10);
    expect(report.bootAgeMs).toBe(600_010);
    expect(report.listVisibleMs).toBe(600_010); // raw boot-relative compat field
  });

  it('keeps a stack-detail attempt from stealing the foreground list attempt', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    store.beginNodeSession(1);
    t = 10;
    const listAttempt = store.newAttemptId();
    t = 50;
    store.commitMilestone('list_visible', listAttempt);
    t = 60;
    const detailAttempt = store.newAttemptId(); // never commits list_visible
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBe(listAttempt);
    expect(report.lastAttemptId).not.toBe(detailAttempt);
    expect(report.lastAttemptListVisibleMs).toBe(40);
  });

  it('leaves lastAttemptListHydratedMs null until the foreground attempt hydrates', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBe(a);
    expect(report.lastAttemptListVisibleMs).not.toBeNull();
    expect(report.lastAttemptListHydratedMs).toBeNull();
    expect(report.lastAttemptHydrationGapMs).toBeNull();
  });

  it('never reports a superseded attempt as the foreground attempt', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    store.beginNodeSession(2); // supersedes session 1 and prunes its events
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBeNull();
    expect(report.lastAttemptListVisibleMs).toBeNull();
  });

  it('never reports an aborted attempt as the foreground attempt', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    store.abortAttempt(a);
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBeNull();
    expect(report.lastAttemptListVisibleMs).toBeNull();
  });

  it('preserves a failed attempt outcome without presenting it as a clean success', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a, { outcome: 'error' });
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBe(a);
    expect(report.phases.find((p) => p.phase === 'list_visible')?.outcome).toBe('error');
  });

  it('degrades attempt-relative fields gracefully when the attempt map evicts the record', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    for (let i = 0; i < 200; i++) store.newAttemptId(); // MAX_ATTEMPTS evicts `a`
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBeNull();
    expect(report.lastAttemptListVisibleMs).toBeNull();
    expect(report.sessionListVisibleMs).not.toBeNull();
  });

  it('degrades boot-relative fields gracefully when the event cap evicts boot markers', async () => {
    const store = await loadStore();
    store.markMilestone('auth_resolved');
    store.beginNodeSession(1);
    evictOldestEvents(store);
    const report = store.getHydrationReport();
    expect(report.bootAuthResolvedMs).toBeNull();
    expect(report.bootAgeMs).not.toBeNull();
    expect(report.sessionAgeMs).not.toBeNull();
  });

  it('clearReport preserves the session anchor and session age', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    await waitFor(() => expect(store.getSnapshot().nodeSessionStartAt).not.toBeNull());

    store.clearReport();
    await waitFor(() =>
      expect(store.getSnapshot().events.some((e) => e.phase === 'list_visible')).toBe(false),
    );

    const report = store.getHydrationReport();
    expect(report.sessionAgeMs).not.toBeNull();
    expect(report.sessionListVisibleMs).toBeNull();
    expect(store.getSnapshot().nodeSessionStartAt).not.toBeNull();
  });

  it('populates boot-relative auth, nodes, and shell durations from boot-scoped events', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    t = 100;
    store.markMilestone('auth_resolved');
    t = 250;
    store.markMilestone('nodes_resolved');
    t = 400;
    store.markMilestone('shell_committed');
    const report = store.getHydrationReport();
    expect(report.bootAuthResolvedMs).toBe(100);
    expect(report.bootNodesResolvedMs).toBe(250);
    expect(report.bootShellCommittedMs).toBe(400);
  });

  it('stamps the foreground attempt proxy flag and node id from its own event', async () => {
    const store = await loadStore();
    store.beginNodeSession(7);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a, { proxied: true });
    const report = store.getHydrationReport();
    expect(report.lastAttemptProxied).toBe(true);
    expect(report.lastAttemptNodeId).toBe(7);
  });

  it('exposes every session-correct schema-2 field on the report', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    const report = store.getHydrationReport();
    expect(report.schemaVersion).toBe(2);
    for (const key of [
      'bootAgeMs',
      'bootAuthResolvedMs',
      'bootNodesResolvedMs',
      'bootShellCommittedMs',
      'sessionAgeMs',
      'sessionListVisibleMs',
      'sessionListHydratedMs',
      'lastAttemptId',
      'lastAttemptListVisibleMs',
      'lastAttemptListHydratedMs',
      'lastAttemptHydrationGapMs',
      'lastAttemptProxied',
      'lastAttemptNodeId',
    ]) {
      expect(report).toHaveProperty(key);
    }
  });

  it('reports positive same-attempt visible, hydrated, and gap durations', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    store.beginNodeSession(1);
    t = 100;
    const a = store.newAttemptId();
    t = 250;
    store.commitMilestone('list_visible', a);
    t = 400;
    store.commitMilestone('list_hydrated', a);
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBe(a);
    expect(report.lastAttemptListVisibleMs).toBe(150);
    expect(report.lastAttemptListHydratedMs).toBe(300);
    expect(report.lastAttemptHydrationGapMs).toBe(150);
  });

  it('never borrows another attempt hydration for the foreground attempt', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    store.beginNodeSession(1);
    t = 100;
    const first = store.newAttemptId();
    t = 250;
    store.commitMilestone('list_visible', first);
    t = 400;
    store.commitMilestone('list_hydrated', first);
    t = 500;
    const second = store.newAttemptId();
    t = 600;
    store.commitMilestone('list_visible', second);
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBe(second);
    expect(report.lastAttemptListVisibleMs).toBe(100);
    expect(report.lastAttemptListHydratedMs).toBeNull();
    expect(report.lastAttemptHydrationGapMs).toBeNull();
  });

  it('a failed hydration marked via markMilestone never reads as hydrated', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    // Real failure path (useStackListState): the statuses fetch threw, so
    // list_hydrated is marked uncommitted with an error outcome, never
    // committed as a completed hydration.
    store.markMilestone('list_hydrated', { attemptId: a, outcome: 'error' });
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBe(a);
    expect(report.lastAttemptListVisibleMs).not.toBeNull();
    expect(report.lastAttemptListHydratedMs).toBeNull();
    expect(report.lastAttemptHydrationGapMs).toBeNull();
    expect(report.phases.find((p) => p.phase === 'list_hydrated')?.outcome).toBe('error');
  });

  it('reports session-correct values across a node switch', async () => {
    let t = 0;
    const store = await loadStore(() => stubClock(() => t));
    store.beginNodeSession(1);
    t = 300_000; // first hydration five minutes into the page
    const a = store.newAttemptId();
    t = 300_010;
    store.commitMilestone('list_visible', a);
    t = 600_000; // node switch at ten minutes
    store.beginNodeSession(2);
    const b = store.newAttemptId();
    t = 600_010;
    store.commitMilestone('list_visible', b);
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBe(b);
    expect(report.sessionListVisibleMs).toBe(10);
    expect(report.lastAttemptListVisibleMs).toBe(10);
    expect(report.listVisibleMs).toBe(600_010); // boot-relative compat stays boot age
  });

  it('degrades gracefully when the event cap evicts the foreground list_visible', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    evictOldestEvents(store);
    const report = store.getHydrationReport();
    expect(report.lastAttemptId).toBeNull(); // list_visible evicted; record survives
    expect(report.lastAttemptListVisibleMs).toBeNull();
    expect(report.sessionListVisibleMs).toBeNull();
    expect(report.sessionAgeMs).not.toBeNull();
  });

  it('leaves lastAttemptProxied null for a local attempt', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    const report = store.getHydrationReport();
    expect(report.lastAttemptProxied).toBeNull();
    expect(report.lastAttemptNodeId).toBe(1);
  });

  it('abortAttempt rebuilds the snapshot so an aborted attempt cannot linger as foreground', async () => {
    const store = await loadStore();
    store.beginNodeSession(1);
    const a = store.newAttemptId();
    store.commitMilestone('list_visible', a);
    await waitFor(() => expect(store.getSnapshot().lastAttempt?.attemptId).toBe(a));

    store.abortAttempt(a); // no open spans: only the scheduled emit can clear it
    await waitFor(() => expect(store.getSnapshot().lastAttempt).toBeNull());
    expect(store.getHydrationReport().lastAttemptId).toBeNull();
  });
});
