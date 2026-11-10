/** Most pieces of work that may wait on, or run for, one key. A client sends one save at a time and gives up on one after 30 seconds, so a key near this has work that is not finishing. */
export const MAX_PENDING_PER_KEY = 16;
/** Most pieces of work that may wait on, or run for, all keys together, so many stalled keys cannot add up to an unbounded backlog. */
export const MAX_PENDING_TOTAL = 256;

/** Raised, and the work not run, when admitting it would go over `MAX_PENDING_PER_KEY` or `MAX_PENDING_TOTAL`. */
export class ArrivalQueueFullError extends Error {
  constructor(readonly key: string) {
    super('Too much work is already waiting to run');
    this.name = 'ArrivalQueueFullError';
  }
}

interface Lane {
  /** Settles when the last piece of work admitted to this key has settled, so the next piece knows what to wait for. */
  tail: Promise<void>;
  /** Pieces of work admitted to this key that have not settled yet. */
  pending: number;
}

/** State is process-local, like the process that owns the data being written. */
const lanes = new Map<string, Lane>();
let pendingTotal = 0;

const settled = () => undefined;

/**
 * Runs the work for one key one after another, in the order `inArrivalOrder` was
 * called, however long an earlier one takes. The call must come before the
 * handler's first `await`: a request that yields while it validates can
 * otherwise be overtaken by a later one that validates faster, so the order the
 * requests arrived in stops being the order they are applied in.
 *
 * Work that throws or rejects does not hold up the work behind it, but work that
 * never settles does: the work behind it waits too, until the process restarts.
 * So that a stall does not also grow a backlog, a key admits at most
 * `MAX_PENDING_PER_KEY` pieces of work that have not settled, and all keys at
 * most `MAX_PENDING_TOTAL`. Past either, the returned promise rejects at once with
 * `ArrivalQueueFullError` and the work never runs. Refusing new work leaves what was
 * already admitted in its place, so the order of that work is unchanged.
 */
export function inArrivalOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = lanes.get(key);
  if ((existing?.pending ?? 0) >= MAX_PENDING_PER_KEY || pendingTotal >= MAX_PENDING_TOTAL) {
    return Promise.reject(new ArrivalQueueFullError(key));
  }
  const lane = existing ?? { tail: Promise.resolve(), pending: 0 };
  const turn = lane.tail.then(work);
  const tail = turn.then(settled, settled);
  lane.tail = tail;
  lane.pending += 1;
  pendingTotal += 1;
  lanes.set(key, lane);
  void tail.then(() => {
    pendingTotal -= 1;
    lane.pending -= 1;
    if (lane.pending === 0) lanes.delete(key);
  });
  return turn;
}

/** How many pieces of work admitted to `key` have not settled yet. */
export function pendingCount(key: string): number {
  return lanes.get(key)?.pending ?? 0;
}
