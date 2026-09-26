/**
 * Reading and rewriting a Compose short-form port spec.
 *
 * The App Store deployment sheet lets an operator change the host port of a
 * published port and must leave every other part of the spec exactly as the
 * registry published it. Splitting on `:` and reassembling two pieces is not
 * enough, because a spec has more shapes than `HOST:CONTAINER`:
 *
 *   443/tcp                      container port and protocol, nothing published
 *   8080:80                      host port and container port
 *   51820:51820/udp              host port, container port, protocol
 *   127.0.0.1:8080:80/tcp        bind address, host port, container port, protocol
 *   [::1]:8080:80/tcp            the same with an IPv6 literal
 *   3000-3005:3000-3005/udp      a port range on both sides
 *
 * Reading `parts[0]` as the host port and `parts[1]` as the container port made
 * the sheet offer `127.0.0.1` as an editable port, display `8080` as the
 * container port, and check port conflicts against a bind address. On deploy it
 * then wrote `127.0.0.1:8080`, dropping the container port and the protocol while
 * the install reported success. A range was worse: `3000-3005` is not a single
 * port, so the sheet put it in a field that accepts one number and blocked the
 * install.
 *
 * `parsePortSpec` is the one place that knows these shapes. `withHostPort`
 * substitutes only the host-port segment, so everything else survives by
 * construction rather than by being reassembled.
 */

/**
 * A port, or a range of ports, optionally with a protocol suffix. Anything the
 * first segment of a spec can be if it is not a bind address.
 */
const PORT_TOKEN = /^\d{1,5}(?:-\d{1,5})?(?:\/.*)?$/;

/** One host port the sheet can offer as a single editable number. */
const SINGLE_PORT = /^\d{1,5}$/;

/** A spec broken into the parts the sheet reasons about. */
export interface PortSpec {
  /** Bind address the spec pins, with its brackets, or null when it publishes on every interface. */
  bindAddress: string | null;
  /**
   * The host segment verbatim, which may be a range such as `3000-3005`. Null
   * when the spec publishes no host port at all.
   */
  hostSegment: string | null;
  /**
   * The published host port as a single number. Null when the spec publishes no
   * host port, and when it publishes a range, which is not one number and so
   * cannot be offered in the sheet's port field.
   */
  hostPort: string | null;
  /** The container segment verbatim, protocol suffix included, for example `80/tcp`. */
  container: string;
}

/**
 * Split a spec into an optional leading bind address and its colon-separated
 * segments. A bracketed IPv6 literal contains colons of its own, so it is
 * consumed whole before the rest is split.
 *
 * The address is recognized by what it is not: a first segment that is a port or
 * a range of ports is a port, and anything else in front of the container is an
 * address the spec is pinned to. Compose documents the position as a host IP,
 * but a hostname is accepted there in practice and a catalogue can publish one,
 * so this does not restrict the address to a dotted quad.
 */
function splitSpec(spec: string): { bindAddress: string | null; parts: string[] } {
  if (spec.startsWith('[')) {
    const close = spec.indexOf(']');
    if (close > 0) {
      const bindAddress = spec.slice(0, close + 1);
      return { bindAddress, parts: spec.slice(close + 1).replace(/^:/, '').split(':') };
    }
  }
  const parts = spec.split(':');
  if (parts.length > 1 && !PORT_TOKEN.test(parts[0])) {
    return { bindAddress: parts[0], parts: parts.slice(1) };
  }
  return { bindAddress: null, parts };
}

/**
 * Index of the host-port segment within `parts`, or -1 when the spec publishes
 * no host port. The container port is always last, so the host port is the one
 * before it whenever a bind address has already been removed.
 */
function hostPortIndex(parts: readonly string[]): number {
  return parts.length - 2;
}

/** Break one Compose short-form port spec into its address, host port and container. */
export function parsePortSpec(spec: string): PortSpec {
  const { bindAddress, parts } = splitSpec(spec);
  const container = parts[parts.length - 1] ?? '';
  const index = hostPortIndex(parts);
  const segment = index >= 0 ? parts[index] : null;
  return {
    bindAddress,
    hostSegment: segment,
    hostPort: segment !== null && SINGLE_PORT.test(segment) ? segment : null,
    container,
  };
}

/**
 * The same spec with its host port replaced and every other segment, including
 * the protocol suffix and any bind address, carried through untouched.
 *
 * Returns the spec unchanged when it publishes no single host port, so a range is
 * never collapsed into one number and a container-only spec is never given a
 * host, and when `hostPort` is not a single number, so a cleared or half-typed
 * field leaves the registry's spec intact instead of writing a broken one.
 */
export function withHostPort(spec: string, hostPort: string): string {
  if (!SINGLE_PORT.test(hostPort)) return spec;
  const { bindAddress, parts } = splitSpec(spec);
  const index = hostPortIndex(parts);
  if (index < 0 || !SINGLE_PORT.test(parts[index])) return spec;
  const replaced = [...parts];
  replaced[index] = hostPort;
  const body = replaced.join(':');
  return bindAddress === null ? body : `${bindAddress}:${body}`;
}

/**
 * How the container side should read next to the host field, keeping a bind
 * address visible so the operator can see the port is not on every interface.
 */
export function containerLabel(spec: PortSpec): string {
  return spec.bindAddress === null ? spec.container : `${spec.bindAddress}:${spec.container}`;
}
