import { apiFetch } from './api';

export interface FetchUpdatePreviewOptions {
  /** When true (default), POST to reconcile sticky state. Falls back to GET on 404/405. */
  reconcile?: boolean;
  /** Optional node-scoped fetch (Fleet). When omitted, uses hub apiFetch. */
  fetchImpl?: (path: string, init?: RequestInit) => Promise<Response>;
}

export interface FetchUpdatePreviewResult {
  ok: boolean;
  status: number;
  preview: unknown | null;
  /** True only when POST succeeded and the body reported reconciled. */
  reconciled: boolean;
  /** True when POST was unsupported and GET was used instead. */
  usedGetFallback: boolean;
}

async function asPreviewResult(
  res: Response,
  opts: { usedGetFallback: boolean; readReconciledFlag: boolean },
): Promise<FetchUpdatePreviewResult> {
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      preview: null,
      reconciled: false,
      usedGetFallback: opts.usedGetFallback,
    };
  }
  const body = await res.json() as { reconciled?: unknown };
  return {
    ok: true,
    status: res.status,
    preview: body,
    reconciled: opts.readReconciledFlag && body.reconciled === true,
    usedGetFallback: opts.usedGetFallback,
  };
}

/**
 * Prefer POST /stacks/:name/update-preview (reconcile). On 404/405 only, fall
 * back to GET and treat as not reconciled. Ordinary 5xx / network errors do
 * not fall back.
 */
export async function fetchUpdatePreview(
  stackName: string,
  options: FetchUpdatePreviewOptions = {},
): Promise<FetchUpdatePreviewResult> {
  const reconcile = options.reconcile !== false;
  const fetchImpl = options.fetchImpl ?? ((path: string, init?: RequestInit) => apiFetch(path, init));
  const path = `/stacks/${encodeURIComponent(stackName)}/update-preview`;

  if (!reconcile) {
    const res = await fetchImpl(path, { method: 'GET' });
    return asPreviewResult(res, { usedGetFallback: false, readReconciledFlag: false });
  }

  const postRes = await fetchImpl(path, { method: 'POST' });
  if (postRes.status === 404 || postRes.status === 405) {
    const getRes = await fetchImpl(path, { method: 'GET' });
    return asPreviewResult(getRes, { usedGetFallback: true, readReconciledFlag: false });
  }

  return asPreviewResult(postRes, { usedGetFallback: false, readReconciledFlag: true });
}
