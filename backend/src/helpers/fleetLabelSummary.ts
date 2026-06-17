import { DatabaseService, type Node } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { formatNoTargetError } from '../utils/remoteTarget';
import { getErrorMessage } from '../utils/errors';

export interface NodeLabelSummaryEntry {
  name: string;
  color: string;
  stackNames: string[];
}

export interface NodeLabelSummary {
  nodeId: number;
  nodeName: string;
  reachable: boolean;
  labels: NodeLabelSummaryEntry[];
  error?: string;
}

// Per-node fetch budget. Suggestions load on card mount and match-preview runs
// on a 500ms debounce, so keep this short: a wedged or slow remote should fall
// to "unreachable" fast rather than stall the whole fleet readout.
const SUMMARY_FETCH_TIMEOUT_MS = 5000;

/**
 * Authoritative stack-label summary for one node's own labels.
 *
 * Stack names are filtered to those still present on disk, matching the
 * `/api/labels/assignments` cleanup (routes/labels.ts) and runLocalLabelStop's
 * validStacks filter (helpers/fleetLabelStop.ts), so the preview/suggestion
 * counts equal the set a stop would actually act on.
 */
export async function readLocalLabelSummary(nodeId: number): Promise<NodeLabelSummaryEntry[]> {
  const db = DatabaseService.getInstance();
  const labels = db.getLabels(nodeId);
  if (labels.length === 0) return [];
  const fsStacks = new Set(await FileSystemService.getInstance(nodeId).getStacks());
  return labels.map(label => ({
    name: label.name,
    color: label.color,
    stackNames: db.getStacksForLabel(label.id, nodeId).filter(name => fsStacks.has(name)),
  }));
}

// Fail-closed parser for a remote `/api/labels` body (Label[]). A malformed
// shape returns null so the caller marks the node unreachable rather than
// flowing partial data into the aggregate counts.
function parseRemoteLabels(value: unknown): { name: string; color: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { name: string; color: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const label = item as Record<string, unknown>;
    if (typeof label.name !== 'string' || typeof label.color !== 'string') return null;
    out.push({ name: label.name, color: label.color });
  }
  return out;
}

// Fail-closed parser for a remote `/api/labels/assignments` body
// (Record<stackName, Label[]>). Collapses to label-name -> stack-name lists.
function parseRemoteAssignments(value: unknown): Map<string, string[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stacksByLabel = new Map<string, string[]>();
  for (const [stackName, labels] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(labels)) return null;
    for (const label of labels) {
      if (!label || typeof label !== 'object') return null;
      const name = (label as Record<string, unknown>).name;
      if (typeof name !== 'string') return null;
      const list = stacksByLabel.get(name) ?? [];
      list.push(stackName);
      stacksByLabel.set(name, list);
    }
  }
  return stacksByLabel;
}

async function summarizeRemoteNode(node: Node): Promise<NodeLabelSummary> {
  const target = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!target) {
    return { nodeId: node.id, nodeName: node.name, reachable: false, labels: [], error: formatNoTargetError(node) };
  }
  const base = target.apiUrl.replace(/\/$/, '');
  // Conditional Bearer only: pilot-agent targets carry an empty token and reach
  // the remote over the loopback tunnel without an Authorization header.
  const headers: Record<string, string> = {};
  if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
  try {
    const [labelsRes, assignmentsRes] = await Promise.all([
      fetch(`${base}/api/labels`, { headers, signal: AbortSignal.timeout(SUMMARY_FETCH_TIMEOUT_MS) }),
      fetch(`${base}/api/labels/assignments`, { headers, signal: AbortSignal.timeout(SUMMARY_FETCH_TIMEOUT_MS) }),
    ]);
    if (!labelsRes.ok || !assignmentsRes.ok) {
      // Surface the remote's own error body (e.g. a token/tier message) the same
      // way the fleet-stop leg does, so a reached-but-erroring node reports its
      // real cause rather than a bare status number.
      const failed = labelsRes.ok ? assignmentsRes : labelsRes;
      const errBody = (await failed.json().catch(() => ({}))) as { error?: string };
      return { nodeId: node.id, nodeName: node.name, reachable: false, labels: [], error: errBody.error || `Remote returned ${failed.status}` };
    }
    const labels = parseRemoteLabels(await labelsRes.json().catch(() => null));
    const stacksByLabel = parseRemoteAssignments(await assignmentsRes.json().catch(() => null));
    if (!labels || !stacksByLabel) {
      return { nodeId: node.id, nodeName: node.name, reachable: false, labels: [], error: 'Invalid label response from remote node' };
    }
    const summary = labels.map(label => ({
      name: label.name,
      color: label.color,
      stackNames: stacksByLabel.get(label.name) ?? [],
    }));
    return { nodeId: node.id, nodeName: node.name, reachable: true, labels: summary };
  } catch (err) {
    return { nodeId: node.id, nodeName: node.name, reachable: false, labels: [], error: getErrorMessage(err, 'Failed to reach remote node') };
  }
}

/**
 * Authoritative fleet-wide stack-label state: the local node from its own DB,
 * each remote queried live through its `/api/labels` + `/api/labels/assignments`
 * endpoints via the proxy target. Replaces the old central-DB read, which only
 * ever held the local node's labels (remote label rows are never mirrored to the
 * control). A node that cannot be reached, or that answers with a non-ok or
 * unusable response, is `reachable: false` with an error (its real cause) and
 * never blocks the reachable ones; reachable nodes carry complete `labels`.
 */
export async function collectFleetLabelSummaries(): Promise<NodeLabelSummary[]> {
  const nodes = DatabaseService.getInstance().getNodes();
  return Promise.all(nodes.map(async (node): Promise<NodeLabelSummary> => {
    if (node.type === 'local') {
      try {
        return { nodeId: node.id, nodeName: node.name, reachable: true, labels: await readLocalLabelSummary(node.id) };
      } catch (err) {
        return { nodeId: node.id, nodeName: node.name, reachable: false, labels: [], error: getErrorMessage(err, 'Failed to read local labels') };
      }
    }
    return summarizeRemoteNode(node);
  }));
}
