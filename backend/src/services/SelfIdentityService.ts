import fs from 'fs/promises';
import DockerController from './DockerController';

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
class SelfIdentityService {
  private static instance: SelfIdentityService;
  private containerId: string | null = null;
  private containerName: string | null = null;
  private imageIdHex: string | null = null;
  private networkIds = new Set<string>();
  private networkNames = new Set<string>();
  private volumeNames = new Set<string>();
  private initialized = false;

  public static getInstance(): SelfIdentityService {
    if (!SelfIdentityService.instance) {
      SelfIdentityService.instance = new SelfIdentityService();
    }
    return SelfIdentityService.instance;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const docker = DockerController.getInstance().getDocker();
    const info = await this.resolveSelfInspect(docker);
    if (!info) return;

    this.containerId = info.Id ?? null;
    this.containerName = (info.Name || '').replace(/^\//, '') || null;
    this.imageIdHex = SelfIdentityService.stripSha(info.Image ?? '') || null;

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

  /** Diagnostic snapshot used by route handlers when composing error responses. */
  getIdentity(): {
    containerId: string | null;
    containerName: string | null;
    imageId: string | null;
    networkNames: string[];
    volumeNames: string[];
  } {
    return {
      containerId: this.containerId,
      containerName: this.containerName,
      imageId: this.imageIdHex,
      networkNames: [...this.networkNames],
      volumeNames: [...this.volumeNames],
    };
  }

  /** Test hook: clear cached state so a fresh initialize() can run with a different stub. */
  resetForTesting(): void {
    this.containerId = null;
    this.containerName = null;
    this.imageIdHex = null;
    this.networkIds.clear();
    this.networkNames.clear();
    this.volumeNames.clear();
    this.initialized = false;
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
