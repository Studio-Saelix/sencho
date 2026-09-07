import fs from 'fs/promises';
import DockerController from './DockerController';
import { classifyBuildChannel, isSenchoDevRepository, type BuildChannel } from '../helpers/selfUpdateCompose';
import { defaultInspectImage } from './selfDevBuildDetect';
import { parseImageRef, selectLocalRepoDigest } from './registry-api';
import { getSenchoVersion } from './CapabilityRegistry';
import { withTimeout } from '../utils/withTimeout';

/**
 * Identifies the Docker resources that belong to the running Sencho container
 * (image, attached networks, named volumes, the container itself) so the
 * Resources view and destructive routes can refuse to delete them and the
 * Unmanaged tab can filter out Sencho's own container.
 *
 * Identification strategy, in order:
 *   1. `process.env.HOSTNAME` resolves via `docker.getContainer(...).inspect()`.
 *      This is Docker's default (HOSTNAME equals the container's short ID).
 *   2. `/proc/self/cgroup` fallback. Custom `--hostname`, Compose `hostname:`,
 *      or `--uts=host` decouples HOSTNAME from the container ID; the kernel
 *      still places the process in a cgroup that names the full 64-hex
 *      container ID for both cgroupv1 (`.../docker/<id>`) and cgroupv2
 *      (`.../docker-<id>.scope` / `.../libpod-<id>.scope`).
 *
 * In dev mode (`npm run dev` outside Docker) both paths fail, the service
 * stays in its empty state, every `isOwn*()` returns false, and today's
 * behavior is preserved.
 */
/** Canonical runtime build identity of the running Sencho container. */
export interface BuildInfo {
  version: string | null;
  channel: BuildChannel;
  /** The image reference the running container was started with, null when unknown. */
  imageRef: string | null;
  /** Running image sha256 hex (no prefix), null when unknown. */
  imageId: string | null;
  /** Validated registry digest or pinned `dev-<sha>` tag, null when unknown. */
  revision: string | null;
}

class SelfIdentityService {
  private static instance: SelfIdentityService;
  private containerId: string | null = null;
  private containerName: string | null = null;
  private composeProjectName: string | null = null;
  private imageIdHex: string | null = null;
  private imageRef: string | null = null;
  private revision: string | null = null;
  private networkIds = new Set<string>();
  private networkNames = new Set<string>();
  private volumeNames = new Set<string>();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private enrichmentPromise: Promise<void> | null = null;

  public static getInstance(): SelfIdentityService {
    if (!SelfIdentityService.instance) {
      SelfIdentityService.instance = new SelfIdentityService();
    }
    return SelfIdentityService.instance;
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    if (this.initialized) return;
    this.initializePromise = this.initializeInternal().finally(() => {
      this.initialized = true;
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  private async initializeInternal(): Promise<void> {
    const docker = DockerController.getInstance().getDocker();
    const info = await this.resolveSelfInspect(docker);
    if (!info) return;

    this.containerId = info.Id ?? null;
    this.containerName = (info.Name || '').replace(/^\//, '') || null;
    this.composeProjectName = info.Config?.Labels?.['com.docker.compose.project'] ?? null;
    this.imageIdHex = SelfIdentityService.stripSha(info.Image ?? '') || null;
    this.imageRef = info.Config?.Image ?? null;
    // Bounded revision enrichment runs detached so it never blocks the callers
    // awaiting initialize() (Docker event monitoring, resources discovery). Core
    // identity above is already captured; enrichment only adds the registry
    // digest / pinned dev-<sha> and is failure-isolated. The promise is retained
    // so a reader that needs the settled revision can await it (see
    // whenRevisionResolved) instead of observing a transient null.
    this.enrichmentPromise = this.enrichRevision(this.imageRef, this.imageIdHex);

    const nets = info.NetworkSettings?.Networks ?? {};
    for (const [name, net] of Object.entries(nets)) {
      if (name) this.networkNames.add(name);
      const id = (net as { NetworkID?: string } | null)?.NetworkID;
      if (id) this.networkIds.add(id);
    }

    const mounts = (info.Mounts ?? []) as Array<{ Type?: string; Name?: string }>;
    for (const m of mounts) {
      if (m.Type === 'volume' && m.Name) {
        this.volumeNames.add(m.Name);
      }
    }

    const cidShort = this.containerId ? this.containerId.substring(0, 12) : '?';
    const iidShort = this.imageIdHex ? this.imageIdHex.substring(0, 12) : '?';
    console.log(
      `[SelfIdentity] Detected self: container=${cidShort}, image=${iidShort}, ` +
      `networks=${this.networkNames.size}, volumes=${this.volumeNames.size}`,
    );
  }

  private async resolveSelfInspect(
    docker: ReturnType<typeof DockerController.prototype.getDocker>,
  ): Promise<Awaited<ReturnType<ReturnType<typeof docker.getContainer>['inspect']>> | null> {
    const hostname = process.env.HOSTNAME;
    if (hostname) {
      try {
        return await docker.getContainer(hostname).inspect();
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        if (e?.statusCode !== 404) {
          console.warn('[SelfIdentity] HOSTNAME inspect failed:', e?.message || String(err));
          return null;
        }
        // 404 on HOSTNAME means custom hostname or running outside Docker;
        // fall through to the cgroup probe.
      }
    }

    const cgroupId = await SelfIdentityService.readContainerIdFromCgroup();
    if (!cgroupId) {
      console.log('[SelfIdentity] no HOSTNAME match and no container ID in /proc/self/cgroup; self-protection disabled (not running in Docker?)');
      return null;
    }

    try {
      return await docker.getContainer(cgroupId).inspect();
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e?.statusCode === 404) {
        console.log('[SelfIdentity] cgroup container ID inspect returned 404; self-protection disabled');
        return null;
      }
      console.warn('[SelfIdentity] cgroup-resolved inspect failed:', e?.message || String(err));
      return null;
    }
  }

  /**
   * Canonical runtime build identity. All fields are captured fields or derived
   * synchronously from them; this read never triggers a Docker call. `revision`
   * is populated by the detached enrichment step fired during initialize() and
   * reads null until that resolves (or if it fails).
   */
  getBuildInfo(): BuildInfo {
    return {
      version: getSenchoVersion(),
      channel: this.imageRef ? classifyBuildChannel(this.imageRef) : 'unknown',
      imageRef: this.imageRef,
      imageId: this.imageIdHex,
      revision: this.revision,
    };
  }

  /**
   * Resolves once the detached revision enrichment has settled (success or
   * failure), or immediately when none was started. Awaiting cannot hang or
   * throw (enrichment is bounded and failure-isolated). A reader that needs
   * the final `revision` awaits this before getBuildInfo() so a successful
   * response never freezes a transient null.
   */
  async whenRevisionResolved(): Promise<void> {
    if (this.enrichmentPromise) await this.enrichmentPromise;
  }

  /**
   * Resolve the immutable revision from the running image. For a dev-repo image
   * carrying a pinned `dev-<sha>` tag, the tag itself is the revision. Otherwise
   * the running image's `RepoDigests` are inspected for a digest matching the
   * running reference. Any failure (inspect rejection, timeout, no matching
   * digest) leaves `revision` null; enrichment never throws to the caller.
   */
  private async enrichRevision(imageRef: string | null, imageIdHex: string | null): Promise<void> {
    try {
      let revision: string | null = null;
      if (imageRef && isSenchoDevRepository(imageRef)) {
        const tag = parseImageRef(imageRef)?.tag;
        if (tag && /^dev-[0-9a-f]{7,40}$/.test(tag)) revision = tag;
      }
      if (!revision && imageRef && imageIdHex) {
        revision = await this.resolveDigestRevision(imageRef, imageIdHex);
      }
      this.revision = revision;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[SelfIdentity] build revision enrichment failed:', message);
    }
  }

  private async resolveDigestRevision(imageRef: string, imageIdHex: string): Promise<string | null> {
    const parsed = parseImageRef(imageRef);
    if (!parsed) return null;
    const inspected = await withTimeout(defaultInspectImage(imageIdHex), 2000, 'build revision inspect');
    return selectLocalRepoDigest(inspected.RepoDigests ?? [], parsed);
  }

  /** True when the given container ID or name matches the running Sencho container. Accepts short or full IDs. */
  isOwnContainer(idOrName: string): boolean {
    if (!idOrName) return false;
    if (this.containerId && SelfIdentityService.matchesId(this.containerId, idOrName)) return true;
    if (this.containerName && this.containerName === idOrName) return true;
    return false;
  }

  /** True when the given image reference (full or short hex ID, optionally `sha256:`-prefixed) matches Sencho's own image. */
  isOwnImage(idOrTag: string): boolean {
    if (!idOrTag || !this.imageIdHex) return false;
    const target = SelfIdentityService.stripSha(idOrTag);
    return SelfIdentityService.matchesId(this.imageIdHex, target);
  }

  /** True when the given network ID or name matches a network the Sencho container is attached to. */
  isOwnNetwork(idOrName: string): boolean {
    if (!idOrName) return false;
    // Names match exactly. Only hex-looking inputs (12 to 64 chars) are
    // prefix-matched against the cached IDs, so a network NAMED like a hex
    // prefix of Sencho's network ID is not falsely flagged.
    if (this.networkNames.has(idOrName)) return true;
    if (this.networkIds.has(idOrName)) return true;
    if (!SelfIdentityService.isHexId(idOrName)) return false;
    for (const id of this.networkIds) {
      if (SelfIdentityService.matchesId(id, idOrName)) return true;
    }
    return false;
  }

  /** True when the given volume name matches a named volume mounted into Sencho. Bind mounts are excluded by design. */
  isOwnVolume(name: string): boolean {
    if (!name) return false;
    return this.volumeNames.has(name);
  }

  /**
   * Bind mounts on the running Sencho container, used by the environment
   * checker to verify the compose directory is mounted at the same path on the
   * host and inside the container. Returns null when Sencho is not running in
   * Docker (dev / bare metal), where the 1:1 path-mapping concern does not
   * apply. Throws when Sencho IS containerized (a container id was resolved at
   * startup) but its own mounts cannot be read now, so the caller can report an
   * unverified state instead of a false "not containerized". Re-inspects on
   * each call rather than caching, because it runs only on an admin-triggered
   * diagnostic.
   */
  async getBindMounts(): Promise<Array<{ source: string; destination: string }> | null> {
    const docker = DockerController.getInstance().getDocker();
    const info = await this.resolveSelfInspect(docker);
    if (!info) {
      if (this.containerId) {
        throw new Error('container self-inspect unavailable; cannot read mounts');
      }
      return null;
    }
    const mounts = (info.Mounts ?? []) as Array<{ Type?: string; Source?: string; Destination?: string }>;
    return mounts
      .filter(m => m.Type === 'bind' && m.Source && m.Destination)
      .map(m => ({ source: m.Source as string, destination: m.Destination as string }));
  }

  /** Diagnostic snapshot used by route handlers when composing error responses. */
  getIdentity(): {
    containerId: string | null;
    containerName: string | null;
    composeProjectName: string | null;
    imageId: string | null;
    networkNames: string[];
    volumeNames: string[];
  } {
    return {
      containerId: this.containerId,
      containerName: this.containerName,
      composeProjectName: this.composeProjectName,
      imageId: this.imageIdHex,
      networkNames: [...this.networkNames],
      volumeNames: [...this.volumeNames],
    };
  }

  /** Test hook: clear cached state so a fresh initialize() can run with a different stub. */
  resetForTesting(): void {
    this.containerId = null;
    this.containerName = null;
    this.composeProjectName = null;
    this.imageIdHex = null;
    this.imageRef = null;
    this.revision = null;
    this.networkIds.clear();
    this.networkNames.clear();
    this.volumeNames.clear();
    this.initialized = false;
    this.initializePromise = null;
    this.enrichmentPromise = null;
  }

  private static stripSha(s: string): string {
    return s.startsWith('sha256:') ? s.slice('sha256:'.length) : s;
  }

  private static isHexId(s: string): boolean {
    return /^[a-f0-9]{12,64}$/i.test(s);
  }

  // Prefix matching is restricted to hex-shaped candidates: a 12-char short
  // ID hits the cached full ID and vice versa, but a name like "bridge" never
  // matches a cached ID just because of a partial overlap.
  private static matchesId(full: string, candidate: string): boolean {
    if (!full || !candidate) return false;
    if (full === candidate) return true;
    if (!SelfIdentityService.isHexId(full) || !SelfIdentityService.isHexId(candidate)) return false;
    if (full.startsWith(candidate)) return true;
    if (candidate.startsWith(full)) return true;
    return false;
  }

  // Both cgroupv1 (`12:cpuset:/docker/<64hex>`) and cgroupv2
  // (`0::/system.slice/docker-<64hex>.scope`, also podman's
  // `libpod-<64hex>.scope`) embed the full container ID as a 64-hex run.
  // Matching the longest such run survives kernel + runtime variation.
  static async readContainerIdFromCgroup(path = '/proc/self/cgroup'): Promise<string | null> {
    try {
      const contents = await fs.readFile(path, 'utf8');
      const matches = contents.match(/[a-f0-9]{64}/gi);
      return matches && matches.length > 0 ? matches[matches.length - 1].toLowerCase() : null;
    } catch {
      return null;
    }
  }
}

export default SelfIdentityService;
