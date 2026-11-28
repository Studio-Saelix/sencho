/**
 * The only shapes in which a host path may reach a recovery helper.
 *
 * A named volume is addressed by name. A host directory is addressed by one of
 * two branded records, and the helper runner refuses a plain string where a host
 * path would go:
 *
 * - `UnprovenHostPath` is a path Sencho is about to prove. Only the `probe`
 *   profile accepts it, read-only, so the proof itself can read a device and an
 *   inode and nothing else.
 * - `ProvenHostRoot` is a path whose device and inode matched Sencho's own view
 *   of the directory it authorized. `proveHostRoot` in `fsRoots.ts` is the one
 *   caller of `ProvenHostRoot.mint`; every helper run that mounts one is started
 *   through the probe's guard, which checks the same identity again inside the
 *   container before the real command runs.
 */

const DECIMAL = /^[0-9]+$/;

function requireAbsoluteHostPath(hostPath: string): string {
  if (typeof hostPath !== 'string' || !hostPath.startsWith('/') || hostPath.includes('\0')) {
    throw new Error('a host root must be an absolute path');
  }
  return hostPath;
}

/**
 * A host path whose device and inode matched Sencho's own view of the directory
 * it authorized. The private member makes the type nominal: an object literal of
 * the same shape is not one.
 */
export class ProvenHostRoot {
  readonly kind = 'proven_host_root' as const;
  private declare readonly provenBrand: never;

  private constructor(
    /** The path the Docker daemon resolves, as a bind source. */
    readonly hostPath: string,
    /** The root's device and inode as exact decimal strings. */
    readonly dev: string,
    readonly ino: string,
  ) {}

  /**
   * Mint a proven root. Call only after the identity proof has compared the
   * daemon's view of `hostPath` with Sencho's own view of the authorized directory.
   */
  static mint(hostPath: string, dev: string, ino: string): ProvenHostRoot {
    if (!DECIMAL.test(dev) || !DECIMAL.test(ino)) throw new Error('a proven root needs a decimal device and inode');
    return new ProvenHostRoot(requireAbsoluteHostPath(hostPath), dev, ino);
  }

  /** The identity the guard compares, `<dev>:<ino>`. */
  identity(): string {
    return `${this.dev}:${this.ino}`;
  }
}

/** A host path the proof probe may read, and nothing else may. */
export class UnprovenHostPath {
  readonly kind = 'unproven_host_path' as const;
  private declare readonly unprovenBrand: never;

  private constructor(readonly hostPath: string) {}

  static of(hostPath: string): UnprovenHostPath {
    return new UnprovenHostPath(requireAbsoluteHostPath(hostPath));
  }
}

/** What a helper mount slot may hold: a volume name, or a branded host path. */
export type HelperMountSource = string | ProvenHostRoot | UnprovenHostPath;

/** A short, log-safe description of a mount source. */
export function describeMountSource(source: HelperMountSource | undefined): string {
  if (source === undefined) return 'none';
  if (typeof source === 'string') return source;
  return source.hostPath;
}
