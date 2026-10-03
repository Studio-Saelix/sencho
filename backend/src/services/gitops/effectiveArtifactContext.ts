/**
 * Leaf-local effective Compose model plus Docker platform, used for digest freeze
 * and pin validation. Remote hubs fetch this over HTTP instead of reading the
 * leaf's compose_dir as a hub-local path.
 */
import { buildEffectiveServiceModel, type EffectiveServiceSpec } from '../effectiveServiceModel';
import DockerController from '../DockerController';

export type NodePlatform = { os: string; architecture: string };

export type EffectiveArtifactContext =
  | {
      renderable: true;
      services: EffectiveServiceSpec[];
      platform: NodePlatform | null;
    }
  | {
      renderable: false;
      services: [];
      platform: NodePlatform | null;
      error: string;
    };

/**
 * Docker reports the daemon host's `uname -m` spelling (`x86_64`, `aarch64`,
 * `armv7l`), while registry index descriptors and OCI manifests name platforms
 * with GOARCH names (`amd64`, `arm64`, `arm`). The digest resolver compares the
 * two by exact string, so this node's own read is translated here. A platform
 * payload a hub accepts from an older leaf arrives exactly as that leaf sent
 * it, so remote targets keep failing closed until their leaf is upgraded. OCI
 * ABI variants are not modelled: `linux/arm` children are matched on os and
 * architecture alone, so an index with several arm children fails closed and a
 * single child is accepted without a variant check.
 */
const DOCKER_TO_OCI_ARCHITECTURE: Record<string, string> = {
  x86_64: 'amd64',
  aarch64: 'arm64',
  armv6l: 'arm',
  armv7l: 'arm',
  armv8l: 'arm',
  i386: '386',
  i486: '386',
  i586: '386',
  i686: '386',
};

/** OCI name for a docker-info architecture spelling; unknown names pass through. */
function toOciArchitecture(architecture: string): string {
  const normalized = architecture.trim().toLowerCase();
  return DOCKER_TO_OCI_ARCHITECTURE[normalized] ?? normalized;
}

/** Docker OS/arch for this node, or null when the daemon is unreachable. */
export async function readNodePlatform(nodeId: number): Promise<NodePlatform | null> {
  try {
    const info = await DockerController.getInstance(nodeId).getDocker().info();
    const os = typeof info.OSType === 'string' ? info.OSType.trim().toLowerCase() : '';
    const architecture = typeof info.Architecture === 'string' ? toOciArchitecture(info.Architecture) : '';
    if (!os || !architecture) return null;
    return { os, architecture };
  } catch {
    return null;
  }
}

export function platformLabelOf(platform: NodePlatform | null): string | null {
  return platform ? `${platform.os}/${platform.architecture}` : null;
}

/** Render the stack on this node and read this node's Docker platform. */
export async function loadEffectiveArtifactContext(
  nodeId: number,
  stackName: string,
): Promise<EffectiveArtifactContext> {
  const platform = await readNodePlatform(nodeId);
  const model = await buildEffectiveServiceModel(nodeId, stackName);
  if (!model.renderable) {
    return {
      renderable: false,
      services: [],
      platform,
      error: model.error,
    };
  }
  return {
    renderable: true,
    services: model.services,
    platform,
  };
}
