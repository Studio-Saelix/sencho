import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * Whether a node's Update and Reapply can also recreate the container that
 * carries its Docker API (a Docker socket proxy in Sencho's own Compose
 * project). `unsupported` is a node running a Sencho version without it.
 */
export type EndpointProviderOption =
    | { state: 'none' }
    | { state: 'unsupported' }
    /** `providerOnly` is false on a node whose build cannot leave Sencho running. */
    | { state: 'available'; service: string; containerName: string; project: string | null; providerOnly: boolean }
    | { state: 'unavailable'; service: string | null; reason: string };

/** Reads the option for one node; null when the check failed (the dialog then offers nothing). */
export async function fetchEndpointProviderOption(nodeId: number): Promise<EndpointProviderOption | null> {
    try {
        const res = await apiFetch(`/fleet/nodes/${nodeId}/endpoint-provider`, { localOnly: true });
        if (!res.ok) {
            console.warn('[Fleet] Docker endpoint option returned HTTP', res.status);
            return null;
        }
        return await res.json() as EndpointProviderOption;
    } catch (error) {
        console.warn('[Fleet] Failed to read the Docker endpoint option:', error);
        return null;
    }
}

export function useEndpointProviderOption(nodeId: number | null | undefined, enabled: boolean): EndpointProviderOption | null {
    const [option, setOption] = useState<{ nodeId: number; value: EndpointProviderOption | null } | null>(null);

    useEffect(() => {
        if (!enabled || nodeId === null || nodeId === undefined) return;
        let cancelled = false;
        void fetchEndpointProviderOption(nodeId).then(value => {
            if (!cancelled) setOption({ nodeId, value });
        });
        return () => { cancelled = true; };
    }, [nodeId, enabled]);

    return enabled && option !== null && option.nodeId === nodeId ? option.value : null;
}
