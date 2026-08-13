import Docker from 'dockerode';
import WebSocket from 'ws';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import * as yaml from 'yaml';

import { NodeRegistry } from './NodeRegistry';
import { CacheService } from './CacheService';
import { FileSystemService } from './FileSystemService';
import SelfIdentityService from './SelfIdentityService';
import {
  fingerprintPrunePlan,
  normalizePruneTargets,
  projectPruneOwnershipLabels,
  pruneImageReferencesEqual,
  PRUNEABLE_CONTAINER_STATES,
  PrunePlanStaleError,
  type PruneItemOutcome,
  type PrunePlan,
  type PrunePlanItem,
  type PruneScope,
  type PruneTarget,
} from './prunePlan';
import type { NetworkingNetworkBase } from './network/networkingTypes';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { describeSpawnError } from '../utils/spawnErrors';
import { authoredComposeFileArgs, authoredComposeEnvFileArgs } from '../utils/authoredComposeArgs';
import { isFullySyntheticHoldImage } from '../utils/senchoRollbackHold';
import { isValidDockerNetworkName } from './network/dockerNetworkName';

export type {
  PruneItemOutcome,
  PrunePlan,
  PrunePlanItem,
  PruneScope,
  PruneTarget,
} from './prunePlan';
export { PrunePlanStaleError } from './prunePlan';
import {
  buildManagedImageRepoSet,
  classifyManagedImageCandidate,
  managedImagePlanReason,
  type ManagedContainerForAttribution,
} from '../helpers/managedImageAttribution';

/** Parsed row from `docker compose ps --format json`. */
interface ComposePsContainer {
  ID?: string;
  Name?: string;
  Service?: string;
  State?: string;
  Status?: string;
  Publishers?: { URL?: string; TargetPort?: number; PublishedPort?: number; Protocol?: string }[];
}

const execFileAsync = promisify(execFile);
const COMPOSE_DIR = process.env.COMPOSE_DIR || '/app/compose';

/** Canonical compose file name variants, checked in priority order. */
const COMPOSE_FILE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const;

/** Cached mapping from compose `name:` field to stack directory name. TTL-based to avoid re-parsing YAML on every poll. */
const PROJECT_NAME_CACHE_TTL_MS = 60_000;
const PROJECT_NAME_CACHE_KEY = 'project-name-map';
/** How long a resolved container StartedAt stays fresh before re-inspecting. */
const STARTED_AT_CACHE_TTL_MS = 20_000;
/** Cap on concurrent inspect() calls when resolving StartedAt in bulk. */
const STARTED_AT_INSPECT_CONCURRENCY = 10;

/** Common web-UI private ports, checked in priority order when detecting the main app port. */
const WEB_UI_PORTS = [32400, 8989, 7878, 9696, 5055, 8080, 80, 443, 3000, 9000];
/** Ports that should never be treated as the main app port. */
const IGNORE_PORTS = [1900, 53, 22];

/**
 * Pick the published host port most likely to be a web UI, in priority order,
 * skipping UDP (not browser-openable) and deprioritizing system ports, falling
 * back to the first TCP port when nothing better matches. Returns the chosen
 * PublicPort, or undefined when no TCP port qualifies.
 */
export function selectMainWebPort(
  ports: { PrivatePort?: number; PublicPort?: number; Type?: string }[],
): number | undefined {
  const tcp = ports.filter(p => p.Type !== 'udp');
  let match = tcp.find(p => p.PrivatePort && WEB_UI_PORTS.includes(p.PrivatePort));
  if (!match) match = tcp.find(p => p.PublicPort && WEB_UI_PORTS.includes(p.PublicPort));
  if (!match) match = tcp.find(p =>
    (!p.PrivatePort || !IGNORE_PORTS.includes(p.PrivatePort)) &&
    (!p.PublicPort || !IGNORE_PORTS.includes(p.PublicPort)),
  );
  const chosen = match || tcp[0];
  return chosen?.PublicPort;
}

/**
 * Pull the exit code out of a Docker container Status string. listContainers
 * exposes the code only inside Status (e.g. "Exited (137) 2 minutes ago"); the
 * structured code would otherwise need a per-container inspect. Returns null when
 * no parenthesized code is present (e.g. "Up 3 hours", "Created").
 */
export function parseExitCode(status: string | undefined): number | null {
  if (!status) return null;
  const match = /\((\d+)\)/.exec(status);
  return match ? Number(match[1]) : null;
}

/**
 * Whether a container represents a genuine failure (a crash) rather than a clean
 * completion. A dead container always counts. An exited or restarting container
 * counts only when it left with a non-zero exit code (read from its Status
 * string), so a finished init job (exit 0) or a container cleanly cycling under a
 * restart policy does not mark its stack as degraded, while a crash loop (e.g.
 * "Restarting (1)") does. An exited or restarting container with an unreadable
 * code is treated as failed, erring toward surfacing a crash.
 */
export function isContainerFailed(state: string, status: string | undefined): boolean {
  if (state === 'dead') return true;
  if (state === 'exited' || state === 'restarting') {
    const code = parseExitCode(status);
    return code === null ? true : code !== 0;
  }
  return false;
}

export interface BulkStackInfo {
  status: 'running' | 'exited' | 'unknown' | 'partial';
  mainPort?: number;
  /** Unix seconds of the oldest running container's last start (approximates stack uptime). */
  runningSince?: number;
  /** Running container count for the stack (set when the stack has containers). */
  running?: number;
  /** Total container count for the stack; paired with `running` for the sidebar tooltip. */
  total?: number;
  /** True when this stack is the running Sencho instance (compose project matches stack name). */
  isSelf?: boolean;
}

export interface ClassifiedImage {
  Id: string;
  RepoTags: string[];
  Size: number;
  Containers: number;
  /** Deduped, localeCompare-sorted Sencho stacks that currently use this image. */
  usedByStacks: string[];
  /** First entry of usedByStacks, or null when unused / unmanaged-only. */
  managedBy: string | null;
  managedStatus: 'managed' | 'unmanaged' | 'unused';
  isSencho: boolean;
  /** True when a StackUpdateRecoveryService/ServiceUpdateRecoveryService hold protects this image from pruning. Additive: does not change managedStatus semantics. */
  rollbackProtected: boolean;
  rollbackProtectionKind?: 'stack' | 'service';
}

export interface PortInUseInfo {
  stack: string | null;
  container: string;
}

export interface ClassifiedVolume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Size: number;
  CreatedAt: string | null;
  managedBy: string | null;
  managedStatus: 'managed' | 'unmanaged';
  isSencho: boolean;
}

export interface ClassifiedNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  managedBy: string | null;
  managedStatus: 'managed' | 'unmanaged' | 'system';
  isSencho: boolean;
}

export interface TopologyContainer {
  id: string;
  name: string;
  ip: string;
  state: string;
  image: string;
  stack: string | null;
}

export interface TopologyNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  managedBy: string | null;
  managedStatus: 'managed' | 'unmanaged' | 'system';
  containers: TopologyContainer[];
}

/** A host-published port binding on a container. */
export interface DependencyPort {
  /** Host interface the port binds to ('' or '0.0.0.0'/'::' means all interfaces). */
  ip: string;
  publishedPort: number;
  privatePort: number | null;
  protocol: string;
}

/** A container as seen by the dependency map: compose identity plus its real
 *  runtime network/volume names and published ports. */
export interface DependencyContainer {
  id: string;
  name: string;
  /** com.docker.compose.service label, or null for non-compose containers. */
  service: string | null;
  /** Raw com.docker.compose.project label (may not map to a known stack). */
  composeProject: string | null;
  /** Resolved Sencho stack, or null when the container is not Sencho-managed. */
  stack: string | null;
  state: string;
  /**
   * Exit code from list Status when a parenthesized code is present
   * (e.g. "Exited (0) …", "Restarting (1) …"); null when none (e.g. "Up …", bare "Exited").
   * Required so Drift can fail closed on unknown codes.
   */
  exitCode: number | null;
  image: string;
  networks: { name: string; id: string; ip: string }[];
  /** Named-volume sources mounted by the container (bind mounts excluded). */
  volumes: string[];
  ports: DependencyPort[];
}

export interface DependencyNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  isSystem: boolean;
  ingress?: boolean;
  enableIPv6?: boolean;
  /** Raw com.docker.compose.project label (may not map to a known stack). */
  composeProject: string | null;
  /** Resolved Sencho stack this network belongs to, or null. */
  stack: string | null;
}

export interface DependencyVolume {
  name: string;
  driver: string;
  composeProject: string | null;
  /** Resolved Sencho stack this volume belongs to, or null. */
  stack: string | null;
}

/** One node-scoped snapshot of everything the dependency map needs. */
export interface DependencySnapshot {
  containers: DependencyContainer[];
  networks: DependencyNetwork[];
  volumes: DependencyVolume[];
}

export type NetworkDriver = 'bridge' | 'overlay' | 'macvlan' | 'host' | 'none';

export interface CreateNetworkOptions {
  Name: string;
  Driver?: NetworkDriver;
  IPAM?: {
    Config: Array<{
      Subnet?: string;
      Gateway?: string;
      IPRange?: string;
    }>;
  };
  Labels?: Record<string, string>;
  Internal?: boolean;
  Attachable?: boolean;
}

export interface LabelInventoryRow {
  id: string;
  name: string;
  state: string;
  stack: string | null;
  service: string | null;
  labels: Record<string, string>;
  imageId: string;
  inspectFailed: boolean;
}

class DockerController {
  private static readonly SYSTEM_NETWORKS = new Set(['bridge', 'host', 'none']);
  /**
   * Cache of container last-start times (unix seconds), keyed by `${nodeId}:${containerId}`.
   * Static because getInstance() hands out throwaway instances per request; the cache must
   * outlive them so status polls do not re-inspect every container every few seconds.
   */
  private static startedAtCache = new Map<string, { startedAtSeconds: number; cachedAtMs: number }>();
  private docker: Docker;
  private nodeId: number;

  private constructor(nodeId: number) {
    this.nodeId = nodeId;
    this.docker = NodeRegistry.getInstance().getDocker(nodeId);
  }

  public static getInstance(nodeId?: number): DockerController {
    const id = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
    return new DockerController(id);
  }

  public getDocker(): Docker {
    return this.docker;
  }

  private validateApiData<T>(data: any): T {
    // If the daemon port points to a web server (like Sencho UI), Dockerode receives HTML
    if (typeof data === 'string') {
      throw new Error("Invalid response from Docker API. Did you provide a web port instead of the Docker daemon port?");
    }
    return data as T;
  }

  /**
   * Docker daemon disk usage, with an optional rollback-hold exclusion.
   * `excludeHeldImages` makes the figure mean "what a prune can actually
   * free": rollback-held images (sencho-rb/*:hold) are counted by the daemon
   * as unused but every Sencho prune path refuses to remove them, so figures
   * that claim prunability must subtract them. The default keeps the raw
   * daemon math for callers whose claim is "unused Docker data" (the
   * MonitorService janitor alert), not "what a prune frees".
   */
  public async getDiskUsage(opts?: { excludeHeldImages: boolean }) {
    const df = await this.docker.df();

    const reclaimableContainers = (items: any[]) => {
      if (!items || !Array.isArray(items)) return { bytes: 0, count: 0 };
      // Count only the containers `docker container prune` will actually
      // remove: created, exited, and dead. A paused or restarting container
      // survives the prune, so counting it leaves a residue the banner can
      // never clear no matter which prune the operator runs.
      const prunableStates = new Set(['created', 'exited', 'dead']);
      const reclaimable = items.filter(i => prunableStates.has(String(i.State).toLowerCase()));
      // Size by the writable layer only. `docker system df` reports a stopped
      // container's reclaimable as its SizeRw; SizeRootFs additionally includes
      // the read-only image layers, which removing the container never frees,
      // so using it over-reports what a prune actually reclaims.
      const bytes = reclaimable.reduce((acc, item) => {
        const size = typeof item.SizeRw === 'number' && item.SizeRw > 0 ? item.SizeRw : 0;
        return acc + size;
      }, 0);
      return { bytes, count: reclaimable.length };
    };

    // Prefer the daemon's own ImageUsage.Reclaimable (Docker API v1.44+); it is
    // the exact number `docker system df` displays and accounts for shared
    // layers correctly. On older daemons, fall back to LayersSize minus the
    // unique-to-in-use bytes, the same arithmetic the CLI uses internally.
    // Summing per-image Size/VirtualSize would over-report by the multiplicity
    // of every shared layer (the old bug that inflated the banner).
    const reclaimableImages = (items: any[], layersSize: number, serverReclaimable: number | undefined) => {
      if (!items || !Array.isArray(items)) return { bytes: 0, count: 0 };
      const reclaimable = items.filter(i => (i?.Containers ?? 0) === 0);
      if (serverReclaimable !== undefined && serverReclaimable >= 0) {
        return { bytes: serverReclaimable, count: reclaimable.length };
      }
      let used = 0;
      for (const item of items) {
        if (!item || (item.Containers ?? 0) <= 0) continue;
        // Choose the best non-negative size: prefer VirtualSize, fall back to
        // Size. If neither is known the image is truly unaccountable; skipping
        // it leaks at most one image's worth of bytes into the reclaim total.
        let virt = -1;
        if (typeof item.VirtualSize === 'number' && item.VirtualSize >= 0) {
          virt = item.VirtualSize;
        } else if (typeof item.Size === 'number' && item.Size >= 0) {
          virt = item.Size;
        }
        if (virt < 0) continue;
        // SharedSize === -1 (or absent) means "unknown" on older daemons. Treat
        // it as 0 so the image's full size counts as in-use. Under-reporting
        // reclaimable is the safer direction; the previous skip-on-(-1) path
        // moved those bytes into the reclaimable total and re-inflated it.
        const shared = typeof item.SharedSize === 'number' && item.SharedSize >= 0
          ? item.SharedSize
          : 0;
        used += Math.max(0, virt - shared);
      }
      const bytes = Math.max(0, (layersSize || 0) - used);
      return { bytes, count: reclaimable.length };
    };

    const reclaimableVolumes = (items: any[]) => {
      if (!items || !Array.isArray(items)) return { bytes: 0, count: 0 };
      const reclaimable = items.filter(i => i.UsageData?.RefCount === 0);
      const bytes = reclaimable.reduce((acc, item) => {
        const size = item.UsageData?.Size || 0;
        return acc + size;
      }, 0);
      return { bytes, count: reclaimable.length };
    };

    const reclaimableBuildCache = (items: any[]) => {
      if (!items || !Array.isArray(items)) return { bytes: 0, count: 0 };
      const reclaimable = items.filter(i => i.InUse === false);
      const bytes = reclaimable.reduce((acc, item) => acc + (item.Size || 0), 0);
      return { bytes, count: reclaimable.length };
    };

    const imageUsage = (df as { ImageUsage?: { Reclaimable?: number } }).ImageUsage;
    let images = df.Images
      ? reclaimableImages(df.Images, df.LayersSize ?? 0, imageUsage?.Reclaimable)
      : { bytes: 0, count: 0 };

    if (opts?.excludeHeldImages === true && Array.isArray(df.Images) && df.Images.length > 0) {
      // Only images that counted as reclaimable (Containers === 0) are
      // adjusted, so bytes and count stay consistent subsets of the base
      // figures. Dynamic import avoids the static cycle (StackUpdateRecoveryService
      // imports this class; see getClassifiedResources below for the same pattern).
      const { buildUnifiedHeldImagePredicate } = await import('./recoveryHeldImages');
      const isImageHeld = buildUnifiedHeldImagePredicate(this.nodeId);
      const sharedSizes = DockerController.mapSharedSizesFromDf(df);
      let heldBytes = 0;
      let heldCount = 0;
      for (const img of df.Images) {
        if (!img?.Id || (img.Containers ?? 0) !== 0 || !isImageHeld(img.Id)) continue;
        heldBytes += DockerController.imageUniqueBytes(img, sharedSizes);
        heldCount += 1;
      }
      images = {
        bytes: Math.max(0, images.bytes - heldBytes),
        count: Math.max(0, images.count - heldCount),
      };
    }

    const containers = df.Containers ? reclaimableContainers(df.Containers) : { bytes: 0, count: 0 };
    const volumes = df.Volumes ? reclaimableVolumes(df.Volumes) : { bytes: 0, count: 0 };
    const buildCache = df.BuildCache ? reclaimableBuildCache(df.BuildCache) : { bytes: 0, count: 0 };

    return {
      reclaimableImages: images.bytes,
      reclaimableContainers: containers.bytes,
      reclaimableVolumes: volumes.bytes,
      reclaimableBuildCache: buildCache.bytes,
      reclaimableImageCount: images.count,
      reclaimableContainerCount: containers.count,
      reclaimableVolumeCount: volumes.count,
      reclaimableBuildCacheCount: buildCache.count,
    };
  }

  /** True when an image is unused and has no meaningful tag (dangling / untagged). */
  private static isDanglingImage(img: { RepoTags?: string[] | null; Containers?: number }): boolean {
    if ((img.Containers ?? 0) !== 0) return false;
    const tags = img.RepoTags ?? [];
    if (tags.length === 0) return true;
    return tags.every((t) => t === '<none>:<none>');
  }

  /**
   * Enumerate candidate images and delete individually. Used when a recovery
   * hold predicate is supplied so held images are never removed by a bulk
   * Docker prune API. Reclaimed bytes come from a LayersSize before/after delta.
   */
  private async pruneImagesEnumerated(
    eligible: (img: { Id: string; RepoTags?: string[] | null; Containers?: number }) => boolean,
    isImageHeld?: (imageId: string) => boolean,
  ): Promise<{ success: boolean; reclaimedBytes: number }> {
    const beforeDf = await this.safeDfSnapshot();
    const rawImages = await this.docker.listImages({ all: false });
    const candidates = (rawImages as Array<{ Id: string; RepoTags?: string[] | null; Containers?: number }>)
      .filter((img) => eligible(img) && !isImageHeld?.(img.Id));

    for (const img of candidates) {
      if (isImageHeld?.(img.Id)) continue;
      try {
        await this.docker.getImage(img.Id).remove({ force: true });
      } catch (e) {
        console.error(`[pruneImagesEnumerated] Failed to remove image ${sanitizeForLog(img.Id)}:`, e);
      }
    }

    const afterDf = await this.safeDfSnapshot();
    let reclaimedBytes = 0;
    if (typeof beforeDf?.LayersSize === 'number' && typeof afterDf?.LayersSize === 'number') {
      reclaimedBytes = Math.max(0, beforeDf.LayersSize - afterDf.LayersSize);
    }
    return { success: true, reclaimedBytes };
  }

  // Sencho's own image, networks, and named volumes are always in use by the
  // running container, so Docker's server-side prune APIs (pruneContainers,
  // pruneImages, pruneNetworks, pruneVolumes) skip them by definition. No
  // extra self-guard is needed at this layer; the `managed` scope path goes
  // through `pruneManagedOnly`, which adds an explicit self filter for
  // defense-in-depth.
  public async pruneSystem(
    target: 'containers' | 'images' | 'networks' | 'volumes',
    labelFilter?: string,
    isImageHeld?: (imageId: string) => boolean,
  ) {
    let spaceReclaimed = 0;
    if (target === 'containers') {
      const filters: Record<string, string[]> = {};
      if (labelFilter) filters.label = [labelFilter];
      const r = await this.docker.pruneContainers({ filters });
      spaceReclaimed = r.SpaceReclaimed || 0;
    } else if (target === 'images') {
      if (isImageHeld) {
        return this.pruneImagesEnumerated((img) => (img.Containers ?? 0) === 0, isImageHeld);
      }
      // Remove all unused images, not just dangling ones
      const filters: Record<string, string[] | Record<string, boolean>> = { dangling: { 'false': true } };
      if (labelFilter) filters.label = [labelFilter];
      const r = await this.docker.pruneImages({ filters });
      spaceReclaimed = r.SpaceReclaimed || 0;
    } else if (target === 'networks') {
      const filters: Record<string, string[]> = {};
      if (labelFilter) filters.label = [labelFilter];
      const r = await this.docker.pruneNetworks({ filters });
      spaceReclaimed = (r as { SpaceReclaimed?: number }).SpaceReclaimed || 0;
    } else if (target === 'volumes') {
      const filters: Record<string, string[]> = { all: ['true'] };
      if (labelFilter) filters.label = [labelFilter];
      const r = await this.docker.pruneVolumes({ filters });
      spaceReclaimed = r.SpaceReclaimed || 0;
    }

    return {
      success: true,
      reclaimedBytes: spaceReclaimed
    };
  }

  // Prune ONLY dangling (untagged) images. Distinct from pruneSystem('images'),
  // which uses { dangling: { 'false': true } } to remove every unused image.
  // Used by the prune-on-update flow to reclaim the layers a pull/recreate
  // orphans, without touching tagged images for stopped stacks.
  public async pruneDanglingImages(isImageHeld?: (imageId: string) => boolean): Promise<{ success: boolean; reclaimedBytes: number }> {
    if (isImageHeld) {
      return this.pruneImagesEnumerated((img) => DockerController.isDanglingImage(img), isImageHeld);
    }
    const filters: Record<string, string[] | Record<string, boolean>> = { dangling: { 'true': true } };
    const r = await this.docker.pruneImages({ filters });
    return { success: true, reclaimedBytes: r.SpaceReclaimed || 0 };
  }

  public async getImages() {
    const data = await this.docker.listImages({ all: false });
    return this.validateApiData<any[]>(data);
  }

  public async getVolumes() {
    const data = await this.docker.listVolumes();
    const validated = this.validateApiData<any>(data);
    return validated.Volumes || [];
  }

  public async getNetworks() {
    const data = await this.docker.listNetworks();
    return this.validateApiData<any[]>(data);
  }

  public async getClassifiedResources(knownStackNames: string[]): Promise<{
    images: ClassifiedImage[];
    volumes: ClassifiedVolume[];
    networks: ClassifiedNetwork[];
  }> {
    const debug = isDebugEnabled();
    const t0 = debug ? Date.now() : 0;
    const knownSet = new Set(knownStackNames);

    const [rawImages, rawVolumeData, rawNetworks, allContainers, projectToStack] = await Promise.all([
      this.docker.listImages({ all: false }),
      this.docker.listVolumes(),
      this.docker.listNetworks(),
      this.docker.listContainers({ all: true }),
      DockerController.resolveProjectNameMap(knownStackNames),
    ]);

    const rawVolumes: any[] = (this.validateApiData<any>(rawVolumeData)).Volumes || [];

    // Build fallback lookup structures for container-to-stack resolution
    const absDirToStack = DockerController.buildAbsDirMap(knownStackNames);
    const resolvedBase = path.resolve(COMPOSE_DIR);

    // Build imageId → set of Sencho stacks (multi-stack reverse index).
    const imageToStacks = new Map<string, Set<string>>();
    for (const c of allContainers as any[]) {
      if (!c.ImageID) continue;
      const stack = DockerController.resolveContainerStack(
        c.Labels, projectToStack, knownSet, absDirToStack, resolvedBase,
      );
      if (!stack) continue;
      const set = imageToStacks.get(c.ImageID) ?? new Set<string>();
      set.add(stack);
      imageToStacks.set(c.ImageID, set);
    }

    const selfIdentity = SelfIdentityService.getInstance();

    // Dynamic (async) imports avoid a static cycle: StackUpdateRecoveryService
    // imports DockerController directly, and ServiceUpdateRecoveryService
    // reaches it transitively through ComposeService. It must be `await import`
    // rather than require(), which does not resolve under Vitest's loader.
    const { StackUpdateRecoveryService } = await import('./StackUpdateRecoveryService');
    const { ServiceUpdateRecoveryService } = await import('./ServiceUpdateRecoveryService');
    const stackHeld = StackUpdateRecoveryService.getInstance().getHeldImageIds(this.nodeId);
    const serviceHeld = ServiceUpdateRecoveryService.getInstance().getHeldImageIds(this.nodeId);
    // A null lookup means "held state unknown" (the DB read failed); treat it
    // as held so the badge never disagrees with the delete guard, which fails
    // the same way (recoveryHeldImages.ts's buildUnifiedHeldImagePredicate).
    const rollbackKind = (imageId: string): ClassifiedImage['rollbackProtectionKind'] => {
      if (stackHeld === null || stackHeld.has(imageId)) return 'stack';
      if (serviceHeld === null || serviceHeld.has(imageId)) return 'service';
      return undefined;
    };

    // Hide hold-only images from generic inventory. Dual-tagged images (registry
    // tag + hold) stay visible here with the badge below; generations still
    // surface in the Rollback tab.
    const images: ClassifiedImage[] = this.validateApiData<any[]>(rawImages)
      .map((img: any) => {
        const usedByStacks = [...(imageToStacks.get(img.Id) ?? [])].sort((a, b) => a.localeCompare(b));
        const managedBy = usedByStacks[0] ?? null;
        const managedStatus: ClassifiedImage['managedStatus'] =
          img.Containers === 0 ? 'unused' :
          managedBy ? 'managed' : 'unmanaged';
        const rollbackProtectionKind = rollbackKind(img.Id);
        return {
          Id: img.Id,
          RepoTags: img.RepoTags ?? [],
          Size: img.Size ?? 0,
          Containers: img.Containers ?? 0,
          usedByStacks,
          managedBy,
          managedStatus,
          isSencho: selfIdentity.isOwnImage(img.Id),
          rollbackProtected: rollbackProtectionKind !== undefined,
          rollbackProtectionKind,
        };
      })
      .filter((img) => !isFullySyntheticHoldImage(img.RepoTags));

    const volumes: ClassifiedVolume[] = rawVolumes.map((vol: any) => {
      const stack = DockerController.resolveProjectLabel(vol.Labels?.['com.docker.compose.project'], knownSet, projectToStack);
      const managedStatus: ClassifiedVolume['managedStatus'] = stack ? 'managed' : 'unmanaged';
      return {
        Name: vol.Name,
        Driver: vol.Driver,
        Mountpoint: vol.Mountpoint,
        Size: vol.UsageData?.Size ?? 0,
        CreatedAt: vol.CreatedAt ?? null,
        managedBy: stack,
        managedStatus,
        isSencho: selfIdentity.isOwnVolume(vol.Name),
      };
    });

    const networks: ClassifiedNetwork[] = this.validateApiData<any[]>(rawNetworks).map((net: any) => {
      if (DockerController.SYSTEM_NETWORKS.has(net.Name)) {
        return { Id: net.Id, Name: net.Name, Driver: net.Driver, Scope: net.Scope, managedBy: null, managedStatus: 'system' as const, isSencho: false };
      }
      const stack = DockerController.resolveProjectLabel(net.Labels?.['com.docker.compose.project'], knownSet, projectToStack);
      const managedStatus: ClassifiedNetwork['managedStatus'] = stack ? 'managed' : 'unmanaged';
      return {
        Id: net.Id,
        Name: net.Name,
        Driver: net.Driver,
        Scope: net.Scope,
        managedBy: stack,
        managedStatus,
        isSencho: selfIdentity.isOwnNetwork(net.Id) || selfIdentity.isOwnNetwork(net.Name),
      };
    });

    if (debug) console.debug('[Resources:debug] Classification completed', {
      ms: Date.now() - t0, images: images.length, volumes: volumes.length, networks: networks.length,
    });

    return { images, volumes, networks };
  }

  /**
   * Returns the `docker df` snapshot, or null if the call fails. The
   * destructive prune path uses this for a `LayersSize` before/after delta;
   * the estimate path uses it for a SharedSize lookup. Null on failure lets
   * each caller decide how to degrade rather than throwing mid-prune.
   */
  private async safeDfSnapshot(): Promise<{
    LayersSize?: number;
    Images?: Array<{ Id?: string; Size?: number; VirtualSize?: number; SharedSize?: number; Containers?: number }>;
    Volumes?: Array<{ Name?: string; UsageData?: { RefCount?: number; Size?: number } }>;
  } | null> {
    try {
      return await this.docker.df();
    } catch {
      return null;
    }
  }

  /**
   * Volume RefCount/Size come from `docker system df`, not `GET /volumes`.
   * listVolumes returns UsageData: null on real daemons, so treating a missing
   * RefCount as "in use" (?? 1) would make every volume look non-prunable.
   */
  private static mapVolumeUsageFromDf(
    df: { Volumes?: Array<{ Name?: string; UsageData?: { RefCount?: number; Size?: number } }> } | null,
  ): Map<string, { refCount: number; size: number }> {
    const m = new Map<string, { refCount: number; size: number }>();
    if (!df?.Volumes) return m;
    for (const vol of df.Volumes) {
      if (!vol?.Name) continue;
      const refCount = vol.UsageData?.RefCount;
      // Missing RefCount is unknown usage; omit so callers treat as non-prunable.
      if (typeof refCount !== 'number') continue;
      m.set(vol.Name, {
        refCount,
        size: typeof vol.UsageData?.Size === 'number' ? vol.UsageData.Size : 0,
      });
    }
    return m;
  }

  /**
   * Extracts `Id -> SharedSize` from a df snapshot. Treats missing or
   * negative (Docker's "unknown" sentinel) SharedSize as 0 so the caller
   * counts the image's full Size as unique, an under-report rather than an
   * over-report.
   */
  private static mapSharedSizesFromDf(
    df: { Images?: Array<{ Id?: string; SharedSize?: number }> } | null,
  ): Map<string, number> {
    const m = new Map<string, number>();
    if (!df?.Images) return m;
    for (const img of df.Images) {
      if (!img?.Id) continue;
      const s = typeof img.SharedSize === 'number' && img.SharedSize >= 0 ? img.SharedSize : 0;
      m.set(img.Id, s);
    }
    return m;
  }

  /** Unique-ish reclaim estimate for one image: Size/VirtualSize minus SharedSize. */
  private static imageUniqueBytes(
    img: { Id: string; Size?: number; VirtualSize?: number },
    sharedSizes: Map<string, number>,
  ): number {
    let virt = -1;
    if (typeof img.VirtualSize === 'number' && img.VirtualSize >= 0) virt = img.VirtualSize;
    else if (typeof img.Size === 'number' && img.Size >= 0) virt = img.Size;
    if (virt < 0) return 0;
    return Math.max(0, virt - (sharedSizes.get(img.Id) ?? 0));
  }

  public async pruneManagedOnly(
    target: 'images' | 'volumes' | 'networks',
    knownStackNames: string[],
    isImageHeld?: (imageId: string) => boolean,
  ): Promise<{ success: boolean; reclaimedBytes: number }> {
    const knownSet = new Set(knownStackNames);
    const projectToStack = await DockerController.resolveProjectNameMap(knownStackNames);
    const selfIdentity = SelfIdentityService.getInstance();
    let reclaimedBytes = 0;

    if (target === 'volumes') {
      const rawVolumeData = await this.docker.listVolumes();
      const rawVolumes: any[] = (this.validateApiData<any>(rawVolumeData)).Volumes || [];
      const volumeUsage = DockerController.mapVolumeUsageFromDf(await this.safeDfSnapshot());
      const prunable = rawVolumes.filter((v: any) => {
        const usage = volumeUsage.get(v.Name);
        // Missing from df: unknown usage; do not prune.
        if (!usage || usage.refCount !== 0) return false;
        return !!DockerController.resolveProjectLabel(v.Labels?.['com.docker.compose.project'], knownSet, projectToStack)
          && !selfIdentity.isOwnVolume(v.Name);
      });
      // Removals are independent and Docker handles concurrent volume
      // deletes; parallelize so wall time matches the slowest single
      // remove rather than the sum of all of them.
      await Promise.all(prunable.map(async (vol) => {
        try {
          await this.docker.getVolume(vol.Name).remove({ force: true });
          reclaimedBytes += volumeUsage.get(vol.Name)?.size ?? 0;
        } catch (e) {
          console.error(`[pruneManagedOnly] Failed to remove volume ${vol.Name}:`, e);
        }
      }));
    } else if (target === 'networks') {
      const rawNetworks = await this.docker.listNetworks();
      const prunable = (rawNetworks as any[]).filter((n: any) => {
        return !!DockerController.resolveProjectLabel(n.Labels?.['com.docker.compose.project'], knownSet, projectToStack)
          && !selfIdentity.isOwnNetwork(n.Id)
          && !selfIdentity.isOwnNetwork(n.Name);
      });
      await Promise.all(prunable.map(async (net) => {
        try {
          await this.docker.getNetwork(net.Id).remove({ force: true });
        } catch (e) {
          console.error(`[pruneManagedOnly] Failed to remove network ${net.Name}:`, e);
        }
      }));
    } else if (target === 'images') {
      const allContainers = await this.docker.listContainers({ all: true });
      const resolvedBase = path.resolve(COMPOSE_DIR);
      const absDirToStack = DockerController.buildAbsDirMap(knownStackNames);
      const resolveStack = (labels: Record<string, string> | undefined) => {
        const viaPath = DockerController.resolveContainerStack(
          labels, projectToStack, knownSet, absDirToStack, resolvedBase,
        );
        if (viaPath) return viaPath;
        // Match resolveProjectLabel: stack directory names in knownSet resolve
        // even when the project-name map cache was built for a different list.
        return DockerController.resolveProjectLabel(
          labels?.['com.docker.compose.project'], knownSet, projectToStack,
        );
      };
      const unmanagedImageIds = new Set<string>();
      const managedImageIds = new Set<string>();
      const managedContainers: ManagedContainerForAttribution[] = [];
      for (const c of allContainers as Array<{
        Image?: string;
        ImageID?: string;
        Labels?: Record<string, string>;
      }>) {
        const stack = resolveStack(c.Labels);
        if (!c.ImageID) continue;
        if (stack) {
          managedImageIds.add(c.ImageID);
          managedContainers.push({ Image: c.Image, ImageID: c.ImageID, stack });
        } else {
          unmanagedImageIds.add(c.ImageID);
        }
      }
      const rawImages = await this.docker.listImages({ all: false }) as Array<{
        Id: string;
        RepoTags?: string[] | null;
        Labels?: Record<string, string>;
        Size?: number;
        Containers?: number;
      }>;
      const { repoKeys } = buildManagedImageRepoSet(managedContainers, rawImages);
      const prunable = rawImages.filter((img) => {
        if (img.Containers !== 0 || selfIdentity.isOwnImage(img.Id)) return false;
        if (isImageHeld?.(img.Id)) return false;
        return classifyManagedImageCandidate({
          imageId: img.Id,
          labels: img.Labels,
          repoTags: img.RepoTags,
          becomesFree: false,
          managedImageIds,
          unmanagedImageIds,
          repoKeys,
          resolveStack,
        }).eligible;
      });
      // df-before / df-after delta is the only honest measurement of bytes
      // actually freed. Per-image (Size - SharedSize) undercounts layers
      // shared exclusively between prunable images (Docker frees the layer
      // once, but the per-image formula subtracts it from every referrer).
      const beforeDf = await this.safeDfSnapshot();
      await Promise.all(prunable.map(async (img) => {
        try {
          await this.docker.getImage(img.Id).remove({ force: true });
        } catch (e) {
          console.error(`[pruneManagedOnly] Failed to remove image ${img.Id}:`, e);
        }
      }));
      const afterDf = await this.safeDfSnapshot();
      if (typeof beforeDf?.LayersSize === 'number' && typeof afterDf?.LayersSize === 'number') {
        // Clamp to 0: a concurrent pull during the prune can grow on-disk
        // bytes, and attributing that growth to "reclaimed" would mislead.
        reclaimedBytes = Math.max(0, beforeDf.LayersSize - afterDf.LayersSize);
      } else if (beforeDf) {
        // After-snapshot failed but we have the before-snapshot, so fall
        // back to a per-image lower bound. (We deliberately do not fall back
        // on after-only: after the prune those image IDs are gone from the
        // daemon's view, so a SharedSize map built from afterDf would treat
        // every pruned image as having no sharing and over-report.)
        console.warn('[pruneManagedOnly] docker df after-snapshot unavailable; reporting per-image lower bound');
        const shared = DockerController.mapSharedSizesFromDf(beforeDf);
        for (const img of prunable) {
          reclaimedBytes += Math.max(0, (img.Size ?? 0) - (shared.get(img.Id) ?? 0));
        }
      } else {
        console.warn('[pruneManagedOnly] docker df unavailable on both ends; reporting 0 reclaimed');
      }
    }

    return { success: true, reclaimedBytes };
  }

  /**
   * Non-destructive sibling of `pruneManagedOnly` used by the dry-run path and
   * the `/api/system/prune/estimate` route. Walks the same filter rules but
   * does not call `.remove()`. Kept structurally parallel to the destructive
   * method so the two stay in lockstep when the enumeration logic changes.
   *
   * For images, the returned figure is a **conservative lower bound** on
   * bytes that will actually be freed. The formula subtracts each prunable
   * image's `SharedSize`, which double-counts layers shared between two
   * prunable images (the layer would only be freed once on prune). The
   * exact freed bytes can only be measured by the df-delta that
   * `pruneManagedOnly` reports after the destructive action.
   */
  public async estimateManagedReclaim(
    target: 'images' | 'volumes' | 'networks',
    knownStackNames: string[],
  ): Promise<{ reclaimableBytes: number }> {
    const knownSet = new Set(knownStackNames);
    const projectToStack = await DockerController.resolveProjectNameMap(knownStackNames);
    const selfIdentity = SelfIdentityService.getInstance();
    let reclaimableBytes = 0;

    if (target === 'volumes') {
      const rawVolumeData = await this.docker.listVolumes();
      const rawVolumes: any[] = (this.validateApiData<any>(rawVolumeData)).Volumes || [];
      const volumeUsage = DockerController.mapVolumeUsageFromDf(await this.safeDfSnapshot());
      const prunable = rawVolumes.filter((v: any) => {
        const usage = volumeUsage.get(v.Name);
        if (!usage || usage.refCount !== 0) return false;
        return !!DockerController.resolveProjectLabel(v.Labels?.['com.docker.compose.project'], knownSet, projectToStack)
          && !selfIdentity.isOwnVolume(v.Name);
      });
      for (const vol of prunable) reclaimableBytes += volumeUsage.get(vol.Name)?.size ?? 0;
    } else if (target === 'networks') {
      // Networks have no on-disk size; the dry-run still reports 0 so the
      // shape matches the destructive path.
    } else if (target === 'images') {
      const allContainers = await this.docker.listContainers({ all: true });
      const resolvedBase = path.resolve(COMPOSE_DIR);
      const absDirToStack = DockerController.buildAbsDirMap(knownStackNames);
      const resolveStack = (labels: Record<string, string> | undefined) => {
        const viaPath = DockerController.resolveContainerStack(
          labels, projectToStack, knownSet, absDirToStack, resolvedBase,
        );
        if (viaPath) return viaPath;
        // Match resolveProjectLabel: stack directory names in knownSet resolve
        // even when the project-name map cache was built for a different list.
        return DockerController.resolveProjectLabel(
          labels?.['com.docker.compose.project'], knownSet, projectToStack,
        );
      };
      const unmanagedImageIds = new Set<string>();
      const managedImageIds = new Set<string>();
      const managedContainers: ManagedContainerForAttribution[] = [];
      for (const c of allContainers as Array<{
        Image?: string;
        ImageID?: string;
        Labels?: Record<string, string>;
      }>) {
        const stack = resolveStack(c.Labels);
        if (!c.ImageID) continue;
        if (stack) {
          managedImageIds.add(c.ImageID);
          managedContainers.push({ Image: c.Image, ImageID: c.ImageID, stack });
        } else {
          unmanagedImageIds.add(c.ImageID);
        }
      }
      const rawImages = await this.docker.listImages({ all: false }) as Array<{
        Id: string;
        RepoTags?: string[] | null;
        Labels?: Record<string, string>;
        Size?: number;
        Containers?: number;
      }>;
      const { repoKeys } = buildManagedImageRepoSet(managedContainers, rawImages);
      // Dynamic import for the same cycle reason as getDiskUsage: a held image
      // can carry compose labels (docker tag preserves them), so the repo/label
      // classifier would otherwise count it and over-report the estimate.
      const { buildUnifiedHeldImagePredicate } = await import('./recoveryHeldImages');
      const isImageHeld = buildUnifiedHeldImagePredicate(this.nodeId);
      const prunable = rawImages.filter((img) => {
        if (img.Containers !== 0 || selfIdentity.isOwnImage(img.Id) || isImageHeld(img.Id)) return false;
        return classifyManagedImageCandidate({
          imageId: img.Id,
          labels: img.Labels,
          repoTags: img.RepoTags,
          becomesFree: false,
          managedImageIds,
          unmanagedImageIds,
          repoKeys,
          resolveStack,
        }).eligible;
      });
      const sharedSizes = DockerController.mapSharedSizesFromDf(await this.safeDfSnapshot());
      for (const img of prunable) {
        reclaimableBytes += Math.max(0, (img.Size ?? 0) - (sharedSizes.get(img.Id) ?? 0));
      }
    }

    return { reclaimableBytes };
  }

  /**
   * Non-destructive estimate for the `all` (system) prune scope. Uses only
   * `docker system df` so the readout matches the daemon's own reclaimable
   * totals for each resource type, except the images figure, which excludes
   * rollback-held images so the estimate matches what the prune plan will
   * actually remove (the plan skips held images). `knownStackNames` is
   * retained for call-site symmetry with {@link estimateManagedReclaim} and
   * is unused by this method.
   */
  public async estimateSystemReclaim(
    target: 'containers' | 'images' | 'networks' | 'volumes',
    _knownStackNames: string[],
  ): Promise<{ reclaimableBytes: number }> {
    const df = await this.getDiskUsage(target === 'images' ? { excludeHeldImages: true } : undefined);
    if (target === 'images') return { reclaimableBytes: df.reclaimableImages };
    if (target === 'containers') return { reclaimableBytes: df.reclaimableContainers };
    if (target === 'volumes') return { reclaimableBytes: df.reclaimableVolumes };
    // Networks have no on-disk size.
    return { reclaimableBytes: 0 };
  }

  /**
   * Build an itemized prune plan using the same eligibility predicates that
   * `executePrunePlan` revalidates before each delete. Never calls remove APIs.
   */
  public async buildPrunePlan(
    targets: PruneTarget[],
    scope: PruneScope,
    knownStackNames: string[],
    nodeId: number = this.nodeId,
    isImageHeld?: (imageId: string) => boolean,
  ): Promise<PrunePlan> {
    const ordered = normalizePruneTargets(targets);
    const knownSet = new Set(knownStackNames);
    const projectToStack = await DockerController.resolveProjectNameMap(knownStackNames);
    const selfIdentity = SelfIdentityService.getInstance();
    const absDirToStack = DockerController.buildAbsDirMap(knownStackNames);
    const resolvedBase = path.resolve(COMPOSE_DIR);

    const allContainers = await this.docker.listContainers({ all: true, size: true }) as Array<{
      Id: string;
      Names?: string[];
      State?: string;
      Status?: string;
      Image?: string;
      ImageID?: string;
      Labels?: Record<string, string>;
      SizeRw?: number;
      NetworkSettings?: { Networks?: Record<string, unknown> };
    }>;

    const items: PrunePlanItem[] = [];

    const containerName = (c: { Id: string; Names?: string[] }) =>
      (c.Names?.[0] ?? c.Id).replace(/^\//, '');

    if (ordered.includes('containers')) {
      for (const c of allContainers) {
        if (selfIdentity.isOwnContainer(c.Id)) continue;
        const state = String(c.State ?? '').toLowerCase();
        if (!PRUNEABLE_CONTAINER_STATES.has(state)) continue;
        const stack = DockerController.resolveContainerStack(
          c.Labels, projectToStack, knownSet, absDirToStack, resolvedBase,
        );
        if (scope === 'managed' && !stack) continue;
        items.push({
          target: 'containers',
          id: c.Id,
          name: containerName(c),
          sizeBytes: typeof c.SizeRw === 'number' && c.SizeRw > 0 ? c.SizeRw : undefined,
          managed: Boolean(stack),
          reason: `Container is ${state} and no longer running`,
          stackName: stack ?? undefined,
        });
      }
    }

    // Volume usage (RefCount/Size) must come from docker.df(); listVolumes
    // returns UsageData: null on real daemons.
    const dfSnapshot = await this.safeDfSnapshot();
    const volumeUsage = DockerController.mapVolumeUsageFromDf(dfSnapshot);
    const sharedSizes = DockerController.mapSharedSizesFromDf(dfSnapshot);

    if (ordered.includes('volumes')) {
      const rawVolumeData = await this.docker.listVolumes();
      const rawVolumes = (this.validateApiData<{ Volumes?: Array<{
        Name: string;
        Driver?: string;
        Labels?: Record<string, string>;
      }> }>(rawVolumeData)).Volumes || [];
      for (const vol of rawVolumes) {
        if (selfIdentity.isOwnVolume(vol.Name)) continue;
        const usage = volumeUsage.get(vol.Name);
        if (!usage || usage.refCount !== 0) continue;
        const stack = DockerController.resolveContainerStack(
          vol.Labels, projectToStack, knownSet, absDirToStack, resolvedBase,
        );
        if (scope === 'managed' && !stack) continue;
        items.push({
          target: 'volumes',
          id: vol.Name,
          name: vol.Name,
          sizeBytes: usage.size > 0 ? usage.size : undefined,
          managed: Boolean(stack),
          reason: 'Volume is not referenced by any container',
          stackName: stack ?? undefined,
          volume: {
            driver: vol.Driver,
            ownershipLabels: projectPruneOwnershipLabels(vol.Labels),
          },
        });
      }
    }

    if (ordered.includes('networks')) {
      const rawNetworks = await this.docker.listNetworks() as Array<{
        Id: string;
        Name: string;
        Driver?: string;
        Scope?: string;
        Labels?: Record<string, string>;
      }>;
      const networksInUse = new Set<string>();
      for (const c of allContainers) {
        const nets = c.NetworkSettings?.Networks;
        if (!nets) continue;
        for (const netName of Object.keys(nets)) {
          networksInUse.add(netName);
        }
      }
      for (const net of rawNetworks) {
        if (DockerController.SYSTEM_NETWORKS.has(net.Name)) continue;
        if (selfIdentity.isOwnNetwork(net.Id) || selfIdentity.isOwnNetwork(net.Name)) continue;
        if (networksInUse.has(net.Name) || networksInUse.has(net.Id)) continue;
        // Belt-and-braces: inspect when list summary did not expose attachments.
        try {
          const inspected = await this.docker.getNetwork(net.Id).inspect() as {
            Containers?: Record<string, unknown>;
          };
          if (inspected.Containers && Object.keys(inspected.Containers).length > 0) continue;
        } catch (e) {
          console.warn(
            `[buildPrunePlan] Skipping network ${sanitizeForLog(net.Name)}: inspect failed:`,
            sanitizeForLog(e instanceof Error ? e.message : String(e)),
          );
          continue;
        }
        const stack = DockerController.resolveContainerStack(
          net.Labels, projectToStack, knownSet, absDirToStack, resolvedBase,
        );
        if (scope === 'managed' && !stack) continue;
        items.push({
          target: 'networks',
          id: net.Id,
          name: net.Name,
          managed: Boolean(stack),
          reason: 'Network has no attached containers',
          stackName: stack ?? undefined,
          network: {
            driver: net.Driver,
            scope: net.Scope,
            ownershipLabels: projectPruneOwnershipLabels(net.Labels),
          },
        });
      }
    }

    if (ordered.includes('images')) {
      const unmanagedImageIds = new Set<string>();
      const managedImageIds = new Set<string>();
      const imageToStack = new Map<string, string>();
      const imageToContainerIds = new Map<string, string[]>();
      const managedContainers: ManagedContainerForAttribution[] = [];
      const resolveStack = (labels: Record<string, string> | undefined) => {
        const viaPath = DockerController.resolveContainerStack(
          labels, projectToStack, knownSet, absDirToStack, resolvedBase,
        );
        if (viaPath) return viaPath;
        // Match resolveProjectLabel: stack directory names in knownSet resolve
        // even when the project-name map cache was built for a different list.
        return DockerController.resolveProjectLabel(
          labels?.['com.docker.compose.project'], knownSet, projectToStack,
        );
      };
      for (const c of allContainers) {
        if (!c.ImageID) continue;
        const refs = imageToContainerIds.get(c.ImageID) ?? [];
        refs.push(c.Id);
        imageToContainerIds.set(c.ImageID, refs);
        const stack = resolveStack(c.Labels);
        if (stack) {
          managedImageIds.add(c.ImageID);
          managedContainers.push({ Image: c.Image, ImageID: c.ImageID, stack });
          if (!imageToStack.has(c.ImageID)) imageToStack.set(c.ImageID, stack);
        } else {
          unmanagedImageIds.add(c.ImageID);
        }
      }
      const plannedContainerIds = new Set(
        items.filter((i) => i.target === 'containers').map((i) => i.id),
      );
      const rawImages = await this.docker.listImages({ all: false }) as Array<{
        Id: string;
        RepoTags?: string[] | null;
        RepoDigests?: string[] | null;
        Labels?: Record<string, string>;
        Size?: number;
        VirtualSize?: number;
        Containers?: number;
        Created?: number;
      }>;
      const { repoKeys } = buildManagedImageRepoSet(managedContainers, rawImages);
      // An image becomes free only when every container that references it is
      // also in this plan (not merely when any planned container uses it).
      const freeingImages = ordered.includes('containers');
      for (const img of rawImages) {
        if (selfIdentity.isOwnImage(img.Id)) continue;
        if (isImageHeld?.(img.Id)) continue;
        const refs = imageToContainerIds.get(img.Id) ?? [];
        const becomesFree = freeingImages
          && refs.length > 0
          && refs.every((id) => plannedContainerIds.has(id));
        if (refs.length > 0 && !becomesFree) continue;
        let planReason = becomesFree
          ? 'Image becomes unused after planned container removal'
          : 'Image is not used by any container';
        let stackName: string | undefined = imageToStack.get(img.Id);
        let managed = Boolean(stackName || managedImageIds.has(img.Id));
        if (scope === 'managed') {
          const classification = classifyManagedImageCandidate({
            imageId: img.Id,
            labels: img.Labels,
            repoTags: img.RepoTags,
            becomesFree,
            managedImageIds,
            unmanagedImageIds,
            repoKeys,
            resolveStack,
          });
          if (!classification.eligible) continue;
          managed = true;
          planReason = managedImagePlanReason(classification.reason);
          // Repo-match deliberately omits stackName (repository sharing is not ownership).
          // Label reasons supply classification.stackName; otherwise keep imageToStack when present.
          if (classification.reason === 'repo-match') {
            stackName = undefined;
          } else {
            stackName = classification.stackName ?? stackName;
          }
        } else {
          // All-scope: foreign compose projects stay eligible; keep stack when known.
          const labeled = resolveStack(img.Labels);
          if (labeled) {
            stackName = labeled;
            managed = true;
          }
        }
        const references = (img.RepoTags ?? []).filter((ref) => ref && ref !== '<none>:<none>');
        const name = references[0] ?? '<none>:<none>';
        const unique = DockerController.imageUniqueBytes(img, sharedSizes);
        items.push({
          target: 'images',
          id: img.Id,
          name,
          sizeBytes: unique > 0 ? unique : undefined,
          managed,
          reason: planReason,
          stackName,
          image: {
            references,
            digest: img.RepoDigests?.find((digest) => Boolean(digest)),
            createdAt: typeof img.Created === 'number' ? img.Created : undefined,
          },
        });
      }
    }

    // Preserve target execution order in the item list for stable previews.
    const targetRank = new Map(ordered.map((t, i) => [t, i]));
    items.sort((a, b) => {
      const tr = (targetRank.get(a.target) ?? 99) - (targetRank.get(b.target) ?? 99);
      if (tr !== 0) return tr;
      return a.id.localeCompare(b.id);
    });

    const reclaimableBytes = items.reduce((acc, item) => acc + (item.sizeBytes ?? 0), 0);
    const fingerprint = fingerprintPrunePlan(nodeId, scope, ordered, items);

    return {
      scope,
      targets: ordered,
      items,
      reclaimableBytes,
      fingerprint,
      createdAt: Date.now(),
      nodeId,
    };
  }

  /**
   * Rebuild the plan with the same targets/scope. Returns the fresh plan when
   * the fingerprint still matches, otherwise null so the caller can report
   * staleness through its route-specific response contract.
   */
  public async assertPlanFresh(
    plan: PrunePlan,
    knownStackNames: string[],
    isImageHeld?: (imageId: string) => boolean,
  ): Promise<PrunePlan | null> {
    const rebuilt = await this.buildPrunePlan(plan.targets, plan.scope, knownStackNames, plan.nodeId, isImageHeld);
    if (rebuilt.fingerprint !== plan.fingerprint) return null;
    return rebuilt;
  }

  /**
   * Execute a previously previewed plan: revalidate fingerprint, then delete
   * each planned item serially with force:false. Never deletes unplanned items.
   */
  public async executePrunePlan(
    plan: PrunePlan,
    knownStackNames: string[],
    isImageHeld?: (imageId: string) => boolean,
  ): Promise<{ outcomes: PruneItemOutcome[]; reclaimedBytes: number; success: boolean }> {
    const fresh = await this.assertPlanFresh(plan, knownStackNames, isImageHeld);
    if (!fresh) throw new PrunePlanStaleError();

    const knownSet = new Set(knownStackNames);
    const projectToStack = await DockerController.resolveProjectNameMap(knownStackNames);
    const selfIdentity = SelfIdentityService.getInstance();
    const absDirToStack = DockerController.buildAbsDirMap(knownStackNames);
    const resolvedBase = path.resolve(COMPOSE_DIR);

    const outcomes: PruneItemOutcome[] = [];
    let reclaimedBytes = 0;
    /** Image IDs whose planned container removal failed or was skipped. */
    const blockedImageIds = new Set<string>();

    const imageIdBlocked = (imageId: string): boolean => {
      for (const id of blockedImageIds) {
        if (imageId === id || imageId.startsWith(id) || id.startsWith(imageId)) return true;
      }
      return false;
    };

    // Items are already sorted in dependency-safe target order by buildPrunePlan.
    for (const item of fresh.items) {
      const { target } = item;
      try {
        if (target === 'containers') {
          const outcome = await this.executePlannedContainer(
            item, fresh.scope, knownSet, projectToStack, absDirToStack, resolvedBase, selfIdentity,
          );
          if (outcome.status !== 'removed' && outcome.imageId) {
            blockedImageIds.add(outcome.imageId);
          }
          if (outcome.status === 'removed') {
            outcomes.push({
              id: outcome.id,
              target: 'containers',
              status: 'removed',
              sizeBytes: outcome.sizeBytes,
            });
            reclaimedBytes += outcome.sizeBytes ?? item.sizeBytes ?? 0;
          } else if (outcome.status === 'skipped') {
            outcomes.push({
              id: outcome.id,
              target: 'containers',
              status: 'skipped',
              reason: outcome.reason,
            });
          } else {
            outcomes.push({
              id: outcome.id,
              target: 'containers',
              status: 'failed',
              error: outcome.error,
            });
          }
          continue;
        }

        if (target === 'volumes') {
          const outcome = await this.executePlannedVolume(
            item, fresh.scope, knownSet, projectToStack, absDirToStack, resolvedBase, selfIdentity,
          );
          outcomes.push(outcome);
          if (outcome.status === 'removed') reclaimedBytes += outcome.sizeBytes ?? item.sizeBytes ?? 0;
          continue;
        }

        if (target === 'networks') {
          outcomes.push(await this.executePlannedNetwork(
            item, fresh.scope, knownSet, projectToStack, absDirToStack, resolvedBase, selfIdentity,
          ));
          continue;
        }

        if (target === 'images') {
          if (isImageHeld?.(item.id)) {
            outcomes.push({
              id: item.id,
              target: 'images',
              status: 'skipped',
              reason: 'Image held for pending service-update recovery',
            });
            continue;
          }
          if (imageIdBlocked(item.id)) {
            const stillReferenced = await this.imageStillReferenced(item.id);
            if (stillReferenced) {
              outcomes.push({
                id: item.id,
                target: 'images',
                status: 'skipped',
                reason: 'Still referenced after container prune skipped or failed',
              });
              continue;
            }
          }
          const outcome = await this.executePlannedImage(
            item, selfIdentity,
          );
          outcomes.push(outcome);
          if (outcome.status === 'removed') reclaimedBytes += outcome.sizeBytes ?? item.sizeBytes ?? 0;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[executePrunePlan] Failed ${target} ${sanitizeForLog(item.id)}:`, sanitizeForLog(message));
        outcomes.push({ id: item.id, target, status: 'failed', error: message });
        if (target === 'containers') {
          const imageId = await this.lookupContainerImageId(item.id);
          if (imageId) blockedImageIds.add(imageId);
        }
      }
    }

    const success = outcomes.every((o) => o.status !== 'failed');
    return { outcomes, reclaimedBytes, success };
  }

  private async lookupContainerImageId(containerId: string): Promise<string | null> {
    try {
      const inspected = await this.docker.getContainer(containerId).inspect() as { Image?: string };
      return inspected.Image ?? null;
    } catch {
      return null;
    }
  }

  private async imageStillReferenced(imageId: string): Promise<boolean> {
    try {
      const containers = await this.docker.listContainers({ all: true }) as Array<{ ImageID?: string }>;
      return containers.some((container) => container.ImageID === imageId
        || Boolean(container.ImageID?.startsWith(imageId))
        || imageId.startsWith(container.ImageID ?? ''));
    } catch {
      return true;
    }
  }

  private async executePlannedContainer(
    item: PrunePlanItem,
    scope: PruneScope,
    knownSet: Set<string>,
    projectToStack: Map<string, string>,
    absDirToStack: Map<string, string>,
    resolvedBase: string,
    selfIdentity: SelfIdentityService,
  ): Promise<
    | { id: string; target: 'containers'; status: 'removed'; sizeBytes?: number; imageId?: string }
    | { id: string; target: 'containers'; status: 'skipped'; reason: string; imageId?: string }
    | { id: string; target: 'containers'; status: 'failed'; error: string; imageId?: string }
  > {
    if (selfIdentity.isOwnContainer(item.id)) {
      return { id: item.id, target: 'containers', status: 'skipped', reason: 'Sencho self container' };
    }
    let inspected: {
      State?: { Status?: string };
      Config?: { Labels?: Record<string, string> };
      Image?: string;
    };
    try {
      inspected = await this.docker.getContainer(item.id).inspect();
    } catch {
      return { id: item.id, target: 'containers', status: 'skipped', reason: 'Container no longer exists' };
    }
    const imageId = inspected.Image;
    const state = String(inspected.State?.Status ?? '').toLowerCase();
    if (!PRUNEABLE_CONTAINER_STATES.has(state)) {
      return {
        id: item.id,
        target: 'containers',
        status: 'skipped',
        reason: `Container state is ${state || 'unknown'}`,
        imageId,
      };
    }
    if (scope === 'managed') {
      const stack = DockerController.resolveContainerStack(
        inspected.Config?.Labels, projectToStack, knownSet, absDirToStack, resolvedBase,
      );
      if (!stack) {
        return {
          id: item.id,
          target: 'containers',
          status: 'skipped',
          reason: 'No longer a managed stack container',
          imageId,
        };
      }
    }
    await this.docker.getContainer(item.id).remove({ force: false });
    return { id: item.id, target: 'containers', status: 'removed', sizeBytes: item.sizeBytes, imageId };
  }

  private async executePlannedVolume(
    item: PrunePlanItem,
    scope: PruneScope,
    knownSet: Set<string>,
    projectToStack: Map<string, string>,
    absDirToStack: Map<string, string>,
    resolvedBase: string,
    selfIdentity: SelfIdentityService,
  ): Promise<PruneItemOutcome> {
    if (selfIdentity.isOwnVolume(item.id)) {
      return { id: item.id, target: 'volumes', status: 'skipped', reason: 'Sencho self volume' };
    }
    const rawVolumeData = await this.docker.listVolumes();
    const rawVolumes = (this.validateApiData<{ Volumes?: Array<{
      Name: string;
      Labels?: Record<string, string>;
    }> }>(rawVolumeData)).Volumes || [];
    const vol = rawVolumes.find((v) => v.Name === item.id);
    if (!vol) {
      return { id: item.id, target: 'volumes', status: 'skipped', reason: 'Volume no longer exists' };
    }
    const usage = DockerController.mapVolumeUsageFromDf(await this.safeDfSnapshot()).get(item.id);
    if (!usage || usage.refCount !== 0) {
      return { id: item.id, target: 'volumes', status: 'skipped', reason: 'Volume is in use' };
    }
    if (scope === 'managed') {
      const stack = DockerController.resolveContainerStack(
        vol.Labels, projectToStack, knownSet, absDirToStack, resolvedBase,
      );
      if (!stack) {
        return { id: item.id, target: 'volumes', status: 'skipped', reason: 'No longer a managed volume' };
      }
    }
    await this.docker.getVolume(item.id).remove({ force: false });
    return { id: item.id, target: 'volumes', status: 'removed', sizeBytes: item.sizeBytes ?? usage.size };
  }

  private async executePlannedNetwork(
    item: PrunePlanItem,
    scope: PruneScope,
    knownSet: Set<string>,
    projectToStack: Map<string, string>,
    absDirToStack: Map<string, string>,
    resolvedBase: string,
    selfIdentity: SelfIdentityService,
  ): Promise<PruneItemOutcome> {
    if (selfIdentity.isOwnNetwork(item.id)) {
      return { id: item.id, target: 'networks', status: 'skipped', reason: 'Sencho self network' };
    }
    let inspected: {
      Name?: string;
      Labels?: Record<string, string>;
      Containers?: Record<string, unknown>;
    };
    try {
      inspected = await this.docker.getNetwork(item.id).inspect();
    } catch {
      return { id: item.id, target: 'networks', status: 'skipped', reason: 'Network no longer exists' };
    }
    if (DockerController.SYSTEM_NETWORKS.has(inspected.Name ?? '')) {
      return { id: item.id, target: 'networks', status: 'skipped', reason: 'System network' };
    }
    if (inspected.Containers && Object.keys(inspected.Containers).length > 0) {
      return { id: item.id, target: 'networks', status: 'skipped', reason: 'Network is in use' };
    }
    if (scope === 'managed') {
      const stack = DockerController.resolveContainerStack(
        inspected.Labels, projectToStack, knownSet, absDirToStack, resolvedBase,
      );
      if (!stack) {
        return { id: item.id, target: 'networks', status: 'skipped', reason: 'No longer a managed network' };
      }
    }
    await this.docker.getNetwork(item.id).remove();
    return { id: item.id, target: 'networks', status: 'removed' };
  }

  private async executePlannedImage(
    item: PrunePlanItem,
    selfIdentity: SelfIdentityService,
  ): Promise<PruneItemOutcome> {
    if (selfIdentity.isOwnImage(item.id)) {
      return { id: item.id, target: 'images', status: 'skipped', reason: 'Sencho self image' };
    }
    if (item.target !== 'images') {
      return { id: item.id, target: 'images', status: 'failed', error: 'Plan item is not an image target' };
    }
    const plannedRefs = item.image.references;
    const rawImages = await this.docker.listImages({ all: false }) as Array<{
      Id: string;
      Size?: number;
      RepoTags?: string[] | null;
    }>;
    const img = rawImages.find((i) => i.Id === item.id || i.Id.startsWith(item.id) || item.id.startsWith(i.Id));
    if (!img) {
      return { id: item.id, target: 'images', status: 'skipped', reason: 'Image no longer exists' };
    }
    // Defense in depth when fleet preflight/assertPlanFresh already matched:
    // refuse mutation if live tags drifted from the reviewed reference set.
    if (!pruneImageReferencesEqual(plannedRefs, img.RepoTags)) {
      return {
        id: item.id,
        target: 'images',
        status: 'failed',
        error: 'Image references changed since the plan was built; refresh and confirm again',
      };
    }
    const allContainers = await this.docker.listContainers({ all: true }) as Array<{
      ImageID?: string;
      Labels?: Record<string, string>;
    }>;
    const containerRefs = allContainers.filter((container) => container.ImageID === img.Id
      || Boolean(container.ImageID?.startsWith(img.Id))
      || img.Id.startsWith(container.ImageID ?? ''));
    if (containerRefs.length > 0) {
      return { id: item.id, target: 'images', status: 'skipped', reason: 'Image still has container references' };
    }
    try {
      await this.docker.getImage(item.id).remove({ force: false });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Re-read tags so a multi-repository conflict that partially untagged is not
      // reported as a no-op when live names already diverged.
      let afterTags: string[] | null | undefined;
      try {
        const afterList = await this.docker.listImages({ all: false }) as Array<{
          Id: string;
          RepoTags?: string[] | null;
        }>;
        afterTags = afterList.find((i) => i.Id === img.Id || i.Id.startsWith(img.Id) || img.Id.startsWith(i.Id))
          ?.RepoTags;
      } catch {
        afterTags = undefined;
      }
      if (afterTags !== undefined && !pruneImageReferencesEqual(plannedRefs, afterTags)) {
        return {
          id: item.id,
          target: 'images',
          status: 'failed',
          error: 'Image delete did not fully remove the reviewed image; some repository tags changed. '
            + 'Refresh the plan and confirm remaining references before pruning again. '
            + message,
        };
      }
      const lower = message.toLowerCase();
      if (lower.includes('multiple repositories') || lower.includes('must be forced') || lower.includes('conflict')) {
        return {
          id: item.id,
          target: 'images',
          status: 'failed',
          error: 'Docker refused to delete this image because it is tagged in multiple repositories. '
            + 'Reviewed tags: ' + (plannedRefs.join(', ') || '(none)') + '. '
            + 'Resolve tags on the host or re-scope the plan, then dry-run again. '
            + message,
        };
      }
      throw e;
    }
    // Prefer plan unique-bytes; do not fall back to full Size (shared layers).
    return { id: item.id, target: 'images', status: 'removed', sizeBytes: item.sizeBytes ?? 0 };
  }

  public async getDiskUsageClassified(knownStackNames: string[]): Promise<{
    reclaimableImages: number;
    reclaimableContainers: number;
    reclaimableVolumes: number;
    reclaimableBuildCache: number;
    reclaimableImageCount: number;
    reclaimableContainerCount: number;
    reclaimableVolumeCount: number;
    reclaimableBuildCacheCount: number;
    managedImageBytes: number;
    unmanagedImageBytes: number;
    managedVolumeBytes: number;
    unmanagedVolumeBytes: number;
  }> {
    const [base, classified] = await Promise.all([
      // Exclude rollback-held images so the banner/treemap figure matches
      // what a prune can actually free (see getDiskUsage docs).
      this.getDiskUsage({ excludeHeldImages: true }),
      this.getClassifiedResources(knownStackNames),
    ]);

    const managedImageBytes = classified.images
      .filter(i => i.managedStatus === 'managed')
      .reduce((acc, i) => acc + i.Size, 0);
    const unmanagedImageBytes = classified.images
      .filter(i => i.managedStatus === 'unmanaged')
      .reduce((acc, i) => acc + i.Size, 0);

    // Volume disk usage: query raw volumes for UsageData (not available in classified resources)
    const rawVolumeData = await this.docker.listVolumes();
    const rawVolumes: any[] = (this.validateApiData<any>(rawVolumeData)).Volumes || [];
    const projectToStack = await DockerController.resolveProjectNameMap(knownStackNames);
    const knownSet = new Set(knownStackNames);

    const isVolumeManaged = (v: any): boolean =>
      !!DockerController.resolveProjectLabel(v.Labels?.['com.docker.compose.project'], knownSet, projectToStack);

    const managedVolumeBytes = rawVolumes
      .filter(isVolumeManaged)
      .reduce((acc: number, v: any) => acc + (v.UsageData?.Size ?? 0), 0);
    const unmanagedVolumeBytes = rawVolumes
      .filter((v: any) => !isVolumeManaged(v))
      .reduce((acc: number, v: any) => acc + (v.UsageData?.Size ?? 0), 0);

    return { ...base, managedImageBytes, unmanagedImageBytes, managedVolumeBytes, unmanagedVolumeBytes };
  }

  public async removeImage(id: string) {
    const image = this.docker.getImage(id);
    await image.remove({ force: true });
  }

  public async inspectImage(id: string) {
    const image = this.docker.getImage(id);
    const [inspect, history] = await Promise.all([image.inspect(), image.history()]);
    return { inspect, history };
  }

  /**
   * Resolve any valid Docker image reference (full ID, short ID, digest, or
   * tag) to its canonical full sha256 ID. isValidDockerResourceId accepts
   * short IDs down to 12 hex chars, which a held-image-id set lookup (always
   * keyed on the full 64-char form) would miss without this resolve step.
   * Returns null when the image does not exist.
   */
  public async resolveImageId(id: string): Promise<string | null> {
    try {
      const info = await this.docker.getImage(id).inspect();
      return info.Id;
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 404) return null;
      throw error;
    }
  }

  public async removeVolume(name: string) {
    const volume = this.docker.getVolume(name);
    await volume.remove({ force: true });
  }

  public async removeNetwork(id: string) {
    const network = this.docker.getNetwork(id);
    await network.remove({ force: true });
  }

  public async inspectNetwork(id: string) {
    const network = this.docker.getNetwork(id);
    return await network.inspect();
  }

  public async createNetwork(options: CreateNetworkOptions) {
    if (!options.Name || !isValidDockerNetworkName(options.Name)) {
      throw new Error('Invalid network name. Use alphanumeric characters, hyphens, underscores, and dots.');
    }
    return await this.docker.createNetwork(options);
  }

  /**
   * Attach a container to a Docker network. Idempotent: if the container is
   * already attached the call resolves silently. Optionally pins the
   * container's IPv4 address inside the network so other services can use
   * static `extra_hosts` entries against it.
   */
  public async connectContainerToNetwork(
    networkName: string,
    containerId: string,
    opts: { ipv4Address?: string } = {},
  ): Promise<void> {
    const network = this.docker.getNetwork(networkName);
    const payload: { Container: string; EndpointConfig?: { IPAMConfig?: { IPv4Address: string } } } = {
      Container: containerId,
    };
    if (opts.ipv4Address) {
      payload.EndpointConfig = { IPAMConfig: { IPv4Address: opts.ipv4Address } };
    }
    try {
      await network.connect(payload);
    } catch (err) {
      if (DockerController.isAlreadyConnectedError(err)) return;
      throw err;
    }
  }

  /**
   * Detach a container from a Docker network. Idempotent: if the container
   * is not attached the call resolves silently.
   */
  public async disconnectContainerFromNetwork(
    networkName: string,
    containerId: string,
  ): Promise<void> {
    const network = this.docker.getNetwork(networkName);
    try {
      await network.disconnect({ Container: containerId, Force: true });
    } catch (err) {
      if (DockerController.isNotConnectedError(err)) return;
      throw err;
    }
  }

  private static isAlreadyConnectedError(err: unknown): boolean {
    const e = err as { statusCode?: number; message?: string };
    const msg = (e?.message || '').toLowerCase();
    // Docker daemon returns 403 for several distinct cases (already
    // attached, host-network containers, permission denied), so match the
    // message body too rather than treating any 403 as idempotent success.
    if (e?.statusCode === 403 && (msg.includes('already exists') || msg.includes('already attached'))) {
      return true;
    }
    return msg.includes('already exists') || msg.includes('already attached');
  }

  private static isNotConnectedError(err: unknown): boolean {
    const e = err as { statusCode?: number; message?: string };
    if (e?.statusCode === 404) return true;
    const msg = (e?.message || '').toLowerCase();
    return msg.includes('is not connected') || msg.includes('no such container');
  }

  public async getRunningContainers() {
    const containers = await this.docker.listContainers({ all: false });
    return this.validateApiData<any[]>(containers);
  }

  public async getAllContainers() {
    const containers = await this.docker.listContainers({ all: true });
    return this.validateApiData<any[]>(containers);
  }

  /** Runtime labels + image ref from container inspect. Null (logged) when inspect fails. */
  public async inspectContainerLabelsAndImage(
    containerId: string,
  ): Promise<{ labels: Record<string, string>; imageId: string } | null> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return { labels: info.Config?.Labels ?? {}, imageId: info.Image ?? '' };
    } catch (err) {
      console.error('[DockerController] Container inspect failed for %s:', sanitizeForLog(containerId), err);
      return null;
    }
  }

  /** Image-level labels for label provenance. Null (logged) when the image cannot be inspected. */
  public async inspectImageLabels(imageId: string): Promise<{ labels: Record<string, string> } | null> {
    if (!imageId) return null;
    try {
      const info = await this.docker.getImage(imageId).inspect();
      return { labels: info.Config?.Labels ?? {} };
    } catch (err) {
      console.error('[DockerController] Image inspect failed for %s:', sanitizeForLog(imageId), err);
      return null;
    }
  }

  /**
   * Containers with runtime labels for the label-inventory API. Resolves stack
   * membership with the same multi-fallback strategy as bulk status. Captures the
   * image ref so label provenance can distinguish image-inherited labels.
   */
  public async listContainersForLabelInventory(): Promise<LabelInventoryRow[]> {
    const knownStacks = await FileSystemService.getInstance(this.nodeId).getStacks();
    const listed = await this.getAllContainers() as Array<{
      Id?: string;
      Names?: string[];
      State?: string;
      Labels?: Record<string, string>;
      ImageID?: string;
    }>;
    const projectToStack = await DockerController.resolveProjectNameMap(knownStacks);
    const absDirToStack = DockerController.buildAbsDirMap(knownStacks);
    const resolvedBase = path.resolve(COMPOSE_DIR);
    const knownStackSet = new Set(knownStacks);

    const CONCURRENCY = 8;
    const results: LabelInventoryRow[] = new Array(listed.length);

    let index = 0;
    const worker = async () => {
      while (index < listed.length) {
        const i = index++;
        const c = listed[i];
        const id = c.Id ?? '';
        const name = (c.Names?.[0] ?? '').replace(/^\//, '');
        const state = c.State ?? 'unknown';
        const stack = DockerController.resolveContainerStack(
          c.Labels,
          projectToStack,
          knownStackSet,
          absDirToStack,
          resolvedBase,
        );
        const service = c.Labels?.['com.docker.compose.service'] ?? null;
        if (!id) {
          results[i] = { id, name, state, stack, service, labels: {}, imageId: c.ImageID ?? '', inspectFailed: true };
          continue;
        }
        let labels: Record<string, string>;
        let imageId: string;
        let inspectFailed = false;
        try {
          const info = await this.docker.getContainer(id).inspect();
          labels = info.Config?.Labels ?? {};
          imageId = info.Image ?? '';
        } catch (err) {
          console.error('[DockerController] Container inspect failed for %s:', sanitizeForLog(id), err);
          labels = c.Labels ?? {};
          imageId = c.ImageID ?? '';
          inspectFailed = true;
        }
        results[i] = { id, name, state, stack, service, labels, imageId, inspectFailed };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, listed.length) }, worker));
    return results;
  }

  /** Resolve a container by its durable name (not ephemeral ID). */
  public async findContainerByName(name: string): Promise<{
    id: string;
    name: string;
    state: string;
    image: string;
    stackProject: string | null;
  } | null> {
    const normalized = name.replace(/^\//, '');
    const containers = await this.getAllContainers();
    for (const c of containers) {
      const containerName = c.Names?.[0]?.replace(/^\//, '');
      if (containerName === normalized) {
        return {
          id: c.Id,
          name: containerName,
          state: c.State ?? 'unknown',
          image: c.Image ?? '',
          stackProject: c.Labels?.['com.docker.compose.project'] ?? null,
        };
      }
    }
    return null;
  }

  /**
   * Builds topology data with 2 Docker API calls instead of N+1.
   * Fetches all networks + all containers in parallel, then maps
   * container-to-network relationships in memory using NetworkSettings.
   */
  public async getTopologyData(
    knownStackNames: string[],
    includeSystem: boolean,
  ): Promise<TopologyNetwork[]> {
    const debug = isDebugEnabled();
    const t0 = debug ? Date.now() : 0;
    const knownSet = new Set(knownStackNames);

    const [rawNetworks, rawContainers, projectToStack] = await Promise.all([
      this.docker.listNetworks(),
      this.docker.listContainers({ all: true }),
      DockerController.resolveProjectNameMap(knownStackNames),
    ]);

    const absDirToStack = DockerController.buildAbsDirMap(knownStackNames);
    const resolvedBase = path.resolve(COMPOSE_DIR);

    const networks = this.validateApiData<any[]>(rawNetworks);
    const containers = this.validateApiData<any[]>(rawContainers);

    // Build network map, optionally filtering system networks
    const networkMap = new Map<string, TopologyNetwork>();
    for (const net of networks) {
      const isSystem = DockerController.SYSTEM_NETWORKS.has(net.Name);
      if (isSystem && !includeSystem) continue;

      const stack = isSystem
        ? null
        : DockerController.resolveProjectLabel(
            net.Labels?.['com.docker.compose.project'],
            knownSet,
            projectToStack,
          );
      const managedStatus: TopologyNetwork['managedStatus'] = isSystem
        ? 'system'
        : stack ? 'managed' : 'unmanaged';

      networkMap.set(net.Id, {
        Id: net.Id,
        Name: net.Name,
        Driver: net.Driver ?? 'bridge',
        Scope: net.Scope ?? 'local',
        managedBy: stack,
        managedStatus,
        containers: [],
      });
    }

    // Map containers to their networks via NetworkSettings.
    // Stack resolution is deferred until a network match is found to avoid
    // wasted work for containers not attached to any tracked network.
    for (const c of containers) {
      const netSettings: Record<string, { NetworkID?: string; IPAddress?: string }> =
        c.NetworkSettings?.Networks ?? {};

      let containerStack: string | null | undefined;
      let stackResolved = false;

      for (const [, netInfo] of Object.entries(netSettings)) {
        const netId = netInfo.NetworkID;
        if (!netId) continue;
        const topology = networkMap.get(netId);
        if (!topology) continue;

        if (!stackResolved) {
          containerStack = DockerController.resolveContainerStack(
            c.Labels, projectToStack, knownSet, absDirToStack, resolvedBase,
          );
          stackResolved = true;
        }

        topology.containers.push({
          id: c.Id,
          name: (c.Names?.[0] ?? '').replace(/^\//, '') || (c.Id ?? '').substring(0, 12),
          ip: netInfo.IPAddress ?? '',
          state: c.State ?? 'unknown',
          image: c.Image ?? '',
          stack: containerStack ?? null,
        });
      }
    }

    const result = Array.from(networkMap.values());

    if (debug) {
      const totalContainers = result.reduce((sum, n) => sum + n.containers.length, 0);
      console.debug('[Resources:debug] Topology built', {
        ms: Date.now() - t0,
        networks: result.length,
        containers: totalContainers,
        systemFiltered: !includeSystem,
        stacksKnown: knownStackNames.length,
      });
    }

    return result;
  }

  /**
   * One-shot, node-scoped snapshot for the dependency map: every container's
   * compose service identity, real network/volume names, and protocol/IP-typed
   * published ports, plus the full network and volume inventory. Three Docker
   * list calls and no per-container inspect keep it cheap at fleet scale.
   */
  public async getDependencySnapshot(knownStackNames: string[]): Promise<DependencySnapshot> {
    const knownSet = new Set(knownStackNames);

    const [rawContainers, rawNetworks, rawVolumeData, projectToStack] = await Promise.all([
      this.docker.listContainers({ all: true }),
      this.docker.listNetworks(),
      this.docker.listVolumes(),
      DockerController.resolveProjectNameMap(knownStackNames),
    ]);

    const absDirToStack = DockerController.buildAbsDirMap(knownStackNames);
    const resolvedBase = path.resolve(COMPOSE_DIR);

    const containersRaw = this.validateApiData<any[]>(rawContainers);
    const networksRaw = this.validateApiData<any[]>(rawNetworks);
    const volumesRaw: any[] = (this.validateApiData<any>(rawVolumeData)).Volumes || [];

    const containers: DependencyContainer[] = containersRaw.map((c: any) => {
      const netSettings: Record<string, { NetworkID?: string; IPAddress?: string }> =
        c.NetworkSettings?.Networks ?? {};
      const networks = Object.entries(netSettings).map(([name, info]) => ({
        name,
        id: info.NetworkID ?? '',
        ip: info.IPAddress ?? '',
      }));

      const volumes: string[] = Array.isArray(c.Mounts)
        ? c.Mounts
            .filter((m: any) => m?.Type === 'volume' && typeof m.Name === 'string' && m.Name)
            .map((m: any) => m.Name as string)
        : [];

      const ports: DependencyPort[] = Array.isArray(c.Ports)
        ? c.Ports
            .filter((p: any) => typeof p.PublicPort === 'number' && p.PublicPort > 0)
            .map((p: any) => ({
              ip: typeof p.IP === 'string' ? p.IP : '',
              publishedPort: p.PublicPort as number,
              privatePort: typeof p.PrivatePort === 'number' ? p.PrivatePort : null,
              protocol: typeof p.Type === 'string' ? p.Type : 'tcp',
            }))
        : [];

      return {
        id: c.Id,
        name: (c.Names?.[0] ?? '').replace(/^\//, '') || (c.Id ?? '').substring(0, 12),
        service: c.Labels?.['com.docker.compose.service'] ?? null,
        composeProject: c.Labels?.['com.docker.compose.project'] ?? null,
        stack: DockerController.resolveContainerStack(c.Labels, projectToStack, knownSet, absDirToStack, resolvedBase),
        state: c.State ?? 'unknown',
        exitCode: parseExitCode(typeof c.Status === 'string' ? c.Status : undefined),
        image: c.Image ?? '',
        networks,
        volumes,
        ports,
      };
    });

    const networks: DependencyNetwork[] = networksRaw.map((net: any) => {
      const project = net.Labels?.['com.docker.compose.project'] ?? null;
      const ingress = net.Ingress === true;
      return {
        id: net.Id,
        name: net.Name,
        driver: net.Driver ?? 'bridge',
        scope: net.Scope ?? 'local',
        isSystem: DockerController.SYSTEM_NETWORKS.has(net.Name) || ingress,
        ingress,
        ...(typeof net.EnableIPv6 === 'boolean' ? { enableIPv6: net.EnableIPv6 } : {}),
        composeProject: project,
        stack: DockerController.resolveProjectLabel(project ?? undefined, knownSet, projectToStack),
      };
    });

    const volumes: DependencyVolume[] = volumesRaw.map((vol: any) => {
      const project = vol.Labels?.['com.docker.compose.project'] ?? null;
      return {
        name: vol.Name,
        driver: vol.Driver ?? 'local',
        composeProject: project,
        stack: DockerController.resolveProjectLabel(project ?? undefined, knownSet, projectToStack),
      };
    });

    return { containers, networks, volumes };
  }

  /**
   * Classifies snapshot networks into base inventory rows (phase A). Uses only
   * the provided snapshot; no additional Docker API calls.
   */
  public static classifySnapshotNetworks(
    snapshot: DependencySnapshot,
    _knownStackNames: string[],
  ): NetworkingNetworkBase[] {
    const selfIdentity = SelfIdentityService.getInstance();
    const connectedByNetwork = new Map<string, number>();
    for (const c of snapshot.containers) {
      for (const attached of c.networks) {
        const key = attached.id || attached.name;
        connectedByNetwork.set(key, (connectedByNetwork.get(key) ?? 0) + 1);
        if (attached.name && attached.name !== key) {
          connectedByNetwork.set(attached.name, (connectedByNetwork.get(attached.name) ?? 0) + 1);
        }
      }
    }

    return snapshot.networks.map(net => ({
      id: net.id,
      name: net.name,
      driver: net.driver,
      scope: net.scope,
      isSystem: net.isSystem,
      ingress: net.ingress === true,
      enableIPv6: net.enableIPv6,
      composeProject: net.composeProject,
      stack: net.stack,
      connectedCount: connectedByNetwork.get(net.id) ?? connectedByNetwork.get(net.name) ?? 0,
      isSencho: selfIdentity.isOwnNetwork(net.id) || selfIdentity.isOwnNetwork(net.name),
      ownership: net.isSystem || net.ingress === true
        ? 'system'
        : net.stack
          ? 'sencho-managed'
          : net.composeProject
            ? 'compose-managed'
            : 'unmanaged',
      declaredByStacks: [],
      declaredExternalByStacks: [],
      isExternalDependency: false,
    }));
  }

  /** Resolves a Docker Compose project label to a known Sencho stack name, or null. */
  private static resolveProjectLabel(
    project: string | undefined,
    knownSet: Set<string>,
    projectToStack: Map<string, string>,
  ): string | null {
    if (!project) return null;
    if (knownSet.has(project)) return project;
    return projectToStack.get(project) ?? null;
  }

  /** Builds a map from absolute stack directory paths to stack names. */
  private static buildAbsDirMap(stackNames: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const stackDir of stackNames) {
      const stackPath = path.join(COMPOSE_DIR, stackDir);
      map.set(stackPath, stackDir);
      map.set(path.resolve(stackPath), stackDir);
    }
    return map;
  }

  /**
   * Resolves which Sencho stack a container belongs to using a multi-fallback strategy.
   * Handles containers whose labels predate Sencho's reorganization of compose files into subdirectories.
   */
  private static resolveContainerStack(
    containerLabels: Record<string, string> | undefined,
    projectToStack: Map<string, string>,
    knownStackSet: Set<string>,
    absDirToStack: Map<string, string>,
    resolvedBase: string,
  ): string | null {
    if (!containerLabels) return null;

    // Primary: match by project name (handles name: overrides and standard directory-based names)
    const project = containerLabels['com.docker.compose.project'];
    if (project) {
      const stack = projectToStack.get(project);
      if (stack) return stack;
    }

    // Fallback 1: match by working_dir
    const workingDir = containerLabels['com.docker.compose.project.working_dir'];
    if (workingDir) {
      const match = absDirToStack.get(workingDir) ?? absDirToStack.get(path.resolve(workingDir));
      if (match) return match;
    }

    // Fallback 2: match by service name
    const serviceName = containerLabels['com.docker.compose.service'];
    if (serviceName && knownStackSet.has(serviceName)) return serviceName;

    // Fallback 3: extract stack from config_files path
    const configFiles = containerLabels['com.docker.compose.project.config_files'];
    if (configFiles) {
      const firstFile = configFiles.split(',')[0].trim();
      const resolvedFile = path.resolve(firstFile);
      if (isPathWithinBase(resolvedFile, resolvedBase)) {
        const relative = resolvedFile.slice(resolvedBase.length + 1);
        const firstSegment = relative.split(path.sep)[0].replace(/\.(ya?ml)$/, '');
        if (knownStackSet.has(firstSegment)) return firstSegment;
      }
    }

    return null;
  }

  /**
   * Builds (or returns cached) mapping from Docker project name to Sencho stack directory name.
   * Compose files with a top-level `name:` field override the default project name.
   */
  private static async resolveProjectNameMap(stackNames: string[]): Promise<Map<string, string>> {
    return CacheService.getInstance().getOrFetch(
      PROJECT_NAME_CACHE_KEY,
      PROJECT_NAME_CACHE_TTL_MS,
      async () => {
        const map = new Map<string, string>();

        await Promise.all(stackNames.map(async (stackDir) => {
          map.set(stackDir, stackDir);

          for (const fileName of COMPOSE_FILE_NAMES) {
            const filePath = path.join(COMPOSE_DIR, stackDir, fileName);
            try {
              const content = await fs.readFile(filePath, 'utf-8');
              const parsed = yaml.parse(content);
              if (parsed?.name && typeof parsed.name === 'string') {
                map.set(parsed.name, stackDir);
              }
              break;
            } catch (err: unknown) {
              const code = (err as NodeJS.ErrnoException)?.code;
              if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                console.error('[DockerController] Failed to read %s:', sanitizeForLog(filePath), sanitizeForLog((err as Error)?.message ?? String(err)));
                break;
              }
            }
          }
        }));

        return map;
      },
    );
  }

  public async getBulkStackStatuses(stackNames: string[]): Promise<Record<string, BulkStackInfo>> {
    // Run Docker API call and project name resolution in parallel
    const [allContainers, projectToStack] = await Promise.all([
      this.docker.listContainers({ all: true }),
      DockerController.resolveProjectNameMap(stackNames),
    ]);

    const absDirToStack = DockerController.buildAbsDirMap(stackNames);
    const knownStackSet = new Set(stackNames);
    const resolvedBase = path.resolve(COMPOSE_DIR);

    const result: Record<string, BulkStackInfo> = {};
    for (const name of stackNames) {
      result[name] = { status: 'unknown' };
    }

    // Per stack, collect running container ids plus the oldest Created as a
    // fallback. Uptime is resolved from StartedAt after the loop; Created is
    // only used if an inspect fails, since it never moves on restart.
    const runningByStack: Record<string, { ids: string[]; oldestCreated?: number }> = {};

    // Per stack, tally running, genuinely-failed (crashed), and total containers
    // so the status can distinguish a fully-up stack from one that is partially
    // degraded (some running, some crashed).
    const countsByStack: Record<string, { running: number; failed: number; total: number }> = {};
    for (const name of stackNames) {
      countsByStack[name] = { running: 0, failed: 0, total: 0 };
    }

    for (const container of allContainers as any[]) {
      const stackDir = DockerController.resolveContainerStack(
        container.Labels, projectToStack, knownStackSet, absDirToStack, resolvedBase,
      );

      if (!stackDir || !result[stackDir]) continue;

      const counts = countsByStack[stackDir];
      counts.total += 1;

      if (container.State === 'running') {
        counts.running += 1;

        const acc = (runningByStack[stackDir] ??= { ids: [] });
        if (typeof container.Id === 'string') acc.ids.push(container.Id);
        const created = typeof container.Created === 'number' ? container.Created : undefined;
        if (created !== undefined && (acc.oldestCreated === undefined || created < acc.oldestCreated)) {
          acc.oldestCreated = created;
        }

        // Detect main web port (first running container with a matchable port wins)
        if (result[stackDir].mainPort === undefined && Array.isArray(container.Ports) && container.Ports.length > 0) {
          const mainPort = selectMainWebPort(
            container.Ports as { PrivatePort?: number; PublicPort?: number; Type?: string }[],
          );
          if (mainPort) result[stackDir].mainPort = mainPort;
        }
      } else if (isContainerFailed(container.State, container.Status)) {
        counts.failed += 1;
      }
    }

    // Classify each stack from its tallies. "partial" requires at least one
    // running and at least one crashed container, so a stack with a cleanly
    // finished one-shot container (exit 0) stays "running". A stack with no
    // containers keeps its seeded "unknown".
    for (const name of stackNames) {
      const { running, failed, total } = countsByStack[name];
      if (total === 0) continue;
      if (running === 0) result[name].status = 'exited';
      else if (failed > 0) result[name].status = 'partial';
      else result[name].status = 'running';
      result[name].running = running;
      result[name].total = total;
    }

    // Resolve real uptime: oldest StartedAt across each stack's running
    // containers, falling back to the oldest Created when inspect is unavailable.
    const allRunningIds = Object.values(runningByStack).flatMap(s => s.ids);
    const startedAts = await this.getRunningStartedAts(allRunningIds);
    for (const [stackDir, acc] of Object.entries(runningByStack)) {
      let oldest: number | undefined;
      for (const id of acc.ids) {
        const started = startedAts.get(id);
        if (started !== undefined && (oldest === undefined || started < oldest)) {
          oldest = started;
        }
      }
      result[stackDir].runningSince = oldest ?? acc.oldestCreated;
    }

    return result;
  }

  /**
   * Resolve each container's last start time (unix seconds) from State.StartedAt,
   * which Docker exposes only via inspect() (listContainers carries Created, which
   * does not move on restart). Results are cached briefly per node+container so
   * steady-state status polls avoid re-inspecting. A container whose inspect fails
   * (e.g. it vanished between listing and inspect) is omitted; callers fall back to
   * Created for those rather than failing the whole batch.
   */
  private async getRunningStartedAts(containerIds: string[]): Promise<Map<string, number>> {
    const now = Date.now();
    const cache = DockerController.startedAtCache;
    const out = new Map<string, number>();
    const misses: string[] = [];

    for (const id of containerIds) {
      const cached = cache.get(`${this.nodeId}:${id}`);
      if (cached && now - cached.cachedAtMs < STARTED_AT_CACHE_TTL_MS) {
        out.set(id, cached.startedAtSeconds);
      } else {
        misses.push(id);
      }
    }

    for (let i = 0; i < misses.length; i += STARTED_AT_INSPECT_CONCURRENCY) {
      const chunk = misses.slice(i, i + STARTED_AT_INSPECT_CONCURRENCY);
      await Promise.all(chunk.map(async (id) => {
        try {
          const info = await this.docker.getContainer(id).inspect();
          const startedAt = info.State?.StartedAt;
          const seconds = startedAt ? Math.floor(Date.parse(startedAt) / 1000) : NaN;
          // Skip the Docker zero-time (0001-01-01...) and unparseable values.
          if (Number.isFinite(seconds) && seconds > 0) {
            cache.set(`${this.nodeId}:${id}`, { startedAtSeconds: seconds, cachedAtMs: now });
            out.set(id, seconds);
          }
        } catch (err: unknown) {
          console.warn('[DockerController] StartedAt inspect failed for %s: %s', sanitizeForLog(id), sanitizeForLog((err as Error)?.message ?? String(err)));
        }
      }));
    }

    // Bound the cache: drop entries past their TTL so removed containers that
    // will never be queried again do not accumulate.
    for (const [key, entry] of cache) {
      if (now - entry.cachedAtMs >= STARTED_AT_CACHE_TTL_MS) cache.delete(key);
    }

    return out;
  }

  /**
   * Returns a map of host ports currently bound by running containers,
   * with ownership info (Sencho-managed stack name or external).
   */
  public async getPortsInUse(knownStackNames: string[]): Promise<Record<number, PortInUseInfo>> {
    const [allContainers, projectToStack] = await Promise.all([
      this.docker.listContainers({ all: false }),
      DockerController.resolveProjectNameMap(knownStackNames),
    ]);

    const absDirToStack = DockerController.buildAbsDirMap(knownStackNames);
    const knownStackSet = new Set(knownStackNames);
    const resolvedBase = path.resolve(COMPOSE_DIR);

    const result: Record<number, PortInUseInfo> = {};

    for (const container of allContainers as Array<{ Names?: string[]; Labels?: Record<string, string>; Ports?: Array<{ PublicPort?: number }> }>) {
      const stackDir = DockerController.resolveContainerStack(
        container.Labels, projectToStack, knownStackSet, absDirToStack, resolvedBase,
      );

      const containerName = (container.Names?.[0] || '').replace(/^\//, '');

      if (!Array.isArray(container.Ports)) continue;

      for (const port of container.Ports) {
        if (!port.PublicPort || port.PublicPort <= 0) continue;
        // First container to claim a port wins (avoids overwrites)
        if (result[port.PublicPort]) continue;
        result[port.PublicPort] = { stack: stackDir, container: containerName };
      }
    }

    return result;
  }

  /**
   * True when `stackDir` is missing (ENOENT) or is not a directory.
   * Other stat failures return false so callers keep the existing compose-ps path.
   */
  private async isStackDirectoryAbsent(stackDir: string): Promise<boolean> {
    try {
      const st = await fs.stat(stackDir);
      return !st.isDirectory();
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  /**
   * Containers visible to `docker compose ps` for this stack. Empty when Compose
   * does not manage any containers (including first deploy or mislabeled legacy).
   */
  private async fetchComposePsContainers(stackName: string, stackDir: string): Promise<ComposePsContainer[]> {
    const filePrefix = authoredComposeFileArgs(stackName, this.nodeId);
    const envFileArgs = await authoredComposeEnvFileArgs(stackName, this.nodeId);
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['compose', ...filePrefix, ...envFileArgs, 'ps', '--format', 'json', '-a'],
      {
        cwd: stackDir,
        env: {
          ...process.env,
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        }
      }
    );

    let containers: ComposePsContainer[] = [];
    if (stdout && stdout.trim() !== '') {
      try {
        const parsed = JSON.parse(stdout);
        containers = Array.isArray(parsed) ? parsed : [parsed];
      } catch (parseError) {
        try {
          const lines = stdout.trim().split('\n').filter(line => line.trim() !== '');
          containers = lines.map(line => JSON.parse(line) as ComposePsContainer);
        } catch {
          const detail = stderr || (parseError as Error).message || 'unparseable compose ps output';
          console.error('Docker Compose JSON Parse Error for %s:', sanitizeForLog(stackName), sanitizeForLog(detail));
          // Fail closed: garbage stdout is not a successful empty ps. Callers must not
          // treat this as "no containers" and run name-matched orphan removal.
          throw new Error(`docker compose ps returned unparseable JSON: ${detail}`);
        }
      }
    }
    return containers;
  }

  /**
   * Legacy orphan containers that Compose ps cannot see but would block a deploy
   * (wrong project labels). When Compose already manages the stack, returns [] so
   * deploy can rely on selective `compose up` recreation.
   * A thrown `compose ps` returns [] (fail closed): name-matched fallback must not
   * run, because those IDs may still be healthy Compose runtimes that deploy would
   * then destroy before `compose up` (which often fails for the same reason).
   */
  public async getLegacyOrphanContainersByStack(stackName: string): Promise<Array<{ Id: string }>> {
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(this.nodeId), stackName);
    if (await this.isStackDirectoryAbsent(stackDir)) return [];
    const toIds = (list: Array<{ Id?: string }>) =>
      list.filter((c): c is { Id: string } => typeof c.Id === 'string' && c.Id.length > 0)
        .map((c) => ({ Id: c.Id }));

    let composeContainers: ComposePsContainer[];
    try {
      composeContainers = await this.fetchComposePsContainers(stackName, stackDir);
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stderr?: string };
      const mapped = describeSpawnError(execError, { command: 'docker compose ps' });
      const detail = execError.stderr || mapped.message || getErrorMessage(error, 'docker compose ps failed');
      console.error('Docker Compose Error for %s:', sanitizeForLog(stackName), sanitizeForLog(detail));
      // Fail closed: do not run smartFallback (see method JSDoc).
      return [];
    }
    if (composeContainers.length > 0) return [];
    // Empty successful ps: only then may smartFallback report leftovers (name + stack-dir evidence).
    try {
      return toIds(await this.smartFallback(stackName, stackDir));
    } catch (fallbackError) {
      console.error(
        'Smart Fallback failed for %s:',
        sanitizeForLog(stackName),
        sanitizeForLog(getErrorMessage(fallbackError, 'smartFallback failed')),
      );
      return [];
    }
  }

  /**
   * Strict Result API for full-stack updates. Never converts Compose-ps + fallback
   * failure into empty success. Compose-managed containers are never orphan IDs.
   * A thrown `compose ps` is classification_failed (fail closed): name-matched
   * fallback must not run, because those IDs may still be healthy Compose runtimes.
   */
  public async classifyLegacyOrphansForUpdate(
    stackName: string,
  ): Promise<
    | { status: 'none' }
    | { status: 'orphans'; ids: string[] }
    | { status: 'classification_failed'; error: string }
  > {
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(this.nodeId), stackName);
    if (await this.isStackDirectoryAbsent(stackDir)) {
      return { status: 'classification_failed', error: 'Stack directory is gone' };
    }
    const toIds = (list: Array<{ Id?: string }>) =>
      list.filter((c): c is { Id: string } => typeof c.Id === 'string' && c.Id.length > 0)
        .map((c) => c.Id);

    const fallbackOrphans = async (): Promise<
      | { status: 'none' }
      | { status: 'orphans'; ids: string[] }
      | { status: 'classification_failed'; error: string }
    > => {
      try {
        const ids = toIds(await this.smartFallback(stackName, stackDir));
        return ids.length === 0 ? { status: 'none' } : { status: 'orphans', ids };
      } catch (fallbackError) {
        return {
          status: 'classification_failed',
          error: getErrorMessage(fallbackError, 'Legacy orphan classification failed'),
        };
      }
    };

    try {
      const composeContainers = await this.fetchComposePsContainers(stackName, stackDir);
      // Compose already manages this stack: no legacy orphan cleanup (same as deploy).
      if (composeContainers.length > 0) return { status: 'none' };
      // Empty successful ps: only then may smartFallback report leftovers (name + stack-dir evidence).
      return await fallbackOrphans();
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stderr?: string };
      const mapped = describeSpawnError(execError, { command: 'docker compose ps' });
      const detail = execError.stderr || mapped.message || getErrorMessage(error, 'docker compose ps failed');
      console.error('Docker Compose Error for %s:', sanitizeForLog(stackName), sanitizeForLog(detail));
      // Fail closed: do not run smartFallback (see method JSDoc).
      return { status: 'classification_failed', error: String(detail) };
    }
  }

  public async getContainersByStack(stackName: string) {
    // Resolve the compose dir and the authored prefix for THIS controller's node,
    // not the process default, so a non-default local node sees its own stack dir
    // and deploy spec.
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(this.nodeId), stackName);
    if (await this.isStackDirectoryAbsent(stackDir)) {
      return this.enrichContainers([]);
    }

    try {
      const containers = await this.fetchComposePsContainers(stackName, stackDir);

      // If containers found via docker compose ps, return them
      if (containers.length > 0) {
        // Map to frontend's expected interface
        // Note: docker compose ps returns Name (singular), but frontend expects Names (array)
        // Dockerode returns Names with leading slash, so we add it for compatibility
        const mapped = containers.map((c) => {
          let Ports: { PrivatePort: number, PublicPort: number, Type?: string }[] = [];
          if (c.Publishers && Array.isArray(c.Publishers)) {
            Ports = c.Publishers
              .filter(p => typeof p.PublishedPort === 'number' && p.PublishedPort > 0)
              .map(p => ({ PrivatePort: (p.TargetPort || 0) as number, PublicPort: p.PublishedPort as number, Type: p.Protocol?.toLowerCase() }));
          }
          return {
            Id: c.ID || '',
            Names: ['/' + (c.Name || '')],  // Add leading slash to match Dockerode format
            Service: c.Service || '',
            State: c.State || 'unknown',
            Status: c.Status || '',
            Ports
          };
        });
        return await this.enrichContainers(mapped);
      }
    } catch (error) {
      // If command fails (e.g., stack not deployed, invalid YAML, missing env_file,
      // or host under memory pressure causing posix_spawn to fail with ENOMEM,
      // which Linux libuv can surface as ENOENT).
      const execError = error as NodeJS.ErrnoException & { stderr?: string };
      const mapped = describeSpawnError(execError, { command: 'docker compose ps' });
      const detail = execError.stderr || mapped.message;
      console.error('Docker Compose Error for %s:', sanitizeForLog(stackName), sanitizeForLog(detail));
    }

    // Empty successful ps or compose error: soft fallback for UI listing (never break the page).
    return this.listViaSoftSmartFallback(stackName, stackDir);
  }

  /** UI listing path: smartFallback, or empty list if it throws. */
  private async listViaSoftSmartFallback(stackName: string, stackDir: string) {
    try {
      return await this.enrichContainers(await this.smartFallback(stackName, stackDir));
    } catch (fallbackError) {
      console.error(
        'Smart Fallback failed for %s:',
        sanitizeForLog(stackName),
        sanitizeForLog(getErrorMessage(fallbackError, 'smartFallback failed')),
      );
      return this.enrichContainers([]);
    }
  }

  /**
   * Inspect each container to attach healthcheck status, image tag, and image digest.
   * Each mapper catches its own errors, so Promise.all never rejects (allSettled adds ceremony with no behavior change).
   */
  private async enrichContainers<T extends { Id?: string }>(list: T[]): Promise<Array<T & { healthStatus: 'healthy' | 'unhealthy' | 'starting' | 'none'; Image?: string; ImageID?: string }>> {
    return Promise.all(list.map(async (c) => {
      const base = { ...c, healthStatus: 'none' as const };
      if (!c.Id) return base;
      try {
        const info = await this.docker.getContainer(c.Id).inspect();
        const health = info.State?.Health?.Status;
        const healthStatus: 'healthy' | 'unhealthy' | 'starting' | 'none' =
          health === 'healthy' || health === 'unhealthy' || health === 'starting' ? health : 'none';
        return { ...c, healthStatus, Image: info.Config?.Image, ImageID: info.Image };
      } catch {
        return base;
      }
    }));
  }

  /**
   * True when container labels bind this runtime to `stackDir` (working_dir or
   * config_files). Name match alone is not enough for orphan removal.
   */
  private static containerHasStackDirEvidence(
    labels: Record<string, string> | undefined,
    stackDir: string,
  ): boolean {
    if (!labels) return false;
    const resolvedStackDir = path.resolve(stackDir);
    const pathKey = (p: string) =>
      process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    const stackKey = pathKey(resolvedStackDir);

    const workingDir = labels['com.docker.compose.project.working_dir'];
    if (workingDir && pathKey(workingDir) === stackKey) return true;

    const firstFile = labels['com.docker.compose.project.config_files']?.split(',')[0]?.trim();
    if (!firstFile) return false;
    const fileKey = pathKey(firstFile);
    return fileKey === stackKey || fileKey.startsWith(stackKey + path.sep);
  }

  /**
   * Smart Fallback: Find legacy containers by parsing compose YAML definitions.
   * Handles containers with incorrect project labels that `docker compose ps`
   * ignores. Name match alone is insufficient: a container must also have
   * working_dir or config_files evidence for this stack directory. Errors
   * propagate to callers (classify fail-closes; UI listing soft-catches).
   */
  private async smartFallback(stackName: string, stackDir: string): Promise<any[]> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack path');
    }
    // Canonical inline js/path-injection barrier at the fs.readFile sink below.
    // CodeQL credits neither wrapped isPathWithinBase nor a barrier separated
    // from the sink; resolve under the compose root and require containment.
    const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(this.nodeId));
    const resolvedStackDir = path.resolve(baseResolved, stackName);
    if (!resolvedStackDir.startsWith(baseResolved + path.sep)) {
      throw new Error('Invalid stack path');
    }
    // Prefer the validated path over the caller-provided stackDir.
    stackDir = resolvedStackDir;

    let yamlContent: string | null = null;
    for (const fileName of COMPOSE_FILE_NAMES) {
      try {
        const composePath = path.resolve(stackDir, fileName);
        if (!composePath.startsWith(stackDir + path.sep)) {
          continue;
        }
        yamlContent = await fs.readFile(composePath, 'utf-8');
        break;
      } catch {
        continue;
      }
    }
    if (!yamlContent) return [];

    const parsedYaml = yaml.parse(yamlContent);
    if (!parsedYaml || !parsedYaml.services) return [];

    const expectedNames: string[] = [];
    const nameToService = new Map<string, string>();
    for (const [serviceName, serviceConfig] of Object.entries(parsedYaml.services)) {
      const config = serviceConfig as { container_name?: string };
      nameToService.set(serviceName, serviceName);
      if (config.container_name) {
        expectedNames.push(config.container_name);
        nameToService.set(config.container_name, serviceName);
      } else {
        expectedNames.push(serviceName);
        expectedNames.push(`${stackName}-${serviceName}-1`);
        // Legacy project prefixes for orphan containers
        expectedNames.push(`compose-${serviceName}-1`);
        expectedNames.push(`compose_${serviceName}_1`);
      }
    }

    const allContainers = await this.docker.listContainers({ all: true });
    const fallbackContainers = allContainers.filter(container => {
      const nameMatch = container.Names.some(name =>
        expectedNames.includes(name.replace(/^\//, '')),
      );
      return nameMatch && DockerController.containerHasStackDirEvidence(container.Labels, stackDir);
    });

    return fallbackContainers.map(c => {
      const strippedName = c.Names?.[0]?.replace(/^\//, '') ?? '';
      const labelService = c.Labels?.['com.docker.compose.service'];
      const service = (typeof labelService === 'string' && labelService.length > 0
        ? labelService
        : nameToService.get(strippedName)) ?? '';
      let Ports: { PrivatePort: number, PublicPort: number, Type?: string }[] = [];
      if (c.Ports && Array.isArray(c.Ports)) {
        Ports = c.Ports
          .filter((p: any) => typeof p.PublicPort === 'number' && p.PublicPort > 0)
          .map((p: any) => ({ PrivatePort: (p.PrivatePort || 0) as number, PublicPort: p.PublicPort as number, Type: typeof p.Type === 'string' ? p.Type.toLowerCase() : undefined }));
      }
      return {
        Id: c.Id,
        Names: c.Names,
        Service: service,
        State: c.State,
        Status: c.Status,
        Labels: c.Labels,
        Ports
      };
    });
  }

  public async streamContainerLogs(containerId: string, req: any, res: any): Promise<void> {
    const container = this.docker.getContainer(containerId);

    // 1. Set SSE Headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 100 // Send the last 100 lines immediately for context
      });

      // 2. Process and forward the stream
      logStream.on('data', (chunk: Buffer) => {
        // Docker multiplexes stdout/stderr with an 8-byte header if TTY is false.
        let data = chunk;
        if (chunk.length > 8 && (chunk[0] === 1 || chunk[0] === 2)) {
          data = chunk.slice(8);
        }

        const text = data.toString('utf-8');
        const lines = text.split('\n');

        lines.forEach(line => {
          if (line.trim()) {
            res.write(`data: ${JSON.stringify(line)}\n\n`);
          }
        });
      });

      // 3. Cleanup on disconnect
      req.on('close', () => {
        (logStream as any).destroy();
      });

    } catch (error: any) {
      res.write(`data: ${JSON.stringify('[Sencho] Error fetching logs: ' + error.message)}\n\n`);
      res.end();
    }
  }

  // State-safe: silently ignores 304 "already started" errors
  public async startContainer(containerId: string) {
    try {
      const container = this.docker.getContainer(containerId);
      await container.start();
    } catch (error: any) {
      if (error?.statusCode === 304) {
        // Container already running - not an error
        return;
      }
      throw error;
    }
  }

  // State-safe: silently ignores 304 "already stopped" errors
  public async stopContainer(containerId: string) {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop();
    } catch (error: any) {
      if (error?.statusCode === 304) {
        // Container already stopped - not an error
        return;
      }
      throw error;
    }
  }

  public async restartContainer(containerId: string) {
    const container = this.docker.getContainer(containerId);
    await container.restart();
  }

  public async getOrphanContainers(knownStackNames: string[]) {
    // 1. Fetch all containers (running and stopped)
    const allContainers = await this.docker.listContainers({ all: true });

    // 2. Filter and categorize orphans
    const orphans: Record<string, any[]> = {};
    const selfIdentity = SelfIdentityService.getInstance();

    allContainers.forEach((container) => {
      // Look for the docker compose project label
      const projectName = container.Labels?.['com.docker.compose.project'];

      // Sencho's own container is not a stack on this node, so when it carries
      // a compose-project label (compose-deployed installations) it would
      // otherwise surface here as a stray under that project name.
      if (selfIdentity.isOwnContainer(container.Id)) return;

      // If it has a project label, but the project is NOT in our known list...
      if (projectName && !knownStackNames.includes(projectName)) {
        if (!orphans[projectName]) {
          orphans[projectName] = [];
        }
        orphans[projectName].push({
          Id: container.Id,
          Names: container.Names,
          State: container.State,
          Status: container.Status,
          Image: container.Image
        });
      }
    });

    return orphans;
  }

  public async removeContainers(containerIds: string[]) {
    if (isDebugEnabled()) console.debug('[Resources:debug] removeContainers', { count: containerIds.length });
    const results = [];
    for (const id of containerIds) {
      try {
        const container = this.docker.getContainer(id);
        await container.remove({ force: true });
        results.push({ id, success: true });
      } catch (error: any) {
        console.error('Failed to remove container %s:', sanitizeForLog(id), sanitizeForLog(error.message));
        results.push({ id, success: false, error: error.message });
      }
    }
    return results;
  }

  public async streamStats(containerId: string, ws: WebSocket) {
    const container = this.docker.getContainer(containerId);
    const stats = await container.stats({ stream: true });

    stats.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk.toString());
      }
    });

    stats.on('error', (err: Error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: err.message }));
      }
    });

    stats.on('end', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ end: true }));
      }
    });

    // Destroy the Docker stats stream when the WebSocket closes to prevent
    // orphaned streams polling the daemon after client disconnect.
    ws.on('close', () => {
      try { (stats as any).destroy(); } catch (e) {
        // Stream already ended before client disconnected
        console.warn('[DockerController] Stats stream already ended on WS close:', (e as Error).message);
      }
    });
  }

  public async getContainerStatsStream(containerId: string): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const stats = await container.stats({ stream: false });
    return typeof stats === 'string' ? stats : JSON.stringify(stats);
  }

  /** Return the cumulative restart count for a container via inspect(). */
  public async getContainerRestartCount(containerId: string): Promise<number> {
    const container = this.docker.getContainer(containerId);
    const info = await container.inspect();
    return info.RestartCount ?? 0;
  }

  /**
   * Exec into a container with full session isolation.
   * All state (exec instance, stream) lives in this closure - no singleton traps.
   * The WebSocket message handler is registered here to handle input, resize, and cleanup.
   */
  public async execContainer(containerId: string, ws: WebSocket) {
    try {
      // Input validation
      if (!containerId || typeof containerId !== 'string') {
        console.warn('[Exec] Empty or invalid containerId');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('\r\n\x1b[31mError: No container ID provided\x1b[0m\r\n');
          ws.close();
        }
        return;
      }

      const container = this.docker.getContainer(containerId);

      // Verify the container is running before attempting exec
      const info = await container.inspect();
      if (!info.State?.Running) {
        console.warn('[Exec] Container not running:', containerId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('\r\n\x1b[31mError: Container is not running\x1b[0m\r\n');
          ws.close();
        }
        return;
      }

      // Try bash first, fall back to sh.
      // Both exec creation AND start must be inside the try/catch because
      // some runtimes reject unknown binaries at start(), not at creation.
      const execOpts = { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true } as const;
      let dockerExec: Docker.Exec;
      let stream: import('stream').Duplex;
      let shellType = '/bin/bash';
      try {
        dockerExec = await container.exec({ ...execOpts, Cmd: ['/bin/bash'] });
        stream = await dockerExec.start({ hijack: true, stdin: true });
      } catch {
        shellType = '/bin/sh';
        dockerExec = await container.exec({ ...execOpts, Cmd: ['/bin/sh'] });
        stream = await dockerExec.start({ hijack: true, stdin: true });
      }

      if (isDebugEnabled()) console.debug('[Exec:diag] Creating exec', { containerId, shell: shellType });
      if (isDebugEnabled()) console.log('[Exec] Shell session started', { containerId, shell: shellType });

      // --- Downstream: container output → client ---
      stream.on('data', (chunk: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk.toString());
        }
      });

      stream.on('error', (err: Error) => {
        console.error('[Exec] Stream error:', err.message, { containerId });
      });

      stream.on('end', () => {
        if (isDebugEnabled()) console.log('[Exec] Shell session ended', { containerId, reason: 'stream-end' });
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });

      // --- Upstream: client messages → container ---
      ws.on('message', (raw: WebSocket.Data) => {
        try {
          const msg = JSON.parse(raw.toString());

          switch (msg.type) {
            case 'input':
              if (msg.data) {
                stream.write(msg.data);
              }
              break;

            case 'resize':
              if (msg.rows && msg.cols) {
                if (isDebugEnabled()) console.debug('[Exec:diag] Terminal resize', { containerId, rows: msg.rows, cols: msg.cols });
                dockerExec.resize({ h: msg.rows, w: msg.cols }).catch((e: Error) => {
                  // Exec may have ended before resize completes
                  console.warn('[Exec] Resize failed (exec may have ended):', e.message);
                });
              }
              break;

            case 'ping':
              // Keep-alive, no-op
              break;
          }
        } catch (e) {
          // Non-JSON or malformed WebSocket message
          console.warn('[Exec] Ignoring malformed WS message:', (e as Error).message);
        }
      });

      // --- Cleanup: prevent zombie processes ---
      ws.on('close', () => {
        if (isDebugEnabled()) console.log('[Exec] Shell session ended', { containerId, reason: 'ws-close' });
        try {
          stream.destroy();
        } catch (e) {
          // Stream already destroyed before WS close
          console.warn('[Exec] Stream already destroyed on WS close:', (e as Error).message);
        }
      });

    } catch (error) {
      const err = error as Error;
      console.error('[Exec] Failed to start shell:', err.message, { containerId });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\r\n\x1b[31mFailed to start shell: ${err.message}\x1b[0m\r\n`);
      }
    }
  }
}

export const globalDockerNetwork = { rxSec: 0, txSec: 0 };
let lastNetSum = { rx: 0, tx: 0, timestamp: Date.now() };
let isUpdatingNetwork = false;

export const updateGlobalDockerNetwork = async () => {
  if (isUpdatingNetwork) return; // Prevent overlapping calls
  isUpdatingNetwork = true;
  try {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const dockerController = DockerController.getInstance(nodeId);
    const containers = await dockerController.getRunningContainers();

    const statsResults = await Promise.allSettled(
      containers.map(c => dockerController.getContainerStatsStream(c.Id))
    );

    let currentRxSum = 0;
    let currentTxSum = 0;

    for (const result of statsResults) {
      if (result.status === 'fulfilled') {
        try {
          const stats = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
          if (stats.networks) {
            for (const [_, net] of Object.entries(stats.networks) as any) {
              currentRxSum += net.rx_bytes || 0;
              currentTxSum += net.tx_bytes || 0;
            }
          }
        } catch (e) {
          // ignore parsing errors
        }
      }
    }

    const now = Date.now();
    const timeDiffSeconds = (now - lastNetSum.timestamp) / 1000;

    if (timeDiffSeconds > 0) {
      const rxDelta = currentRxSum >= lastNetSum.rx ? currentRxSum - lastNetSum.rx : 0;
      const txDelta = currentTxSum >= lastNetSum.tx ? currentTxSum - lastNetSum.tx : 0;

      globalDockerNetwork.rxSec = rxDelta / timeDiffSeconds;
      globalDockerNetwork.txSec = txDelta / timeDiffSeconds;
    }

    lastNetSum = { rx: currentRxSum, tx: currentTxSum, timestamp: now };
  } catch {
    // Silently skip when Docker is unreachable (e.g. no local engine).
    // Network stats will remain at their last known values.
  } finally {
    isUpdatingNetwork = false;
  }
};

// Poll network stats every 5s (reduced from 3s to lower Docker daemon pressure)
setInterval(updateGlobalDockerNetwork, 5000);

export default DockerController;
