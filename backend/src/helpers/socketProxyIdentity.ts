/**
 * Canonical Docker socket proxy identities shared by the authored Compose
 * rules and the runtime socket inventory.
 *
 * Two lists exist on purpose:
 *
 * - `AUTHORED_SOCKET_PROXY_IMAGE_HINTS` is what Compose Doctor already
 *   classifies from a rendered Compose model. Its membership and matching are
 *   part of an existing rule's behavior, so they change only when that rule
 *   does.
 * - `RUNTIME_SOCKET_PROVIDER_IMAGE_HINTS` is what a live container scan can
 *   recognize. Discovery is allowed to know providers that the authored rules
 *   do not model yet, and a runtime match never hides another proxy: the
 *   inventory reports every matching container and marks which one carries
 *   Sencho's own Docker connection.
 */

/** Docker socket proxy implementations recognized at runtime, by image reference. */
export type SocketProviderType =
  | 'tecnativa'
  | 'linuxserver'
  | 'wollomatic'
  | 'sencho-socket-gateway'
  | 'generic-socket-proxy'
  | 'direct-unix-socket'
  | 'unknown';

/**
 * `substring` preserves the authored rule's historical matching. `repository`
 * matches the repository path with any registry prefix but no suffix, so an
 * image such as `company/socket-proxy-test` or
 * `tecnativa/docker-socket-proxy-evil` is not a proxy by its image alone.
 */
interface ImageHint {
  hint: string;
  provider: SocketProviderType;
  match: 'substring' | 'repository';
}

/**
 * Images the authored Compose Doctor rules already classify as socket proxies.
 * Kept byte-for-byte equivalent to the previous inline list, including the
 * registry-anchored LinuxServer hint, so the authored rule's behavior does not
 * move in this change.
 */
export const AUTHORED_SOCKET_PROXY_IMAGE_HINTS: readonly ImageHint[] = [
  { hint: 'tecnativa/docker-socket-proxy', provider: 'tecnativa', match: 'substring' },
  { hint: 'lscr.io/linuxserver/socket-proxy', provider: 'linuxserver', match: 'substring' },
  { hint: 'docker-socket-proxy', provider: 'generic-socket-proxy', match: 'substring' },
];

/**
 * Superset recognized by runtime discovery. Vendor hints precede the generic
 * name, which is matched on the repository path so a lookalike image does not
 * become a confirmed proxy.
 */
export const RUNTIME_SOCKET_PROVIDER_IMAGE_HINTS: readonly ImageHint[] = [
  { hint: 'tecnativa/docker-socket-proxy', provider: 'tecnativa', match: 'repository' },
  { hint: 'linuxserver/socket-proxy', provider: 'linuxserver', match: 'repository' },
  { hint: 'wollomatic/socket-proxy', provider: 'wollomatic', match: 'repository' },
  { hint: 'sencho-socket-gateway', provider: 'sencho-socket-gateway', match: 'repository' },
  { hint: 'docker-socket-proxy', provider: 'generic-socket-proxy', match: 'repository' },
  { hint: 'socket-proxy', provider: 'generic-socket-proxy', match: 'repository' },
];

/** Repository path without tag, digest, or a leading registry host. */
function imageRepositoryPath(image: string): string {
  const withoutDigest = image.split('@')[0];
  const slash = withoutDigest.lastIndexOf('/');
  const lastSegment = withoutDigest.slice(slash + 1);
  const colon = lastSegment.indexOf(':');
  const withoutTag = colon === -1
    ? withoutDigest
    : `${withoutDigest.slice(0, slash + 1)}${lastSegment.slice(0, colon)}`;
  return withoutTag.replace(/\/+$/, '').toLowerCase();
}

function hintMatches(image: string, entry: ImageHint): boolean {
  if (entry.match === 'substring') return image.includes(entry.hint);
  const path = imageRepositoryPath(image);
  return path === entry.hint || path.endsWith(`/${entry.hint}`);
}

/** Provider identity for an image reference, or null when it carries no hint. */
export function socketProxyProviderForImage(
  image: string | undefined,
  list: readonly ImageHint[] = RUNTIME_SOCKET_PROVIDER_IMAGE_HINTS,
): SocketProviderType | null {
  const normalized = image?.trim().toLowerCase();
  if (!normalized) return null;
  return list.find(entry => hintMatches(normalized, entry))?.provider ?? null;
}

/**
 * True when a name reads like a socket proxy (`socket-proxy`,
 * `docker-socket-proxy`, and `_`/`.` separated variants). Free text an author
 * controls, so it is only ever corroborating evidence.
 */
export function hasSocketProxyNameHint(names: readonly (string | null | undefined)[]): boolean {
  return names.some(name => typeof name === 'string'
    && name.toLowerCase().replace(/[_.]/g, '-').includes('socket-proxy'));
}

/** A trimmed, forward-slash path with trailing slashes removed; `/` stays `/`. */
function normalizedSocketPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/');
  return trimmed === '/' ? '/' : trimmed.replace(/\/+$/, '');
}

/** True when a path is a Docker socket bind source or target. */
export function isDockerSocketPath(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = normalizedSocketPath(value);
  if (!normalized) return false;
  return normalized === 'docker.sock' || normalized.endsWith('/docker.sock');
}

/**
 * True when a bind source is an absolute host directory that contains one of the
 * Docker socket paths, so a container mounting it can open the socket through
 * that directory (`/var/run`, `/run`, `/var`, or `/` for the default socket).
 *
 * This is possible access, not proof that the container uses the socket: a
 * directory mount exposes everything in it, so the caller treats it as
 * undetermined unless stronger evidence (a socket path it names itself, or a
 * recognised proxy identity) settles the row. A relative path is not a known
 * absolute host path, so it proves nothing here.
 */
export function isDockerSocketDirectoryMount(
  value: string | null | undefined,
  socketPaths: readonly string[],
): boolean {
  if (typeof value !== 'string') return false;
  const directory = normalizedSocketPath(value);
  if (!directory.startsWith('/')) return false;
  return socketPaths.some(socketPath => {
    const socket = normalizedSocketPath(socketPath);
    if (!socket.startsWith('/')) return false;
    return directory === '/' || socket.startsWith(`${directory}/`);
  });
}

/**
 * Docker socket-proxy API group / verb env keys whose value grants access when
 * it is exactly `1`. Shared with the authored effective model so both surfaces
 * read the same flag names. Values are never retained.
 */
export const PROXY_API_FLAG_KEYS: ReadonlySet<string> = new Set([
  'CONTAINERS', 'IMAGES', 'INFO', 'EVENTS', 'NETWORKS', 'VOLUMES', 'POST', 'DELETE',
]);

/**
 * Recognized proxy API flags whose value is exactly `1`, read from a container's
 * `KEY=value` environment entries. Only names are returned; values are dropped
 * as soon as enablement is decided.
 */
export function enabledProxyApiFlags(env: readonly string[] | null | undefined): string[] {
  const enabled = new Set<string>();
  for (const entry of env ?? []) {
    if (typeof entry !== 'string') continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!PROXY_API_FLAG_KEYS.has(key)) continue;
    if (entry.slice(eq + 1).trim() === '1') enabled.add(key);
  }
  return [...enabled].sort();
}
