import { apiFetch } from './api';
import type { BlueprintSelector } from './blueprintsApi';

export type DiffStatus = 'added' | 'changed' | 'removed' | 'unchanged';
export type SecretPushStatus = 'ok' | 'failed' | 'skipped';

export interface SecretSummary {
    id: number;
    name: string;
    description: string;
    currentVersion: number;
    keyCount: number;
    createdAt: number;
    createdBy: string;
    updatedAt: number;
}

export interface SecretKeyEntry {
    key: string;
    /** The fixed stand-in the server sends instead of a value. */
    masked: string;
}

/**
 * Bundle detail. Values are masked by default; one key at a time can be
 * revealed through `revealValue` for a short window.
 */
export interface SecretDetail extends SecretSummary {
    masked: true;
    keys: SecretKeyEntry[];
}

export interface SecretVersionSummary {
    version: number;
    keyCount: number;
    createdAt: number;
    createdBy: string;
    note: string;
}

export interface SecretDiffEntry {
    key: string;
    status: DiffStatus;
}

export interface SecretImportPreview {
    added: number;
    changed: number;
    unchanged: number;
    keys: SecretDiffEntry[];
}

export interface SecretPushPlanEntry {
    nodeId: number;
    nodeName: string;
    stackName: string;
    envFileBasename: string;
    reachable: boolean;
    stackExists: boolean;
    error?: string;
    diff: SecretDiffEntry[];
    added: number;
    changed: number;
    unchanged: number;
    removedInformational: number;
}

export interface SecretPushResultEntry {
    nodeId: number;
    nodeName: string;
    stackName: string;
    envFileBasename: string;
    status: SecretPushStatus;
    error?: string;
    added: number;
    changed: number;
    unchanged: number;
}

/** One change applied on top of the version the client loaded. */
export type SecretPatchOp =
    | { op: 'set'; key: string; value: string }
    | { op: 'remove'; key: string }
    | { op: 'rename'; from: string; to: string };

export interface RevealGrant {
    grantId: string;
    key: string;
    version: number;
    expiresAt: number;
}

export interface RevealedValue {
    key: string;
    version: number;
    value: string;
    expiresAt: number;
}

async function expectJson<T>(res: Response, fallback: string): Promise<T> {
    if (!res.ok) {
        let detail = fallback;
        try {
            const body = await res.json();
            if (body && typeof body === 'object' && typeof body.error === 'string') detail = body.error;
        } catch {
            // body not JSON
        }
        const err = new Error(detail) as Error & { status: number; code?: string };
        err.status = res.status;
        throw err;
    }
    return res.json() as Promise<T>;
}

async function expectOk(res: Response, fallback: string): Promise<void> {
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
}

export async function listSecrets(): Promise<SecretSummary[]> {
    const res = await apiFetch('/secrets', { localOnly: true });
    return expectJson<SecretSummary[]>(res, 'Failed to load secrets');
}

export async function getSecret(id: number): Promise<SecretDetail> {
    const res = await apiFetch(`/secrets/${id}`, { localOnly: true });
    return expectJson<SecretDetail>(res, 'Failed to load secret');
}

export interface CreateSecretInput {
    name: string;
    description?: string;
    kv: Record<string, string>;
    note?: string;
}

export async function createSecret(input: CreateSecretInput): Promise<{ id: number; version: number }> {
    const res = await apiFetch('/secrets', {
        method: 'POST',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<{ id: number; version: number }>(res, 'Failed to create secret');
}

export interface PatchSecretInput {
    /** The version the editor loaded; a mismatch is refused instead of overwriting values. */
    expectedVersion: number;
    ops: SecretPatchOp[];
    description?: string;
    note?: string;
}

export async function patchSecret(id: number, input: PatchSecretInput): Promise<{ version: number }> {
    const res = await apiFetch(`/secrets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<{ version: number }>(res, 'Failed to update secret');
}

export async function deleteSecret(id: number): Promise<void> {
    const res = await apiFetch(`/secrets/${id}`, {
        method: 'DELETE',
        localOnly: true,
    });
    await expectOk(res, 'Failed to delete secret');
}

export async function listSecretVersions(id: number): Promise<SecretVersionSummary[]> {
    const res = await apiFetch(`/secrets/${id}/versions`, { localOnly: true });
    return expectJson<SecretVersionSummary[]>(res, 'Failed to load versions');
}

/**
 * Reveal one value. A grant is minted for this exact bundle version and key,
 * then exchanged once for the value; the value lives in component state only
 * until `expiresAt`.
 */
export async function revealValue(id: number, key: string, version?: number): Promise<RevealedValue> {
    const grantRes = await apiFetch(`/secrets/${id}/reveal-grant`, {
        method: 'POST',
        body: JSON.stringify(version === undefined ? { key } : { key, version }),
        localOnly: true,
    });
    const grant = await expectJson<RevealGrant>(grantRes, 'Failed to authorize reveal');
    const revealRes = await apiFetch(`/secrets/${id}/reveal`, {
        method: 'POST',
        body: JSON.stringify({ grantId: grant.grantId }),
        localOnly: true,
    });
    return expectJson<RevealedValue>(revealRes, 'Failed to reveal value');
}

export interface ImportSourceInput {
    nodeId: number;
    stackName: string;
    envFileBasename?: string;
}

export async function previewImport(id: number, input: ImportSourceInput): Promise<SecretImportPreview> {
    const res = await apiFetch(`/secrets/${id}/import-from-stack/preview`, {
        method: 'POST',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<SecretImportPreview>(res, 'Failed to preview import');
}

export async function applyImport(
    id: number,
    input: ImportSourceInput & { expectedVersion: number; note?: string },
): Promise<{ version: number; added: number; changed: number; unchanged: number }> {
    const res = await apiFetch(`/secrets/${id}/import-from-stack`, {
        method: 'POST',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<{ version: number; added: number; changed: number; unchanged: number }>(res, 'Failed to import env from stack');
}

export interface PushInput {
    selector: BlueprintSelector;
    stackName: string;
    envFileBasename: string;
}

export async function previewPush(id: number, input: PushInput): Promise<SecretPushPlanEntry[]> {
    const res = await apiFetch(`/secrets/${id}/push/preview`, {
        method: 'POST',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<SecretPushPlanEntry[]>(res, 'Failed to preview push');
}

export async function executePush(id: number, input: PushInput): Promise<{ pushId: string; results: SecretPushResultEntry[] }> {
    const res = await apiFetch(`/secrets/${id}/push`, {
        method: 'POST',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<{ pushId: string; results: SecretPushResultEntry[] }>(res, 'Failed to push secret');
}
