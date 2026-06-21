/**
 * StackFileRootsService: discovers the safe, stack-scoped file "roots" the
 * Files & Volumes explorer can browse for a given stack. A root is either the
 * stack source directory, a declared bind-mount host directory, or a named
 * Docker volume. Discovery is the single server-side source of truth for which
 * paths a file operation may touch: the route always re-derives the allowed
 * roots and matches the client `rootId` against them, so a client can never
 * address a path the stack itself did not declare.
 *
 * Reuses the rendered effective model (`parseEffectiveModel`) and
 * `isDockerSocketMount` from the storage feature so it never re-implements mount
 * parsing. Bind browse-accessibility uses its own `probeBindRootAccess` (NOT the
 * portability-focused `probeHostPath`, which refuses to probe sources outside
 * the stack dir).
 */
import path from 'path';
import { promises as fsPromises } from 'fs';
import { createHash } from 'crypto';

import { NodeRegistry } from './NodeRegistry';
import { FileSystemService } from './FileSystemService';
import { ComposeService } from './ComposeService';
import DockerController from './DockerController';
import { parseEffectiveModel, type EffectiveModel } from './preflight/effectiveModel';
import { isDockerSocketMount } from './storage/types';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { isDebugEnabled } from '../utils/debug';

export interface RootMount {
  service: string;
  containerPath: string;
  readOnly: boolean;
}

export interface StackFileRoot {
  /** Opaque, server-minted id. The resolved path/name lives in metadata, never in the id. */
  id: string;
  kind: 'stack-source' | 'bind' | 'volume';
  label: string;
  /** Absolute host path (bind), resolved Docker volume name (volume), or stack dir (stack-source). */
  hostPathOrName: string;
  /** Every service/containerPath/readOnly declaration that maps to this resolved source. */
  mounts: RootMount[];
  /** Aggregate: true only when EVERY declaration is read-only. */
  readonly: boolean;
  /** Bind: a stat-able directory reachable by Sencho. Volume: the helper can inspect it. */
  accessible: boolean;
  browsable: boolean;
  writable: boolean;
  /** fs roots only (POSIX chmod is unsupported on helper-backed volume roots). */
  chmodable: boolean;
  dangerous: boolean;
  /** Bind overlaps Sencho's managed compose base / a stack dir, so it is suppressed. */
  managedSourceOverlap: boolean;
  warning: string | null;
  backend: 'fs' | 'helper';
}

export const STACK_SOURCE_ROOT_ID = 'stack-source';

/**
 * The stack-source root. `hostPathOrName` is informational (the gateway scopes
 * stack-source ops to the stack dir via FileSystemService, not this field), so
 * the route can build a synthetic one without resolving the compose base dir.
 */
export function stackSourceFileRoot(hostPathOrName = ''): StackFileRoot {
  return {
    id: STACK_SOURCE_ROOT_ID,
    kind: 'stack-source',
    label: 'Stack source',
    hostPathOrName,
    mounts: [],
    readonly: false,
    accessible: true,
    browsable: true,
    writable: true,
    chmodable: true,
    dangerous: false,
    managedSourceOverlap: false,
    warning: null,
    backend: 'fs',
  };
}

const ROOTS_CACHE_TTL_MS = 15_000;

// Dangerous host directories: a bind equal to or under any of these grants
// node-level access and is never browsable. The docker socket is caught
// separately via isDockerSocketMount on the declared source.
const DANGEROUS_ROOTS = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/run'];

interface CacheEntry {
  roots: StackFileRoot[];
  expiresAt: number;
}

// Module-level cache: getInstance(nodeId) returns a fresh service each call (like
// FileSystemService), so the cache must outlive the instance. Keyed by node+stack.
const rootsCache = new Map<string, CacheEntry>();

/**
 * Sencho's writable data directory (sencho.db, encryption.key, backups). Mirrors
 * the resolution DatabaseService / FileSystemService use, so a bind mount that
 * points at it is recognised as a managed-area overlap and never browsable.
 */
function resolveDataDir(): string {
  return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
}

/** A bind source equal to or under one of the dangerous roots (POSIX semantics). */
export function isDangerousHostPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  if (norm === '/') return true;
  return DANGEROUS_ROOTS.some((d) => norm === d || norm.startsWith(`${d}/`));
}

/**
 * Browse-accessibility probe for a bind root, scoped to the compose base dir.
 * The realpath/stat run ONLY for a source that lexically resolves inside
 * `baseDir`: in the containerized deployment that is the only host area the
 * Sencho process can reach, so a source outside it is unreachable anyway and is
 * reported non-accessible without touching the filesystem. The containment is
 * an INLINE path.resolve + startsWith guard at each filesystem sink (the
 * realpath of a within-base symlink can still escape, so the resolved canonical
 * is re-checked before stat). Returns the canonical realpath so the route can
 * pass it to FileSystemService as the containment root.
 */
export async function probeBindRootAccess(
  absPath: string,
  baseDir: string,
): Promise<{ canonical: string; accessible: boolean; isDir: boolean }> {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(absPath);
  // Out-of-base sources keep their original path for the dangerous/overlap
  // classification the caller does, but are never statted.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return { canonical: absPath, accessible: false, isDir: false };
  }
  // A missing path (ENOENT) is the common, expected "not reachable" outcome and
  // is left silent; any other code (e.g. EACCES on a path that exists but Sencho
  // cannot read) is logged so an operator chasing "why can't I browse this bind"
  // has a trail, while the root still degrades gracefully to non-browsable.
  const logNonEnoent = (stage: string, err: unknown): void => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[StackFileRoots] bind %s failed (%s):', stage, code ?? 'unknown', sanitizeForLog(resolved));
    }
  };
  let canonical: string;
  try {
    canonical = await fsPromises.realpath(resolved);
  } catch (err) {
    logNonEnoent('realpath', err);
    return { canonical: resolved, accessible: false, isDir: false };
  }
  // A within-base source can be a symlink whose target escapes the base; re-check
  // the resolved canonical inline before the stat sink.
  if (canonical !== base && !canonical.startsWith(base + path.sep)) {
    return { canonical, accessible: false, isDir: false };
  }
  try {
    const st = await fsPromises.stat(canonical);
    return { canonical, accessible: true, isDir: st.isDirectory() };
  } catch (err) {
    logNonEnoent('stat', err);
    return { canonical, accessible: false, isDir: false };
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function debugCount(event: string, stackName: string): void {
  if (isDebugEnabled()) {
    console.debug('[StackFileRoots:debug] %s for %s', event, sanitizeForLog(stackName));
  }
}

export class StackFileRootsService {
  private nodeId: number;

  private constructor(nodeId: number) {
    this.nodeId = nodeId;
  }

  static getInstance(nodeId?: number): StackFileRootsService {
    return new StackFileRootsService(nodeId ?? NodeRegistry.getInstance().getDefaultNodeId());
  }

  /** Drop the cached allowlist for a stack so a changed mount stops being addressable immediately. */
  static invalidate(nodeId: number, stackName: string): void {
    rootsCache.delete(`${nodeId}:${stackName}`);
  }

  invalidate(stackName: string): void {
    StackFileRootsService.invalidate(this.nodeId, stackName);
  }

  private cacheKey(stackName: string): string {
    return `${this.nodeId}:${stackName}`;
  }

  private stackSourceRoot(stackDir: string): StackFileRoot {
    return stackSourceFileRoot(stackDir);
  }

  /**
   * Render the merged effective model on the owning node. Returns null on any
   * render/parse failure (so discovery degrades to stack-source only); never
   * throws and never surfaces raw stderr.
   */
  private async renderModel(stackName: string): Promise<EffectiveModel | null> {
    try {
      const result = await ComposeService.getInstance(this.nodeId).renderConfig(stackName);
      if (result.rendered === null) return null;
      return parseEffectiveModel(JSON.parse(result.rendered), stackName);
    } catch (err) {
      console.warn('[StackFileRoots] Model render failed for %s:',
        sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(err, 'unknown')));
      return null;
    }
  }

  async listRoots(stackName: string, opts: { fresh?: boolean } = {}): Promise<StackFileRoot[]> {
    if (!isValidStackName(stackName)) {
      throw Object.assign(new Error('Invalid stack name'), { code: 'INVALID_STACK_NAME' });
    }

    const key = this.cacheKey(stackName);
    if (!opts.fresh) {
      const cached = rootsCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        debugCount('cache hit', stackName);
        return cached.roots;
      }
    }
    debugCount(opts.fresh ? 'fresh' : 'cache miss', stackName);

    const baseDir = FileSystemService.getInstance(this.nodeId).getBaseDir();
    const stackDir = path.join(baseDir, stackName);
    const roots: StackFileRoot[] = [this.stackSourceRoot(stackDir)];

    const model = await this.renderModel(stackName);
    if (!model) {
      // Render failure: only the stack-source root survives (never depends on a
      // render). Cache the stack-source-only result, never a stale allowlist.
      debugCount('render failure', stackName);
      rootsCache.set(key, { roots, expiresAt: Date.now() + ROOTS_CACHE_TTL_MS });
      return roots;
    }

    roots.push(...(await this.discoverVolumeRoots(model, baseDir, stackDir)));
    rootsCache.set(key, { roots, expiresAt: Date.now() + ROOTS_CACHE_TTL_MS });
    return roots;
  }

  /**
   * Resolve a client-supplied rootId to a server-derived root. Throws INVALID_ROOT
   * for an unknown/forged id. Writes pass `fresh: true` to bypass the cache, so a
   * removed mount can never be written through a stale allowlist.
   */
  async resolveRoot(stackName: string, rootId: string, opts: { fresh?: boolean } = {}): Promise<StackFileRoot> {
    if (!isValidStackName(stackName)) {
      throw Object.assign(new Error('Invalid stack name'), { code: 'INVALID_STACK_NAME' });
    }
    // The stack-source root never depends on a compose render, so resolve it
    // directly. This keeps plain stack-source file ops (the common case, and all
    // existing API clients that send no rootId) off the docker-compose render
    // path entirely.
    if (rootId === STACK_SOURCE_ROOT_ID) {
      const baseDir = FileSystemService.getInstance(this.nodeId).getBaseDir();
      return this.stackSourceRoot(path.join(baseDir, stackName));
    }
    const roots = await this.listRoots(stackName, opts);
    const root = roots.find((r) => r.id === rootId);
    if (!root) {
      throw Object.assign(new Error('Unknown file root'), { code: 'INVALID_ROOT' });
    }
    return root;
  }

  private async discoverVolumeRoots(
    model: EffectiveModel,
    baseDir: string,
    stackDir: string,
  ): Promise<StackFileRoot[]> {
    interface BindGroup {
      canonical: string;
      accessible: boolean;
      isDir: boolean;
      dockerSock: boolean;
      mounts: RootMount[];
    }
    const probeByRaw = new Map<string, { canonical: string; accessible: boolean; isDir: boolean }>();
    const bindByCanonical = new Map<string, BindGroup>();
    const volByName = new Map<string, { name: string; mounts: RootMount[] }>();

    for (const svc of model.services) {
      for (const m of svc.storageMounts ?? []) {
        const mount: RootMount = { service: svc.name, containerPath: m.target, readOnly: m.readOnly };
        if (m.type === 'bind' && m.source) {
          const rawAbs = path.isAbsolute(m.source) ? m.source : path.resolve(stackDir, m.source);
          let probe = probeByRaw.get(rawAbs);
          if (!probe) {
            probe = await probeBindRootAccess(rawAbs, baseDir);
            probeByRaw.set(rawAbs, probe);
          }
          let group = bindByCanonical.get(probe.canonical);
          if (!group) {
            group = {
              canonical: probe.canonical,
              accessible: probe.accessible,
              isDir: probe.isDir,
              dockerSock: false,
              mounts: [],
            };
            bindByCanonical.set(probe.canonical, group);
          }
          group.mounts.push(mount);
          if (isDockerSocketMount({ source: m.source, target: m.target })) group.dockerSock = true;
        } else if (m.type === 'named' && m.source) {
          const resolvedName = model.volumes[m.source]?.name ?? m.source;
          let group = volByName.get(resolvedName);
          if (!group) {
            group = { name: resolvedName, mounts: [] };
            volByName.set(resolvedName, group);
          }
          group.mounts.push(mount);
        }
        // anonymous / tmpfs mounts have no stable browse target and are skipped.
      }
    }

    const roots: StackFileRoot[] = [];
    for (const group of bindByCanonical.values()) {
      const root = this.buildBindRoot(group, baseDir, stackDir);
      if (root) roots.push(root);
    }
    for (const group of volByName.values()) {
      roots.push(await this.buildVolumeRoot(group));
    }
    return roots;
  }

  private buildBindRoot(
    group: { canonical: string; accessible: boolean; isDir: boolean; dockerSock: boolean; mounts: RootMount[] },
    baseDir: string,
    stackDir: string,
  ): StackFileRoot | null {
    const { canonical } = group;

    // A bind equal to the stack dir is already served (with protected-file
    // enforcement) by the stack-source root; do not expose a second, unprotected
    // editable root for it.
    if (canonical === stackDir) return null;

    const inStack = isPathWithinBase(canonical, stackDir); // strictly within (equal handled above)
    // A bind that overlaps Sencho's own managed areas (the compose base dir, a
    // sibling stack, or the data dir that holds sencho.db / encryption.key) must
    // never become a browsable/editable root. Compare in both directions so a
    // mount equal to, inside, or an ancestor of a managed dir is caught.
    const dataDir = resolveDataDir();
    const overlapsManaged = (dir: string): boolean => isPathWithinBase(canonical, dir) || isPathWithinBase(dir, canonical);
    const overlap = !inStack && (overlapsManaged(baseDir) || overlapsManaged(dataDir));
    const dangerous = isDangerousHostPath(canonical) || group.dockerSock;
    const readonly = group.mounts.every((m) => m.readOnly);
    const isFile = group.accessible && !group.isDir;

    let warning: string | null = null;
    if (overlap) {
      warning = "This mount overlaps Sencho's managed stack area. Browse the owning stack's source instead.";
    } else if (dangerous) {
      warning = 'This mount targets a protected host path and cannot be browsed.';
    } else if (!group.accessible) {
      warning = 'Sencho cannot access this host path. Bind it into the Sencho container to browse it.';
    } else if (isFile) {
      warning = 'This bind mount targets a single file, not a directory.';
    }

    const browsable = group.accessible && group.isDir && !dangerous && !overlap;
    const writable = browsable && !readonly;
    const label = group.mounts[0]?.containerPath || path.basename(canonical) || canonical;

    return {
      id: `bind:${shortHash(canonical)}`,
      kind: 'bind',
      label,
      hostPathOrName: canonical,
      mounts: group.mounts,
      readonly,
      accessible: group.accessible,
      browsable,
      writable,
      chmodable: browsable,
      dangerous,
      managedSourceOverlap: overlap,
      warning,
      backend: 'fs',
    };
  }

  private async buildVolumeRoot(group: { name: string; mounts: RootMount[] }): Promise<StackFileRoot> {
    let accessible = false;
    let warning: string | null = null;
    try {
      await DockerController.getInstance(this.nodeId).getDocker().getVolume(group.name).inspect();
      accessible = true;
    } catch (err) {
      // Distinguish a genuine 404 (volume absent) from a transient Docker failure
      // (daemon unreachable, proxy hop down) so the warning is honest and a
      // non-404 leaves a server-side trail rather than silently reading as "gone".
      const e = err as { statusCode?: number; message?: string };
      const notFound = e.statusCode === 404 || /no such volume/i.test(e.message ?? '');
      if (!notFound) {
        console.warn('[StackFileRoots] volume inspect failed for %s:',
          sanitizeForLog(group.name), sanitizeForLog(getErrorMessage(err, 'unknown')));
      }
      warning = notFound
        ? 'Sencho could not resolve this named volume on the owning node.'
        : 'Sencho could not reach Docker to resolve this named volume; it may be temporarily unavailable.';
    }
    const readonly = group.mounts.every((m) => m.readOnly);
    const browsable = accessible;
    return {
      id: `volume:${shortHash(group.name)}`,
      kind: 'volume',
      label: group.name,
      hostPathOrName: group.name,
      mounts: group.mounts,
      readonly,
      accessible,
      browsable,
      writable: browsable && !readonly,
      chmodable: false,
      dangerous: false,
      managedSourceOverlap: false,
      warning,
      backend: 'helper',
    };
  }
}
