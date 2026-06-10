/**
 * Documentation drift for the Stack Dossier: warns when operator-authored
 * documentation no longer matches the facts Sencho can observe. This first
 * version is deterministic and read-only, and checks one thing: a port written
 * into the dossier `access_urls` that no service actually publishes (the Plex
 * "moved from :32400 to :32401" case, and "an access URL with no matching
 * published port"). No prose is interpreted and no AI is involved.
 *
 * It compares against exactly the published ports the Anatomy panel shows (the
 * `anatomy.ports` in "generated facts", rendered directly above these warnings),
 * so a warning can never contradict the visible facts in the same tab. That
 * means it inherits the frontend parser's one-part convention: `ports: ["80"]`
 * reads as host `80` here, matching the panel, even though a bare one-part
 * mapping actually publishes to an ephemeral host port. Reconciling that is a
 * separate, panel-wide concern and out of scope for this check.
 */
import type { AnatomyMarkdownInput } from './anatomyMarkdown';

export interface DocDriftFinding {
  /** Discriminant mirroring the backend `StackDriftFinding`, so a later check can extend this into a union. */
  kind: 'access-url-port-unpublished';
  /** The port written into an access URL that nothing publishes. */
  port: number;
  /** The dossier `access_urls` line the port came from. */
  source: string;
  /** Specific, actionable description of what to review. */
  detail: string;
}

/** A published port: a single port or an inclusive `[low, high]` range. */
type PortSpec = number | [number, number];

function validPort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * The explicit host port an access-URL line points at, or null when there is
 * nothing to check. Scheme-default ports (`:80` on http, `:443` on https) are
 * intentionally skipped: the URL API normalizes them to '' so a documented
 * default port never produces a warning.
 */
export function extractExplicitAccessPort(line: string): number | null {
  const s = line.trim();
  if (!s) return null;

  // Absolute URL (a real `scheme://`): parse directly. `url.port` is '' for an
  // omitted or scheme-default port, and the API isolates the port from any
  // `user:pass@` userinfo and from IPv6 brackets.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const { port } = new URL(s);
      return port ? validPort(port) : null;
    } catch {
      return null;
    }
  }

  // Bare `host:port` (no scheme). `new URL('host:port')` would misread it as
  // `scheme:opaque` with no port, so prefix a scheme and require a host-ish
  // authority. Accepts `192.168.1.5:32400`, `localhost:8080`, `[::1]:8080`;
  // rejects prose like `note:8080` (host `note`) or `ratio 16:9` (throws).
  try {
    const url = new URL(`http://${s}`);
    if (!url.port) return null;
    const host = url.hostname;
    const hostish = host.includes('.') || host === 'localhost' || host.startsWith('[');
    return hostish ? validPort(url.port) : null;
  } catch {
    return null;
  }
}

function parsePortSpec(host: string): PortSpec | null {
  const h = host.trim();
  const range = h.match(/^(\d+)-(\d+)$/);
  if (range) {
    const lo = validPort(range[1]);
    const hi = validPort(range[2]);
    return lo !== null && hi !== null && lo <= hi ? [lo, hi] : null;
  }
  return validPort(h);
}

/**
 * The published TCP ports the panel shows, as single/range specs (an http(s)
 * access URL cannot be served by a UDP publish). An empty `host` is a
 * container-only port and is skipped. `indeterminate` is set when a TCP port is
 * published through an unresolved variable (e.g. `${PLEX_PORT}:32400`): its real
 * value is unknown, so any documented port might match it and the caller must
 * not flag, to avoid a false positive.
 */
function publishedPortModel(anatomy: AnatomyMarkdownInput): { specs: PortSpec[]; indeterminate: boolean } {
  const specs: PortSpec[] = [];
  let indeterminate = false;
  for (const rows of Object.values(anatomy.ports)) {
    for (const row of rows) {
      if (row.proto && row.proto.toLowerCase() !== 'tcp') continue;
      const host = row.host.trim();
      if (!host) continue;
      const spec = parsePortSpec(host);
      if (spec === null) indeterminate = true;
      else specs.push(spec);
    }
  }
  return { specs, indeterminate };
}

function isPublished(port: number, specs: PortSpec[]): boolean {
  return specs.some((s) => (typeof s === 'number' ? s === port : port >= s[0] && port <= s[1]));
}

/**
 * Compares ports written into the dossier `access_urls` against the stack's
 * published ports and returns one finding per documented port that nothing
 * publishes. Pure and deterministic: findings are deduped per port and sorted
 * by port then source. Returns [] when anatomy is unavailable (compose could
 * not be parsed) or when a published port resolves through a variable, since in
 * both cases the published set cannot be compared without risking a false flag.
 */
export function computeDocDrift(
  anatomy: AnatomyMarkdownInput | null,
  accessUrls: string,
): DocDriftFinding[] {
  if (!anatomy) return [];
  const { specs, indeterminate } = publishedPortModel(anatomy);
  if (indeterminate) return [];
  const seen = new Set<number>();
  const findings: DocDriftFinding[] = [];
  for (const line of accessUrls.split('\n')) {
    const port = extractExplicitAccessPort(line);
    if (port === null || isPublished(port, specs) || seen.has(port)) continue;
    seen.add(port);
    findings.push({
      kind: 'access-url-port-unpublished',
      port,
      source: line.trim(),
      detail: `An access URL points to port ${port}, but no service in this stack publishes it. Review the access URL or the stack's published ports.`,
    });
  }
  return findings.sort((a, b) => a.port - b.port || a.source.localeCompare(b.source));
}
