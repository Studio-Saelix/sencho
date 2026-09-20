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

/** Docker OS/arch for this node, or null when the daemon is unreachable. */
export async function readNodePlatform(nodeId: number): Promise<NodePlatform | null> {
  try {
    const info = await DockerController.getInstance(nodeId).getDocker().info();
    const os = typeof info.OSType === 'string' ? info.OSType : '';
    const architecture = typeof info.Architecture === 'string' ? info.Architecture : '';
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
