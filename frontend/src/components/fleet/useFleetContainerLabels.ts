import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { FleetLabelInventoryResponse, LabelIndexRow } from '@/lib/labelInventory';

/** Requests in flight at once, so a large fleet does not exhaust the browser's connections. */
const LABELS_CONCURRENCY = 4;

/** A node that has not answered by now is reported as failed, so Refresh never stays locked behind it. */
export const LABELS_NODE_TIMEOUT_MS = 20_000;

export interface LabelsNodeRef {
  id: number;
  name: string;
}

export interface FleetContainerLabelsState {
  /** Every node that has answered so far, or null until the first one does. */
  data: FleetLabelInventoryResponse | null;
  /** True while any node's request is in flight, including a background revalidation. */
  loading: boolean;
  /** Nodes answered of nodes asked, only while loading. */
  progress: { done: number; total: number } | null;
  /** Reload every node, keeping what is already shown until each node's new answer lands. */
  refresh: () => void;
}

type NodeRow = FleetLabelInventoryResponse['nodes'][number];

function labelRowKey(row: LabelIndexRow): string {
  return `${row.key}\0${row.value}\0${row.source}`;
}

/**
 * Concatenate each node's inventory in node order. A node that failed on the way
 * (the request itself, not the node's own report) keeps the inventory it had
 * before, so a failed refresh does not blank its part of the tab, and its error
 * is named beside it.
 */
export function mergeLabelPieces(
  order: readonly LabelsNodeRef[],
  pieces: ReadonlyMap<number, FleetLabelInventoryResponse>,
  failures: ReadonlyMap<number, string>,
): FleetLabelInventoryResponse {
  const nodes: NodeRow[] = [];
  const byLabel = new Map<string, LabelIndexRow>();
  const nodeErrors: Record<number, string> = {};
  let generatedAt = 0;

  for (const node of order) {
    const piece = pieces.get(node.id);
    const failure = failures.get(node.id);
    if (piece) {
      nodes.push(...piece.nodes);
      for (const row of piece.aggregatedByLabel) {
        const key = labelRowKey(row);
        const existing = byLabel.get(key);
        if (existing) existing.containers.push(...row.containers);
        else byLabel.set(key, { ...row, containers: [...row.containers] });
      }
      Object.assign(nodeErrors, piece.nodeErrors);
      generatedAt = Math.max(generatedAt, piece.generatedAt);
    }
    // A fresh request failure replaces the error an older answer carried for the
    // same node, and a node that never answered is still listed as an error
    // rather than disappearing from the tab.
    if (failure !== undefined) {
      const kept = (piece?.nodes.length ?? 0) > 0;
      nodeErrors[node.id] = kept ? `${failure}, showing its last result` : failure;
      if (!kept) {
        nodes.push({ nodeId: node.id, nodeName: node.name, status: 'error', inventory: null, error: failure });
      }
    }
  }

  return {
    nodes,
    aggregatedByLabel: [...byLabel.values()].sort((a, b) =>
      a.key.localeCompare(b.key) || a.value.localeCompare(b.value) || a.source.localeCompare(b.source)),
    nodeErrors,
    generatedAt,
  };
}

function isLabelPiece(value: unknown): value is FleetLabelInventoryResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.nodes) && Array.isArray(v.aggregatedByLabel)
    && typeof v.nodeErrors === 'object' && v.nodeErrors !== null
    && typeof v.generatedAt === 'number';
}

async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function describeFailure(err: unknown): string {
  if (err instanceof SyntaxError) return 'Invalid response from the hub';
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'Timed out reading this node';
  }
  return err instanceof Error ? err.message : 'Failed to load Docker labels';
}

/**
 * The fleet Docker label inventory, read one node at a time (a few at a time) so
 * the hub and the healthy nodes draw as soon as they answer and one unreachable
 * node never holds the tab until its read budget runs out. Each node's answer
 * replaces only that node's slice.
 */
export function useFleetContainerLabels(nodes: readonly LabelsNodeRef[], reveal: boolean): FleetContainerLabelsState {
  const [pieces, setPieces] = useState<ReadonlyMap<number, FleetLabelInventoryResponse>>(new Map());
  const [failures, setFailures] = useState<ReadonlyMap<number, string>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const [total, setTotal] = useState(0);

  const controllersRef = useRef(new Set<AbortController>());
  // A newer load owns the state, so a superseded answer never touches it.
  const generationRef = useRef(0);
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  });
  const nodeKey = useMemo(() => nodes.map(n => n.id).join(','), [nodes]);

  const load = useCallback(async (requested: readonly LabelsNodeRef[]) => {
    if (requested.length === 0) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    controllersRef.current.forEach(c => c.abort());
    controllersRef.current.clear();
    const controller = new AbortController();
    controllersRef.current.add(controller);

    const ids = requested.map(n => n.id);
    setPending(new Set(ids));
    setTotal(ids.length);

    await runPool(requested, LABELS_CONCURRENCY, async (node) => {
      let piece: FleetLabelInventoryResponse | null = null;
      let failure: string | null = null;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LABELS_NODE_TIMEOUT_MS)]);
        const revealQs = reveal ? '&reveal=1' : '';
        const res = await apiFetch(`/fleet/container-labels?nodeId=${node.id}${revealQs}`, { localOnly: true, signal });
        if (res.ok) {
          const body: unknown = await res.json();
          if (isLabelPiece(body)) piece = body;
          else failure = 'Unexpected response from the hub';
        } else {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          failure = body?.error ?? `Request failed (${res.status})`;
        }
      } catch (err) {
        // Superseded or unmounted: a newer load (or nobody) owns the state now.
        if (controller.signal.aborted) return;
        console.error('Failed to load Docker labels for node', node.id, err);
        failure = describeFailure(err);
      }
      if (generation !== generationRef.current || controller.signal.aborted) return;
      if (piece) setPieces(prev => new Map(prev).set(node.id, piece));
      setFailures(prev => {
        const next = new Map(prev);
        if (failure === null) next.delete(node.id); else next.set(node.id, failure);
        return next;
      });
      setPending(prev => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    });

    controllersRef.current.delete(controller);
  }, [reveal]);

  // Only a change of the node set or of the reveal mode starts a load; the live
  // node list is read through a ref so it never has to sit in the dependency array.
  useEffect(() => {
    if (nodesRef.current.length === 0) return;
    void load(nodesRef.current);
  }, [load, nodeKey]);

  useEffect(() => () => { controllersRef.current.forEach(c => c.abort()); }, []);

  const refresh = useCallback(() => { void load(nodesRef.current); }, [load]);

  const data = useMemo(() => {
    if (pieces.size === 0 && failures.size === 0) return null;
    return mergeLabelPieces(nodes, pieces, failures);
  }, [nodes, pieces, failures]);

  const loading = pending.size > 0;
  return {
    data,
    loading,
    progress: loading ? { done: total - pending.size, total } : null,
    refresh,
  };
}
