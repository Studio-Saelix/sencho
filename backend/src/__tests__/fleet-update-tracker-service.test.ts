import { describe, it, expect, beforeEach } from 'vitest';
import { FleetUpdateTrackerService } from '../services/FleetUpdateTrackerService';

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
});
