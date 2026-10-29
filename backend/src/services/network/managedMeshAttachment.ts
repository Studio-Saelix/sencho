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

/** Whether the stack is opted into Sencho Mesh, through the database or a
 *  Pilot Mesh override. A failed opt-in read is logged and counts as not
 *  opted in. */
export async function isStackMeshManaged(nodeId: number, stackName: string): Promise<boolean> {
  try {
    if (DatabaseService.getInstance().isMeshStackEnabled(nodeId, stackName)) return true;
  } catch (error) {
    console.warn(
      '[NetworkDrift] Could not verify Mesh opt-in state for %s:',
      sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
  }
  return hasPilotMeshOverride(nodeId, stackName);
}

export async function resolveManagedMeshAttachment(
  nodeId: number,
  stackName: string,
): Promise<ManagedNetworkAttachmentPredicate> {
  const stackManaged = await isStackMeshManaged(nodeId, stackName);
  const selfIdentity = SelfIdentityService.getInstance();

  return (container, networkName) => networkName === SENCHO_MESH_NETWORK && (
    stackManaged
    || selfIdentity.isOwnContainer(container.id)
    || selfIdentity.isOwnContainer(container.name)
  );
}
