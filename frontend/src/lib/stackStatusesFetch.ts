import { apiFetch } from '@/lib/api';

/**
 * Bound for the in-flight owner so a hung remote cannot occupy the coalescer
 * across a dashboard statuses poll tick (10s).
 */
export const STACK_STATUSES_OWNER_TIMEOUT_MS = 8000;

export type StackStatusesFetchFailure = 'http' | 'timeout' | 'auth-abort';

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

function failureFromAbort(reason: unknown): Exclude<StackStatusesFetchFailure, 'http'> {
  return reason === 'timeout' ? 'timeout' : 'auth-abort';
}

function abortedResult(
  failure: Exclude<StackStatusesFetchFailure, 'http'>,
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
  return {
    ok: res.ok,
    status: res.status,
    proxied,
    body,
    coalesced: false,
    failure: res.ok ? undefined : 'http',
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
