import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiFetch } from '@/lib/api';
import type { Capability } from '@/lib/capabilities';

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
  api_token?: string;
  pilot_last_seen?: number | null;
  pilot_agent_version?: string | null;
}

export interface NodeMeta {
  version: string | null;
  capabilities: string[];
  fetchedAt: number;
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

    const setMeta = (meta: NodeMeta) =>
      setNodeMeta(prev => {
        const next = new Map(prev);
        next.set(nodeId, meta);
        return next;
      });

    try {
      const res = await apiFetch(`/nodes/${nodeId}/meta`, { localOnly: true });
      if (res.ok) {
        const data = await res.json();
        setMeta({
          version: data.version ?? null,
          capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
          fetchedAt: Date.now(),
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

  const refreshNodes = useCallback(async () => {
    try {
      const res = await apiFetch('/nodes');
      if (res.ok) {
        const data = await res.json();
        setNodes(data);

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
            setActiveNodeState(updatedActive);
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

    window.addEventListener('node-not-found', handleNodeNotFound);
    return () => window.removeEventListener('node-not-found', handleNodeNotFound);
  }, [refreshNodes]);

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
