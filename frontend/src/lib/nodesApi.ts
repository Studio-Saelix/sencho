import { apiFetch } from './api';
import type { GitOpsRevisionsCarrier } from '@/types/gitops';

export interface NodeRecord {
    id: number;
    name: string;
    type: 'local' | 'remote';
    mode?: string;
    compose_dir?: string;
    is_default?: boolean;
    status: 'online' | 'offline' | 'unknown';
    api_url?: string;
    cordoned: boolean;
    cordoned_at: number | null;
    cordoned_reason: string | null;
}

/**
 * Cordon and uncordon answer with the node plus a GitOps revision list that is
 * always empty, by design: a cordon governs whether new placements may be made,
 * not what a Blueprint asks for, and the reconciler leaves existing deployments
 * where they are. The field is declared for shape parity with node delete and
 * label add. Do not build a consumer that expects rows in it.
 */
export type NodeCordonResult = NodeRecord & GitOpsRevisionsCarrier;

async function expectJson<T>(res: Response, fallback: string): Promise<T> {
    if (!res.ok) {
        let detail = fallback;
        try {
            const body = await res.json();
            if (body && typeof body === 'object' && typeof body.error === 'string') detail = body.error;
        } catch {
            // body not JSON
        }
        const err = new Error(detail) as Error & { status: number };
        err.status = res.status;
        throw err;
    }
    return res.json() as Promise<T>;
}

export async function listNodes(): Promise<NodeRecord[]> {
    const res = await apiFetch('/nodes', { localOnly: true });
    return expectJson<NodeRecord[]>(res, 'Failed to load nodes');
}

export async function cordonNode(id: number, reason: string | null): Promise<NodeCordonResult> {
    const res = await apiFetch(`/nodes/${id}/cordon`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
        localOnly: true,
    });
    return expectJson<NodeCordonResult>(res, 'Failed to cordon node');
}

export async function uncordonNode(id: number): Promise<NodeCordonResult> {
    const res = await apiFetch(`/nodes/${id}/uncordon`, {
        method: 'POST',
        localOnly: true,
    });
    return expectJson<NodeCordonResult>(res, 'Failed to uncordon node');
}
