import axios from 'axios';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { PROXY_TIER_HEADER } from '../services/license-headers';
import { LicenseService } from '../services/LicenseService';
import { isValidStackName } from '../utils/validation';
import { getErrorMessage } from '../utils/errors';

const REMOTE_STACKS_TIMEOUT_MS = 30_000;

export type AssertStackExistsResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Verify that `stackName` exists on `nodeId` before inserting a stack-scoped
 * role assignment. Local nodes use FileSystemService; remotes use a machine
 * GET /api/stacks via NodeRegistry.getProxyTarget.
 */
export async function assertStackExistsOnNode(
  nodeId: number,
  stackName: string,
): Promise<AssertStackExistsResult> {
  if (!isValidStackName(stackName)) {
    return { ok: false, error: 'Invalid stack name' };
  }

  const node = DatabaseService.getInstance().getNode(nodeId);
  if (!node) {
    return { ok: false, error: 'Node not found' };
  }

  if (node.type === 'local') {
    try {
      const stacks = await FileSystemService.getInstance(nodeId).getStacks();
      if (!stacks.includes(stackName)) {
        return { ok: false, error: 'Stack not found on node' };
      }
      return { ok: true };
    } catch (err) {
      console.error('[assertStackExistsOnNode] Local stack list failed:', getErrorMessage(err, 'unknown'));
      return { ok: false, error: 'Failed to verify stack on node' };
    }
  }

  const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
  if (!target) {
    return { ok: false, error: 'Remote node is unreachable' };
  }

  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const headers: Record<string, string> = {
    [PROXY_TIER_HEADER]: LicenseService.getInstance().getProxyHeaders().tier,
  };
  if (target.apiToken) {
    headers.Authorization = `Bearer ${target.apiToken}`;
  }

  try {
    const res = await axios.get(`${baseUrl}/api/stacks`, {
      headers,
      timeout: REMOTE_STACKS_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: 'Failed to verify stack on remote node' };
    }
    if (!Array.isArray(res.data)) {
      return { ok: false, error: 'Failed to verify stack on remote node' };
    }
    const names = res.data.filter((n): n is string => typeof n === 'string');
    if (!names.includes(stackName)) {
      return { ok: false, error: 'Stack not found on node' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[assertStackExistsOnNode] Remote stack list failed:', getErrorMessage(err, 'unknown'));
    return { ok: false, error: 'Failed to verify stack on remote node' };
  }
}
