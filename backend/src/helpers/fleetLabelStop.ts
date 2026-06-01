import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { containerActionForStack } from '../routes/stacks';
import { activeBulkActions } from '../routes/labels';
import { invalidateNodeCaches } from './cacheInvalidation';

export interface StackStopResult {
  stackName: string;
  success: boolean;
  error?: string;
  dryRun?: boolean;
}

export interface LabelStopOutcome {
  matched: boolean;
  stackResults: StackStopResult[];
}

/**
 * Wire shape of `POST /api/fleet-actions/labels/local-stop`. The in-process
 * helper returns `stackResults`; the HTTP response names the same array
 * `results` to match the fleet-stop fan-out's existing remote contract. Keep
 * the rename in this one type so the producer and the control-side consumer
 * cannot drift.
 */
export interface LabelLocalStopResponse {
  matched: boolean;
  results: StackStopResult[];
}

/**
 * Run a label-name-matched container stop against one node's own local Docker.
 *
 * Used by the gateway-orchestrated fleet-stop for the control node's own stacks
 * and by the per-node `POST /api/fleet-actions/labels/local-stop` receiver that
 * a control instance calls on each remote during a fleet-wide stop. Matching by
 * name (not by a shared label id) keeps the work self-contained on the executing
 * node, so the control never has to assert that its mirrored label ids line up
 * with the remote's local ids.
 *
 * Shares the per-node `bulk:<nodeId>` lock with `POST /api/labels/:id/action` so
 * a fleet-stop and a per-label action cannot double-stop the same containers.
 */
export async function runLocalLabelStop(
  nodeId: number,
  labelName: string,
  dryRun: boolean,
): Promise<LabelStopOutcome> {
  const db = DatabaseService.getInstance();
  const label = db.getLabels(nodeId).find(l => l.name === labelName);
  if (!label) return { matched: false, stackResults: [] };
  const stackNames = db.getStacksForLabel(label.id, nodeId);
  if (stackNames.length === 0) return { matched: true, stackResults: [] };

  const lockKey = `bulk:${nodeId}`;
  if (activeBulkActions.has(lockKey)) {
    return {
      matched: true,
      stackResults: stackNames.map(stackName => ({
        stackName,
        success: false,
        error: 'A bulk action is already running on this node',
      })),
    };
  }
  activeBulkActions.add(lockKey);
  try {
    const fsStacks = await FileSystemService.getInstance(nodeId).getStacks();
    const fsStackSet = new Set(fsStacks);
    const validStacks = stackNames.filter(name => fsStackSet.has(name));
    const stackResults: StackStopResult[] = [];
    for (const stackName of validStacks) {
      if (dryRun) {
        stackResults.push({ stackName, success: true, dryRun: true });
        continue;
      }
      const outcome = await containerActionForStack(nodeId, stackName, 'stop');
      if (outcome.kind === 'ok') stackResults.push({ stackName, success: true });
      else if (outcome.kind === 'no-containers') stackResults.push({ stackName, success: false, error: 'No containers found for this stack' });
      else stackResults.push({ stackName, success: false, error: outcome.message });
    }
    if (!dryRun && stackResults.some(r => r.success)) invalidateNodeCaches(nodeId);
    return { matched: true, stackResults };
  } finally {
    activeBulkActions.delete(lockKey);
  }
}
