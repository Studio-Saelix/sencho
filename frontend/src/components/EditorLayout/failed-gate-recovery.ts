import type { HealthGateUiState } from '@/context/DeployFeedbackContext';

/**
 * Decide whether a failed health gate should record a recovery entry, and for
 * which stack file. Extracted as a pure function so the cross-node guard (the
 * load-bearing rule that a gate's failure records only on the node it ran on)
 * is unit-testable without standing up the editor.
 *
 * - `skip`: not a failed gate, or it ran on a different node than the active one,
 *   or the loaded file list does not yet belong to the gate's node. Stack
 *   filenames repeat across nodes and recovery records are cleared on node
 *   switch, so recording against another node's list would attach the failure to
 *   the wrong stack. `filesNodeId` (the node `files` was fetched for) must match
 *   too: right after a switch the active node updates before the new list lands,
 *   and a name lookup against the stale list could resolve to a wrong filename.
 * - `no-file`: the gate's node matches and its file list is loaded, but no stack
 *   file matches its name yet (the list may be mid-refresh). The caller leaves it
 *   unhandled so the effect retries once the files land.
 * - `record`: record a recovery entry against `stackFile`.
 */
export type FailedGateOutcome =
  | { kind: 'skip' }
  | { kind: 'no-file' }
  | { kind: 'record'; stackFile: string };

export function classifyFailedGate(
  healthGate: Pick<HealthGateUiState, 'status' | 'nodeId' | 'stackName'> | null,
  activeNodeId: number | null,
  filesNodeId: number | null,
  files: string[],
): FailedGateOutcome {
  if (!healthGate || healthGate.status !== 'failed') return { kind: 'skip' };
  // Record only while on the gate's node AND with that node's file list loaded.
  if (healthGate.nodeId !== activeNodeId || healthGate.nodeId !== filesNodeId) return { kind: 'skip' };
  const stackFile = files.find(f => f.replace(/\.(yml|yaml)$/, '') === healthGate.stackName);
  return stackFile ? { kind: 'record', stackFile } : { kind: 'no-file' };
}
