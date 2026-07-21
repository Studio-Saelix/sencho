import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import { fetchNodeSettings } from './fetchNodeSettings';

export type NodeSettingsLoadPhase = 'loading' | 'ready' | 'error';

export interface SettingsSaveGuard {
    nodeId: number | null;
    gen: number;
}

/**
 * Race-safe load ownership for node-scoped settings sections.
 * Clears ownership on node switch, ignores stale responses for value adoption
 * and loading finalization, and exposes whether the active node has an
 * authoritative load.
 */
export function useNodeSettingsLoad(activeNodeId: number | undefined) {
    const [phase, setPhase] = useState<NodeSettingsLoadPhase>('loading');
    const [loadedNodeId, setLoadedNodeId] = useState<number | null | undefined>(undefined);
    const genRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const activeNodeIdRef = useRef(activeNodeId);
    activeNodeIdRef.current = activeNodeId;

    const captureSaveGuard = useCallback((): SettingsSaveGuard => ({
        nodeId: activeNodeIdRef.current ?? null,
        gen: genRef.current,
    }), []);

    const isCurrentNodeLoaded =
        loadedNodeId !== undefined && loadedNodeId === (activeNodeId ?? null);

    const isSaveOwner = useCallback((guard: SettingsSaveGuard): boolean => {
        return (activeNodeIdRef.current ?? null) === guard.nodeId
            && genRef.current === guard.gen;
    }, []);

    const load = useCallback(async (): Promise<Record<string, string> | null> => {
        // Hard refresh boots with activeNode=null; a fetch for that frame is not
        // authoritative and would toast again once the real node id settles.
        if (activeNodeIdRef.current === undefined) {
            abortRef.current?.abort();
            setLoadedNodeId(undefined);
            setPhase('loading');
            return null;
        }

        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        const gen = ++genRef.current;
        const captured = activeNodeIdRef.current ?? null;

        setLoadedNodeId(undefined);
        setPhase('loading');

        const result = await fetchNodeSettings(captured, ac.signal);

        // Stale generation: leave the newer load's phase alone; do not toast.
        if (genRef.current !== gen) return null;

        if (!result.ok) {
            if (ac.signal.aborted) return null;
            toast.error('Failed to load settings.');
            setPhase('error');
            return null;
        }

        setLoadedNodeId(captured);
        setPhase('ready');
        return result.settings;
    }, []);

    useEffect(() => {
        return () => {
            abortRef.current?.abort();
        };
    }, []);

    return {
        phase,
        isCurrentNodeLoaded,
        loadedNodeId,
        load,
        isSaveOwner,
        captureSaveGuard,
    };
}
