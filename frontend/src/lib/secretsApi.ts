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

export interface SecretWithKv extends SecretSummary {
    kv: Record<string, string>;
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
    before?: string;
    after?: string;
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

export async function getSecret(id: number): Promise<SecretWithKv> {
    const res = await apiFetch(`/secrets/${id}`, { localOnly: true });
    return expectJson<SecretWithKv>(res, 'Failed to load secret');
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

export interface UpdateSecretInput {
    description?: string;
    kv: Record<string, string>;
    note?: string;
}

export async function updateSecret(id: number, input: UpdateSecretInput): Promise<{ version: number }> {
    const res = await apiFetch(`/secrets/${id}`, {
        method: 'PUT',
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

export async function importFromStack(id: number, input: { nodeId: number; stackName: string; envFileBasename?: string }): Promise<{ kv: Record<string, string> }> {
    const res = await apiFetch(`/secrets/${id}/import-from-stack`, {
        method: 'POST',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<{ kv: Record<string, string> }>(res, 'Failed to import env from stack');
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
