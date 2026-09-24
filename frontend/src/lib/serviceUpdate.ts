import { apiFetch, withDeploySession } from './api';

export interface RequestServiceUpdateParams {
    nodeId: number | null;
    stackName: string;
    serviceName: string;
    /** Caller's intent only (Update vs Rebuild copy); the backend route and
     *  orchestrator path are the same either way. Defaults to 'update'. */
    mode?: 'update' | 'rebuild';
    /** Deploy-feedback session id so Compose output streams to the panel. */
    deploySessionId?: string;
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
    serviceName?: string;
    mutationStage?: string;
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
    const { nodeId, stackName, serviceName, mode = 'update', deploySessionId } = params;
    try {
        const res = await apiFetch(
            `/stacks/${encodeURIComponent(stackName)}/services/${encodeURIComponent(serviceName)}/update`,
            withDeploySession(deploySessionId ?? '', { method: 'POST', nodeId }),
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
                serviceName: isRecord(body) && typeof body.serviceName === 'string' ? body.serviceName : undefined,
                mutationStage: isRecord(body) && typeof body.mutationStage === 'string' ? body.mutationStage : undefined,
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
    deploySessionId?: string;
}

/**
 * Restore one Compose service from a recovery snapshot captured during a
 * prior service-scoped update (`POST .../services/:serviceName/restore`).
 */
export async function requestServiceRestore(params: RequestServiceRestoreParams): Promise<ServiceUpdateResult> {
    const { nodeId, stackName, serviceName, recoveryId, deploySessionId } = params;
    try {
        const res = await apiFetch(
            `/stacks/${encodeURIComponent(stackName)}/services/${encodeURIComponent(serviceName)}/restore`,
            withDeploySession(deploySessionId ?? '', {
                method: 'POST',
                nodeId,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recoveryId }),
            }),
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
                serviceName: isRecord(body) && typeof body.serviceName === 'string' ? body.serviceName : undefined,
                mutationStage: isRecord(body) && typeof body.mutationStage === 'string' ? body.mutationStage : undefined,
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

export interface ActiveServiceRecovery {
    id: string;
    status: string;
    healthGateId: string | null;
    expiresAt: number;
    createdAt: number;
    majorityImageId: string;
    declaredImageRef: string;
}

/**
 * Fetch the newest active recovery snapshot for a service, if any. Used when
 * Deploy Progress is disabled or dismissed so Restore remains discoverable.
 * Distinguishes "none" from lookup failure so the UI does not claim the
 * snapshot is missing when the request actually failed.
 */
export type FetchActiveServiceRecoveryResult =
    | { ok: true; recovery: ActiveServiceRecovery | null }
    | { ok: false; error: string };

/** Wire status after the /recoveries route collapses never-run / missing reports to unknown. */
export type StackRecoveryGateStatus = 'observing' | 'passed' | 'failed' | 'unknown';

export interface StackRecoveryEntry {
    serviceName: string;
    recoveryId: string;
    healthGateId: string | null;
    healthGateStatus: StackRecoveryGateStatus;
    healthGateReason: string | null;
    healthGateFailureSource: 'primary' | 'collateral' | null;
    expiresAt: number;
}

function isStackRecoveryGateStatus(value: unknown): value is StackRecoveryGateStatus {
    return value === 'observing' || value === 'passed' || value === 'failed' || value === 'unknown';
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function parseStackRecoveryEntry(value: unknown): StackRecoveryEntry | null {
    if (!isRecord(value)) return null;
    const { serviceName, recoveryId, healthGateStatus, expiresAt, healthGateId, healthGateReason } = value;
    const failureSource = value.healthGateFailureSource;
    if (typeof serviceName !== 'string' || typeof recoveryId !== 'string') return null;
    if (!isStackRecoveryGateStatus(healthGateStatus)) return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
    if (!isNullableString(healthGateId) || !isNullableString(healthGateReason)) return null;
    if (failureSource !== null && failureSource !== 'primary' && failureSource !== 'collateral') {
        return null;
    }
    return {
        serviceName,
        recoveryId,
        healthGateId,
        healthGateStatus,
        healthGateReason,
        healthGateFailureSource: failureSource,
        expiresAt,
    };
}

export async function fetchStackRecoveries(params: {
    nodeId: number | null;
    stackName: string;
}): Promise<StackRecoveryEntry[]> {
    const { nodeId, stackName } = params;
    try {
        const res = await apiFetch(
            `/stacks/${encodeURIComponent(stackName)}/recoveries`,
            { method: 'GET', nodeId },
        );
        if (!res.ok) {
            console.warn('[serviceUpdate] stack recoveries fetch returned', res.status);
            return [];
        }
        const body: unknown = await res.json().catch(() => null);
        if (!Array.isArray(body)) return [];
        const parsed = body
            .map(parseStackRecoveryEntry)
            .filter((entry): entry is StackRecoveryEntry => entry !== null);
        // Defensive dedup: the server orders newest-first and already returns one
        // row per service, but an older node (or a bug) could send several. Keep
        // only the first entry per service so a superseded row can never produce
        // a Restore toast pointing at a stale snapshot.
        const seen = new Set<string>();
        return parsed.filter((entry) => {
            if (seen.has(entry.serviceName)) return false;
            seen.add(entry.serviceName);
            return true;
        });
    } catch {
        console.warn('[serviceUpdate] stack recoveries fetch failed');
        return [];
    }
}

export async function fetchActiveServiceRecovery(params: {
    nodeId: number | null;
    stackName: string;
    serviceName: string;
}): Promise<FetchActiveServiceRecoveryResult> {
    const { nodeId, stackName, serviceName } = params;
    try {
        const res = await apiFetch(
            `/stacks/${encodeURIComponent(stackName)}/services/${encodeURIComponent(serviceName)}/recovery`,
            { method: 'GET', nodeId },
        );
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
            const error = isRecord(body) && typeof body.error === 'string'
                ? body.error
                : `Failed to look up recovery for "${serviceName}"`;
            console.warn('[serviceUpdate] recovery lookup failed:', res.status, error);
            return { ok: false, error };
        }
        if (!isRecord(body)) return { ok: true, recovery: null };
        if (body.recovery === null || body.recovery === undefined) {
            return { ok: true, recovery: null };
        }
        if (!isRecord(body.recovery)) {
            console.warn('[serviceUpdate] recovery lookup returned an unexpected payload');
            return { ok: false, error: `Unexpected recovery response for "${serviceName}"` };
        }
        const row = body.recovery;
        const id = row.id;
        if (typeof id !== 'string') {
            console.warn('[serviceUpdate] recovery lookup returned an unexpected payload');
            return { ok: false, error: `Unexpected recovery response for "${serviceName}"` };
        }
        return {
            ok: true,
            recovery: {
                id,
                status: typeof row.status === 'string' ? row.status : 'active',
                healthGateId: typeof row.healthGateId === 'string' ? row.healthGateId : null,
                expiresAt: typeof row.expiresAt === 'number' ? row.expiresAt : 0,
                createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
                majorityImageId: typeof row.majorityImageId === 'string' ? row.majorityImageId : '',
                declaredImageRef: typeof row.declaredImageRef === 'string' ? row.declaredImageRef : '',
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : `Failed to look up recovery for "${serviceName}"`;
        console.warn('[serviceUpdate] recovery lookup failed:', message);
        return { ok: false, error: message };
    }
}
