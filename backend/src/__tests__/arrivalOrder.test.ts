import { describe, it, expect } from 'vitest';
import { inArrivalOrder } from '../helpers/arrivalOrder';

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
});
