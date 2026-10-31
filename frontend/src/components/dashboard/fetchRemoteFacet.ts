import { apiFetch } from '@/lib/api';
import { STACK_STATUSES_OWNER_TIMEOUT_MS } from '@/lib/stackStatusesFetch';
import { classifyRemoteReadError, classifyRemoteReadFailure } from '@/lib/remoteReadFailure';

export type RemoteFacetFailure =
  | 'timeout'
  | 'unreachable'
  | 'unauthorized'
  | 'unsupported'
  | 'auth-abort'
  | 'http'
  | 'error';

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
      // Timeout, unreachable, authorization, and an older node that does not
      // serve the route keep their own names; everything else is a plain HTTP
      // failure.
      const classified = classifyRemoteReadFailure(res);
      if (classified === 'timeout' || classified === 'unreachable'
        || classified === 'unauthorized' || classified === 'unsupported') {
        return { ok: false, failure: classified, status: res.status };
      }
      return { ok: false, failure: 'http', status: res.status };
    }
    return { ok: true, body: await res.json() };
  } catch (error) {
    return {
      ok: false,
      failure: signal.aborted ? abortReasonFailure(signal.reason) : classifyRemoteReadError(error),
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
