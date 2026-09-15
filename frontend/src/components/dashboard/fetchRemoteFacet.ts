import { apiFetch } from '@/lib/api';
import { STACK_STATUSES_OWNER_TIMEOUT_MS } from '@/lib/stackStatusesFetch';

export type RemoteFacetFailure = 'timeout' | 'auth-abort' | 'http' | 'error';

export type RemoteFacetResult =
  | { ok: true; body: unknown }
  | { ok: false; failure: RemoteFacetFailure; status: number };

export function abortReasonFailure(reason: unknown): RemoteFacetFailure {
  if (reason === 'timeout') return 'timeout';
  if (reason === 'auth-abort') return 'auth-abort';
  return 'error';
}

export async function fetchRemoteFacet(
  path: string,
  nodeId: number,
  signal: AbortSignal,
): Promise<RemoteFacetResult> {
  try {
    const res = await apiFetch(path, { nodeId, signal });
    if (!res.ok) {
      return { ok: false, failure: 'http', status: res.status };
    }
    return { ok: true, body: await res.json() };
  } catch {
    return {
      ok: false,
      failure: signal.aborted ? abortReasonFailure(signal.reason) : 'error',
      status: 0,
    };
  }
}

export function startFacetTimeout(
  controller: AbortController,
  ms: number = STACK_STATUSES_OWNER_TIMEOUT_MS,
): () => void {
  const id = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort('timeout');
  }, ms);
  return () => clearTimeout(id);
}
