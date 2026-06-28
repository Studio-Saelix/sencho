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

function isStackStopResult(value: unknown): value is StackStopResult {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.stackName === 'string' && typeof r.success === 'boolean';
}

/**
 * Validate a remote node's `local-stop` 200 body before the control trusts it.
 * A response that is not this exact shape (a missing/non-boolean `matched`, a
 * non-array `results`, or a malformed result element) is a remote contract
 * failure, not an empty stop. The control-side fan-out fails that node rather
 * than defaulting `matched` to true and `results` to [], which the UI would
 * otherwise render as a successful zero-stack node and hide the failure.
 */
export function isLabelLocalStopResponse(value: unknown): value is LabelLocalStopResponse {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.matched === 'boolean'
    && Array.isArray(r.results)
    && r.results.every(isStackStopResult);
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
 *
 * `allowedStacks`, when provided, binds the stop to exactly the stacks the
 * operator confirmed in the preview: only stacks that are still label-matched
 * AND in this set are stopped, so a stack that gained the label between preview
 * and execution is never stopped. A confirmed stack that went the other way (it
 * lost the label or left disk) is reported as a failure rather than dropped, so
 * the stop never reads as clean for a stack that silently fell out of scope.
 * Omitted (e.g. a dry run) means stop every currently label-matched stack.
 */
export async function runLocalLabelStop(
  nodeId: number,
  labelName: string,
  dryRun: boolean,
  allowedStacks?: ReadonlySet<string>,
): Promise<LabelStopOutcome> {
  const db = DatabaseService.getInstance();
  const label = db.getLabels(nodeId).find(l => l.name === labelName);
  if (!label) return { matched: false, stackResults: [] };
  const stackNames = db.getStacksForLabel(label.id, nodeId);
  // With no confirmed allowlist this is the unbound path: an unassigned label is
  // a clean no-op. When stacks were confirmed we fall through so any that left
  // scope are reported rather than silently dropped (see the reconcile below).
  if (stackNames.length === 0 && !allowedStacks) return { matched: true, stackResults: [] };

  const lockKey = `bulk:${nodeId}`;
  if (activeBulkActions.has(lockKey)) {
    const busyStacks = allowedStacks ? stackNames.filter(name => allowedStacks.has(name)) : stackNames;
    return {
      matched: true,
      stackResults: busyStacks.map(stackName => ({
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
    const validStacks = stackNames.filter(name =>
      fsStackSet.has(name) && (!allowedStacks || allowedStacks.has(name)),
    );
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
    // Reconcile the confirmed set against what was actually stoppable. A stack
    // the operator confirmed that has since lost the label or left disk is
    // reported as a failure, so the stop never reads as clean for a stack that
    // silently dropped out between preview and execution.
    if (allowedStacks) {
      const acted = new Set(validStacks);
      const labelled = new Set(stackNames);
      for (const stackName of allowedStacks) {
        if (acted.has(stackName)) continue;
        stackResults.push({
          stackName,
          success: false,
          error: labelled.has(stackName) ? 'Stack not found on this node' : 'No longer carries this label',
        });
      }
    }
    if (!dryRun && stackResults.some(r => r.success)) invalidateNodeCaches(nodeId);
    return { matched: true, stackResults };
  } finally {
    activeBulkActions.delete(lockKey);
  }
}
