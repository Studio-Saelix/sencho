export interface NodeStackResult { stackName: string; success: boolean; error?: string; dryRun?: boolean }
export interface FleetStopNodeResult {
  nodeId: number;
  nodeName: string;
  reachable: boolean;
  matched: boolean;
  stackResults: NodeStackResult[];
  error?: string;
}

// Stop-by-label targets stack labels only. The `scope: 'stack'` tag keeps node
// labels (a separate namespace) from ever being fed into this destructive action,
// and the counts make the stack scope tangible in the picker. `nodes` lists the
// nodes that carry the label so the operator can see the spread before acting.
export interface FleetStopLabelSuggestion { name: string; scope: 'stack'; nodeCount: number; stackCount: number; nodes: string[] }

export interface MatchPreviewNode { nodeId: number; nodeName: string; reachable: boolean; labelExists: boolean; stackCount: number; stackNames: string[]; error?: string }
export interface MatchPreviewResponse { matchedNodes: number; matchedStacks: number; unreachableNodes: number; perNode: MatchPreviewNode[] }

export type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  /** `label` is the name the preview was resolved for, so a preview never gates Stop for a different label. */
  | { kind: 'ready'; data: MatchPreviewResponse; label: string };

// One node and the stacks the resolved blast radius would stop on it. The
// destructive Stop stays disabled until this is known, so the operator always
// acts on a concrete node/stack list shown in the Plan section rather than a
// label name alone.
export interface ResolvedTarget { nodeId: number; nodeName: string; stackNames: string[] }


export function isSuggestion(value: unknown): value is FleetStopLabelSuggestion {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  // `nodes` is tolerated as absent (coerced to [] at render) so a suggestion is
  // never dropped over a missing optional detail field.
  const nodesOk = s.nodes === undefined
    || (Array.isArray(s.nodes) && s.nodes.every(n => typeof n === 'string'));
  return typeof s.name === 'string' && s.scope === 'stack'
    && typeof s.nodeCount === 'number' && typeof s.stackCount === 'number' && nodesOk;
}

// The Plan section renders `perNode` (filter/some) outside any
// try/catch, so a malformed success body would throw during render rather than
// degrade. Validate the load-bearing shape before trusting it; anything off
// falls to the "unavailable" state.
export function isMatchPreviewResponse(value: unknown): value is MatchPreviewResponse {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.matchedNodes !== 'number' || typeof d.matchedStacks !== 'number') return false;
  if (!Array.isArray(d.perNode)) return false;
  return d.perNode.every((n) => {
    if (typeof n !== 'object' || n === null) return false;
    const node = n as Record<string, unknown>;
    return typeof node.nodeId === 'number'
      && typeof node.nodeName === 'string'
      && typeof node.reachable === 'boolean'
      && typeof node.stackCount === 'number'
      && Array.isArray(node.stackNames)
      && node.stackNames.every((name) => typeof name === 'string');
  });
}
