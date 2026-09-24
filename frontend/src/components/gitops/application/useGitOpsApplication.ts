/**
 * Data hook for one GitOps application view.
 *
 * Reads the hub-owned detail endpoint with the same conventions as the
 * portfolio hook: `localOnly`, event-driven refresh off the gitops
 * `sencho:state-invalidate` channel (debounced), a generation guard so a slow
 * answer never overwrites a newer one, and a failed refresh that keeps the
 * last good state flagged stale rather than blanking it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { GitOpsPortfolioDetailResponse } from '@/types/gitopsPortfolio';

const INVALIDATE_DEBOUNCE_MS = 250;

/**
 * Why there is no application to show.
 *
 * `not_readable` covers "does not exist" and "not yours to read" (a Direct
 * read answers 404 for both, precisely so the two cannot be told apart) and a
 * Blueprint read without fleet read access (403). `invalid_link` is an id that
 * is not a portfolio id at all (400). `unreachable` is the owning node failing to answer, and
 * `unsupported` is the owning node answering that it cannot serve this read;
 * neither says anything about the application itself.
 */
export type GitOpsApplicationError =
  | { kind: 'not_readable' }
  | { kind: 'invalid_link' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'failed'; message: string };

/**
 * The hook keeps three rules the flat shape (shared with the portfolio hook)
 * does not encode: `data` and `error` are never both set, `staleSince` is only
 * set while `data` is, and `loading` is true only while there is no answer to
 * show (the first load, or a retry after a failed one).
 */
export interface GitOpsApplicationState {
  data: GitOpsPortfolioDetailResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: GitOpsApplicationError | null;
  /** Epoch ms of the first failed refresh since the data was last good; null while fresh. */
  staleSince: number | null;
  refresh: () => void;
}

class ApplicationReadError extends Error {
  readonly failure: GitOpsApplicationError;
  constructor(failure: GitOpsApplicationError) {
    super('message' in failure ? failure.message : failure.kind);
    this.failure = failure;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Enough of the shape to render without crashing; anything else is an answer this build cannot read. */
function isDetailResponse(body: unknown): body is GitOpsPortfolioDetailResponse {
  return isRecord(body) && body.schemaVersion === 1 && isRecord(body.application) && isRecord(body.projection);
}

async function readApplication(id: string): Promise<GitOpsPortfolioDetailResponse> {
  const res = await apiFetch(`/gitops/applications/${encodeURIComponent(id)}`, { localOnly: true });
  if (res.ok) {
    const body: unknown = await res.json().catch(() => null);
    if (!isDetailResponse(body)) {
      throw new ApplicationReadError({ kind: 'failed', message: 'The server returned an answer this version of Sencho cannot read.' });
    }
    return body;
  }
  const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
  const message = body?.error ?? `HTTP ${res.status}`;
  if (res.status === 400) throw new ApplicationReadError({ kind: 'invalid_link' });
  if (res.status === 404 || res.status === 403) throw new ApplicationReadError({ kind: 'not_readable' });
  if (res.status === 502 && body?.code === 'node_unsupported') {
    throw new ApplicationReadError({ kind: 'unsupported', message });
  }
  if (res.status === 502 || res.status === 503) throw new ApplicationReadError({ kind: 'unreachable', message });
  throw new ApplicationReadError({ kind: 'failed', message });
}

export function useGitOpsApplication(id: string): GitOpsApplicationState {
  const [data, setData] = useState<GitOpsPortfolioDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<GitOpsApplicationError | null>(null);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const generation = useRef(0);
  const dataRef = useRef<GitOpsPortfolioDetailResponse | null>(null);

  const fetchApplication = useCallback(async () => {
    const current = ++generation.current;
    // With data on screen this is a refresh; without it (a retry after a
    // failed load) it is a load again, so the view shows progress either way.
    if (dataRef.current !== null) setRefreshing(true);
    else setLoading(true);
    try {
      const body = await readApplication(id);
      if (current !== generation.current) return;
      dataRef.current = body;
      setData(body);
      setError(null);
      setStaleSince(null);
    } catch (e) {
      if (current !== generation.current) return;
      const failure: GitOpsApplicationError = e instanceof ApplicationReadError
        ? e.failure
        : { kind: 'failed', message: e instanceof Error ? e.message : 'Failed to load the application.' };
      if (failure.kind === 'not_readable' || failure.kind === 'invalid_link' || dataRef.current === null) {
        // An application that stopped being readable is gone from this view,
        // not stale: keeping its last state would show something the reader
        // may no longer see.
        dataRef.current = null;
        setData(null);
        setStaleSince(null);
        setError(failure);
      } else {
        console.warn('[GitOps application] refresh failed; showing last-known state', id, failure);
        setStaleSince(prev => prev ?? Date.now());
      }
    } finally {
      if (current === generation.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [id]);

  // Callers key the view on the id, so a different application is a fresh
  // mount (and a fresh load), never a refresh that could flash the last one.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchApplication();
  }, [fetchApplication]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onInvalidate = (e: Event) => {
      const detail = (e as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope !== 'gitops') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fetchApplication();
      }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (timer) clearTimeout(timer);
    };
  }, [fetchApplication]);

  const refresh = useCallback(() => {
    void fetchApplication();
  }, [fetchApplication]);

  return { data, loading, refreshing, error, staleSince, refresh };
}
