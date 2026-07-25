/**
 * CacheService: a single in-process cache for the entire backend.
 *
 * Design goals (see plans/caching-strategy-audit.md for full context):
 *   - TTL-based entries. Entries expire after a configured ms window.
 *   - Inflight deduplication: concurrent getOrFetch() calls for the same key
 *     share one in-flight Promise, preventing thundering-herd on cache miss.
 *   - Stale-on-error fallback: if fetcher() rejects while a stale value
 *     exists, return the stale value (and count it as a "stale" hit).
 *   - Namespaced stats: per-namespace hit / miss / stale counters for
 *     observability, surfaced via /api/system/cache-stats.
 *   - Key conventions: use "namespace:subkey" for per-entity caches
 *     (e.g. "stats:1" for nodeId=1). Stats are aggregated by namespace.
 *   - Safety cap: a hard limit on total entries as a defense-in-depth
 *     guard against unbounded growth. Default 1000 entries; each cache
 *     used in Sencho is bounded by construction (singleton or per-nodeId).
 *
 * Non-goals:
 *   - LRU eviction. All current callers have bounded keyspaces.
 *   - Persistence. Caches are rebuilt on process restart.
 *   - Cross-process sync. Sencho runs single-process per instance.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Observational outcome of a single getOrFetchWithMeta call. Truthful under
 * concurrency: an `inflight` join is never reported as a `hit`.
 *
 *   - hit:      fresh entry returned without waiting
 *   - computed: this caller ran the fetcher and it succeeded
 *   - inflight: joined an existing in-flight promise (this caller did not run
 *               the fetcher)
 *   - stale:    the fetcher this caller ran failed and a stale entry was
 *               returned instead
 */
export type CacheFetchOutcome = 'hit' | 'computed' | 'inflight' | 'stale';

export interface CacheFetchResult<T> {
  value: T;
  outcome: CacheFetchOutcome;
}

interface NamespaceStats {
  hits: number;
  misses: number;
  stale: number;
  size: number;
}

const MAX_ENTRIES = 1000;

/** Extract the namespace (part before first colon) from a key. */
function namespaceOf(key: string): string {
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(0, idx);
}

export class CacheService {
  private static instance: CacheService;

  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Per-key write generation. Bumped on invalidate so an older in-flight
   *  fetcher cannot commit after the key was intentionally cleared. */
  private readonly generations = new Map<string, number>();
  private readonly stats = new Map<string, NamespaceStats>();

  public static getInstance(): CacheService {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }

  /**
   * Retrieve a cached value or compute it via `fetcher`. Concurrent callers
   * for the same key await the same in-flight promise.
   *
   * On fetcher rejection: if a stale entry exists, return it (counted as
   * `stale`); otherwise propagate the error.
   *
   * Thin wrapper over getOrFetchWithMeta that discards the outcome; all
   * stats / TTL / inflight-dedup / stale-on-error semantics are identical.
   */
  public async getOrFetch<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const { value } = await this.getOrFetchWithMeta(key, ttlMs, fetcher);
    return value;
  }

  /**
   * Same behaviour as getOrFetch, but also reports how the value was obtained
   * (see CacheFetchOutcome). Intended for diagnostic logging that must not
   * mislabel an in-flight join as a cache hit. The stats counters, TTL, cap,
   * and stale-on-error fallback are recorded exactly as getOrFetch does: one
   * miss per in-flight join, one stale per failed computation.
   */
  public async getOrFetchWithMeta<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<CacheFetchResult<T>> {
    const ns = namespaceOf(key);
    const now = Date.now();
    const existing = this.store.get(key) as CacheEntry<T> | undefined;

    if (existing && existing.expiresAt > now) {
      this.recordHit(ns);
      return { value: existing.value, outcome: 'hit' };
    }

    this.recordMiss(ns);

    const inflight = this.inflight.get(key) as Promise<T> | undefined;
    if (inflight) {
      const value = await inflight;
      return { value, outcome: 'inflight' };
    }

    // Capture generation before the fetch so invalidate() during the wait can
    // supersede this writer's store commit (and drop the inflight slot so a
    // later caller starts a fresh computation).
    const generation = this.currentGeneration(key);

    // This caller owns the computation; the closure records whether it ended
    // as a fresh compute or a stale fallback, read after the promise settles.
    let outcome: CacheFetchOutcome = 'computed';
    const inflightSelf: { promise: Promise<T> | null } = { promise: null };
    const promise = (async () => {
      try {
        const value = await fetcher();
        if (this.currentGeneration(key) === generation) {
          this.set(key, value, ttlMs);
        }
        return value;
      } catch (err) {
        if (existing) {
          this.recordStale(ns);
          outcome = 'stale';
          return existing.value;
        }
        throw err;
      } finally {
        // Only clear the inflight slot if we still own it. invalidate() may
        // have already deleted this entry and allowed a newer owner.
        if (this.inflight.get(key) === inflightSelf.promise) {
          this.inflight.delete(key);
        }
      }
    })();
    inflightSelf.promise = promise;

    this.inflight.set(key, promise);
    const value = await promise;
    return { value, outcome };
  }

  /**
   * Synchronous get: returns undefined if the key is absent or expired.
   * Updates hit/miss counters.
   */
  public get<T>(key: string): T | undefined {
    const ns = namespaceOf(key);
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry || entry.expiresAt <= Date.now()) {
      this.recordMiss(ns);
      return undefined;
    }
    this.recordHit(ns);
    return entry.value;
  }

  /**
   * Set a value with a TTL. If the total number of entries exceeds
   * MAX_ENTRIES, the oldest expired entries are purged first; if still
   * over cap, the insertion is rejected with a warning (defense in depth).
   */
  public set<T>(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= MAX_ENTRIES && !this.store.has(key)) {
      this.purgeExpired();
      if (this.store.size >= MAX_ENTRIES) {
        console.warn(`[CacheService] Entry cap reached (${MAX_ENTRIES}); refusing to cache "${key}"`);
        return;
      }
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Invalidate a single key and supersede any in-flight writer for it. */
  public invalidate(key: string): void {
    this.store.delete(key);
    this.inflight.delete(key);
    this.bumpGeneration(key);
  }

  /** Invalidate every key whose namespace matches `namespace`. */
  public invalidateNamespace(namespace: string): void {
    const prefix = `${namespace}:`;
    const keys = new Set([...this.store.keys(), ...this.inflight.keys(), ...this.generations.keys()]);
    for (const key of keys) {
      if (key === namespace || key.startsWith(prefix)) {
        this.store.delete(key);
        this.inflight.delete(key);
        this.bumpGeneration(key);
      }
    }
  }

  /** Reset all state. Intended for tests and admin "flush" actions. */
  public flush(): void {
    this.store.clear();
    this.inflight.clear();
    this.generations.clear();
    this.stats.clear();
  }

  /**
   * Per-namespace statistics snapshot. Size counts live (non-expired) entries
   * currently in the store for each namespace at call time.
   */
  public getStats(): Record<string, NamespaceStats> {
    // Recompute live sizes at snapshot time; counters are kept incrementally.
    const sizes = new Map<string, number>();
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) continue;
      const ns = namespaceOf(key);
      sizes.set(ns, (sizes.get(ns) ?? 0) + 1);
    }

    const result: Record<string, NamespaceStats> = {};
    const allNs = new Set<string>([...this.stats.keys(), ...sizes.keys()]);
    for (const ns of allNs) {
      const base = this.stats.get(ns) ?? { hits: 0, misses: 0, stale: 0, size: 0 };
      result[ns] = {
        hits: base.hits,
        misses: base.misses,
        stale: base.stale,
        size: sizes.get(ns) ?? 0,
      };
    }
    return result;
  }

  // ─── internals ────────────────────────────────────────────────────────

  private recordHit(namespace: string): void {
    const s = this.getOrCreateNs(namespace);
    s.hits += 1;
  }

  private recordMiss(namespace: string): void {
    const s = this.getOrCreateNs(namespace);
    s.misses += 1;
  }

  private recordStale(namespace: string): void {
    const s = this.getOrCreateNs(namespace);
    s.stale += 1;
  }

  private getOrCreateNs(namespace: string): NamespaceStats {
    let s = this.stats.get(namespace);
    if (!s) {
      s = { hits: 0, misses: 0, stale: 0, size: 0 };
      this.stats.set(namespace, s);
    }
    return s;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  private currentGeneration(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private bumpGeneration(key: string): number {
    const next = this.currentGeneration(key) + 1;
    this.generations.set(key, next);
    return next;
  }
}
