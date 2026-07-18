import { apiFetch } from './api';

export interface RequestServiceUpdateParams {
    nodeId: number | null;
    stackName: string;
    serviceName: string;
    /** Caller's intent only (Update vs Rebuild copy); the backend route and
     *  orchestrator path are the same either way. Defaults to 'update'. */
    mode?: 'update' | 'rebuild';
}

export interface ServiceUpdateSuccess {
    ok: true;
    mode: 'update' | 'rebuild';
    serviceName: string;
    healthGateId: string | null;
    observing: boolean;
    recoveryId: string | null;
    recoveryAvailable: boolean;
    recheckWarning?: string;
}

export interface ServiceUpdateFailure {
    ok: false;
    mode: 'update' | 'rebuild';
    error: string;
    code?: string;
    recoveryId?: string;
    status?: number;
}

export type ServiceUpdateResult = ServiceUpdateSuccess | ServiceUpdateFailure;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

/**
 * Single entry point for a manual service-scoped update/rebuild, mirroring
 * `POST /stacks/:stackName/services/:serviceName/update`'s response shape
 * (see `sendServiceResult` in backend/src/routes/stacks.ts).
 */
export async function requestServiceUpdate(params: RequestServiceUpdateParams): Promise<ServiceUpdateResult> {
    const { nodeId, stackName, serviceName, mode = 'update' } = params;
    try {
        const res = await apiFetch(
            `/stacks/${encodeURIComponent(stackName)}/services/${encodeURIComponent(serviceName)}/update`,
            { method: 'POST', nodeId },
        );
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
            const error = isRecord(body) && typeof body.error === 'string'
                ? body.error
                : `Failed to update service "${serviceName}"`;
            return {
                ok: false,
                mode,
                error,
                code: isRecord(body) && typeof body.code === 'string' ? body.code : undefined,
                recoveryId: isRecord(body) && typeof body.recoveryId === 'string' ? body.recoveryId : undefined,
                status: res.status,
            };
        }
        if (!isRecord(body) || typeof body.serviceName !== 'string') {
            return { ok: false, mode, error: 'Unexpected response from the service update', status: res.status };
        }
        return {
            ok: true,
            mode,
            serviceName: body.serviceName,
            healthGateId: typeof body.healthGateId === 'string' ? body.healthGateId : null,
            observing: body.observing === true,
            recoveryId: typeof body.recoveryId === 'string' ? body.recoveryId : null,
            recoveryAvailable: body.recoveryAvailable === true,
            recheckWarning: typeof body.recheckWarning === 'string' ? body.recheckWarning : undefined,
        };
    } catch (error) {
        return {
            ok: false,
            mode,
            error: error instanceof Error ? error.message : `Failed to update service "${serviceName}"`,
        };
    }
}

export interface RequestServiceRestoreParams {
    nodeId: number | null;
    stackName: string;
    serviceName: string;
    recoveryId: string;
}

/**
 * Restore one Compose service from a recovery snapshot captured during a
 * prior service-scoped update (`POST .../services/:serviceName/restore`).
 */
export async function requestServiceRestore(params: RequestServiceRestoreParams): Promise<ServiceUpdateResult> {
    const { nodeId, stackName, serviceName, recoveryId } = params;
    try {
        const res = await apiFetch(
            `/stacks/${encodeURIComponent(stackName)}/services/${encodeURIComponent(serviceName)}/restore`,
            {
                method: 'POST',
                nodeId,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recoveryId }),
            },
        );
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
            const error = isRecord(body) && typeof body.error === 'string'
                ? body.error
                : `Failed to restore service "${serviceName}"`;
            return {
                ok: false,
                mode: 'update',
                error,
                code: isRecord(body) && typeof body.code === 'string' ? body.code : undefined,
                recoveryId: isRecord(body) && typeof body.recoveryId === 'string' ? body.recoveryId : undefined,
                status: res.status,
            };
        }
        if (!isRecord(body) || typeof body.serviceName !== 'string') {
            return { ok: false, mode: 'update', error: 'Unexpected response from the service restore', status: res.status };
        }
        return {
            ok: true,
            mode: 'update',
            serviceName: body.serviceName,
            healthGateId: typeof body.healthGateId === 'string' ? body.healthGateId : null,
            observing: body.observing === true,
            recoveryId: typeof body.recoveryId === 'string' ? body.recoveryId : null,
            recoveryAvailable: body.recoveryAvailable === true,
            recheckWarning: typeof body.recheckWarning === 'string' ? body.recheckWarning : undefined,
        };
    } catch (error) {
        return {
            ok: false,
            mode: 'update',
            error: error instanceof Error ? error.message : `Failed to restore service "${serviceName}"`,
        };
    }
}
