/**
 * Shared reading of a Compose `ports:` entry, so the authored-file parser and
 * the rendered-model adapter agree on what counts as a host publication.
 *
 * A host port Docker assigns at start (`"51820/udp"`, `"127.0.0.1::51820"`,
 * a host port of `0`, or a long-form entry with no `published`) is still a
 * publication: the container is reachable from the host's interfaces. Only
 * the concrete port number is unknown, so callers record it as dynamic and
 * never invent one.
 */

/** The ports of a service whose host port number is known (not `dynamic`). */
export function fixedPorts<T extends { dynamic?: true }>(ports: readonly T[]): T[] {
  return ports.filter(port => !port.dynamic);
}

export interface ShortPortSpec {
  /** Host interface with any IPv6 brackets removed; '' when none is written. */
  hostIp: string;
  /** Host port text (`80`, `8000-8010`, `0`); '' when none is written. */
  hostPart: string;
  /** Container port text. */
  container: string;
  /** Transport as written, `tcp` when none is. */
  protocol: string;
}

/**
 * Splits a short-syntax entry `[[IP:]HOST:]CONTAINER[/PROTOCOL]`. Compose reads
 * the last two colon-separated fields as host and container port and treats
 * whatever precedes them as the IP, so an IPv6 address works with or without
 * brackets. Returns null only for a malformed bracketed address; any other
 * shape is returned as written and the caller judges its host and container
 * parts.
 */
export function splitShortPortSpec(raw: string): ShortPortSpec | null {
  const slash = raw.indexOf('/');
  const spec = slash === -1 ? raw : raw.slice(0, slash);
  const protocol = (slash === -1 ? '' : raw.slice(slash + 1)) || 'tcp';
  let hostIp = '';
  let fields: string[];
  if (spec.startsWith('[')) {
    const close = spec.indexOf(']');
    if (close === -1 || spec[close + 1] !== ':') return null;
    hostIp = spec.slice(1, close);
    fields = spec.slice(close + 2).split(':');
    if (fields.length !== 2) return null;
  } else {
    fields = spec.split(':');
    if (fields.length >= 3) {
      hostIp = fields.slice(0, -2).join(':');
      fields = fields.slice(-2);
    }
  }
  if (fields.length === 1) return { hostIp: '', hostPart: '', container: fields[0], protocol };
  return { hostIp, hostPart: fields[0], container: fields[1], protocol };
}

/** Whether a host-port text leaves the port to Docker: absent, blank, or a number (or range start) of 0. */
export function isDynamicHostPort(hostPart: string | undefined): boolean {
  return hostPart === undefined || /^\s*(?:0+(?:-\d+)?)?\s*$/.test(hostPart);
}

/** A host port Compose accepts as fixed: digits, or a `start-end` range of digits. */
export function isFixedHostPort(hostPart: string): boolean {
  return /^\d+(?:-\d+)?$/.test(hostPart);
}

/** A container port text starts with a digit (a port or a `start-end` range); anything else is not a port entry. */
export function isContainerPort(container: string | undefined): boolean {
  return container !== undefined && /^\d/.test(container.trim());
}
