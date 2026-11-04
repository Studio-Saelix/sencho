/**
 * Leaf-local effective Compose model plus Docker platform, used for digest freeze
 * and pin validation. Remote hubs fetch this over HTTP instead of reading the
 * leaf's compose_dir as a hub-local path.
 */
import { buildEffectiveServiceModel, type EffectiveServiceSpec } from '../effectiveServiceModel';
import DockerController from '../DockerController';
import { canonicalNodePlatform } from './platformNames';

/**
 * A platform label. `variant` is present only when an override names one (for
 * example `linux/arm/v7`); a node read does not report a variant, and the
 * registry resolver compares OS and architecture.
 */
export type NodePlatform = { os: string; architecture: string; variant?: string };

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
 * Docker OS/arch for this node, or null when the daemon is unreachable.
 *
 * The architecture is translated to its OCI name here, because the digest
 * resolver compares platform labels by exact string. A platform payload a hub
 * accepts from an older leaf arrives exactly as that leaf sent it, so remote
 * targets keep failing closed until their leaf is upgraded.
 */
export async function readNodePlatform(nodeId: number): Promise<NodePlatform | null> {
  try {
    const info = await DockerController.getInstance(nodeId).getDocker().info();
    const platform = canonicalNodePlatform({
      os: typeof info.OSType === 'string' ? info.OSType : '',
      architecture: typeof info.Architecture === 'string' ? info.Architecture : '',
    });
    if (!platform.os || !platform.architecture) return null;
    return platform;
  } catch {
    return null;
  }
}

export function platformLabelOf(platform: NodePlatform | null): string | null {
  if (!platform) return null;
  return `${platform.os}/${platform.architecture}${platform.variant ? `/${platform.variant}` : ''}`;
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
