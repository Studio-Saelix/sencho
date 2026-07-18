import { useMemo } from 'react';
import type { StackUpdateInfo, StackServiceUpdateStatus } from '@/types/imageUpdates';

/**
 * Per-service update status for one stack, selected from the
 * `useImageUpdates` map (`detail.services`). Returns an empty array when the
 * stack has no persisted per-service breakdown yet (older check, or a stack
 * that has never been checked).
 */
export function useServiceUpdateStatus(
    stackUpdates: Record<string, StackUpdateInfo>,
    stackFile: string | null,
): StackServiceUpdateStatus[] {
    return useMemo(() => {
        if (!stackFile) return [];
        return stackUpdates[stackFile]?.services ?? [];
    }, [stackUpdates, stackFile]);
}

/** Look up one service's status by name from a per-stack breakdown. */
export function findServiceUpdateStatus(
    services: StackServiceUpdateStatus[],
    serviceName: string,
): StackServiceUpdateStatus | undefined {
    return services.find((s) => s.service === serviceName);
}
