import type { DockerEndpointRefusal } from '@/lib/stackUpdate';
import { resolveStackFileKey } from './resolveStackFileKey';

/** A refusal handed to the editor by another surface, bound to the stack it was raised for. */
export interface PendingEndpointRefusal {
  nodeId: number;
  stackName: string;
  refusal: DockerEndpointRefusal;
}

/**
 * The stack file the pending refusal may open for, or null while the target
 * node or stack is not the one now loaded. A cross-node handoff (or a canceled
 * unsaved-changes prompt) can leave the navigation unfinished, so the dialog is
 * opened only once the named stack is the active selection, never against
 * whatever happened to be loaded first.
 */
export function loadedEndpointRefusal(
  pending: PendingEndpointRefusal | null,
  activeNodeId: number | null,
  files: ReadonlyArray<string>,
  selectedFile: string | null,
  loading: boolean,
): { nodeId: number; stackFile: string } | null {
  if (!pending || activeNodeId === null || activeNodeId !== pending.nodeId) return null;
  if (loading || !selectedFile) return null;
  if (!files.some(file => file === pending.stackName || file.replace(/\.(yml|yaml)$/, '') === pending.stackName)) {
    return null;
  }
  const stackFile = resolveStackFileKey([...files], pending.stackName);
  if (stackFile !== selectedFile) return null;
  return { nodeId: pending.nodeId, stackFile };
}
