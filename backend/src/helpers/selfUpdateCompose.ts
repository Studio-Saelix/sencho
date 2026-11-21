import fs from 'fs';
import path from 'path';
import { parse, parseDocument } from 'yaml';
import semver from 'semver';
import { normalizeImageRepository } from './imageChannel';

/**
 * How the Sencho service's compose `image:` is pinned. Drives the Fleet
 * self-update behavior:
 *   - `semver`   : rewrite the tag to the target release, then recreate.
 *   - `floating` : pull the compose-declared ref (e.g. `:latest`), no rewrite.
 *   - `digest`   : `@sha256:...` pin; blocked (needs a manual digest change).
 *   - `unknown`  : interpolated (`${VAR}`), unparseable, or the service/image is
 *                  absent; blocked, because the tag cannot be resolved safely.
 */
export type ImagePinKind = 'floating' | 'semver' | 'digest' | 'unknown';

/** True when Fleet cannot repin or resolve the compose image automatically. */
export function isRepinBlocked(pinKind: ImagePinKind): boolean {
  return pinKind === 'digest' || pinKind === 'unknown';
}

export interface ResolvedComposeImage {
  /** Absolute path of the highest-precedence compose file that sets the image. */
  filePath: string;
  /** The verbatim compose-declared image reference. */
  imageRef: string;
  /** The full contents of that file, so the caller can patch it in place. */
  fileContent: string;
  pinKind: ImagePinKind;
}

/**
 * Classify how an image reference is pinned. Aligned with the preflight
 * `usesLatestTag` rule: a digest wins, an interpolated value is unknown, a tag
 * that parses as semver is a pin, and everything else (implicit latest and
 * non-semver moving tags) is floating.
 */
export function classifyImagePin(imageRef: string): ImagePinKind {
  const ref = imageRef?.trim();
  if (!ref) return 'unknown';
  // Compose variable interpolation: the real tag is only known at deploy time.
  if (ref.includes('${') || ref.includes('$(')) return 'unknown';
  if (ref.includes('@sha256:') || ref.startsWith('sha256:')) return 'digest';

  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  // A colon after the last slash is a tag separator; before it is a registry port.
  const tag = lastColon > lastSlash ? ref.slice(lastColon + 1) : '';
  if (!tag) return 'floating'; // no explicit tag -> implicit latest
  if (tag === 'latest') return 'floating';
  if (semver.valid(tag.replace(/^v/, ''))) return 'semver';
  return 'floating'; // other moving tag (dev, stable, edge, ...)
}

/**
 * Build the target image reference for a semver-pinned install: keep the
 * registry and repository (including any `-dev` variant), swap only the tag to
 * the target version. Any digest suffix on the current ref is dropped. A `v`
 * prefix on the current tag is preserved so `:v1.2.3` stays `:v...`.
 */
export function buildTargetImageRef(currentRef: string, targetVersion: string): string {
  const ref = currentRef.split('@')[0];
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const currentTag = hasTag ? ref.slice(lastColon + 1) : '';
  const base = hasTag ? ref.slice(0, lastColon) : ref;
  const prefix = /^v\d/.test(currentTag) ? 'v' : '';
  return `${base}:${prefix}${targetVersion}`;
}

/**
 * Conservative image-reference validation before `docker pull`. execFile runs
 * docker with no shell, so this is defense in depth, not the only guard: it
 * fails closed on whitespace, control characters, or an implausibly long value.
 */
export function isValidImageRef(ref: string): boolean {
  if (!ref || ref.length > 512) return false;
  if (/\s/.test(ref)) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/.test(ref);
}

/**
 * True for any reference to the `studio-saelix/sencho-dev` repository on
 * `ghcr.io`, including digest-pinned references and the immutable `dev-<sha>`
 * tag. Normalizes the image reference to the bare repository string and
 * compares against the canonical Sencho dev repository identifier.
 */
export function isSenchoDevRepository(imageRef: string): boolean {
  const normalized = normalizeImageRepository(imageRef);
  return normalized === 'ghcr.io/studio-saelix/sencho-dev';
}

/**
 * True only when the image reference points to the Sencho dev repository with
 * the floating `dev` tag, not digest-pinned. This predicate identifies the
 * canonical floating tag that users configure for auto-update detection.
 */
export function isSenchoDevFloatingTag(imageRef: string): boolean {
  if (!isSenchoDevRepository(imageRef)) return false;

  const ref = imageRef?.trim();
  if (!ref) return false;

  // A digest pin disqualifies the reference (e.g., `@sha256:...`)
  if (ref.includes('@sha256:') || ref.startsWith('sha256:')) return false;

  const tag = extractTagFromRef(ref);
  return tag === 'dev';
}

/**
 * Build channel of a running or declared image, derived from the image
 * reference alone. This is the canonical build identity classifier used by
 * `/api/build-info` and the shell/About surfaces: it answers "is this a dev,
 * preview, or stable build" from the ref, independent of the packaged semver
 * (a dev image carries the last released version, so version alone cannot
 * identify it).
 *
 *   - dev repo (`ghcr.io/studio-saelix/sencho-dev`): always `'dev'`. An
 *     arbitrary `:dev-<sha>` tag still reads `dev` (a deliberate operator
 *     choice); the immutable revision is surfaced separately from the digest.
 *   - stable repos (`ghcr.io/studio-saelix/sencho-hardened`, `saelix/sencho`,
 *     `ghcr.io/studio-saelix/sencho`): `pr-<n>` and `preview-<sha>` tags are
 *     `'preview'` (CI builds on the stable repo that are not releases);
 *     everything else is `'stable'`.
 *   - any other repository: `'unknown'`.
 */
export type BuildChannel = 'stable' | 'dev' | 'preview' | 'unknown';

export function classifyBuildChannel(imageRef: string): BuildChannel {
  const repository = normalizeImageRepository(imageRef);
  if (repository === 'ghcr.io/studio-saelix/sencho-dev') return 'dev';
  if (
    repository === 'ghcr.io/studio-saelix/sencho-hardened' ||
    repository === 'saelix/sencho' ||
    repository === 'ghcr.io/studio-saelix/sencho'
  ) {
    const tag = extractTagFromRef(imageRef.trim());
    if (tag && (/^pr-\d+$/.test(tag) || /^preview-[0-9a-f]{7,40}$/.test(tag))) return 'preview';
    return 'stable';
  }
  return 'unknown';
}

/** Extract the tag portion of an image ref (`.../repo:tag`), or '' when absent. */
function extractTagFromRef(ref: string): string {
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  // A colon after the last slash is a tag separator; before it is a registry port.
  return lastColon > lastSlash ? ref.slice(lastColon + 1) : '';
}

/**
 * Resolve the Sencho service's image from already-read compose file contents.
 * Files are given in compose `-f` order; they are scanned in REVERSE so the
 * highest-precedence override that explicitly sets the service image wins,
 * matching how Docker Compose merges later `-f` files over earlier ones.
 * Returns null when no file declares a string image for the service.
 */
export function resolveServiceImageFromContents(
  files: ReadonlyArray<{ filePath: string; content: string }>,
  serviceName: string,
): ResolvedComposeImage | null {
  for (let i = files.length - 1; i >= 0; i--) {
    const { filePath, content } = files[i];
    let parsed: unknown;
    try {
      parsed = parse(content);
    } catch {
      continue; // a malformed override cannot own the image; try the next file
    }
    const image = extractServiceImage(parsed, serviceName);
    if (image) {
      return { filePath, imageRef: image, fileContent: content, pinKind: classifyImagePin(image) };
    }
  }
  return null;
}

/** Read `services.<name>.image` as a trimmed string, or null if absent/non-string. */
function extractServiceImage(parsed: unknown, serviceName: string): string | null {
  if (!isRecord(parsed)) return null;
  const services = parsed.services;
  if (!isRecord(services)) return null;
  const service = services[serviceName];
  if (!isRecord(service)) return null;
  const image = service.image;
  if (typeof image !== 'string') return null;
  const trimmed = image.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrite only the target service's `image:` value, preserving comments,
 * formatting, and every other node via a document round-trip. Throws when the
 * service has no image to patch, so a caller never silently no-ops.
 */
export function patchComposeServiceImage(content: string, serviceName: string, newImageRef: string): string {
  const doc = parseDocument(content);
  if (!doc.hasIn(['services', serviceName, 'image'])) {
    throw new Error(`Service "${serviceName}" has no image to patch`);
  }
  doc.setIn(['services', serviceName, 'image'], newImageRef);
  return String(doc);
}

/** A bind mount of Sencho's own container: host path and where it appears inside. */
export interface PathMount {
  source: string;
  destination: string;
}

/** An absolute POSIX path with no `..` segment, normalized and without a trailing slash. */
function normalizeAbsolutePath(value: string): string | null {
  if (!value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) return null;
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/** Whether `child` is `parent` or sits under it, compared by whole path segment. */
export function isSameOrChildPath(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent === '/' ? '/' : `${parent}/`);
}

/**
 * Whether another mount sits over `containerPath` inside Sencho's own container:
 * its destination is the path or a parent of it, and deeper than the mount the
 * path was mapped through. What Sencho reads there is then that mount's file, not
 * the host file the label names (two mounts `/apps` and `/apps/sencho` show a
 * different `/apps/sencho/compose.yaml` than the host path under `/apps`). Every
 * mount counts, not only bind mounts: a volume or tmpfs shadows a path too.
 */
export function isShadowedByDeeperMount(
  containerPath: string,
  chosenDestination: string,
  allDestinations: ReadonlyArray<string>,
): boolean {
  for (const raw of allDestinations) {
    const destination = normalizeAbsolutePath(raw);
    if (!destination || destination.length <= chosenDestination.length) continue;
    if (isSameOrChildPath(containerPath, destination)) return true;
  }
  return false;
}

/** The mount points in a `/proc/self/mountinfo` text (field 5, with its octal escapes decoded). */
export function parseMountPoints(mountinfo: string): string[] {
  const points: string[] = [];
  for (const line of mountinfo.split('\n')) {
    const point = line.split(' ')[4];
    if (point) points.push(point.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
  }
  return points;
}

/** Where Sencho's own mounts really are, for the shadow check. */
export interface MountView {
  /** Every path a mount may sit at, to test a path against (see `resolveMountDestinations`). */
  destinations: string[];
  /** Whether a later mount hides the mount at `root`: another mount on the same path, or one on a parent path. */
  hides(root: string): boolean;
}

/**
 * Where the container's mounts really are, not only where Docker recorded them.
 * Docker lists a mount at the path it was asked for, but the runtime resolves a
 * symlink on the way (`/apps/current/sencho` with `current -> v2` lands at
 * `/apps/v2/sencho`), and two destinations can land on one path (`/run` and
 * `/var/run`). The kernel's own list in `/proc/self/mountinfo`, in mount order,
 * is the truth, and it does not move when a link is retargeted after the
 * container started.
 *
 * `destinations` holds the recorded destinations, where each resolves now, and
 * the live mount points. The live points are used only when a recorded
 * destination runs through a symlink, does not resolve, or is not itself a live
 * mount point, because only then can a recorded mount sit somewhere the recorded
 * form does not say (a link retargeted or replaced after the start). Without
 * one, every live mount that Docker did not record is a submount of a bound
 * folder, which shows the host's own file there and is not a shadow. A recorded
 * mount's own path is always a live mount point, so a `root` that is not one has
 * been hidden or replaced. Where mountinfo cannot be read, only the recorded and
 * resolved destinations are used, which is right until a link on the way is
 * retargeted.
 */
export async function resolveMountDestinations(
  destinations: ReadonlyArray<string>,
  mountinfoPath = '/proc/self/mountinfo',
): Promise<MountView> {
  let live: string[] = [];
  try {
    live = parseMountPoints(await fs.promises.readFile(mountinfoPath, 'utf8'));
  } catch {
    // Not Linux, or /proc is hidden: resolve the recorded destinations below.
  }
  let throughSymlink = false;
  const resolved: string[] = [];
  for (const raw of destinations) {
    const destination = normalizeAbsolutePath(raw);
    if (!destination) continue;
    try {
      const real = await fs.promises.realpath(destination);
      if (real !== destination) throughSymlink = true;
      resolved.push(real);
    } catch {
      throughSymlink = true;
      resolved.push(destination);
    }
  }
  const placed = live.length > 0 ? live : resolved;
  const unplaced = live.length > 0 && resolved.some(real => !live.includes(real));
  return {
    destinations: [...destinations, ...resolved, ...(throughSymlink || unplaced ? live : [])],
    hides(root) {
      const last = placed.lastIndexOf(root);
      if (last === -1) return live.length > 0;
      if (placed.indexOf(root) !== last) return true;
      // Only the live list has an order; resolved destinations do not say which mounted last.
      return live.length > 0 && live.slice(last + 1).some(point => isSameOrChildPath(root, point));
    },
  };
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Whether resolving `containerPath` below the mount at `root` passes a symlink
 * whose target is absolute, or leaves the mount, or cannot be examined (a link
 * that cannot be read, or a chain of more than 40 links). A missing path is not
 * a link; the read reports it. An
 * absolute target resolves in Sencho's own filesystem, but the host resolves it
 * in the host's, and when the mount's source and destination differ those are
 * different trees: Sencho would read a file the host path does not name.
 * Relative links that stay inside the mount resolve the same on both sides.
 */
export async function crossesAbsoluteSymlink(root: string, containerPath: string): Promise<boolean> {
  if (!isSameOrChildPath(containerPath, root)) return true;
  const pending = path.posix.relative(root, containerPath).split('/').filter(Boolean);
  let current = root;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      current = path.posix.dirname(current);
      if (!isSameOrChildPath(current, root)) return true;
      continue;
    }
    const next = path.posix.join(current, part);
    let target: string;
    try {
      target = await fs.promises.readlink(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EINVAL: not a symlink. ENOENT: nothing there, so nothing to resolve; the read reports it.
      if (code === 'EINVAL' || code === 'ENOENT') {
        current = next;
        continue;
      }
      return true;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS || target.startsWith('/')) return true;
    pending.unshift(...target.split('/').filter(Boolean));
  }
  return false;
}

/**
 * Translate a host path into the path Sencho sees it at, through the bind mount
 * with the longest matching source. A prefix only matches on a whole path
 * segment (`/opt/dock` never covers `/opt/docker/x`). Relative paths and `..`
 * segments are refused rather than resolved, so a caller never reads a file the
 * mount did not expose. A path another mount covers more deeply (see
 * `isShadowedByDeeperMount`, given every destination in the container) maps to
 * null, so the caller reads the host file through the helper instead. Returns the
 * mount's destination too, so the caller can confirm the resolved file still
 * lives under it.
 */
export function mapHostPathToContainerPath(
  hostPath: string,
  mounts: ReadonlyArray<PathMount>,
  allDestinations: ReadonlyArray<string>,
): { containerPath: string; mountDestination: string } | null {
  const host = normalizeAbsolutePath(hostPath);
  if (!host) return null;
  let best: PathMount | null = null;
  for (const mount of mounts) {
    const source = normalizeAbsolutePath(mount.source);
    const destination = normalizeAbsolutePath(mount.destination);
    if (!source || !destination || !isSameOrChildPath(host, source)) continue;
    if (!best || source.length > best.source.length) best = { source, destination };
  }
  if (!best) return null;
  const containerPath = path.posix.join(best.destination, path.posix.relative(best.source, host));
  if (isShadowedByDeeperMount(containerPath, best.destination, allDestinations)) return null;
  return { containerPath, mountDestination: best.destination };
}
