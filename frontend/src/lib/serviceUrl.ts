/**
 * Build and open the browser URL for a container's published service port.
 *
 * Centralizes the host, protocol, and path logic that the container card, the
 * stack "Open App" menu, and the stack anatomy footer all need, so a published
 * port renders as a real, reliable link instead of an ad hoc
 * `window.open('http://host:port')`.
 */

// Some multi-port apps serve their UI at a sub-path, so a bare host:port does
// not land on the working page. Keyed by the app's container (private) port;
// the lookup also falls back to the published port (see buildServiceUrl).
const KNOWN_SERVICE_PATHS: Record<number, string> = {
  32400: '/web', // Plex
};

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// Accepts a bare host or a full URL (a future configured public host may be
// pasted either way) and returns just the hostname, or '' when unusable.
function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return '';
    }
  }
  return trimmed;
}

export interface ServiceUrlOptions {
  /** Active node; a remote node resolves to its own host, never the browser host. */
  node?: { type?: 'local' | 'remote'; api_url?: string } | null;
  /** Published host port (the browser-reachable one). */
  publicPort: number;
  /** Container port, used for protocol/path inference only. */
  privatePort?: number;
  /** Configured public/service host that overrides the node host. Reserved for future use. */
  publicHost?: string | null;
  /** Browser hostname; defaults to window.location.hostname. Injectable for tests. */
  browserHost?: string;
  /** Explicit protocol override. Reserved for future use. */
  protocol?: 'http' | 'https';
}

/**
 * Returns the browser URL for the published port, or null when no
 * browser-reachable host can be resolved (e.g. a remote node with no API URL,
 * such as a pilot-agent node) or the port is out of range. Callers render a
 * link only when this is non-null.
 */
export function buildServiceUrl(opts: ServiceUrlOptions): string | null {
  const { node, publicPort, privatePort, publicHost, browserHost, protocol } = opts;
  if (!isValidPort(publicPort)) return null;

  const host = resolveHost(node, publicHost, browserHost);
  if (!host) return null;

  const scheme = protocol ?? (publicPort === 443 || privatePort === 443 ? 'https' : 'http');
  const path =
    (privatePort !== undefined ? KNOWN_SERVICE_PATHS[privatePort] : undefined) ??
    KNOWN_SERVICE_PATHS[publicPort] ??
    '';
  return `${scheme}://${host}:${publicPort}${path}`;
}

function resolveHost(
  node: ServiceUrlOptions['node'],
  publicHost: string | null | undefined,
  browserHost: string | undefined,
): string | null {
  if (publicHost) {
    const normalized = normalizeHost(publicHost);
    if (normalized) return normalized;
  }
  if (node?.type === 'remote') {
    // A remote node must resolve to its own reachable host. Never fall back to
    // the browser host: that points at the control instance, not the remote.
    if (node.api_url) {
      try {
        return new URL(node.api_url).hostname || null;
      } catch {
        return null;
      }
    }
    return null;
  }
  // Local or no node: the browser is talking to the instance that runs the
  // stacks, so its hostname is the right target.
  if (browserHost) return browserHost;
  return typeof window !== 'undefined' ? window.location.hostname : null;
}

/**
 * Open a URL in a new tab via a transient anchor click. More reliable than
 * window.open on mobile browsers, which may block programmatic popups.
 */
export function openServiceUrl(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
