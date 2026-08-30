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

  // Extract the tag using the same logic as classifyImagePin.
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  // A colon after the last slash is a tag separator; before it is a registry port.
  const tag = lastColon > lastSlash ? ref.slice(lastColon + 1) : '';

  return tag === 'dev';
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
