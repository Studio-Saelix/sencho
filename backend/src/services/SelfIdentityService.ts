import DockerController from './DockerController';

/**
 * Identifies the Docker resources that belong to the running Sencho container
 * (image, attached networks, named volumes, the container itself) so the
 * Resources view and destructive routes can refuse to delete them and the
 * Unmanaged tab can filter out Sencho's own container.
 *
 * Reads the container's identity from `process.env.HOSTNAME` (Docker injects
 * the container short-ID as HOSTNAME unless overridden) and inspects it via
 * Dockerode against the local node's socket. Mirrors the bootstrap pattern in
 * SelfUpdateService and the 404-tolerance pattern in MeshService.ensureSelfAttached.
 *
 * In dev mode (`npm run dev` outside Docker), HOSTNAME points at the
 * workstation and the inspect lookup returns 404; the service stays in its
 * empty state and every `isOwn*()` returns false, leaving today's behavior
 * untouched.
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

    const hostname = process.env.HOSTNAME;
    if (!hostname) {
      console.log('[SelfIdentity] HOSTNAME not set, self-protection disabled (not running in Docker?)');
      return;
    }

    try {
      const docker = DockerController.getInstance().getDocker();
      const container = docker.getContainer(hostname);
      const info = await container.inspect();

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
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e?.statusCode === 404) {
        console.log('[SelfIdentity] self-container lookup failed (404); self-protection disabled (not running in Docker?)');
        return;
      }
      console.warn('[SelfIdentity] initialization failed:', e?.message || String(err));
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
    if (this.networkNames.has(idOrName)) return true;
    if (this.networkIds.has(idOrName)) return true;
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

  // 64-hex IDs match when either side is a prefix of the other so the UI's
  // short-ID (12 chars) hits the cached full ID and vice versa.
  private static matchesId(full: string, candidate: string): boolean {
    if (!full || !candidate) return false;
    if (full === candidate) return true;
    if (full.startsWith(candidate)) return true;
    if (candidate.startsWith(full)) return true;
    return false;
  }
}

export default SelfIdentityService;
