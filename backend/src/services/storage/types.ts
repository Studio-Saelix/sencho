import type { EffStorageMount } from '../preflight/effectiveModel';

/** Resolved type of a host path behind a bind mount. */
export type HostPathKind = 'file' | 'directory' | 'socket' | 'symlink' | 'missing' | 'unknown';

/**
 * Existence/type/ownership of a bind-mount host source. Resolved ONLY for
 * sources lexically inside the stack's own directory; absolute external paths
 * are outside Sencho's filesystem view and are left unverified. Never reads the
 * path's content.
 */
export interface HostPathProbe {
  /** True when the source path lexically resolves inside the stack's own directory. */
  lexicalWithinStackDir: boolean;
  /** True when the resolved (symlink-followed) target still sits inside the stack dir. */
  withinStackDir: boolean;
  /** Existence is only probed for within-stack-dir sources; external paths stay false (unverifiable). */
  exists: boolean;
  kind: HostPathKind;
  /** True when a within-stack symlink points (resolved, or for a broken link its readlink target) outside the stack dir. */
  escapes: boolean;
  /** POSIX owner uid/gid and octal mode when statted; null on Windows or for unverified paths. */
  uid: number | null;
  gid: number | null;
  mode: string | null;
}

/** One mount in the storage inventory: the parsed mount, its service, and (binds only) the host-path probe. */
export interface StorageMount extends EffStorageMount {
  service: string;
  /** Probe for bind sources; null for named/anonymous/tmpfs mounts. */
  probe: HostPathProbe | null;
  /** True when this named mount references a top-level `external: true` volume. */
  externalNamed: boolean;
}

export type PortabilityStatus = 'portable' | 'partially-portable' | 'node-bound' | 'unknown';

export interface PortabilityVerdict {
  status: PortabilityStatus;
  /** Every reason that applies, so the UI can list all contributing factors. */
  reasons: string[];
}

/** Per-stack storage inventory returned by GET /api/stacks/:stackName/storage. */
export interface StorageInventory {
  stack: string;
  renderable: boolean;
  /** Redacted, structural render error when `renderable` is false; never raw docker stderr. */
  renderError: string | null;
  /** True when the stack has any bind/named/anonymous mount (tmpfs-only and no-mounts are stateless). */
  stateful: boolean;
  mounts: StorageMount[];
  portability: PortabilityVerdict;
}

/** A bind/target referencing the Docker socket grants root-equivalent host control and is node-bound. */
export function isDockerSocketMount(m: Pick<EffStorageMount, 'source' | 'target'>): boolean {
  return (m.source?.includes('docker.sock') ?? false) || m.target.includes('docker.sock');
}
