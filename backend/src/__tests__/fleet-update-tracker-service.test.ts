import { describe, it, expect, beforeEach } from 'vitest';
import {
  FleetUpdateTrackerService,
  UPDATE_TIMEOUT_MS,
  TERMINAL_TTL_MS,
  type UpdateTracker,
} from '../services/FleetUpdateTrackerService';

/** Build a tracker literal with sane defaults so tests set only what matters. */
function mk(over: Partial<UpdateTracker>): UpdateTracker {
  return {
    status: 'updating',
    startedAt: Date.now(),
    previousVersion: null,
    previousProcessStart: null,
    wasOffline: false,
    ...over,
  };
}

// The service is a process-local singleton. Each test clears any entries left
// by a prior test so assertions on size() are deterministic.
function clearAll(svc: FleetUpdateTrackerService) {
  for (const [nodeId] of [...svc.entries()]) svc.delete(nodeId);
}

describe('FleetUpdateTrackerService', () => {
  let svc: FleetUpdateTrackerService;

  beforeEach(() => {
    svc = FleetUpdateTrackerService.getInstance();
    clearAll(svc);
  });

  it('returns the same singleton instance', () => {
    expect(FleetUpdateTrackerService.getInstance()).toBe(svc);
  });

  it('create() starts an updating tracker with startedAt and no resolvedAt', () => {
    const before = Date.now();
    const tracker = svc.create('updating', '1.0.0', 1234);
    expect(tracker.status).toBe('updating');
    expect(tracker.previousVersion).toBe('1.0.0');
    expect(tracker.previousProcessStart).toBe(1234);
    expect(tracker.wasOffline).toBe(false);
    expect(tracker.startedAt).toBeGreaterThanOrEqual(before);
    expect(tracker.resolvedAt).toBeUndefined();
  });

  it('create() with a terminal status sets resolvedAt immediately', () => {
    const tracker = svc.create('failed', '1.0.0', null, 'pull failed');
    expect(tracker.status).toBe('failed');
    expect(tracker.error).toBe('pull failed');
    expect(tracker.resolvedAt).toBeTypeOf('number');
  });

  it('set()/get() round-trips a tracker by node id', () => {
    const tracker = svc.create('updating', '1.0.0', null);
    svc.set(7, tracker);
    expect(svc.get(7)).toEqual(tracker);
    expect(svc.get(999)).toBeUndefined();
  });

  it('resolve() returns a terminal copy without mutating the original', () => {
    const original = svc.create('updating', '1.0.0', null);
    const resolved = svc.resolve(original, 'completed');
    expect(resolved).not.toBe(original);
    expect(original.status).toBe('updating');
    expect(original.resolvedAt).toBeUndefined();
    expect(resolved.status).toBe('completed');
    expect(resolved.resolvedAt).toBeTypeOf('number');
    // Carries forward the immutable fields.
    expect(resolved.startedAt).toBe(original.startedAt);
    expect(resolved.previousVersion).toBe(original.previousVersion);
  });

  it('resolve() to timeout/failed carries the error message', () => {
    const original = svc.create('updating', '1.0.0', null);
    const timedOut = svc.resolve(original, 'timeout', 'did not come back');
    expect(timedOut.status).toBe('timeout');
    expect(timedOut.error).toBe('did not come back');
  });

  it('delete() removes a tracker and reports whether one existed', () => {
    svc.set(3, svc.create('completed', '1.0.0', null));
    expect(svc.size()).toBe(1);
    expect(svc.delete(3)).toBe(true);
    expect(svc.delete(3)).toBe(false);
    expect(svc.get(3)).toBeUndefined();
    expect(svc.size()).toBe(0);
  });

  it('entries() iterates every stored tracker keyed by node id', () => {
    svc.set(1, svc.create('updating', '1.0.0', null));
    svc.set(2, svc.create('completed', '1.0.0', null));
    const ids = [...svc.entries()].map(([id]) => id).sort();
    expect(ids).toEqual([1, 2]);
    expect(svc.size()).toBe(2);
  });

  it('models the full updating -> completed transition the way the poll loop uses it', () => {
    // create updating, store, then resolve and store the terminal copy.
    const updating = svc.create('updating', '1.0.0', 100);
    svc.set(5, updating);
    expect(svc.get(5)?.status).toBe('updating');

    const completed = svc.resolve(svc.get(5)!, 'completed');
    svc.set(5, completed);
    expect(svc.get(5)?.status).toBe('completed');
    expect(svc.get(5)?.resolvedAt).toBeTypeOf('number');
  });

  describe('sweepStale()', () => {
    it('times out an updating tracker past the ceiling and leaves a fresh one alone', () => {
      svc.set(1, mk({ status: 'updating', startedAt: Date.now() - (UPDATE_TIMEOUT_MS + 1_000) }));
      svc.set(2, mk({ status: 'updating', startedAt: Date.now() }));

      const result = svc.sweepStale();

      expect(result.timedOut).toBe(1);
      expect(svc.get(1)?.status).toBe('timeout');
      expect(svc.get(2)?.status).toBe('updating');
    });

    it('reaps a completed tracker past its TTL but keeps a recent one', () => {
      svc.set(1, mk({ status: 'completed', resolvedAt: Date.now() - (TERMINAL_TTL_MS + 1_000) }));
      svc.set(2, mk({ status: 'completed', resolvedAt: Date.now() }));

      const result = svc.sweepStale();

      expect(result.reaped).toBe(1);
      expect(svc.get(1)).toBeUndefined();
      expect(svc.get(2)?.status).toBe('completed');
    });

    it('never sweeps failed or timeout trackers (the operator must dismiss them)', () => {
      const old = Date.now() - (TERMINAL_TTL_MS + 60_000);
      svc.set(1, mk({ status: 'failed', resolvedAt: old }));
      svc.set(2, mk({ status: 'timeout', resolvedAt: old }));

      const result = svc.sweepStale();

      expect(result).toEqual({ timedOut: 0, reaped: 0 });
      expect(svc.get(1)?.status).toBe('failed');
      expect(svc.get(2)?.status).toBe('timeout');
    });

    it('does not reap a completed tracker that has no resolvedAt', () => {
      svc.set(1, mk({ status: 'completed', resolvedAt: undefined }));

      expect(svc.sweepStale().reaped).toBe(0);
      expect(svc.get(1)?.status).toBe('completed');
    });
  });
});
