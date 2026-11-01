import { apiFetch } from '@/lib/api';
import { STACK_STATUSES_OWNER_TIMEOUT_MS } from '@/lib/stackStatusesFetch';
import { classifyRemoteReadError, classifyRemoteReadFailure, type RemoteReadFailure } from '@/lib/remoteReadFailure';

/** A read failure, plus the coalescer's own abort reason. */
export type RemoteFacetFailure = RemoteReadFailure | 'auth-abort';

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
      // Keep every cause the classifier established. A hand-written list here
      // is how a disconnected Pilot became a bare HTTP failure in the fleet
      // facet reads.
      return { ok: false, failure: classifyRemoteReadFailure(res) ?? 'http', status: res.status };
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
