/**
 * Unit tests for StackOpLockService.
 *
 * The service is the in-memory mutex behind the 409 fast-fail for concurrent
 * stack lifecycle operations. Each test resets the singleton via
 * `resetForTests()` so state doesn't leak between cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StackOpLockService, stackOpSkipMessage } from '../services/StackOpLockService';

beforeEach(() => {
  StackOpLockService.resetForTests();
});

describe('StackOpLockService', () => {
  it('returns a singleton instance', () => {
    const a = StackOpLockService.getInstance();
    const b = StackOpLockService.getInstance();
    expect(a).toBe(b);
  });

  it('acquires a lock when the slot is empty', () => {
    const svc = StackOpLockService.getInstance();
    const result = svc.tryAcquire(1, 'web', 'deploy', 'admin');
    expect(result.acquired).toBe(true);
    expect(svc.size()).toBe(1);
  });

  it('returns acquired=false with the existing lock when already held', () => {
    const svc = StackOpLockService.getInstance();
    svc.tryAcquire(1, 'web', 'deploy', 'admin');
    const result = svc.tryAcquire(1, 'web', 'restart', 'bob');
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.existing.action).toBe('deploy');
      expect(result.existing.user).toBe('admin');
      expect(typeof result.existing.startedAt).toBe('number');
    }
  });

  it('different stacks on the same node lock independently', () => {
    const svc = StackOpLockService.getInstance();
    expect(svc.tryAcquire(1, 'web', 'deploy', 'admin').acquired).toBe(true);
    expect(svc.tryAcquire(1, 'api', 'deploy', 'admin').acquired).toBe(true);
    expect(svc.size()).toBe(2);
  });

  it('same stack name on different nodes locks independently', () => {
    const svc = StackOpLockService.getInstance();
    expect(svc.tryAcquire(1, 'web', 'deploy', 'admin').acquired).toBe(true);
    expect(svc.tryAcquire(2, 'web', 'deploy', 'admin').acquired).toBe(true);
    expect(svc.size()).toBe(2);
  });

  it('release frees the slot so the next caller acquires', () => {
    const svc = StackOpLockService.getInstance();
    svc.tryAcquire(1, 'web', 'deploy', 'admin');
    svc.release(1, 'web');
    expect(svc.size()).toBe(0);
    expect(svc.tryAcquire(1, 'web', 'restart', 'bob').acquired).toBe(true);
  });

  it('release on an unheld key is a no-op', () => {
    const svc = StackOpLockService.getInstance();
    expect(() => svc.release(1, 'nope')).not.toThrow();
    expect(svc.size()).toBe(0);
  });

  it('get returns the lock contents or undefined', () => {
    const svc = StackOpLockService.getInstance();
    expect(svc.get(1, 'web')).toBeUndefined();
    svc.tryAcquire(1, 'web', 'update', 'eve');
    const lock = svc.get(1, 'web');
    expect(lock?.action).toBe('update');
    expect(lock?.user).toBe('eve');
  });

  it('resetForTests clears all state and returns a fresh instance', () => {
    const before = StackOpLockService.getInstance();
    before.tryAcquire(1, 'web', 'deploy', 'admin');
    StackOpLockService.resetForTests();
    const after = StackOpLockService.getInstance();
    expect(after).not.toBe(before);
    expect(after.size()).toBe(0);
  });

  it('records the lock startedAt as a recent timestamp', () => {
    const svc = StackOpLockService.getInstance();
    const t0 = Date.now();
    svc.tryAcquire(1, 'web', 'deploy', 'admin');
    const lock = svc.get(1, 'web');
    expect(lock).toBeDefined();
    expect(lock!.startedAt).toBeGreaterThanOrEqual(t0);
    expect(lock!.startedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('StackOpLockService.runExclusive', () => {
  it('runs fn and releases the lock when the slot is free', async () => {
    const svc = StackOpLockService.getInstance();
    const outcome = await svc.runExclusive(1, 'web', 'deploy', 'system', async () => 'done');
    expect(outcome).toEqual({ ran: true, result: 'done' });
    // Released after fn resolves, so a later op acquires.
    expect(svc.size()).toBe(0);
  });

  it('holds the lock for the duration of fn, blocking a concurrent acquire', async () => {
    const svc = StackOpLockService.getInstance();
    let observed: ReturnType<typeof svc.tryAcquire> | null = null;
    const outcome = await svc.runExclusive(1, 'web', 'update', 'system', async () => {
      // A manual op attempting to acquire mid-operation must be rejected.
      observed = svc.tryAcquire(1, 'web', 'deploy', 'admin');
      return 42;
    });
    expect(outcome).toEqual({ ran: true, result: 42 });
    expect(observed!.acquired).toBe(false);
  });

  it('skips (ran=false) and returns the holder when the lock is already held', async () => {
    const svc = StackOpLockService.getInstance();
    svc.tryAcquire(1, 'web', 'rollback', 'admin');
    let called = false;
    const outcome = await svc.runExclusive(1, 'web', 'deploy', 'system', async () => {
      called = true;
      return 'should not run';
    });
    expect(called).toBe(false);
    expect(outcome.ran).toBe(false);
    if (!outcome.ran) expect(outcome.existing.action).toBe('rollback');
  });

  it('releases the lock even when fn throws, then propagates', async () => {
    const svc = StackOpLockService.getInstance();
    await expect(
      svc.runExclusive(1, 'web', 'deploy', 'system', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(svc.size()).toBe(0);
  });
});

describe('stackOpSkipMessage', () => {
  it('names the stack and the conflicting action', () => {
    expect(stackOpSkipMessage('web', 'update')).toBe(
      'Skipped "web": another operation (update) is already in progress.',
    );
  });
});
