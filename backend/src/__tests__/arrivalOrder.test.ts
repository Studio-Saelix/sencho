import { describe, it, expect, vi } from 'vitest';
import { inArrivalOrder, pendingCount, ArrivalQueueFullError, MAX_PENDING_PER_KEY } from '../helpers/arrivalOrder';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('inArrivalOrder', () => {
  it('runs work for one key in the order it was asked for, however long an earlier one takes', async () => {
    const slow = deferred();
    const ran: string[] = [];
    const first = inArrivalOrder('k', async () => { await slow.promise; ran.push('first'); });
    const second = inArrivalOrder('k', async () => { ran.push('second'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toEqual([]);
    slow.resolve();
    await Promise.all([first, second]);
    expect(ran).toEqual(['first', 'second']);
  });

  it('does not make another key wait', async () => {
    const slow = deferred();
    const held = inArrivalOrder('a', () => slow.promise);
    await expect(inArrivalOrder('b', async () => 'done')).resolves.toBe('done');
    slow.resolve();
    await held;
  });

  it('runs the next work after one that threw, and still reports the throw to its own caller', async () => {
    const failed = inArrivalOrder('k', async () => { throw new Error('boom'); });
    const next = inArrivalOrder('k', async () => 'ran');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
  });

  it('keeps a third piece of work behind a second one that is still running after the first finished', async () => {
    const second = deferred();
    const ran: string[] = [];
    const first = inArrivalOrder('k', async () => { ran.push('first'); });
    const secondDone = inArrivalOrder('k', async () => { ran.push('second'); await second.promise; });
    await first;
    await new Promise((r) => setTimeout(r, 20));
    const third = inArrivalOrder('k', async () => { ran.push('third'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toEqual(['first', 'second']);
    second.resolve();
    await Promise.all([secondDone, third]);
    expect(ran).toEqual(['first', 'second', 'third']);
  });

  it('keeps the same stack name on another node independent, as the route keys it', async () => {
    const slow = deferred();
    const held = inArrivalOrder('1\0web', () => slow.promise);
    await expect(inArrivalOrder('2\0web', async () => 'done')).resolves.toBe('done');
    slow.resolve();
    await held;
  });

  it('holds later work behind work that never settles, so later work cannot run ahead of it', async () => {
    const ran: string[] = [];
    void inArrivalOrder('wedged', () => new Promise<void>(() => {}));
    const later = inArrivalOrder('wedged', async () => { ran.push('later'); });
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toEqual([]);
    void later;
  });

  describe('when work is not finishing', () => {
    /** Holds one piece of work on `key`, then admits work up to its limit behind it; records what ran, in order, into `ran` and returns everything admitted. */
    function fillKey(key: string, hold: ReturnType<typeof deferred>, ran: string[]) {
      const admitted = [inArrivalOrder(key, async () => { await hold.promise; ran.push(`${key}#0`); })];
      for (let i = 1; i < MAX_PENDING_PER_KEY; i += 1) {
        admitted.push(inArrivalOrder(key, async () => { ran.push(`${key}#${i}`); }));
      }
      return admitted;
    }

    it('refuses work at once once a key is full, and never runs it', async () => {
      const hold = deferred();
      const ran: string[] = [];
      const admitted = fillKey('k', hold, ran);
      let refusedRan = false;
      const refused = inArrivalOrder('k', async () => { refusedRan = true; });
      await expect(refused).rejects.toBeInstanceOf(ArrivalQueueFullError);
      await expect(refused).rejects.toMatchObject({ key: 'k' });
      hold.resolve();
      await Promise.all(admitted);
      expect(refusedRan).toBe(false);
      expect(ran).toEqual(Array.from({ length: MAX_PENDING_PER_KEY }, (_, i) => `k#${i}`));
    });

    it('counts the work admitted to a key that has not settled, and not the work it refused', async () => {
      const hold = deferred();
      const admitted = fillKey('counted', hold, []);
      await expect(inArrivalOrder('counted', async () => undefined)).rejects.toBeInstanceOf(ArrivalQueueFullError);
      expect(pendingCount('counted')).toBe(MAX_PENDING_PER_KEY);
      hold.resolve();
      await Promise.all(admitted);
      expect(pendingCount('counted')).toBe(0);
    });

    it('keeps admitted work in its order while it refuses more, then admits again once it has finished', async () => {
      const hold = deferred();
      const ran: string[] = [];
      const admitted = fillKey('k', hold, ran);
      for (let i = 0; i < 5; i += 1) {
        await expect(inArrivalOrder('k', async () => { ran.push('refused'); })).rejects.toBeInstanceOf(ArrivalQueueFullError);
      }
      hold.resolve();
      await Promise.all(admitted);
      await expect(inArrivalOrder('k', async () => 'again')).resolves.toBe('again');
      expect(ran).not.toContain('refused');
    });

    it('frees a place when admitted work throws, so the key is not full for good', async () => {
      const hold = deferred();
      const first = inArrivalOrder('k', async () => { await hold.promise; throw new Error('boom'); });
      const rest = Array.from({ length: MAX_PENDING_PER_KEY - 1 }, () => inArrivalOrder('k', async () => undefined));
      await expect(inArrivalOrder('k', async () => undefined)).rejects.toBeInstanceOf(ArrivalQueueFullError);
      hold.resolve();
      await expect(first).rejects.toThrow('boom');
      await Promise.all(rest);
      await expect(inArrivalOrder('k', async () => 'again')).resolves.toBe('again');
    });

    it('does not count refused work against the key, so one refusal does not make the next one worse', async () => {
      const hold = deferred();
      const admitted = fillKey('k', hold, []);
      await expect(inArrivalOrder('k', async () => undefined)).rejects.toBeInstanceOf(ArrivalQueueFullError);
      hold.resolve();
      await Promise.all(admitted);
      const again = Array.from({ length: MAX_PENDING_PER_KEY }, () => inArrivalOrder('k', async () => undefined));
      await expect(Promise.all(again)).resolves.toHaveLength(MAX_PENDING_PER_KEY);
    });

    it('leaves another key, and the same stack name on another node, free while one key is full', async () => {
      const hold = deferred();
      const admitted = fillKey('1\0web', hold, []);
      await expect(inArrivalOrder('1\0web', async () => undefined)).rejects.toBeInstanceOf(ArrivalQueueFullError);
      await expect(inArrivalOrder('2\0web', async () => 'done')).resolves.toBe('done');
      await expect(inArrivalOrder('1\0api', async () => 'done')).resolves.toBe('done');
      hold.resolve();
      await Promise.all(admitted);
    });

    it('refuses work for any key once all keys together are full, and admits again when some finish', async () => {
      // The earlier test of a wedged key leaves work pending for good, so count from a module of its own.
      vi.resetModules();
      const fresh = await import('../helpers/arrivalOrder');
      const hold = deferred();
      const held: Promise<void>[] = [];
      for (let i = 0; i < fresh.MAX_PENDING_TOTAL; i += 1) held.push(fresh.inArrivalOrder(`stalled-${i}`, () => hold.promise));
      await expect(fresh.inArrivalOrder('fresh', async () => 'x')).rejects.toBeInstanceOf(fresh.ArrivalQueueFullError);
      hold.resolve();
      await Promise.all(held);
      await expect(fresh.inArrivalOrder('fresh', async () => 'x')).resolves.toBe('x');
    });
  });
});
