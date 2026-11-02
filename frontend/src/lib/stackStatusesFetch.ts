import { apiFetch } from '@/lib/api';
import { classifyRemoteReadFailure, type RemoteReadFailure } from '@/lib/remoteReadFailure';

/**
 * Bound for the in-flight owner so a hung remote cannot occupy the coalescer
 * across a dashboard statuses poll tick (10s). The gateway's own interactive
 * read deadline normally answers first, so this is the backstop for a hub that
 * is slow to even reach the proxy hop.
 */
export const STACK_STATUSES_OWNER_TIMEOUT_MS = 8000;

/** Every cause the classifier establishes, plus the coalescer's own abort.
 *  The helper must not narrow this: a caller that only knows `timeout` and
 *  `unreachable` is how a disconnected Pilot reached Home and the sidebar as a
 *  bare 503. */
export type StackStatusesFetchFailure = RemoteReadFailure | 'auth-abort';

/** The two failures the coalescer synthesizes itself (no HTTP status). */
type AbortFailure = 'timeout' | 'auth-abort';

/**
 * Raw transport result for GET /stacks/statuses. Callers keep all
 * interpretation (sanitization, legacy-format fallback, error copy).
 */
export type StackStatusesFetchResult = {
  ok: boolean;
  status: number;
  proxied: boolean;
  body: unknown;
  /** True when this waiter joined an in-flight promise owned by another caller. */
  coalesced: boolean;
  /** Set when ok is false. Timeout and auth-abort are not HTTP statuses. */
  failure?: StackStatusesFetchFailure;
};

type NodeKey = string;

type InflightEntry = {
  /** Monotonic id so settled owners clear only their own map slot. */
  id: number;
  promise: Promise<StackStatusesFetchResult>;
  controller: AbortController;
};

const inflight = new Map<NodeKey, InflightEntry>();
let nextInflightId = 0;

function nodeKey(nodeId: number | null): NodeKey {
  return nodeId === null ? 'local' : String(nodeId);
}

function failureFromAbort(reason: unknown): AbortFailure {
  return reason === 'timeout' ? 'timeout' : 'auth-abort';
}

function abortedResult(
  failure: AbortFailure,
  coalesced: boolean,
): StackStatusesFetchResult {
  return {
    ok: false,
    status: 0,
    proxied: false,
    body: null,
    coalesced,
    failure,
  };
}

async function requestStackStatuses(
  nodeId: number | null,
  signal: AbortSignal,
): Promise<StackStatusesFetchResult> {
  const res = await apiFetch('/stacks/statuses', { nodeId, signal });
  const proxied = res.headers.get('x-sencho-proxy') === '1';
  let body: unknown = null;
  if (res.ok) {
    body = await res.json();
  }
  // Every cause the classifier established keeps its own name. A caller that
  // needs the cause (the dashboard headline, the sidebar card, the fleet stack
  // health) must be able to tell a disconnected Pilot from a bare 503.
  const failure: StackStatusesFetchFailure | undefined = res.ok
    ? undefined
    : classifyRemoteReadFailure(res) ?? 'http';
  return {
    ok: res.ok,
    status: res.status,
    proxied,
    body,
    coalesced: false,
    failure,
  };
}

function waitForAbort(controller: AbortController): Promise<StackStatusesFetchResult> {
  return new Promise((resolve) => {
    const settle = () => {
      resolve(abortedResult(failureFromAbort(controller.signal.reason), false));
    };
    if (controller.signal.aborted) {
      settle();
      return;
    }
    controller.signal.addEventListener('abort', settle, { once: true });
  });
}

/** Drop every in-flight join so a prior auth session cannot share results. */
export function clearStackStatusesFetch(): void {
  for (const entry of inflight.values()) {
    if (!entry.controller.signal.aborted) {
      entry.controller.abort('auth-abort');
    }
  }
  inflight.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('sencho-unauthorized', clearStackStatusesFetch);
}

/**
 * Coalesce concurrent GET /stacks/statuses for the same node/auth context.
 * Always forwards an explicit nodeId to apiFetch so the key and request target
 * cannot diverge from localStorage during a node switch.
 */
export async function fetchStackStatusesShared(
  nodeId: number | null,
): Promise<StackStatusesFetchResult> {
  const key = nodeKey(nodeId);
  const existing = inflight.get(key);
  if (existing) {
    const shared = await existing.promise;
    return { ...shared, coalesced: true };
  }

  const id = ++nextInflightId;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort('timeout');
  }, STACK_STATUSES_OWNER_TIMEOUT_MS);

  const requestDone = requestStackStatuses(nodeId, controller.signal);
  const abortDone = waitForAbort(controller);

  const promise = (async (): Promise<StackStatusesFetchResult> => {
    try {
      const winner = await Promise.race([
        requestDone.then(
          (r) => ({ kind: 'http' as const, r }),
          () => ({
            kind: 'http' as const,
            r: {
              ok: false,
              status: 0,
              proxied: false,
              body: null,
              coalesced: false,
              failure: 'http' as const,
            },
          }),
        ),
        abortDone.then((r) => ({ kind: 'abort' as const, r })),
      ]);
      if (winner.kind === 'abort') {
        void requestDone.catch(() => undefined);
        return winner.r;
      }
      return winner.r;
    } finally {
      clearTimeout(timeoutId);
      if (!controller.signal.aborted) controller.abort('settled');
      if (inflight.get(key)?.id === id) {
        inflight.delete(key);
      }
    }
  })();

  inflight.set(key, { id, promise, controller });
  return promise;
}

/** Test-only: reset module state between vitest cases. */
export function __resetStackStatusesFetchForTests(): void {
  clearStackStatusesFetch();
}
