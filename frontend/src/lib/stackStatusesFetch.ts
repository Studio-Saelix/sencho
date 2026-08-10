import { apiFetch } from '@/lib/api';

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
};

type NodeKey = string;

type InflightEntry = {
  /** Monotonic id so settled owners clear only their own map slot. */
  id: number;
  promise: Promise<StackStatusesFetchResult>;
};

const inflight = new Map<NodeKey, InflightEntry>();
let nextInflightId = 0;

function nodeKey(nodeId: number | null): NodeKey {
  return nodeId === null ? 'local' : String(nodeId);
}

async function requestStackStatuses(
  nodeId: number | null,
): Promise<StackStatusesFetchResult> {
  const res = await apiFetch('/stacks/statuses', { nodeId });
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
  };
}

/** Drop every in-flight join so a prior auth session cannot share results. */
export function clearStackStatusesFetch(): void {
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
  const promise = requestStackStatuses(nodeId);
  inflight.set(key, { id, promise });
  try {
    return await promise;
  } finally {
    // Clear only if this owner still holds the slot. A logout clear followed by
    // a new fetch must not be deleted by a stale settlement.
    if (inflight.get(key)?.id === id) {
      inflight.delete(key);
    }
  }
}

/** Test-only: reset module state between vitest cases. */
export function __resetStackStatusesFetchForTests(): void {
  clearStackStatusesFetch();
}
