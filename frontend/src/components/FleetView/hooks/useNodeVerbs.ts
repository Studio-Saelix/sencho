import { useCallback, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import { openGitOpsWorkplace } from '@/components/gitops/portfolio/portfolioNavigation';
import type { NodeVerb } from '../nodeStatus';
import type { FleetNode } from '../types';

/** What the Fleet shell hands a node surface so a verb can run where it is shown. */
export interface NodeVerbHandlers {
    onUpdate?: (nodeId: number) => void;
    updatingNodeId?: number | null;
    onRetryUpdate?: (nodeId: number) => void;
    onOpenNetworking?: (nodeId: number) => void;
    /** Runs after a connection test so the overview can pick up the new state. */
    onTested?: () => void;
}

interface UseNodeVerbsOptions {
    node: FleetNode;
    handlers: NodeVerbHandlers;
    /** Opens the shared cordon confirmation. */
    openCordon: () => void;
}

/**
 * One place that decides whether the session may run a node verb and what
 * running it does, so the card, the sheet toolbar and the Answer all call the
 * same handler. A verb the session cannot run is not offered.
 */
export function useNodeVerbs({ node, handlers, openCordon }: UseNodeVerbsOptions) {
    const { isAdmin, can } = useAuth();
    const [testing, setTesting] = useState(false);
    const canManage = can('node:manage', 'node', String(node.id));
    const { onUpdate, updatingNodeId, onRetryUpdate, onOpenNetworking, onTested } = handlers;

    const testConnection = useCallback(async () => {
        setTesting(true);
        try {
            const res = await apiFetch(`/nodes/${node.id}/test`, { method: 'POST', localOnly: true });
            const data = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
            if (res.ok && data?.success) {
                toast.success(`Connected to "${node.name}"`);
            } else {
                toast.error(data?.error ?? `Connection test failed for "${node.name}" (${res.status})`);
            }
        } catch (error) {
            console.error('Connection test failed for node', node.id, error);
            const reason = error instanceof Error ? `: ${error.message}` : '';
            toast.error(`Connection test failed for "${node.name}"${reason}`);
        } finally {
            setTesting(false);
            onTested?.();
        }
    }, [node.id, node.name, onTested]);

    const isAllowed = useCallback((verb: NodeVerb): boolean => {
        switch (verb.id) {
            case 'test-connection':
            case 'uncordon': return canManage;
            case 'update':
            case 'update-dev': return isAdmin && Boolean(onUpdate);
            case 'retry-update': return isAdmin && Boolean(onRetryUpdate);
            case 'view-networking': return Boolean(onOpenNetworking);
            // The GitOps workplace enforces its own access, so the verb is offered to anyone who sees the card.
            case 'open-gitops': return true;
        }
    }, [canManage, isAdmin, onUpdate, onRetryUpdate, onOpenNetworking]);

    const run = useCallback((verb: NodeVerb) => {
        if (!isAllowed(verb)) return;
        switch (verb.id) {
            case 'test-connection': void testConnection(); return;
            case 'uncordon': openCordon(); return;
            case 'update':
            case 'update-dev': onUpdate?.(node.id); return;
            case 'retry-update': onRetryUpdate?.(node.id); return;
            case 'view-networking': onOpenNetworking?.(node.id); return;
            case 'open-gitops': openGitOpsWorkplace({ nodeId: node.id, attention: true }); return;
            default: {
                const unhandled: never = verb.id;
                throw new Error(`Unhandled node verb: ${String(unhandled)}`);
            }
        }
    }, [isAllowed, node.id, onUpdate, onRetryUpdate, onOpenNetworking, openCordon, testConnection]);

    const isPending = useCallback((verb: NodeVerb): boolean => {
        if (verb.id === 'test-connection') return testing;
        if (verb.id === 'update' || verb.id === 'update-dev') return updatingNodeId === node.id;
        return false;
    }, [testing, updatingNodeId, node.id]);

    return { canManage, isAllowed, run, isPending };
}
