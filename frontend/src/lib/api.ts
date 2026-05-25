const API_BASE = '/api';

export interface ApiFetchOptions extends RequestInit {
  /** When true, omits the x-node-id header so the request always targets
   *  the local node regardless of which node is currently active in the UI. */
  localOnly?: boolean;
}

export async function apiFetch(
  endpoint: string,
  options: ApiFetchOptions = {}
): Promise<Response> {
  const { localOnly, ...fetchOptions } = options;
  const url = `${API_BASE}${endpoint}`;
  const activeNodeId = localOnly ? null : localStorage.getItem('sencho-active-node');

  const defaultOptions: RequestInit = {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(activeNodeId ? { 'x-node-id': activeNodeId } : {}),
      ...fetchOptions.headers,
    },
  };

  // Drop headers from fetchOptions before the outer spread so the merged
  // defaultOptions.headers (with Content-Type and x-node-id) survives. Without
  // this, any caller that passes a `headers` field clobbers the defaults.
  const { headers: _callerHeaders, ...fetchOptionsWithoutHeaders } = fetchOptions;
  void _callerHeaders;
  const response = await fetch(url, { ...defaultOptions, ...fetchOptionsWithoutHeaders });

  if (response.status === 401) {
    // Only fire the global logout event for local auth failures.
    // When the response carries x-sencho-proxy, the 401 came from a remote
    // Sencho node (expired/invalid api_token) - not from the user's own session.
    // Logging out in that case creates an unrecoverable loop.
    if (!response.headers.get('x-sencho-proxy')) {
      window.dispatchEvent(new Event('sencho-unauthorized'));
    }
    throw new Error('Unauthorized');
  }

  // Intercept 404 Node Not Found responses and force context refresh
  if (response.status === 404) {
    try {
      const clone = response.clone();
      const errData = await clone.json();
      if (errData.error && errData.error.includes('not found') && errData.error.includes('Node')) {
        window.dispatchEvent(new Event('node-not-found'));
      }
    } catch {
      // Ignore JSON parse errors, caller handles standard 404s
    }
  }

  return response;
}

/** Fetch against a specific node by ID without touching the localStorage active-node key.
 *  Used by the notification panel to target individual remote nodes explicitly. */
export async function fetchForNode(
  endpoint: string,
  nodeId: number,
  options: RequestInit = {}
): Promise<Response> {
  const { headers: extraHeaders, ...rest } = options;
  const response = await fetch(`${API_BASE}${endpoint}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-node-id': String(nodeId),
      ...(extraHeaders as Record<string, string> | undefined),
    },
    ...rest,
  });

  if (response.status === 401) {
    // Same logic as apiFetch: only log out for local auth failures.
    if (!response.headers.get('x-sencho-proxy')) {
      window.dispatchEvent(new Event('sencho-unauthorized'));
    }
    throw new Error('Unauthorized');
  }

  return response;
}

export { API_BASE };
