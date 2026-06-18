import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { getErrorMessage } from '../utils/errors';
import { formatNoTargetError } from '../utils/remoteTarget';

// Per-node read budget for the authoritative label fan-out. Mirrors the
// node-stacks proxy budget in fleet.ts so a slow remote cannot stall the Stop
// card's suggestions/preview reads indefinitely; an unreachable node is reported
// rather than blocking the rest of the fleet.
const REMOTE_TIMEOUT_MS = 8_000;

export interface NodeStackLabelState {
  nodeId: number;
  nodeName: string;
  reachable: boolean;
  error?: string;
  /** Every stack label on this node (name + node-local color), assigned or not. */
  labels: { name: string; color: string }[];
  /** Stack-label name -> stack names assigned to it on this node. */
  labelStacks: Record<string, string[]>;
}

// Narrow a `GET /api/labels` response (`Label[]`) to name/color pairs. Tolerates
// `unknown` so a malformed remote body degrades to empty rather than throwing.
function parseLabels(raw: unknown): { name: string; color: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; color: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    const color = (item as { color?: unknown }).color;
    if (typeof name === 'string') out.push({ name, color: typeof color === 'string' ? color : 'slate' });
  }
  return out;
}

// Invert a `GET /api/labels/assignments` response (`Record<stackName, Label[]>`)
// into label-name -> assigned stack names.
function invertAssignments(raw: unknown): Record<string, string[]> {
  const labelStacks: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object') return labelStacks;
  for (const [stackName, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(labels)) continue;
    for (const label of labels) {
      if (!label || typeof label !== 'object') continue;
      const name = (label as { name?: unknown }).name;
      if (typeof name === 'string') (labelStacks[name] ??= []).push(stackName);
    }
  }
  return labelStacks;
}

/**
 * Resolve every node's authoritative stack-label state.
 *
 * The local node is read in-process; each remote is queried live via its own
 * `GET /api/labels` (all stack labels) and `GET /api/labels/assignments` (which
 * stacks carry each). This is the authoritative source for fleet-wide stack-label
 * discovery: the control DB does not mirror remote-node labels (FleetSyncService
 * replicates only security resources), so a central-DB read would miss labels
 * that live only on a remote. An unreachable remote is returned with
 * `reachable: false` and empty maps so callers can flag it without dropping the
 * rest of the fleet. Node labels (the separate `/api/node-labels` namespace) are
 * never included, because `/api/labels` returns stack labels only.
 */
export async function getFleetStackLabelStates(): Promise<NodeStackLabelState[]> {
  const db = DatabaseService.getInstance();
  const nodes = db.getNodes();
  return Promise.all(nodes.map(async (node): Promise<NodeStackLabelState> => {
    if (node.type === 'local') {
      try {
        const labels = db.getLabels(node.id).map(l => ({ name: l.name, color: l.color }));
        return { nodeId: node.id, nodeName: node.name, reachable: true, labels, labelStacks: invertAssignments(db.getLabelsForStacks(node.id)) };
      } catch (err) {
        console.warn(`[FleetLabelSummary] local node ${node.id} (${node.name}) label read failed:`, getErrorMessage(err, 'read error'));
        return { nodeId: node.id, nodeName: node.name, reachable: false, error: getErrorMessage(err, 'Failed to read local labels'), labels: [], labelStacks: {} };
      }
    }

    try {
      const target = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!target) {
        return { nodeId: node.id, nodeName: node.name, reachable: false, error: formatNoTargetError(node), labels: [], labelStacks: {} };
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
      const base = target.apiUrl.replace(/\/$/, '');
      const [labelsRes, assignRes] = await Promise.all([
        fetch(`${base}/api/labels`, { headers, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) }),
        fetch(`${base}/api/labels/assignments`, { headers, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) }),
      ]);
      if (!labelsRes.ok || !assignRes.ok) {
        const status = labelsRes.ok ? assignRes.status : labelsRes.status;
        console.warn(`[FleetLabelSummary] node ${node.id} (${node.name}) returned ${status} for label state`);
        return { nodeId: node.id, nodeName: node.name, reachable: false, error: `Remote returned ${status}`, labels: [], labelStacks: {} };
      }
      // A 200 with an unparseable or wrong-shaped body is a degraded node, not an
      // empty one: report it unreachable rather than silently dropping its labels
      // (which would defeat the authoritative discovery this helper exists for).
      let labelsBody: unknown;
      let assignBody: unknown;
      try {
        labelsBody = await labelsRes.json();
        assignBody = await assignRes.json();
      } catch (err) {
        console.warn(`[FleetLabelSummary] node ${node.id} (${node.name}) returned an unreadable label body:`, getErrorMessage(err, 'parse error'));
        return { nodeId: node.id, nodeName: node.name, reachable: false, error: 'Remote returned an unreadable response', labels: [], labelStacks: {} };
      }
      // `/api/labels` returns an array; `/api/labels/assignments` returns an
      // object map. A wrong top-level shape is a malformed response, not a
      // genuinely label-less node, so surface it instead of reporting zero labels.
      if (!Array.isArray(labelsBody) || assignBody === null || typeof assignBody !== 'object' || Array.isArray(assignBody)) {
        console.warn(`[FleetLabelSummary] node ${node.id} (${node.name}) returned an unexpected label shape`);
        return { nodeId: node.id, nodeName: node.name, reachable: false, error: 'Remote returned an unexpected label shape', labels: [], labelStacks: {} };
      }
      return { nodeId: node.id, nodeName: node.name, reachable: true, labels: parseLabels(labelsBody), labelStacks: invertAssignments(assignBody) };
    } catch (err) {
      console.warn(`[FleetLabelSummary] node ${node.id} (${node.name}) unreachable:`, getErrorMessage(err, 'Failed to reach remote node'));
      return { nodeId: node.id, nodeName: node.name, reachable: false, error: getErrorMessage(err, 'Failed to reach remote node'), labels: [], labelStacks: {} };
    }
  }));
}
