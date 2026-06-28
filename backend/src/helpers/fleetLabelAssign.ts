import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { VALID_LABEL_COLORS, MAX_LABELS_PER_NODE } from './constants';
import { isValidStackName } from '../utils/validation';
import { getErrorMessage, isSqliteUniqueViolation } from '../utils/errors';

export interface LabelTemplate {
  name: string;
  color: string;
}

export interface LabelAssignResult {
  stackName: string;
  success: boolean;
  error?: string;
}

export interface LabelAssignOutcome {
  /** True when this node did not have the label and it was created here. */
  created: boolean;
  stackResults: LabelAssignResult[];
}

/**
 * Wire shape of `POST /api/fleet-actions/labels/local-assign`. The in-process
 * helper returns `stackResults`; the HTTP response names the same array
 * `results` to match the assign fan-out's remote contract. Keep the rename in
 * this one type so the producer and the control-side consumer cannot drift.
 */
export interface LabelLocalAssignResponse {
  created: boolean;
  results: LabelAssignResult[];
}

/**
 * Per-node row in the fleet bulk-assign orchestrator response
 * (`POST /api/fleet/labels/bulk-assign`). `reachable` is always set; `error`
 * carries the node-level cause when a node could not be reached or resolved.
 */
export interface AssignNodeResult {
  nodeId: number;
  nodeName: string;
  reachable: boolean;
  created: boolean;
  error?: string;
  stackResults: LabelAssignResult[];
}

/** Attribute one node-level error to every stack a node was meant to receive. */
export function failAllAssign(stackNames: string[], error: string): LabelAssignResult[] {
  return Array.from(new Set(stackNames)).map(stackName => ({ stackName, success: false, error }));
}

function isLabelAssignResult(value: unknown): value is LabelAssignResult {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.stackName === 'string'
    && typeof r.success === 'boolean'
    && (r.error === undefined || typeof r.error === 'string');
}

/**
 * Validate a remote node's `local-assign` 200 body before the control trusts it.
 *
 * Beyond the `{ created: boolean, results: LabelAssignResult[] }` shape, this
 * checks result *membership*: the receiver returns exactly one row per unique
 * requested stack, so a body that drops rows (an empty `results` for a non-empty
 * request), duplicates a stack, or returns a stack that was never requested is a
 * remote contract failure, not a clean assign. Without this, an empty `results`
 * passes the bare `Array.isArray` check and the control reports the node as a
 * successful zero-stack assign, which the UI then renders as success.
 *
 * `requestedStacks` is the per-node target list the control sent; it is deduped
 * here so the caller does not have to.
 */
export function validateRemoteAssignResults(
  requestedStacks: string[],
  body: unknown,
): { ok: true; created: boolean; results: LabelAssignResult[] } | { ok: false } {
  if (!body || typeof body !== 'object') return { ok: false };
  const b = body as Record<string, unknown>;
  if (typeof b.created !== 'boolean' || !Array.isArray(b.results)) return { ok: false };
  const requested = new Set(requestedStacks);
  const seen = new Set<string>();
  const results: LabelAssignResult[] = [];
  for (const row of b.results) {
    if (!isLabelAssignResult(row)) return { ok: false };
    if (!requested.has(row.stackName) || seen.has(row.stackName)) return { ok: false };
    seen.add(row.stackName);
    results.push(row);
  }
  if (seen.size !== requested.size) return { ok: false };
  return { ok: true, created: b.created, results };
}

/**
 * Validate a label template (the name/color a cross-node assign propagates).
 * Mirrors the create-label rules in `routes/labels.ts` and is the single
 * validator shared by the per-node receiver and the fleet orchestrator.
 */
export function validateLabelTemplate(
  input: unknown,
): { ok: true; template: LabelTemplate } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'label is required' };
  }
  const { name, color } = input as { name?: unknown; color?: unknown };
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 30) {
    return { ok: false, error: 'label.name is required and must be 1-30 characters' };
  }
  if (!/^[a-zA-Z0-9 -]+$/.test(name)) {
    return { ok: false, error: 'label.name may only contain letters, numbers, spaces, and hyphens' };
  }
  if (typeof color !== 'string' || !(VALID_LABEL_COLORS as readonly string[]).includes(color)) {
    return { ok: false, error: `label.color must be one of: ${VALID_LABEL_COLORS.join(', ')}` };
  }
  return { ok: true, template: { name: name.trim(), color } };
}

/**
 * Resolve-or-create a label by name on one node, then assign it to the given
 * stacks while preserving their existing labels (add semantics).
 *
 * Used by the gateway-orchestrated bulk-assign for the control node's own stacks
 * and by the per-node `POST /api/fleet-actions/labels/local-assign` receiver that
 * a control instance calls on each remote. Matching/creating by name (never by a
 * shared id) keeps labels node-local: each node owns its own label id, so the
 * control never reuses a local id on a remote.
 */
export async function runLocalLabelAssign(
  nodeId: number,
  label: LabelTemplate,
  stackNames: string[],
): Promise<LabelAssignOutcome> {
  const db = DatabaseService.getInstance();

  // Resolve the label on this node by exact name; create it if missing.
  let resolved = db.getLabels(nodeId).find(l => l.name === label.name);
  let created = false;
  if (!resolved) {
    if (db.getLabelCount(nodeId) >= MAX_LABELS_PER_NODE) {
      return { created: false, stackResults: failAllAssign(stackNames, `Maximum of ${MAX_LABELS_PER_NODE} labels per node reached`) };
    }
    try {
      resolved = db.createLabel(nodeId, label.name, label.color);
      created = true;
    } catch (err) {
      // A concurrent create can win the UNIQUE(node_id, name) race; re-fetch and
      // reuse the now-existing label rather than failing the assignment.
      if (isSqliteUniqueViolation(err)) {
        resolved = db.getLabels(nodeId).find(l => l.name === label.name);
      }
      if (!resolved) {
        return { created: false, stackResults: failAllAssign(stackNames, getErrorMessage(err, 'Failed to create label')) };
      }
    }
  }
  const labelId = resolved.id;

  const fsStacks = new Set(await FileSystemService.getInstance(nodeId).getStacks());
  const stackResults: LabelAssignResult[] = [];
  for (const stackName of Array.from(new Set(stackNames))) {
    if (!isValidStackName(stackName)) {
      stackResults.push({ stackName, success: false, error: 'Invalid stack name' });
      continue;
    }
    if (!fsStacks.has(stackName)) {
      stackResults.push({ stackName, success: false, error: 'Stack not found' });
      continue;
    }
    try {
      db.addStackLabels(stackName, nodeId, [labelId]);
      stackResults.push({ stackName, success: true });
    } catch (err) {
      stackResults.push({ stackName, success: false, error: getErrorMessage(err, 'Failed to assign label') });
    }
  }
  return { created, stackResults };
}
