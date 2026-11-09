/**
 * Runs the work for one key one after another, in the order `inArrivalOrder` was
 * called, however long an earlier one takes. The call must come before the
 * handler's first `await`: a request that yields while it validates can
 * otherwise be overtaken by a later one that validates faster, so the order the
 * requests arrived in stops being the order they are applied in.
 *
 * Work that throws or rejects does not hold up the work behind it, but work that
 * never settles does: the work behind it waits too, until the process restarts.
 * Bounding the queue instead would let the abandoned work run after the work
 * behind it, which is the reordering this exists to prevent. State is
 * process-local, like the process that owns the data being written.
 */
const chains = new Map<string, Promise<void>>();

export function inArrivalOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
  const turn = (chains.get(key) ?? Promise.resolve()).then(work);
  const tail = turn.then(() => undefined, () => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return turn;
}
