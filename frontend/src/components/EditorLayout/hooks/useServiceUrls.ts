import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import {
  acceptServiceUrlGeneration,
  createServiceKeyMap,
  parseServiceUrlResponse,
  type AnatomyPortRef,
  type ServiceUrlEditState,
  type ServiceUrlEntry,
} from '@/lib/serviceUrlResolve';

export type { ServiceUrlEntry };

async function readEntry(nodeId: number | null, stackName: string): Promise<{ generationReady: ServiceUrlEntry }> {
  const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/effective-anatomy`, { nodeId });
  const body = await res.json().catch(() => null);
  return { generationReady: parseServiceUrlResponse(nodeId, stackName, res.ok, body) };
}

/** One-shot read. Callers apply it only when the captured node and stack are still current. */
export async function fetchServiceUrlEntry(nodeId: number | null, stackName: string): Promise<ServiceUrlEntry> {
  try {
    const { generationReady } = await readEntry(nodeId, stackName);
    return generationReady;
  } catch (error) {
    console.error('Failed to load service URLs:', error);
    return parseServiceUrlResponse(nodeId, stackName, false, null);
  }
}

export function useServiceUrls(nodeId: number | null, stackName: string | null) {
  const generationRef = useRef(0);
  const targetRef = useRef({ nodeId, stackName });
  const [entry, setEntry] = useState<ServiceUrlEntry | null>(null);

  const refresh = useCallback(async (): Promise<ServiceUrlEntry | null> => {
    if (targetRef.current.nodeId !== nodeId || targetRef.current.stackName !== stackName) return null;
    if (!stackName) {
      generationRef.current += 1;
      setEntry(null);
      return null;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setEntry(prev => {
      if (prev && prev.stackName === stackName && prev.nodeId === nodeId && prev.status === 'ready') return prev;
      return prev && prev.stackName === stackName && prev.nodeId === nodeId
        ? { ...prev, status: 'loading' }
        : {
          status: 'loading',
          nodeId,
          stackName,
          serviceUrls: createServiceKeyMap<string>(),
          serviceUrlEdit: createServiceKeyMap<ServiceUrlEditState>(),
          ports: createServiceKeyMap<AnatomyPortRef[]>(),
          renderable: false,
        };
    });
    let next: ServiceUrlEntry;
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/effective-anatomy`, { nodeId });
      const body = await res.json().catch(() => null);
      next = parseServiceUrlResponse(nodeId, stackName, res.ok, body);
    } catch (error) {
      console.error('Failed to load service URLs:', error);
      next = parseServiceUrlResponse(nodeId, stackName, false, null);
    }
    if (targetRef.current.nodeId !== nodeId || targetRef.current.stackName !== stackName) return null;
    if (!acceptServiceUrlGeneration(generation, generationRef.current)) return null;
    setEntry(next);
    return next;
  }, [nodeId, stackName]);

  useEffect(() => {
    targetRef.current = { nodeId, stackName };
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => { cancelled = true; };
  }, [refresh, nodeId, stackName]);

  // The stored entry lags a selection change by a render or more. Hand it out only for
  // the node and stack it was read for, so a port never links to the previous target.
  const current = useMemo<ServiceUrlEntry | null>(() => {
    if (!stackName) return null;
    if (entry && entry.nodeId === nodeId && entry.stackName === stackName) return entry;
    return { status: 'loading', nodeId, stackName, serviceUrls: createServiceKeyMap<string>(), serviceUrlEdit: createServiceKeyMap<ServiceUrlEditState>(), ports: createServiceKeyMap<AnatomyPortRef[]>(), renderable: false };
  }, [entry, nodeId, stackName]);

  return { entry: current, refresh };
}
