import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiFetch } from '@/lib/api';
import { beginNodeSession, markMilestone } from '@/lib/hydrationTiming';
import { onNotificationsReturn } from '@/lib/notificationsConnection';
import type { Capability } from '@/lib/capabilities';
import type { BootstrapOperationState, NodeReadinessState } from '@/components/nodes/bootstrap/types';

/** How long a burst of readiness announcements is gathered before the node list is refetched once. */
const READINESS_REFRESH_DELAY_MS = 500;
/** How long after a catch-up read that did not apply the next one starts; it doubles up to the cap while reads keep failing. */
const READINESS_RETRY_BASE_MS = 5_000;
const READINESS_RETRY_MAX_MS = 30_000;

export type NodeMode = 'proxy' | 'pilot_agent';

export interface Node {
  id: number;
  name: string;
  type: 'local' | 'remote';
  mode?: NodeMode;
  compose_dir: string;
  is_default: boolean;
  status: 'online' | 'offline' | 'unknown';
  created_at: number;
  api_url?: string;
  /** True when a node_proxy token is stored server-side. The token value itself
   *  is never sent to the browser (see backend helpers/publicNode.ts). */
  has_token?: boolean;
  /** Hub-pinned registry sealing-key fingerprint, when TOFU has completed. */
  sealingKeyFingerprint?: string | null;
  pilot_last_seen?: number | null;
  pilot_agent_version?: string | null;
  /**
   * Set only for a node the bootstrap registered: the hub's readiness verdict
   * and the state of the run that registered it. Null (or absent) for every
   * other node, whose status keeps its usual meaning.
   */
  readiness?: {
    state: NodeReadinessState;
    checkedAt: number | null;
    operationId: string | null;
    operationState: BootstrapOperationState | null;
  } | null;
}

export type ImagePinKind = 'floating' | 'semver' | 'digest' | 'unknown';

export interface NodeMeta {
  version: string | null;
  capabilities: string[];
  fetchedAt: number;
  /** Remote-only fields below; absent (undefined) for local nodes' /meta response. */
  startedAt?: number | null;
  updateError?: string | null;
  online?: boolean;
  imagePinKind?: ImagePinKind | null;
  updateBlocked?: boolean;
  imageChannel?: 'community' | 'hardened' | 'unknown' | null;
}

interface NodeContextType {
  nodes: Node[];
  activeNode: Node | null;
  setActiveNode: (node: Node) => void;
  refreshNodes: () => Promise<void>;
  isLoading: boolean;
  activeNodeMeta: NodeMeta | null;
  hasCapability: (cap: Capability) => boolean;
  nodeMeta: Map<number, NodeMeta>;
  refreshNodeMeta: (nodeId: number, force?: boolean) => Promise<void>;
}

const META_CACHE_TTL = 5 * 60 * 1000;
const META_FAILURE_TTL = 30 * 1000;

const NodeContext = createContext<NodeContextType | undefined>(undefined);

export function NodeProvider({ children }: { children: React.ReactNode }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [activeNode, setActiveNodeState] = useState<Node | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [nodeMeta, setNodeMeta] = useState<Map<number, NodeMeta>>(new Map());

  // Refs let callbacks read current state without being deps (breaks infinite loop)
  const activeNodeRef = useRef<Node | null>(null);
  activeNodeRef.current = activeNode;
  const nodeMetaRef = useRef<Map<number, NodeMeta>>(nodeMeta);
  nodeMetaRef.current = nodeMeta;

  // Open a fresh hydration-timing session the moment the active node id changes,
  // during render (guarded by a ref to fire once per id). This must precede the
  // shell's stack-list refresh so its attempt binds to the new node session:
  // child effects (EditorLayout's node-switch effect that calls refreshStacks)
  // run before this provider's effects, so an effect here would begin the
  // session too late and the list milestone would never commit.
  const hydrationNodeRef = useRef<number | null>(null);
  if (activeNode && hydrationNodeRef.current !== activeNode.id) {
    hydrationNodeRef.current = activeNode.id;
    beginNodeSession(activeNode.id);
  }

  const metaSeqRef = useRef<Map<number, number>>(new Map());

  const fetchNodeMeta = useCallback(async (nodeId: number, force = false) => {
    const cached = nodeMetaRef.current.get(nodeId);
    if (cached && !force) {
      // Use shorter TTL for failed fetches so we retry quickly after transient errors.
      // `force` bypasses the TTL after an explicit user action (e.g. a connection test)
      // that just dropped the server-side cache, so the dashboard reflects the new
      // version and capabilities without waiting out the TTL.
      const ttl = cached.capabilities.length > 0 ? META_CACHE_TTL : META_FAILURE_TTL;
      if (Date.now() - cached.fetchedAt < ttl) return;
    }

    // Reads for one node can overlap (a selection, a forced refresh after a readiness change). Only the newest
    // read may write, so a slow older answer cannot put an offline or stale reading back over a newer one.
    const seq = (metaSeqRef.current.get(nodeId) ?? 0) + 1;
    metaSeqRef.current.set(nodeId, seq);
    const setMeta = (meta: NodeMeta) => {
      if (metaSeqRef.current.get(nodeId) !== seq) return;
      setNodeMeta(prev => {
        const next = new Map(prev);
        next.set(nodeId, meta);
        return next;
      });
    };

    try {
      const res = await apiFetch(`/nodes/${nodeId}/meta`, { localOnly: true });
      if (res.ok) {
        const data = await res.json();
        setMeta({
          version: data.version ?? null,
          capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
          fetchedAt: Date.now(),
          startedAt: data.startedAt ?? null,
          updateError: data.updateError ?? null,
          online: data.online,
          imagePinKind: data.imagePinKind ?? null,
          updateBlocked: data.updateBlocked,
          imageChannel: data.imageChannel ?? null,
        });
      } else {
        // A non-OK response (proxy error, auth, 5xx) is a resolved failure: record an
        // offline meta so gates fail closed to the lock card and the short failure TTL
        // throttles retries, instead of leaving hasCapability optimistically open.
        setMeta({ version: null, capabilities: [], fetchedAt: Date.now() });
      }
    } catch {
      setMeta({ version: null, capabilities: [], fetchedAt: Date.now() });
    }
  }, []);

  // Refetches can overlap (mount, node-not-found, readiness announcements, a manual refresh). A response
  // older than the one already applied is dropped, so a slow earlier answer cannot bring back a list (and a
  // readiness verdict) that a later answer replaced. An older answer still applies when the newer request
  // fails or has not answered yet.
  const nodesRequestSeqRef = useRef(0);
  const nodesAppliedSeqRef = useRef(0);
  const appliedNodesRef = useRef<Node[]>([]);
  // Readiness announcements and notification-socket returns seen so far, and the highest count a read that applied had
  // already seen when it started. A read answers for every signal that came before it began, so while the second is
  // behind the first, the list on screen may still hold a verdict the hub has withdrawn, and a catch-up read is owed.
  const readinessSignalsSeenRef = useRef(0);
  const readinessSignalsCoveredRef = useRef(0);

  const refreshNodes = useCallback(async () => {
    const seq = ++nodesRequestSeqRef.current;
    const signals = readinessSignalsSeenRef.current;
    try {
      const res = await apiFetch('/nodes');
      if (res.ok) {
        const data = await res.json();
        if (seq < nodesAppliedSeqRef.current) return;
        nodesAppliedSeqRef.current = seq;
        readinessSignalsCoveredRef.current = Math.max(readinessSignalsCoveredRef.current, signals);
        const before = appliedNodesRef.current;
        appliedNodesRef.current = data;
        setNodes(data);
        // A node that just became ready is usable now: what the dashboard cached about it while it was provisional (a failed
        // read, no capabilities, an older release) is stale, so its metadata is read again without waiting out the cache.
        for (const node of data as Node[]) {
          if (node.readiness?.state !== 'ready') continue;
          if (before.find((previous) => previous.id === node.id)?.readiness?.state === 'ready') continue;
          if (nodeMetaRef.current.has(node.id) || activeNodeRef.current?.id === node.id) void fetchNodeMeta(node.id, true);
        }

        const currentActive = activeNodeRef.current;
        if (!currentActive) {
          // On initial load, restore from localStorage before falling back to default.
          // This keeps the UI dropdown in sync with the node ID that apiFetch is already
          // injecting via x-node-id (read directly from localStorage on every request).
          const storedId = localStorage.getItem('sencho-active-node');
          const storedNode = storedId ? data.find((n: Node) => n.id === parseInt(storedId, 10)) : null;
          const nodeToActivate = storedNode ?? data.find((n: Node) => n.is_default) ?? data[0] ?? null;
          if (nodeToActivate) {
            setActiveNodeState(nodeToActivate);
            localStorage.setItem('sencho-active-node', String(nodeToActivate.id));
            fetchNodeMeta(nodeToActivate.id);
          }
        } else {
          const updatedActive = data.find((n: Node) => n.id === currentActive.id);
          if (updatedActive) {
            // Keep the same object when nothing about the active node changed, so a list refresh
            // (such as another node's readiness changing) does not re-run every activeNode effect.
            setActiveNodeState((prev) => (prev && JSON.stringify(prev) === JSON.stringify(updatedActive) ? prev : updatedActive));
            localStorage.setItem('sencho-active-node', String(updatedActive.id));
          } else {
            const fallback = data.find((n: Node) => n.is_default) ?? data[0] ?? null;
            if (fallback) {
              setActiveNodeState(fallback);
              localStorage.setItem('sencho-active-node', String(fallback.id));
              fetchNodeMeta(fallback.id);
            } else {
              setActiveNodeState(null);
              localStorage.removeItem('sencho-active-node');
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch nodes:', error);
    } finally {
      setIsLoading(false);
    }
  }, [fetchNodeMeta]); // stable - reads activeNode via ref, not closure capture

  const setActiveNode = useCallback((node: Node) => {
    setActiveNodeState(node);
    localStorage.setItem('sencho-active-node', String(node.id));
    fetchNodeMeta(node.id);
  }, [fetchNodeMeta]);

  useEffect(() => {
    refreshNodes();

    const handleNodeNotFound = () => {
      console.warn('[NodeContext] Active node is unreachable or deleted. Forcing sync...');
      refreshNodes();
    };

    // A read of the list made because the readiness changed. One that does not apply (the request failed, the answer was
    // not OK or not JSON, or a newer read overtook it) leaves the signal unanswered, so it is tried again at a bounded
    // pace until a read that began after the signal applies. The change is never consumed by a read that failed.
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = READINESS_RETRY_BASE_MS;
    let disposed = false;
    const catchUp = () => {
      void refreshNodes().then(() => {
        if (disposed) return;
        if (readinessSignalsCoveredRef.current >= readinessSignalsSeenRef.current) {
          retryDelay = READINESS_RETRY_BASE_MS;
          return;
        }
        if (retryTimer !== null) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          catchUp();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, READINESS_RETRY_MAX_MS);
      });
    };

    // The hub announces a changed readiness verdict, so badges in Fleet, the switcher and Settings do not go stale.
    // Announcements that arrive within one window share a refetch; a check that outlasts it refetches again for its verdict.
    let readinessTimer: ReturnType<typeof setTimeout> | null = null;
    const handleStateInvalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: unknown }>).detail;
      if (detail?.scope !== 'node-readiness') return;
      readinessSignalsSeenRef.current += 1;
      if (readinessTimer !== null) return;
      readinessTimer = setTimeout(() => {
        readinessTimer = null;
        catchUp();
      }, READINESS_REFRESH_DELAY_MS);
    };

    // Announcements sent while the notification socket was down are lost, so its return reads the list once.
    const stopWatchingSocket = onNotificationsReturn(() => {
      readinessSignalsSeenRef.current += 1;
      catchUp();
    });

    window.addEventListener('node-not-found', handleNodeNotFound);
    window.addEventListener('sencho:state-invalidate', handleStateInvalidate);
    return () => {
      window.removeEventListener('node-not-found', handleNodeNotFound);
      window.removeEventListener('sencho:state-invalidate', handleStateInvalidate);
      stopWatchingSocket();
      disposed = true;
      if (readinessTimer !== null) clearTimeout(readinessTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [refreshNodes]);

  // One-shot boot milestone: nodes have finished loading and an active node is
  // resolved. Deduped by the store, so a later re-run is a no-op.
  useEffect(() => {
    if (isLoading || !activeNode) return;
    markMilestone('nodes_resolved');
  }, [isLoading, activeNode]);

  const activeNodeMeta = useMemo(() => {
    if (!activeNode) return null;
    return nodeMeta.get(activeNode.id) ?? null;
  }, [activeNode, nodeMeta]);

  const hasCapability = useCallback((cap: Capability): boolean => {
    const current = activeNodeRef.current;
    if (!current) return true;
    const meta = nodeMetaRef.current.get(current.id);
    // Optimistic: if meta not yet fetched, assume capable (prevents flash of disabled UI)
    if (!meta) return true;
    return meta.capabilities.includes(cap);
  }, []);

  const contextValue = useMemo(() => ({
    nodes, activeNode, setActiveNode, refreshNodes, isLoading,
    activeNodeMeta, hasCapability, nodeMeta, refreshNodeMeta: fetchNodeMeta,
  }), [nodes, activeNode, setActiveNode, refreshNodes, isLoading,
       activeNodeMeta, hasCapability, nodeMeta, fetchNodeMeta]);

  return (
    <NodeContext.Provider value={contextValue}>
      {children}
    </NodeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNodes() {
  const context = useContext(NodeContext);
  if (!context) {
    throw new Error('useNodes must be used within a NodeProvider');
  }
  return context;
}
