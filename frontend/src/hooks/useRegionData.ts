import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One independently-hydrating page region: its own request, its own loading
 * status, and its last good payload. A page that composes several regions
 * renders each one as soon as that region's data is available, so an expensive
 * or degraded read cannot hold unrelated information behind one page-wide gate.
 */

/** The identity a region's payload belongs to (an active node id, a stack name, ...). */
type RegionScope = string | number | null | undefined;

export type RegionStatus = 'loading' | 'ready' | 'failed';

export interface RegionData<T> {
  /** Last successful payload for the scope on screen; null until the first success. */
  data: T | null;
  /**
   * 'loading' until this scope's first attempt settles, 'ready' after a
   * success, 'failed' when the last attempt failed and there is no payload to
   * show. A failed refresh that already has a payload keeps status 'ready' and
   * the visible data, rather than blanking a region that the operator trusted.
   */
  status: RegionStatus;
  /**
   * Refetch, keeping the visible payload until the new response lands. Resolves
   * once the read it starts settles, so a caller that must not accept another
   * action against the pre-refresh payload can keep its busy state until then.
   */
  refresh: () => Promise<void>;
  /**
   * Adopt a payload another response already fetched for this scope (a scan
   * completing, for example) without starting a request of its own.
   */
  apply: (data: T) => void;
}

export interface RegionOptions {
  /**
   * Called when a read fails, with whether the region already had a payload to
   * keep. A page uses this to report a failed background refresh once, while a
   * first read with no payload is left to the region's own error surface.
   */
  onError?: (error: unknown, hadData: boolean) => void;
}

interface StoredRegion<T> {
  scope: RegionScope;
  status: RegionStatus;
  data: T | null;
}

/**
 * Load `load` for `scope`, re-running whenever the scope or `refreshKey`
 * changes (or `refresh` is called).
 *
 * The returned payload belongs to the scope on screen: a late response for a
 * scope the user has already left is dropped, and a scope change reads as
 * loading until that scope's own response lands, so another node's data can
 * never be presented as the current node's.
 *
 * `load` may throw; the failure is logged here and recorded on the region. The
 * error message should name the endpoint so the log line is actionable.
 */
export function useRegionData<T>(
  scope: RegionScope,
  load: (signal: AbortSignal) => Promise<T>,
  refreshKey: number = 0,
  options: RegionOptions = {},
): RegionData<T> {
  const loadRef = useRef(load);
  const onErrorRef = useRef(options.onError);
  const [stored, setStored] = useState<StoredRegion<T>>({ scope, status: 'loading', data: null });
  const [attempt, setAttempt] = useState(0);
  const generationRef = useRef(0);
  // Whether the scope on screen already has a payload, read at failure time so a
  // failed refresh can be told apart from a first read that never succeeded.
  const hadDataRef = useRef(false);
  // The scope on screen, written during render so a handler that fires between a
  // scope change and the next effect still knows the request it owns has ended.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const controllerRef = useRef<AbortController | null>(null);
  // Callers of `refresh` waiting for the read it starts. A refresh that the
  // scope change or unmount supersedes still settles, because the run resolves
  // its waiters in `finally` even when it is aborted.
  const pendingRefreshRef = useRef<Array<() => void>>([]);

  // Callers pass fresh closures every render; only a scope change, a refresh key
  // change, or an explicit refresh may start a new request.
  useEffect(() => {
    loadRef.current = load;
    onErrorRef.current = options.onError;
  });

  useEffect(() => {
    hadDataRef.current = stored.scope === scope && stored.data !== null;
  }, [stored, scope]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    // Every refresh call that has not been picked up by a run yet is settled by
    // this one, whether it succeeds, fails, or is superseded by a newer scope.
    const waiters = pendingRefreshRef.current;
    pendingRefreshRef.current = [];
    const settleRefreshWaiters = () => {
      for (const resolve of waiters) resolve();
    };
    // A new scope starts empty. A refresh of the scope already on screen keeps
    // its payload until the new response lands.
    setStored((prev) => (
      prev.scope === scope && prev.data !== null
        ? prev
        : { scope, status: 'loading', data: null }
    ));
    void (async () => {
      try {
        const data = await loadRef.current(controller.signal);
        if (generation !== generationRef.current) return;
        setStored({ scope, status: 'ready', data });
      } catch (error) {
        if (generation !== generationRef.current) return;
        console.warn('[RegionData] load failed:', error);
        setStored((prev) => (
          prev.scope === scope && prev.data !== null
            ? prev
            : { scope, status: 'failed', data: null }
        ));
        onErrorRef.current?.(error, hadDataRef.current);
      } finally {
        settleRefreshWaiters();
      }
    })();
    return () => {
      // A response that lands after the scope is replaced or the view unmounts
      // is never written.
      generationRef.current += 1;
      controllerRef.current = null;
      controller.abort();
      // This run is over as far as its caller is concerned: a refresh that the
      // scope change or unmount superseded must not strand a pending action.
      settleRefreshWaiters();
    };
  }, [scope, refreshKey, attempt]);

  // A refresh requested in the same tick as an unmount can be scheduled but
  // never picked up by a run, which would leave its caller awaiting forever.
  // Settle whatever the last run did not.
  useEffect(() => () => {
    const waiters = pendingRefreshRef.current;
    pendingRefreshRef.current = [];
    for (const resolve of waiters) resolve();
  }, []);

  const refresh = useCallback(() => {
    let resolve!: () => void;
    const settled = new Promise<void>((r) => { resolve = r; });
    pendingRefreshRef.current.push(resolve);
    setAttempt((n) => n + 1);
    return settled;
  }, []);
  // A payload another response fetched for this scope is newer than a read that
  // started before it, so adopting it abandons that read: an older response must
  // not overwrite fresher data when it finally lands. A payload for another
  // scope is not ours to adopt, because writing it would blank the scope on
  // screen and no new read would start to fill it.
  const apply = useCallback((data: T) => {
    if (scopeRef.current !== scope) return;
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStored({ scope, status: 'ready', data });
  }, [scope]);

  if (stored.scope !== scope) {
    return { data: null, status: 'loading', refresh, apply };
  }
  return { data: stored.data, status: stored.status, refresh, apply };
}
