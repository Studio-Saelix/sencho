import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import {
  acceptServiceUrlGeneration,
  parseServiceUrlResponse,
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
  const [entry, setEntry] = useState<ServiceUrlEntry | null>(() => (
    stackName
      ? { status: 'loading', nodeId, stackName, serviceUrls: {}, ports: {}, renderable: false }
      : null
  ));

  const refresh = useCallback(async (): Promise<ServiceUrlEntry | null> => {
    if (targetRef.current.nodeId !== nodeId || targetRef.current.stackName !== stackName) return null;
    if (!stackName) {
      generationRef.current += 1;
      setEntry(null);
      return null;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setEntry(prev => prev && prev.stackName === stackName && prev.nodeId === nodeId
      ? { ...prev, status: 'loading' }
      : {
        status: 'loading',
        nodeId,
        stackName,
        serviceUrls: {},
        ports: {},
        renderable: false,
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

  return { entry, refresh };
}
