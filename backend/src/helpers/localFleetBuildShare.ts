import { LOCAL_FLEET_READ_DEADLINE_MS } from './fleetReadBudget';

/**
 * How long a finished hub build nobody has read yet stays available.
 *
 * A read that reaches its deadline leaves its build running in this process.
 * When that build finishes, the tab's Retry usually arrives next, and keeping
 * the finished answer lets Retry return it instead of paying for the same
 * listing again. Only an answer no reader has received is kept: once a read
 * has returned it, the next read builds again, so a container started or
 * removed since is not hidden behind an old answer. The exception is the first
 * read after one that gave up: the server cannot tell a Retry from a Refresh,
 * so either takes the kept answer, which reflects the hub as of when its build
 * started, not when it finished.
 */
export const LOCAL_FLEET_BUILD_SHARE_TTL_MS = 10_000;

/**
 * How long a never-settling build is still joinable. A Docker call that hangs
 * forever must not poison every later read: once a build is older than this, a
 * new reader starts a fresh build instead of joining the old one.
 */
export const LOCAL_FLEET_BUILD_MAX_AGE_MS =
  LOCAL_FLEET_READ_DEADLINE_MS + LOCAL_FLEET_BUILD_SHARE_TTL_MS;

class SharedBuild<T> {
  public settledAt: number | null = null;
  public readonly promise: Promise<T>;
  private expiry: NodeJS.Timeout | undefined;

  /**
   * `onExpire` runs when nobody has taken the entry in time: at the maximum
   * age for a build that never settles, at the share window once it has. The
   * timer is unref'd and only drops the entry, so an unread answer (including
   * revealed label values) does not stay in memory until the next read.
   */
  public constructor(
    public readonly startedAt: number,
    build: Promise<T>,
    private readonly onExpire: () => void,
  ) {
    this.arm(LOCAL_FLEET_BUILD_MAX_AGE_MS);
    this.promise = build.then((value) => {
      this.settledAt = Date.now();
      this.arm(LOCAL_FLEET_BUILD_SHARE_TTL_MS);
      return value;
    });
  }

  public cancelExpiry(): void {
    clearTimeout(this.expiry);
  }

  private arm(afterMs: number): void {
    clearTimeout(this.expiry);
    this.expiry = setTimeout(this.onExpire, afterMs);
    this.expiry.unref();
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
    // Only a reader that got the answer reaches this line. A deadline throws
    // above and leaves the build running for the next reader; a failed build
    // was already dropped by `join`.
    if (joined) this.drop(key, joined);
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
      this.drop(key, existing);
    }

    const entry: SharedBuild<T> = new SharedBuild(now, start(), () => this.drop(key, entry));
    // A failed build has no result to share; the next reader tries again.
    entry.promise.catch(() => this.drop(key, entry));
    this.builds.set(key, entry);
    return entry;
  }

  /** Remove `entry` unless a newer build has already replaced it under `key`. */
  private drop(key: string, entry: SharedBuild<T>): void {
    entry.cancelExpiry();
    if (this.builds.get(key) === entry) this.builds.delete(key);
  }

  public clear(): void {
    for (const entry of this.builds.values()) entry.cancelExpiry();
    this.builds.clear();
  }
}

/** Drop in-flight and finished builds of every share. Tests call this between isolated cases. */
export function _resetLocalFleetBuildSharesForTests(): void {
  for (const store of stores) store.clear();
}
