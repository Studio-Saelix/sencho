import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { runPool } from '@/lib/runPool';
import { FLEET_READ_ATTEMPTS, hubKeptBuild } from '@/lib/fleetBuildKept';
import type { ContainerLabelRow, FleetLabelInventoryResponse, LabelIndexRow, LabelSource } from '@/lib/labelInventory';

/** Requests in flight at once, so a large fleet does not exhaust the browser's connections. */
const LABELS_CONCURRENCY = 4;

/** A node that has not answered by now is reported as failed, so Refresh is not held indefinitely behind it. */
export const LABELS_NODE_TIMEOUT_MS = 28_000;

export interface LabelsNodeRef {
  id: number;
  name: string;
}

export interface FleetContainerLabelsState {
  /** Every node that has answered so far, or null until the first one does. */
  data: FleetLabelInventoryResponse | null;
  /** True while any node's request is in flight, including a background revalidation. */
  loading: boolean;
  /** Nodes answered of nodes asked, only while a load is running over a known node set. */
  progress: { done: number; total: number } | null;
  /** Reload every node, keeping what is already shown until each node's new answer lands. */
  refresh: () => void;
  /** Reload only the nodes that could not be read. */
  retryFailed: () => void;
}

type NodeRow = FleetLabelInventoryResponse['nodes'][number];

const LABEL_SOURCES: ReadonlySet<string> = new Set<LabelSource>([
  'compose', 'runtime', 'image', 'compose-system', 'unknown',
]);

function labelRowKey(row: LabelIndexRow): string {
  return `${row.key}\0${row.value}\0${row.source}`;
}

function isLabelValue(v: unknown): v is ContainerLabelRow['labels'][number] {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.key === 'string' && typeof o.value === 'string'
    && typeof o.source === 'string' && LABEL_SOURCES.has(o.source);
}

function isContainerRow(v: unknown): v is ContainerLabelRow {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.state === 'string'
    && Array.isArray(o.labels) && o.labels.every(isLabelValue);
}

function isLabelIndexRow(v: unknown): v is LabelIndexRow {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.key === 'string' && typeof o.value === 'string'
    && typeof o.source === 'string' && LABEL_SOURCES.has(o.source)
    && Array.isArray(o.containers)
    && o.containers.every(c => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).id === 'string');
}

/**
 * A node slice exactly as the hub sends it. Checked field by field so a body
 * from another build (or a proxy's own error envelope) degrades to a per-node
 * failure instead of reaching the table as data nobody validated.
 */
function parseLabelPiece(body: unknown): FleetLabelInventoryResponse | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.nodes) || !Array.isArray(o.aggregatedByLabel)) return null;
  if (!o.nodeErrors || typeof o.nodeErrors !== 'object' || Array.isArray(o.nodeErrors)) return null;
  if (typeof o.generatedAt !== 'number') return null;
  const nodes: NodeRow[] = [];
  for (const raw of o.nodes) {
    if (!raw || typeof raw !== 'object') return null;
    const n = raw as Record<string, unknown>;
    const inventory = n.inventory;
    if (typeof n.nodeId !== 'number' || typeof n.nodeName !== 'string') return null;
    if (n.status !== 'ok' && n.status !== 'error') return null;
    if (n.error !== null && typeof n.error !== 'string') return null;
    if (inventory !== null) {
      if (!inventory || typeof inventory !== 'object') return null;
      const inv = inventory as Record<string, unknown>;
      if (!Array.isArray(inv.containers) || !inv.containers.every(isContainerRow)) return null;
      if (!Array.isArray(inv.byLabel) || !inv.byLabel.every(isLabelIndexRow)) return null;
      if (typeof inv.partial !== 'boolean' || typeof inv.generatedAt !== 'number') return null;
    }
    nodes.push(raw as NodeRow);
  }
  if (!o.aggregatedByLabel.every(isLabelIndexRow)) return null;
  if (!Object.values(o.nodeErrors).every(reason => typeof reason === 'string')) return null;
  return {
    nodes,
    aggregatedByLabel: o.aggregatedByLabel,
    nodeErrors: o.nodeErrors as Record<number, string>,
    generatedAt: o.generatedAt,
  };
}

/**
 * Why a 200 body cannot replace this node's slice, or null when it can. A
 * `?nodeId=` read answers with exactly one row for that node, and only a row
 * that is not itself an error and carries an inventory is an answer. A row
 * whose status is `error` is how the hub reports an unreachable remote
 * (timeout, non-ok upstream, untrusted payload, no Pilot target); it is that
 * node's failure, not a fresh empty inventory, so the caller keeps the previous
 * slice and names the reason. Anything else is not this node's answer.
 */
function unusableNodeReason(piece: FleetLabelInventoryResponse, nodeId: number): string | null {
  if (piece.nodes.length !== 1 || piece.nodes[0].nodeId !== nodeId) {
    return 'Unexpected response from the hub';
  }
  const row = piece.nodes[0];
  if (row.status === 'error') {
    return piece.nodeErrors[nodeId] || row.error || 'The hub could not read this node';
  }
  if (row.inventory === null) {
    return piece.nodeErrors[nodeId] || row.error || 'Unexpected response from the hub';
  }
  return null;
}

/**
 * Concatenate each node's inventory in node order. A node whose read failed for
 * this load (a request or HTTP error, an untrusted body, or the hub's own report
 * that the node was unreachable) keeps the slice the caller last stored for it,
 * so a failed refresh does not blank its part of the tab, and the error is
 * reported in the banner above the table. A node with no stored slice is listed
 * as an error without claiming a last result.
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
    // rather than disappearing from the tab. "Last result" is only claimed when
    // the kept slice actually carried an inventory.
    if (failure !== undefined) {
      const kept = piece?.nodes.some(n => n.status === 'ok' && n.inventory !== null) ?? false;
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
  // Held only while a load over the whole node set runs; a retry of a few nodes
  // leaves it alone, because "n of N" describes the fleet, not the retry.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const controllersRef = useRef(new Set<AbortController>());
  // Nodes with a request in flight, so a retry never doubles one up.
  const inFlightRef = useRef(new Set<number>());
  // A newer load owns the state, so a superseded answer never touches it.
  const generationRef = useRef(0);
  const nodesRef = useRef(nodes);
  const piecesRef = useRef(pieces);
  const failuresRef = useRef(failures);
  useEffect(() => {
    nodesRef.current = nodes;
    piecesRef.current = pieces;
    failuresRef.current = failures;
  });
  const nodeKey = useMemo(() => nodes.map(n => n.id).join(','), [nodes]);

  const load = useCallback(async (requested: readonly LabelsNodeRef[], full: boolean) => {
    const targets = full ? requested : requested.filter(n => !inFlightRef.current.has(n.id));
    if (targets.length === 0) return;
    if (full) {
      generationRef.current += 1;
      controllersRef.current.forEach(c => c.abort());
      controllersRef.current.clear();
      inFlightRef.current.clear();
    }
    const generation = generationRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);

    const ids = targets.map(n => n.id);
    ids.forEach(id => inFlightRef.current.add(id));
    setPending(prev => (full ? new Set(ids) : new Set([...prev, ...ids])));
    if (full) setProgress({ done: 0, total: ids.length });

    await runPool(targets, LABELS_CONCURRENCY, async (node) => {
      let piece: FleetLabelInventoryResponse | null = null;
      let failure: string | null = null;
      // The hub keeps a build it cut at its deadline, so a second ask joins it
      // (or takes its finished answer) instead of the tab reporting a slow hub
      // as failed. The node stays pending across both asks.
      for (let attempt = 1; attempt <= FLEET_READ_ATTEMPTS; attempt += 1) {
        piece = null;
        failure = null;
        let buildKept = false;
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LABELS_NODE_TIMEOUT_MS)]);
          const revealQs = reveal ? '&reveal=1' : '';
          const res = await apiFetch(`/fleet/container-labels?nodeId=${node.id}${revealQs}`, { localOnly: true, signal });
          if (res.ok) {
            buildKept = hubKeptBuild(res);
            const body: unknown = await res.json();
            const parsed = parseLabelPiece(body);
            if (!parsed) {
              failure = 'Unexpected response from the hub';
            } else {
              const reason = unusableNodeReason(parsed, node.id);
              if (reason !== null) failure = reason;
              else piece = parsed;
            }
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
        if (piece !== null || !buildKept) break;
      }
      if (generation !== generationRef.current || controller.signal.aborted) return;
      inFlightRef.current.delete(node.id);
      if (full) setProgress(prev => (prev ? { ...prev, done: prev.done + 1 } : prev));
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
    if (full && generation === generationRef.current) setProgress(null);
  }, [reveal]);

  // Only a change of the node set or of the reveal mode starts a full load; the
  // live node list is read through a ref so it never has to sit in the effect's
  // dependency array.
  useEffect(() => {
    if (nodesRef.current.length === 0) return;
    void load(nodesRef.current, true);
  }, [load, nodeKey]);

  useEffect(() => () => { controllersRef.current.forEach(c => c.abort()); }, []);

  const failedNodes = useCallback((): LabelsNodeRef[] => {
    return nodesRef.current.filter(n => failuresRef.current.has(n.id)
      || (piecesRef.current.get(n.id)?.nodeErrors[n.id] !== undefined));
  }, []);

  const refresh = useCallback(() => { void load(nodesRef.current, true); }, [load]);
  const retryFailed = useCallback(() => {
    const failed = failedNodes();
    if (failed.length > 0) void load(failed, false);
  }, [load, failedNodes]);

  const data = useMemo(() => {
    if (pieces.size === 0 && failures.size === 0) return null;
    return mergeLabelPieces(nodes, pieces, failures);
  }, [nodes, pieces, failures]);

  // `data === null` covers the first paint when there are nodes to read, so the
  // tab shows a loading state instead of an empty audit. An empty node list is
  // the caller's problem (it knows whether the registry is still loading).
  const loading = pending.size > 0 || (data === null && nodes.length > 0);
  return {
    data,
    loading,
    progress: loading ? progress : null,
    refresh,
    retryFailed,
  };
}
