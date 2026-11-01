import { LOCAL_FLEET_READ_DEADLINE_MS } from './fleetReadBudget';

/**
 * How long a finished hub build nobody has read yet stays available.
 *
 * A read that reaches its deadline leaves its build running in this process.
 * When that build finishes, the tab's Retry usually arrives next, and keeping
 * the finished answer lets Retry return it instead of paying for the same
 * listing again. Only an answer no reader has received is kept: once a read
 * has returned it, the next read (Refresh, a reload) builds again, so a
 * container started or removed since is not hidden behind an old answer.
 */
export const LOCAL_FLEET_BUILD_SHARE_TTL_MS = 10_000;

/**
 * How long a never-settling build is still joinable. A Docker call that hangs
 * forever must not poison every later read: once a build is older than this, a
 * new reader starts a fresh build instead of joining the old one. The check
 * runs on the next read; there is no background timer.
 */
export const LOCAL_FLEET_BUILD_MAX_AGE_MS =
  LOCAL_FLEET_READ_DEADLINE_MS + LOCAL_FLEET_BUILD_SHARE_TTL_MS;

class SharedBuild<T> {
  public settledAt: number | null = null;
  public readonly promise: Promise<T>;

  public constructor(
    public readonly startedAt: number,
    build: Promise<T>,
  ) {
    this.promise = build.then((value) => {
      this.settledAt = Date.now();
      return value;
    });
  }
}

/** Every store, so tests can clear all hub build shares between isolated cases. */
const stores = new Set<LocalFleetBuildShare<unknown>>();

/**
 * Share one hub-local build between readers of the same key.
 *
 * Hub-local Fleet reads (label inventory, dependency graph, networking
 * summary) do host-sized work that cannot be cancelled. A reader that gives up
 * at its deadline leaves that work running, and the build keeps its result for
 * the next reader: concurrent readers join the running build, and the first
 * reader after it finished takes the answer nobody received. A reader that
 * received the answer drops it from the share.
 */
export class LocalFleetBuildShare<T> {
  private readonly builds = new Map<string, SharedBuild<T>>();

  public constructor() {
    stores.add(this as LocalFleetBuildShare<unknown>);
  }

  /**
   * Read `key` through the share. `bound` applies the caller's own limits
   * (liveness check, deadline) around the thunk it is handed; the thunk joins
   * or starts the build, so a build that a failed liveness check never reached
   * does not start. Each caller gets a fresh deadline around shared work.
   */
  public async read(
    key: string,
    start: () => Promise<T>,
    bound: (work: () => Promise<T>) => Promise<T>,
  ): Promise<T> {
    let joined: SharedBuild<T> | undefined;
    const result = await bound(() => {
      joined = this.join(key, start);
      return joined.promise;
    });
    // Only a reader that got the answer reaches this line: a deadline or a
    // failed build throws above and leaves the build for the next reader.
    if (joined && this.builds.get(key) === joined) this.builds.delete(key);
    return result;
  }

  private join(key: string, start: () => Promise<T>): SharedBuild<T> {
    const now = Date.now();
    const existing = this.builds.get(key);
    if (existing) {
      const stillJoinable = existing.settledAt === null
        ? now - existing.startedAt < LOCAL_FLEET_BUILD_MAX_AGE_MS
        : now - existing.settledAt < LOCAL_FLEET_BUILD_SHARE_TTL_MS;
      if (stillJoinable) return existing;
      this.builds.delete(key);
    }

    const entry = new SharedBuild(now, start());
    entry.promise.catch(() => {
      // A failed build has no result to share; the next reader tries again.
      if (this.builds.get(key) === entry) this.builds.delete(key);
    });
    this.builds.set(key, entry);
    return entry;
  }

  public clear(): void {
    this.builds.clear();
  }
}

/** Drop in-flight and finished builds of every share. Tests call this between isolated cases. */
export function _resetLocalFleetBuildSharesForTests(): void {
  for (const store of stores) store.clear();
}
