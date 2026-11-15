import type Docker from 'dockerode';
import {
  fsGenerationChanged,
  locateStoredFsRoot,
  nestedMountExclusions,
  observeFsRootInUse,
  proveHostRoot,
  readFsRootEnvironment,
  readOwnMounts,
  resolveFsRootDependents,
  storedFsRootSenchoPath,
  type FsRootEnvironment,
} from './fsRoots';
import {
  describeStoredLocator,
  generationTokenMatchesVolume,
  resolveVolumeDependents,
  type DependentResolution,
  type InUseObservation,
} from './volumeSources';
import type { ResticHostRootDeps } from './restic/ResticEngine';
import type { RecoveryHelperRunner } from './restic/helperRunner';
import type { StorageIdentity, StorageKind } from './types';

/**
 * The one seam between the recovery engine and the kind of storage it protects.
 *
 * Routes, the operation runner and the overwrite pipeline ask these questions of
 * a stored identity and never branch on its kind themselves. The named-volume
 * adapter wraps the functions volumes always used, unchanged; the host-directory
 * adapter answers from `fsRoots.ts`.
 */
export interface StorageAdapterContext {
  nodeId: number;
  docker: Docker;
  knownStackNames: readonly string[];
  ownerNodeKey: string;
}

export interface StorageAdapter {
  readonly kind: StorageKind;
  /**
   * Every stack that depends on the stored storage now. `render` renders every
   * stack's model (a decision to change or read data); without it a listing or a
   * read of recorded work uses what is cached.
   */
  dependents(storage: StorageIdentity, options: { render: boolean }): Promise<DependentResolution>;
  /** Whether a listing can already see that the storage was recreated, without starting a helper. */
  liveGenerationChanged(storage: StorageIdentity): Promise<boolean>;
}

/**
 * Whether a resolution leaves the caller to the node-wide check: a model that
 * would not render makes the dependent set unknown, and a container no stack
 * owns depends on a host directory.
 */
export function requiresNodeWideCheck(resolution: DependentResolution): boolean {
  if (resolution.kind === 'unrenderable') return true;
  return resolution.unownedContainer === true;
}

class NamedVolumeAdapter implements StorageAdapter {
  readonly kind = 'named_volume' as const;
  constructor(private readonly ctx: StorageAdapterContext) {}

  async dependents(storage: StorageIdentity, options: { render: boolean }): Promise<DependentResolution> {
    // The volume may be gone by now (that is when a point is needed), so the
    // stored locator is described, not required.
    const described = await describeStoredLocator({
      docker: this.ctx.docker,
      ownerNodeKey: this.ctx.ownerNodeKey,
      locator: storage.locator,
    });
    return resolveVolumeDependents({
      nodeId: this.ctx.nodeId,
      ownerNodeKey: this.ctx.ownerNodeKey,
      knownStackNames: this.ctx.knownStackNames,
      volumeName: storage.locator,
      volumeLabels: described.labels,
      render: options.render,
      docker: this.ctx.docker,
    });
  }

  async liveGenerationChanged(storage: StorageIdentity): Promise<boolean> {
    const described = await describeStoredLocator({
      docker: this.ctx.docker,
      ownerNodeKey: this.ctx.ownerNodeKey,
      locator: storage.locator,
    });
    return !generationTokenMatchesVolume(storage.generationToken, described.createdAt);
  }
}

class HostDirectoryAdapter implements StorageAdapter {
  readonly kind = 'bind_root' as const;
  private environment: Promise<FsRootEnvironment> | null = null;
  constructor(private readonly ctx: StorageAdapterContext) {}

  private env(): Promise<FsRootEnvironment> {
    if (!this.environment) this.environment = readFsRootEnvironment(this.ctx.nodeId, this.ctx.docker);
    return this.environment;
  }

  async dependents(storage: StorageIdentity, options: { render: boolean }): Promise<DependentResolution> {
    const environment = await this.env();
    const senchoPath = await storedFsRootSenchoPath(storage.locator, environment);
    // A root Sencho can no longer place in its own namespace cannot be matched
    // against any stack, so only the recorded dependents and the containers
    // speak for it, and the answer is unknown: the node-wide check applies.
    const resolution = await resolveFsRootDependents({
      nodeId: this.ctx.nodeId,
      storageKey: storage.storageKey,
      knownStackNames: this.ctx.knownStackNames,
      root: { senchoPath: senchoPath ?? storage.locator, hostPath: storage.locator, aliases: [] },
      render: options.render,
      onlyStacks: senchoPath === null ? [] : undefined,
      docker: this.ctx.docker,
      environment,
    });
    if (senchoPath === null) return { ...resolution, kind: 'unrenderable', stackName: '' };
    return resolution;
  }

  async liveGenerationChanged(storage: StorageIdentity): Promise<boolean> {
    const senchoPath = await storedFsRootSenchoPath(storage.locator, await this.env());
    if (senchoPath === null) return true;
    return fsGenerationChanged(storage.generationToken, senchoPath);
  }
}

/** The adapter for a stored identity's kind. */
export function storageAdapterFor(kind: StorageKind, ctx: StorageAdapterContext): StorageAdapter {
  return kind === 'bind_root' ? new HostDirectoryAdapter(ctx) : new NamedVolumeAdapter(ctx);
}

/**
 * The engine's host-directory dependencies. Each capture proves the stored root
 * again (the admission proved it with every declared alias), lists the mounts
 * below it, and re-reads the token after the bytes were read.
 */
export function hostRootEngineDeps(ctx: { docker: Docker; runner: () => RecoveryHelperRunner }): ResticHostRootDeps {
  return {
    prepareSource: async (storage, engineCtx) => {
      const location = await locateStoredFsRoot(storage.locator);
      const proven = await proveHostRoot({
        runner: ctx.runner(),
        operationId: engineCtx.operationId,
        senchoPath: location.senchoPath,
        hostPath: location.hostPath,
        signal: engineCtx.signal,
      });
      const exclusions = await nestedMountExclusions({
        runner: ctx.runner(),
        operationId: engineCtx.operationId,
        root: proven.root,
        signal: engineCtx.signal,
      });
      return { root: proven.root, exclusions };
    },
    readGenerationToken: async (storage, engineCtx) => {
      const location = await locateStoredFsRoot(storage.locator);
      const proven = await proveHostRoot({
        runner: ctx.runner(),
        operationId: engineCtx.operationId,
        senchoPath: location.senchoPath,
        hostPath: location.hostPath,
        signal: engineCtx.signal,
      });
      return proven.generationToken;
    },
    observeInUse: async (storage): Promise<InUseObservation> => {
      const location = await locateStoredFsRoot(storage.locator);
      return observeFsRootInUse({ docker: ctx.docker, root: location, ownMounts: await readOwnMounts() });
    },
  };
}
