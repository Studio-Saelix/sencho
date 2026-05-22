/**
 * Shared snapshot capture functions used by both the REST API (index.ts)
 * and the SchedulerService for fleet-wide snapshot operations.
 */

import type { NodeMode } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { formatNoTargetError } from './remoteTarget';
import { isDebugEnabled } from './debug';

export interface SnapshotNodeData {
  nodeId: number;
  nodeName: string;
  stacks: Array<{
    stackName: string;
    files: Array<{ filename: string; content: string }>;
  }>;
}

/**
 * Minimal node shape accepted by capture functions.
 * `mode` is required so remote dispatch can emit a tunnel-aware error when
 * the pilot-agent proxy target is null.
 */
export interface CaptureNode {
  id: number;
  name: string;
  mode: NodeMode;
}

/**
 * Read compose.yaml and .env files for every stack on a local node.
 * Stacks whose compose file cannot be read are silently skipped.
 */
export async function captureLocalNodeFiles(node: CaptureNode): Promise<SnapshotNodeData> {
  const start = Date.now();
  const fsService = FileSystemService.getInstance(node.id);
  const stackNames = await fsService.getStacks();
  const stacks: SnapshotNodeData['stacks'] = [];

  for (const stackName of stackNames) {
    const files: Array<{ filename: string; content: string }> = [];
    try {
      const composeContent = await fsService.getStackContent(stackName);
      files.push({ filename: 'compose.yaml', content: composeContent });
    } catch (e) {
      console.warn(`[Fleet Snapshot] Could not read compose file for stack "${stackName}", skipping:`, (e as Error).message);
      continue;
    }
    try {
      const envContent = await fsService.getEnvContent(stackName);
      files.push({ filename: '.env', content: envContent });
    } catch {
      // No .env file - that's fine
    }
    stacks.push({ stackName, files });
  }

  if (isDebugEnabled()) {
    const fileCount = stacks.reduce((sum, s) => sum + s.files.length, 0);
    console.debug(`[Fleet:debug] Local capture "${node.name}": ${stacks.length} stack(s), ${fileCount} file(s) in ${Date.now() - start}ms`);
  }

  return { nodeId: node.id, nodeName: node.name, stacks };
}

/**
 * Fetch compose.yaml and .env files for every stack on a remote node
 * via the Distributed API proxy. Stacks whose compose file cannot be
 * fetched are silently skipped.
 */
export async function captureRemoteNodeFiles(node: CaptureNode): Promise<SnapshotNodeData> {
  const target = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!target) {
    throw new Error(formatNoTargetError(node));
  }

  const start = Date.now();
  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;

  const stacksRes = await fetch(`${baseUrl}/api/stacks`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!stacksRes.ok) throw new Error('Failed to fetch stacks from remote node');
  const stackNames = await stacksRes.json() as string[];

  const stacks: SnapshotNodeData['stacks'] = [];

  for (const stackName of stackNames) {
    const files: Array<{ filename: string; content: string }> = [];
    try {
      const composeRes = await fetch(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (composeRes.ok) {
        const content = await composeRes.text();
        files.push({ filename: 'compose.yaml', content });
      }
    } catch (e) {
      console.warn(`[Fleet Snapshot] Failed to fetch remote compose for stack "${stackName}":`, (e as Error).message);
      continue;
    }
    try {
      const envRes = await fetch(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/env`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (envRes.ok) {
        const content = await envRes.text();
        files.push({ filename: '.env', content });
      }
    } catch {
      // No .env - skip
    }
    if (files.length > 0) {
      stacks.push({ stackName, files });
    }
  }

  if (isDebugEnabled()) {
    const fileCount = stacks.reduce((sum, s) => sum + s.files.length, 0);
    console.debug(`[Fleet:debug] Remote capture "${node.name}": ${stacks.length} stack(s), ${fileCount} file(s) in ${Date.now() - start}ms`);
  }

  return { nodeId: node.id, nodeName: node.name, stacks };
}
