import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { FleetDependencyMap } from '@/lib/dependency-map-layout';

/** A map older than this is re-fetched when the Map tab is reopened. */
export const MAP_STALE_MS = 60_000;

/** Requests in flight at once, so a large fleet does not exhaust the browser's connections. */
const MAP_CONCURRENCY = 4;

/** A node that has not answered by now is reported as failed, so Refresh and Retry never stay locked behind it. */
export const MAP_NODE_TIMEOUT_MS = 20_000;

export interface MapNodeRef {
  id: number;
  name: string;
}

export interface FleetMapState {
  /** Everything the nodes that have answered so far contribute, or null until the first does. */
  data: FleetDependencyMap | null;
  /** True while any node's request is in flight, including a background revalidation. */
  loading: boolean;
  /** Nodes answered of nodes asked, only while loading. */
  progress: { done: number; total: number } | null;
  /** Reload every node, keeping what is already drawn until each node's new answer lands. */
  refresh: () => void;
  /** Reload only the nodes that could not be read. */
  retryFailed: () => void;
}

/**
 * Concatenate each node's slice in node order. Ids are already prefixed per node
 * by the server, so slices never collide. A node that failed on the way (the
 * request itself, not the node's own report) is added as an error, and keeps any
 * slice it had before so a failed refresh does not blank its part of the map.
 */
export function mergeMapPieces(
  order: readonly MapNodeRef[],
  pieces: ReadonlyMap<number, FleetDependencyMap>,
  failures: ReadonlyMap<number, string>,
): FleetDependencyMap {
  const merged: FleetDependencyMap = { nodes: [], edges: [], flags: [], nodeErrors: [], parseErrors: [] };
  for (const node of order) {
    const piece = pieces.get(node.id);
    if (piece) {
      merged.nodes.push(...piece.nodes);
      merged.edges.push(...piece.edges);
      merged.flags.push(...piece.flags);
      merged.parseErrors.push(...piece.parseErrors);
    }
    const failure = failures.get(node.id);
    // A fresh request failure replaces the error an older slice carried for the same node.
    if (piece) merged.nodeErrors.push(...piece.nodeErrors.filter(e => failure === undefined || e.nodeId !== node.id));
    if (failure !== undefined) {
      const kept = (piece?.nodes.length ?? 0) > 0;
      merged.nodeErrors.push({ nodeId: node.id, nodeName: node.name, error: kept ? `${failure}, showing its last result` : failure });
    }
  }
  return merged;
}

function isMapPiece(value: unknown): value is FleetDependencyMap {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return ['nodes', 'edges', 'flags', 'nodeErrors', 'parseErrors'].every(key => Array.isArray(v[key]));
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

/**
 * The fleet dependency map, owned by the Fleet shell so a return to the Map tab
 * shows the last result immediately and revalidates it in the background. Each
 * node is read on its own (a few at a time), so the hub and the healthy nodes
 * draw as soon as they answer and one slow or unreachable node never holds the
 * rest. Fetches the first time the tab is opened, and again on reopening once the
 * result is older than `MAP_STALE_MS`, the node set changed, or a node failed.
 */
export function useFleetMap(active: boolean, nodes: readonly MapNodeRef[]): FleetMapState {
  const [pieces, setPieces] = useState<ReadonlyMap<number, FleetDependencyMap>>(new Map());
  const [failures, setFailures] = useState<ReadonlyMap<number, string>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const [total, setTotal] = useState(0);
  const [settled, setSettled] = useState(false);

  const controllersRef = useRef(new Set<AbortController>());
  // Nodes with a request in flight, so a reopen or a retry never doubles one up.
  const inFlightRef = useRef(new Set<number>());
  // The node set of a full load that has not settled yet.
  const fullInFlightKeyRef = useRef<string | null>(null);
  // A full refresh bumps the generation, so a superseded request never touches state.
  const generationRef = useRef(0);
  const loadedAtRef = useRef<number | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const nodesRef = useRef(nodes);
  const piecesRef = useRef(pieces);
  const failuresRef = useRef(failures);
  useEffect(() => {
    nodesRef.current = nodes;
    piecesRef.current = pieces;
    failuresRef.current = failures;
  });
  const nodeKey = useMemo(() => nodes.map(n => n.id).join(','), [nodes]);

  const load = useCallback(async (requested: readonly MapNodeRef[], full: boolean) => {
    if (full) {
      generationRef.current += 1;
      controllersRef.current.forEach(c => c.abort());
      controllersRef.current.clear();
      inFlightRef.current.clear();
      fullInFlightKeyRef.current = requested.map(n => n.id).join(',');
    }
    const targets = full ? requested : requested.filter(n => !inFlightRef.current.has(n.id));
    if (targets.length === 0) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    const ids = targets.map(t => t.id);
    ids.forEach(id => inFlightRef.current.add(id));
    setPending(prev => (full ? new Set(ids) : new Set([...prev, ...ids])));
    if (full) setTotal(ids.length);

    await runPool(targets, MAP_CONCURRENCY, async (node) => {
      let piece: FleetDependencyMap | null = null;
      let failure: string | null = null;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MAP_NODE_TIMEOUT_MS)]);
        const res = await apiFetch(`/fleet/dependency-map?nodeId=${node.id}`, { localOnly: true, signal });
        if (res.ok) {
          const body: unknown = await res.json();
          if (isMapPiece(body)) piece = body;
          else failure = 'Unexpected response from the hub';
        } else {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          failure = body?.error ?? `Request failed (${res.status})`;
        }
      } catch (err) {
        // Superseded or unmounted: a newer load (or nobody) owns the state now.
        if (controller.signal.aborted) return;
        console.error('Failed to load the dependency map for node', node.id, err);
        if (err instanceof SyntaxError) {
          failure = 'Invalid response from the hub';
        } else if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          failure = 'Timed out reading this node';
        } else if (err instanceof Error) {
          failure = err.message;
        } else {
          failure = 'Failed to load dependency map';
        }
      }
      if (generation !== generationRef.current || controller.signal.aborted) return;
      inFlightRef.current.delete(node.id);
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
    if (full && generation === generationRef.current && !controller.signal.aborted) {
      fullInFlightKeyRef.current = null;
      loadedAtRef.current = Date.now();
      loadedKeyRef.current = ids.join(',');
      setSettled(true);
    }
  }, []);

  const failedNodes = useCallback((): MapNodeRef[] => {
    return nodesRef.current.filter(n => failuresRef.current.has(n.id)
      || (piecesRef.current.get(n.id)?.nodeErrors.some(e => e.nodeId === n.id) ?? false));
  }, []);

  // Only a change of `active` or of the node set may start a load; the live
  // state is read through refs so it never has to sit in the dependency array.
  useEffect(() => {
    // The registry fills in after the app boots; with no nodes there is nothing
    // to ask yet, and recording an empty load as finished would hide the map
    // until the key changes. The effect runs again when the node set arrives.
    if (!active || nodesRef.current.length === 0) return;
    // A full load for this node set is already running: let it finish.
    if (fullInFlightKeyRef.current === nodeKey) return;
    const stale = loadedAtRef.current === null
      || Date.now() - loadedAtRef.current > MAP_STALE_MS
      || loadedKeyRef.current !== nodeKey;
    if (stale) {
      void load(nodesRef.current, true);
    } else {
      const failed = failedNodes();
      if (failed.length > 0) void load(failed, false);
    }
  }, [active, nodeKey, load, failedNodes]);

  useEffect(() => () => { controllersRef.current.forEach(c => c.abort()); }, []);

  const refresh = useCallback(() => { void load(nodesRef.current, true); }, [load]);
  const retryFailed = useCallback(() => {
    const failed = failedNodes();
    if (failed.length > 0) void load(failed, false);
  }, [load, failedNodes]);

  const data = useMemo(() => {
    if (pieces.size === 0 && failures.size === 0 && !settled) return null;
    return mergeMapPieces(nodes, pieces, failures);
  }, [nodes, pieces, failures, settled]);

  const loading = pending.size > 0;
  return {
    data,
    loading,
    progress: loading ? { done: total - pending.size, total } : null,
    refresh,
    retryFailed,
  };
}
