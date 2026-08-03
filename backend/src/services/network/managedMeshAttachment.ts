import fs from 'fs/promises';
import path from 'path';
import { DatabaseService } from '../DatabaseService';
import { SENCHO_MESH_NETWORK } from '../MeshComposeOverride';
import SelfIdentityService from '../SelfIdentityService';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import { isPathWithinBase, isValidStackName } from '../../utils/validation';
import type { ManagedNetworkAttachmentPredicate } from './normalize';

async function hasPilotMeshOverride(nodeId: number, stackName: string): Promise<boolean> {
  if (process.env.SENCHO_MODE !== 'pilot' || !isValidStackName(stackName)) return false;

  const dataDir = process.env.DATA_DIR || '/app/data';
  const overrideDir = path.resolve(dataDir, 'mesh', 'overrides', String(nodeId));
  const overridePath = path.resolve(overrideDir, `${path.basename(stackName)}.override.yml`);
  if (!isPathWithinBase(overridePath, overrideDir)) return false;

  try {
    await fs.access(overridePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    console.warn(
      '[NetworkDrift] Could not verify Pilot Mesh override for %s:',
      sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return false;
  }
}

export async function resolveManagedMeshAttachment(
  nodeId: number,
  stackName: string,
): Promise<ManagedNetworkAttachmentPredicate> {
  let stackManaged = false;
  try {
    stackManaged = DatabaseService.getInstance().isMeshStackEnabled(nodeId, stackName);
  } catch (error) {
    console.warn(
      '[NetworkDrift] Could not verify Mesh opt-in state for %s:',
      sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
  }
  if (!stackManaged) stackManaged = await hasPilotMeshOverride(nodeId, stackName);
  const selfIdentity = SelfIdentityService.getInstance();

  return (container, networkName) => networkName === SENCHO_MESH_NETWORK && (
    stackManaged
    || selfIdentity.isOwnContainer(container.id)
    || selfIdentity.isOwnContainer(container.name)
  );
}
