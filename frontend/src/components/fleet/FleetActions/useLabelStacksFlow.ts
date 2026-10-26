import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, fetchForNode } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import type { FleetNode } from '@/components/FleetView/types';
import { type Label, type LabelColor, LABEL_COLORS } from '@/components/label-types';
import type { ResultRow } from './ResultsList';

interface NodeStackResult { stackName: string; success: boolean; error?: string }
interface AssignNodeResult {
  nodeId: number;
  nodeName: string;
  reachable?: boolean;
  error?: string;
  created: boolean;
  stackResults: NodeStackResult[];
}

export interface NodeData {
  node: FleetNode;
  reachable: boolean;
  stacks: string[];
  labels: Label[];
}

// A label name that exists somewhere in the fleet, with a deterministic color
// to propagate. `colorConflict` flags names whose stored color differs across
// nodes (the local node's color wins, then the most common, then the first).
export interface LabelTemplate {
  name: string;
  color: LabelColor;
  colorConflict: boolean;
}

// One node's slice of the pending assignment: the stacks selected on it and
// whether the label will be created there.
export type PreviewNode = { nodeId: number; nodeName: string; willCreate: boolean; stacks: string[] };

export interface AssignOutcome {
  label: string;
  rows: ResultRow[];
  ok: number;
  failed: number;
  unreachable: number;
  nodes: number;
}

interface Options {
  open: boolean;
  nodes: FleetNode[];
}

async function loadNode(node: FleetNode): Promise<NodeData> {
  try {
    const [stacksRes, labelsRes] = await Promise.all([
      fetchForNode(`/fleet/node/${node.id}/stacks`, node.id),
      fetchForNode('/labels', node.id),
    ]);
    const stacks: unknown = stacksRes.ok ? await stacksRes.json() : null;
    const labels: unknown = labelsRes.ok ? await labelsRes.json() : null;
    const wellFormed = Array.isArray(stacks) && Array.isArray(labels)
      && stacks.every((stack) => typeof stack === 'string')
      && labels.every((label) => typeof label?.name === 'string' && typeof label?.color === 'string');
    if (!wellFormed) {
      console.warn(`[LabelStacks] node ${node.id} (${node.name}) load incomplete: stacks ${stacksRes.status}, labels ${labelsRes.status}`);
      return { node, reachable: false, stacks: [], labels: [] };
    }
    return { node, reachable: true, stacks: stacks as string[], labels: labels as Label[] };
  } catch (err) {
    console.error(`[LabelStacks] failed to load node ${node.id} (${node.name}):`, err);
    return { node, reachable: false, stacks: [], labels: [] };
  }
}

function buildTemplates(nodeData: NodeData[]): LabelTemplate[] {
  const byName = new Map<string, { colors: Map<string, number>; localColor?: string }>();
  for (const entry of nodeData) {
    const isLocal = entry.node.type === 'local';
    for (const label of entry.labels) {
      const t = byName.get(label.name) ?? { colors: new Map<string, number>() };
      t.colors.set(label.color, (t.colors.get(label.color) ?? 0) + 1);
      if (isLocal) t.localColor = label.color;
      byName.set(label.name, t);
    }
  }
  return Array.from(byName.entries())
    .map(([name, t]) => {
      let color = t.localColor;
      if (!color) {
        let best = -1;
        for (const [c, count] of t.colors) {
          if (count > best) { best = count; color = c; }
        }
      }
      const safe: LabelColor = typeof color === 'string' && (LABEL_COLORS as string[]).includes(color) ? (color as LabelColor) : 'slate';
      return { name, color: safe, colorConflict: t.colors.size > 1 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toRows(apiResults: AssignNodeResult[]): ResultRow[] {
  return apiResults.map((node) => {
    const unreachable = node.reachable === false;
    const ok = node.stackResults.filter(s => s.success).length;
    return {
      key: `node-${node.nodeId}`,
      label: unreachable
        ? `${node.nodeName} (unreachable)`
        : `${node.nodeName} · ${node.created ? 'label created' : 'label reused'} · ${ok}/${node.stackResults.length} stack${node.stackResults.length === 1 ? '' : 's'}`,
      success: !unreachable && node.stackResults.length > 0 && node.stackResults.every(s => s.success),
      error: unreachable ? (node.error ?? 'Node unreachable') : undefined,
      sub: node.stackResults.map((s, i) => ({
        key: `${node.nodeId}-${s.stackName}-${i}`,
        label: s.stackName,
        success: s.success,
        error: s.error,
      })),
    };
  });
}

/** Stack-label assignment across nodes. Loads the fleet's stacks and labels once the sheet opens. */
export function useLabelStacksFlow({ open, nodes }: Options) {
  const { can } = useAuth();
  const [nodeData, setNodeData] = useState<NodeData[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<LabelTemplate | null>(null);
  // nodeId -> selected stack names on that node.
  const [selected, setSelected] = useState<Map<number, Set<string>>>(new Map());
  const [search, setSearch] = useState('');
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<AssignOutcome | null>(null);
  // Bumped by Refresh so the snapshot is never trusted indefinitely: a remote
  // that recovers, or a label added after the sheet opened, is re-read on demand.
  const [refreshKey, setRefreshKey] = useState(0);

  // The latest nodes are read through a ref so the load effect can rebuild
  // per-node state without taking the array as a reactive dependency (it is a
  // fresh reference each parent render, e.g. on each fleet poll).
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; });
  const nodeIds = nodes.map(n => n.id).join(',');
  // A finished or running assign must not be wiped by a roster change. A change
  // that arrives while locked is replayed once the lock releases.
  const lockedRef = useRef(false);
  const reloadPendingRef = useRef(false);
  useEffect(() => {
    lockedRef.current = running || outcome !== null;
    if (!lockedRef.current && reloadPendingRef.current) {
      reloadPendingRef.current = false;
      setRefreshKey((key) => key + 1);
    }
  }, [running, outcome]);

  // Reload when the node set changes or the operator refreshes, unless a run is
  // in flight or finished (the change is replayed once it releases). Resets the
  // selection because a refreshed fleet can no longer guarantee the previously
  // picked stacks still exist.
  useEffect(() => {
    if (!open) return;
    if (lockedRef.current) {
      reloadPendingRef.current = true;
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setSelected(new Map());
      setSelectedTemplate(null);
      setOutcome(null);
      const entries = await Promise.all(nodesRef.current.map(loadNode));
      if (!cancelled) {
        setNodeData(entries);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [open, nodeIds, refreshKey]);

  const templates = useMemo(() => buildTemplates(nodeData), [nodeData]);
  const totalSelected = useMemo(() => {
    let n = 0;
    for (const set of selected.values()) n += set.size;
    return n;
  }, [selected]);
  const canApplySelection = useMemo(() =>
    [...selected].every(([nodeId, stackNames]) =>
      [...stackNames].every(stackName => can('stack:edit', 'stack', stackName, nodeId))),
  [selected, can]);

  const denied = totalSelected > 0 && !canApplySelection;

  const previewNodes = useMemo(() => {
    if (!selectedTemplate) return [];
    return nodeData
      .map(entry => {
        const set = selected.get(entry.node.id);
        const stacks = set ? Array.from(set) : [];
        if (stacks.length === 0) return null;
        const willCreate = !entry.labels.some(l => l.name === selectedTemplate.name);
        return { nodeId: entry.node.id, nodeName: entry.node.name, willCreate, stacks };
      })
      .filter((n): n is PreviewNode => n !== null);
  }, [nodeData, selected, selectedTemplate]);

  function toggleStack(nodeId: number, stackName: string) {
    setSelected(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(nodeId) ?? []);
      if (set.has(stackName)) set.delete(stackName);
      else set.add(stackName);
      next.set(nodeId, set);
      return next;
    });
  }
  function toggleAllForNode(nodeId: number, stacks: string[]) {
    setSelected(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(nodeId) ?? []);
      const allSelected = stacks.length > 0 && stacks.every(s => set.has(s));
      if (allSelected) stacks.forEach(s => set.delete(s));
      else stacks.forEach(s => set.add(s));
      next.set(nodeId, set);
      return next;
    });
  }
  function reset() {
    setSelected(new Map());
    setSelectedTemplate(null);
    setOutcome(null);
    setSearch('');
  }

  async function run() {
    if (running || outcome !== null) return;
    if (!selectedTemplate || totalSelected === 0 || !canApplySelection) return;
    const targets = Array.from(selected.entries())
      .filter(([, set]) => set.size > 0)
      .map(([nodeId, set]) => ({ nodeId, stackNames: Array.from(set) }));
    const toastId = toast.loading(`Assigning "${selectedTemplate.name}" to ${totalSelected} stack${totalSelected === 1 ? '' : 's'} across ${targets.length} node${targets.length === 1 ? '' : 's'}…`);
    setRunning(true);
    try {
      const res = await apiFetch('/fleet/labels/bulk-assign', {
        method: 'POST',
        body: JSON.stringify({ label: { name: selectedTemplate.name, color: selectedTemplate.color }, targets }),
      });
      const body = await res.json().catch(() => ({}));
      toast.dismiss(toastId);
      if (!res.ok) {
        toast.error(body.error || 'Label stacks failed');
        return;
      }
      // A 200 with a missing or non-array `results` is a server/contract bug,
      // not an empty assign: don't let it fall through to the success path with
      // zero counts. Log it and tell the operator it was unexpected.
      if (!Array.isArray(body.results)) {
        console.error('[LabelStacks] bulk-assign returned a malformed body', body);
        toast.error('Label stacks returned an unexpected response. Check the server logs and retry.');
        return;
      }
      const apiResults = body.results as AssignNodeResult[];
      const allStacks = apiResults.flatMap(n => n.stackResults);
      const ok = allStacks.filter(s => s.success).length;
      const failed = allStacks.length - ok;
      const unreachable = apiResults.filter(n => n.reachable === false).length;
      if (ok === 0 && failed === 0 && unreachable === 0) {
        // Every node reported zero stack results for a non-empty request: a
        // contract break the success path must not absorb.
        console.error('[LabelStacks] bulk-assign returned no stack results', apiResults);
        toast.error('Label stacks returned no results. Check the server logs and retry.');
        return;
      }
      setOutcome({ label: selectedTemplate.name, rows: toRows(apiResults), ok, failed, unreachable, nodes: apiResults.length });
      if (failed === 0 && unreachable === 0) toast.success(`Assigned "${selectedTemplate.name}" to ${ok} stack${ok === 1 ? '' : 's'} across ${apiResults.length} node${apiResults.length === 1 ? '' : 's'}.`);
      else toast.warning(`${ok} assigned, ${failed} failed${unreachable > 0 ? `, ${unreachable} node${unreachable === 1 ? '' : 's'} unreachable` : ''}. See the result.`);
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setRunning(false);
    }
  }

  return {
    nodeData, loading, templates, selectedTemplate, selected, search, running, outcome,
    totalSelected, canApplySelection, denied, previewNodes,
    setSelectedTemplate, setSearch, toggleStack, toggleAllForNode, reset, run,
    refresh: () => setRefreshKey(k => k + 1),
  };
}
