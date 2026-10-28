/**
 * Registry-agnostic normalization of a template catalogue's `ports:` entries
 * into the Compose short-form strings a generated `compose.yaml` can hold.
 *
 * Registries describe a published port in incompatible ways, and no single
 * spelling covers all of them:
 *
 *  - A short-form string, already in Compose's own syntax (`"8080:80"`,
 *    `"3000-3005:3000-3005/udp"`). The Portainer v2 catalogue format uses this.
 *  - A structured entry with a host/container pair, named
 *    `external`/`internal`, `host`/`container`, or `published`/`target`, and
 *    with the port values arriving as either strings or numbers.
 *  - A structured entry that already carries its protocol inside the container
 *    value (`"443/udp"`) while sending no separate protocol field at all. The
 *    bundled LinuxServer.io catalogue does exactly this for 19 of its 201 apps,
 *    which is why appending a protocol unconditionally produced the unrenderable
 *    `443:443/udp/tcp`.
 *
 * Two rules keep this correct for every registry rather than for the one that
 * happens to be bundled:
 *
 *  1. A string is already in the target syntax and is returned VERBATIM. It is
 *     never inspected, trimmed, or rewritten. That keeps this helper incapable
 *     of altering registry-supplied content, and leaves the YAML emitter as the
 *     single owner of escaping.
 *  2. Only entries this helper can represent with full confidence are emitted.
 *     Anything else returns null so the caller drops it loudly rather than
 *     writing a spec that Docker Compose will reject at deploy time.
 */

import { sanitizeForLog } from '../utils/safeLog';

/** Transport protocols Docker Compose accepts in a port short form. */
const KNOWN_PROTOCOLS: ReadonlySet<string> = new Set(['tcp', 'udp', 'sctp']);

/** Field names registries use for the container-side port, in preference order. */
const CONTAINER_FIELDS = ['internal', 'container', 'target'] as const;

/** Field names registries use for the host-published port, in preference order. */
const HOST_FIELDS = ['external', 'host', 'published'] as const;

/** A port value split into its numeric part and an optional protocol suffix. */
interface PortParts {
  base: string;
  /** Protocol carried by the value itself, or null when it carried none. */
  protocol: string | null;
}

/** Split `"443/udp"` into `443` plus `udp`; a value with no suffix yields null. */
function splitProtocol(value: string): PortParts {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash < 0) return { base: trimmed, protocol: null };
  return { base: trimmed.slice(0, slash).trim(), protocol: trimmed.slice(slash + 1).trim() };
}

/** First non-empty string among `keys`, or null when the entry names none. */
function portField(entry: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    const asString = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (asString !== '') return asString;
  }
  return null;
}

/**
 * The one protocol to publish, from whichever field stated it.
 *
 * A protocol attached to the container value is the most specific statement of
 * that port's transport, a protocol on the host value next, and a separate
 * field last. Returns null when Compose cannot accept a stated protocol, and
 * null when the fields disagree: an entry that contradicts itself is not one
 * this helper can represent with confidence, and a wrong-but-renderable spec
 * fails later and more quietly than a dropped one.
 */
function pickProtocol(...candidates: unknown[]): string | null {
  const stated: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim().toLowerCase();
    if (value === '') continue;
    if (!KNOWN_PROTOCOLS.has(value)) return null;
    if (!stated.includes(value)) stated.push(value);
  }
  if (stated.length === 0) return 'tcp';
  return stated.length === 1 ? stated[0] : null;
}

/**
 * Reduce one catalogue `ports:` entry to a Compose short-form string, or null
 * when the entry cannot be represented with confidence.
 *
 * A host port is optional. When the entry names none (or names port 0, which
 * asks for an ephemeral binding rather than a published port), the container
 * port is published on the same number, matching the behaviour this replaces.
 */
export function normalizePortEntry(entry: unknown): string | null {
  // Already in the target syntax: returned untouched, never inspected.
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'number') return Number.isFinite(entry) ? String(entry) : null;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;

  const record = entry as Record<string, unknown>;
  const container = portField(record, CONTAINER_FIELDS);
  if (container === null) return null;

  const target = splitProtocol(container);
  const host = splitProtocol(portField(record, HOST_FIELDS) ?? target.base);
  const protocol = pickProtocol(target.protocol, host.protocol, record.protocol);
  if (protocol === null) return null;

  return `${host.base === '0' ? target.base : host.base}:${target.base}/${protocol}`;
}

/**
 * Normalize a catalogue's whole `ports:` list, dropping entries this helper
 * cannot represent. `source` names the registry in the warning so an operator
 * can tell which catalogue lost entries.
 */
export function normalizePortEntries(entries: unknown, source: string): string[] {
  if (!Array.isArray(entries)) return [];
  const specs: string[] = [];
  let dropped = 0;
  for (const entry of entries) {
    const spec = normalizePortEntry(entry);
    if (spec === null) dropped++;
    else specs.push(spec);
  }
  if (dropped > 0) {
    console.warn(
      '[Templates] Dropped %d unrenderable port entries from the %s catalogue.',
      dropped,
      sanitizeForLog(source),
    );
  }
  return specs;
}
