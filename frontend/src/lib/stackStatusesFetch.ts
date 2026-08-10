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

const inflight = new Map<NodeKey, Promise<StackStatusesFetchResult>>();

function nodeKey(nodeId: number | null): NodeKey {
  return nodeId === null ? 'local' : String(nodeId);
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
    const shared = await existing;
    return { ...shared, coalesced: true };
  }

  const request = (async (): Promise<StackStatusesFetchResult> => {
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
  })();

  inflight.set(key, request);
  try {
    return await request;
  } finally {
    if (inflight.get(key) === request) {
      inflight.delete(key);
    }
  }
}

/** Test-only: reset module state between vitest cases. */
export function __resetStackStatusesFetchForTests(): void {
  inflight.clear();
}
