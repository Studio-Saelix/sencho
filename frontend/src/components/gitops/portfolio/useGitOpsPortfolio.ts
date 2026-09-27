/**
 * Data hook for the GitOps portfolio workplace.
 *
 * One bounded request against the hub-owned aggregate endpoint; no per-node
 * fan-out in the browser. Refresh is event-driven off the existing
 * `sencho:state-invalidate` gitops channel (debounced so a transition burst
 * is one fetch), never a poll. A failed refresh keeps the previous data and
 * flags it stale, because a triage surface showing last-known state must say
 * it is last-known.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { GitOpsPortfolioFilters, GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';
import {
  applicationIdFromSearch,
  clearPendingPortfolioScope,
  GITOPS_APPLICATION_EVENT,
  GITOPS_PORTFOLIO_SCOPE_EVENT,
  peekPendingPortfolioScope,
  type GitOpsPortfolioScope,
} from './portfolioNavigation';

const INVALIDATE_DEBOUNCE_MS = 250;
const QUERY_DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;

export interface GitOpsPortfolioState {
  data: GitOpsPortfolioResponse | null;
  /** True until the first successful load. */
  loading: boolean;
  /** True while a refresh request is in flight (initial load excluded). */
  refreshing: boolean;
  /** A failed *initial* load, where no data exists to fall back to. */
  error: string | null;
  /**
   * Epoch ms of the first failed refresh since data was last good. Null while
   * the current response is fresh. A non-null value means: the rows are
   * last-known, not current.
   */
  staleSince: number | null;
  filters: GitOpsPortfolioFilters;
  setFilters: (next: GitOpsPortfolioFilters) => void;
  clearFilters: () => void;
  setQuery: (q: string) => void;
  /** Server-side pagination. `nextPage` is a no-op without a nextCursor. */
  pageLoaded: number;
  nextPage: () => void;
  prevPage: () => void;
  refresh: () => void;
}

/**
 * Query string for one request. Covers exactly the filter fields this hook
 * reads back through `filtersFromSearch`: the two halves of the URL contract
 * must agree, or a link would encode a question it cannot restore.
 */
function buildQueryString(filters: GitOpsPortfolioFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.stack) params.set('stack', filters.stack);
  if (filters.attention === '1') params.set('attention', '1');
  if (filters.mode) params.set('mode', filters.mode);
  if (filters.nodeId !== undefined) params.set('nodeId', String(filters.nodeId));
  if (filters.blueprintId !== undefined) params.set('blueprintId', String(filters.blueprintId));
  if (filters.source) params.set('source', filters.source);
  if (filters.rollout) params.set('rollout', filters.rollout);
  if (filters.health) params.set('health', filters.health);
  if (filters.drift) params.set('drift', filters.drift);
  if (filters.evidence) params.set('evidence', filters.evidence);
  params.set('limit', String(PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Filters read from the current URL, so a triage view is a shareable link. */
export function filtersFromSearch(search: string): GitOpsPortfolioFilters {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const filters: GitOpsPortfolioFilters = {};
  const q = params.get('q');
  if (q) filters.q = q;
  const stack = params.get('stack');
  if (stack) filters.stack = stack;
  if (params.get('attention') === '1') filters.attention = '1';
  const mode = params.get('mode');
  if (mode === 'direct' || mode === 'blueprint') filters.mode = mode;
  const nodeId = Number(params.get('nodeId'));
  if (Number.isSafeInteger(nodeId) && nodeId > 0) filters.nodeId = nodeId;
  const blueprintId = Number(params.get('blueprintId'));
  if (Number.isSafeInteger(blueprintId) && blueprintId > 0) filters.blueprintId = blueprintId;
  const evidence = params.get('evidence');
  if (evidence === 'stale' || evidence === 'unreachable' || evidence === 'unknown') filters.evidence = evidence;
  const source = params.get('source');
  if (source) filters.source = source;
  const rollout = params.get('rollout');
  if (rollout) filters.rollout = rollout;
  const health = params.get('health');
  if (health) filters.health = health;
  const drift = params.get('drift');
  if (drift) filters.drift = drift;
  return filters;
}

/** A scope is a fresh question: it replaces every other filter. */
function filtersForScope(scope: GitOpsPortfolioScope): GitOpsPortfolioFilters {
  if ('blueprintId' in scope) return { blueprintId: scope.blueprintId };
  if ('stack' in scope) return { nodeId: scope.nodeId, stack: scope.stack };
  return { nodeId: scope.nodeId, attention: '1' };
}

/** True when the address bar is on the GitOps view's path. */
function isGitOpsPath(pathname: string): boolean {
  return pathname.split('/').filter(Boolean).at(-1) === 'gitops';
}

/** Bound on waiting for the router to reach the GitOps path after a scoped mount (about 5 s). */
const SCOPED_URL_WRITE_ATTEMPTS = 50;
const SCOPED_URL_WRITE_INTERVAL_MS = 100;

/**
 * Write the filter set into the address bar, but only once the bar shows the
 * portfolio list itself: not while an application view owns it, and not
 * before the router has moved onto the GitOps path (writing then would attach
 * the query to the page being left).
 */
function writeFiltersToUrl(filters: GitOpsPortfolioFilters): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
  const { pathname, search } = window.location;
  if (!isGitOpsPath(pathname)) return;
  if (applicationIdFromSearch(search) !== null) return;
  const qs = buildQueryString(filters, null).replace(/[?&]limit=\d+/, '');
  const next = qs.startsWith('?') ? qs : '';
  if (next === search) return;
  // Keep the existing history state: the router stores its own index marker
  // in it, and wiping it would corrupt its back/forward deltas.
  window.history.replaceState(window.history.state, '', `${pathname}${next}`);
}

export function useGitOpsPortfolio(): GitOpsPortfolioState {
  // Read once, at first render: StrictMode re-runs effects, and the second
  // run must still know this mount came from a scope.
  const [initialScope] = useState(peekPendingPortfolioScope);
  const [filters, setFiltersState] = useState<GitOpsPortfolioFilters>(() => {
    if (typeof window === 'undefined') return {};
    return initialScope ? filtersForScope(initialScope) : filtersFromSearch(window.location.search);
  });
  const [data, setData] = useState<GitOpsPortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  // Cursor stack: index N is the cursor that returns page N+1. Empty = page 1.
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const pageLoaded = cursorStack.length + 1;
  // A stale in-flight answer must never overwrite a newer fetch (the same
  // generation-guard the other GitOps hooks use).
  const generation = useRef(0);
  const cursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1]! : null;
  /** Pending debounce for typed search; cleared by any immediate filter change. */
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest-value refs so fetches and the invalidate handler never close over
  // stale state and never re-register themselves on every render.
  const filtersRef = useRef(filters);
  const cursorRef = useRef(cursor);
  const dataRef = useRef<GitOpsPortfolioResponse | null>(null);
  useEffect(() => {
    filtersRef.current = filters;
    cursorRef.current = cursor;
  }, [filters, cursor]);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const fetchPortfolio = useCallback(async (activeFilters: GitOpsPortfolioFilters, activeCursor: string | null) => {
    const current = ++generation.current;
    // `refreshing` is the "there is already data, a newer answer is coming"
    // state; the first load is `loading`, so the pill never overlays the
    // initial skeleton.
    if (dataRef.current !== null) setRefreshing(true);
    try {
      const res = await apiFetch(`/gitops/applications${buildQueryString(activeFilters, activeCursor)}`, { localOnly: true });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        if (res.status === 400 && activeCursor !== null) {
          // A rejected cursor (server restarted, cursor policy changed) is
          // recovered by returning to page 1 rather than stranding the user on
          // an error they cannot clear.
          if (current === generation.current) setCursorStack([]);
          return;
        }
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json() as GitOpsPortfolioResponse;
      if (current !== generation.current) return;
      setData(body);
      setError(null);
      setStaleSince(null);
    } catch (e) {
      if (current !== generation.current) return;
      const message = e instanceof Error ? e.message : 'Failed to load the GitOps portfolio.';
      if (dataRef.current === null) {
        // No data to show: the failure is the page's content.
        setError(message);
      } else {
        // Keep the last good page, but flag it so nothing reads as current.
        setStaleSince(prev => prev ?? Date.now());
      }
    } finally {
      if (current === generation.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    void fetchPortfolio(filtersRef.current, cursorRef.current);
  }, [fetchPortfolio]);

  /**
   * Apply a filter set: page 1, URL in sync.
   *
   * State and the address bar move together so the visible question and the
   * linkable question cannot drift apart.
   */
  const applyFilters = useCallback((next: GitOpsPortfolioFilters) => {
    setCursorStack([]);
    setFiltersState(next);
    filtersRef.current = next;
    writeFiltersToUrl(next);
  }, []);

  const setFilters = useCallback((next: GitOpsPortfolioFilters) => {
    if (queryTimer.current !== null) {
      window.clearTimeout(queryTimer.current);
      queryTimer.current = null;
    }
    applyFilters(next);
  }, [applyFilters]);

  // Typed search is debounced, because every keystroke would otherwise be one
  // hub aggregation; discrete chip/combobox changes are not.
  const setQuery = useCallback((q: string) => {
    if (queryTimer.current !== null) window.clearTimeout(queryTimer.current);
    queryTimer.current = window.setTimeout(() => {
      queryTimer.current = null;
      const next = { ...filtersRef.current };
      if (q) next.q = q; else delete next.q;
      applyFilters(next);
    }, QUERY_DEBOUNCE_MS);
  }, [applyFilters]);
  useEffect(() => () => {
    if (queryTimer.current !== null) window.clearTimeout(queryTimer.current);
  }, []);

  const clearFilters = useCallback(() => setFilters({}), [setFilters]);

  // Stack-scoped entry points (see openGitOpsWorkplace). A workplace mounted
  // by the navigation took the scope in its state initializer; its URL write
  // waits until the router has moved onto the GitOps path (the view is
  // lazy-loaded, so that can trail the mount), bounded so a navigation that
  // never lands stops trying. A workplace already mounted hears the scope as
  // an event instead.
  useEffect(() => {
    clearPendingPortfolioScope();
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const writeWhenOnPath = () => {
      timer = null;
      if (isGitOpsPath(window.location.pathname)) {
        writeFiltersToUrl(filtersRef.current);
      } else if (++attempts < SCOPED_URL_WRITE_ATTEMPTS) {
        timer = setTimeout(writeWhenOnPath, SCOPED_URL_WRITE_INTERVAL_MS);
      }
    };
    if (initialScope !== null) timer = setTimeout(writeWhenOnPath, 0);

    const onScope = (e: Event) => {
      clearPendingPortfolioScope();
      setFilters(filtersForScope((e as CustomEvent<GitOpsPortfolioScope>).detail));
    };

    // Address changes while mounted. Closing an application view lands on the
    // list, where this hook's filters are the truth (a scope may have arrived
    // while the view was open), so they are written back. Any other Back or
    // Forward onto a list entry is the user choosing that entry's question,
    // so the list adopts it instead of overwriting their history.
    let applicationOpen = applicationIdFromSearch(window.location.search) !== null;
    const onAddressChange = () => {
      const { pathname, search } = window.location;
      const wasOpen = applicationOpen;
      applicationOpen = applicationIdFromSearch(search) !== null;
      if (applicationOpen || !isGitOpsPath(pathname)) return;
      if (wasOpen) {
        writeFiltersToUrl(filtersRef.current);
        return;
      }
      const fromUrl = filtersFromSearch(search);
      if (buildQueryString(fromUrl, null) !== buildQueryString(filtersRef.current, null)) setFilters(fromUrl);
    };
    window.addEventListener(GITOPS_PORTFOLIO_SCOPE_EVENT, onScope);
    window.addEventListener('popstate', onAddressChange);
    window.addEventListener(GITOPS_APPLICATION_EVENT, onAddressChange);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener(GITOPS_PORTFOLIO_SCOPE_EVENT, onScope);
      window.removeEventListener('popstate', onAddressChange);
      window.removeEventListener(GITOPS_APPLICATION_EVENT, onAddressChange);
    };
  }, [initialScope, setFilters]);

  // Initial + on-change fetch. Filters and pagination reset together: a new
  // filter set applies to page 1, never to a cursor from the old question.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPortfolio(filters, cursor);
  }, [fetchPortfolio, filters, cursor]);

  const nextPage = useCallback(() => {
    const next = data?.nextCursor;
    if (!next) return;
    setCursorStack(prev => [...prev, next]);
  }, [data]);

  const prevPage = useCallback(() => {
    setCursorStack(prev => prev.slice(0, -1));
  }, []);

  // State changes arrive as events, not on a clock. Debounce coalesces a
  // transition burst into one fetch; the aggregation itself is server-side.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onInvalidate = (e: Event) => {
      const detail = (e as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope !== 'gitops') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fetchPortfolio(filtersRef.current, cursorRef.current);
      }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (timer) clearTimeout(timer);
    };
  }, [fetchPortfolio]);

  return useMemo(() => ({
    data,
    loading,
    refreshing,
    error,
    staleSince,
    filters,
    setFilters,
    clearFilters,
    setQuery,
    pageLoaded,
    nextPage,
    prevPage,
    refresh,
  }), [data, loading, refreshing, error, staleSince, filters, setFilters, clearFilters, setQuery, pageLoaded, nextPage, prevPage, refresh]);
}
