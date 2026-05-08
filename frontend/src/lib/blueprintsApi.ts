import { apiFetch } from './api';

export type DriftMode = 'observe' | 'suggest' | 'enforce';
export type BlueprintClassification = 'stateless' | 'stateful' | 'unknown';
export type BlueprintDeploymentStatus =
    | 'pending'
    | 'pending_state_review'
    | 'deploying'
    | 'active'
    | 'drifted'
    | 'correcting'
    | 'failed'
    | 'withdrawing'
    | 'withdrawn'
    | 'evict_blocked'
    | 'name_conflict';

export type BlueprintSelector =
    | { type: 'labels'; any: string[]; all: string[] }
    | { type: 'nodes'; ids: number[] };

export interface Blueprint {
    id: number;
    name: string;
    description: string | null;
    compose_content: string;
    selector: BlueprintSelector;
    drift_mode: DriftMode;
    classification: BlueprintClassification;
    classification_reasons: string[];
    enabled: boolean;
    revision: number;
    created_at: number;
    updated_at: number;
    created_by: string | null;
    pinned_node_id: number | null;
}

export interface BlueprintListItem extends Blueprint {
    deploymentCounts: Partial<Record<BlueprintDeploymentStatus, number>>;
    deploymentTotal: number;
}

export interface BlueprintDeployment {
    id: number;
    blueprint_id: number;
    node_id: number;
    status: BlueprintDeploymentStatus;
    applied_revision: number | null;
    last_deployed_at: number | null;
    last_checked_at: number | null;
    last_drift_at: number | null;
    drift_summary: string | null;
    last_error: string | null;
}

export interface BlueprintSummary {
    blueprint: Blueprint;
    deployments: BlueprintDeployment[];
    statusCounts: Partial<Record<BlueprintDeploymentStatus, number>>;
}

export interface AnalyzerResult {
    classification: BlueprintClassification;
    reasons: string[];
    hasNamedVolumes: boolean;
    hasBindMounts: boolean;
    hasExternalVolumes: boolean;
    hasTmpfsOnly: boolean;
    parseError?: string;
}

export interface BlueprintPreview {
    blueprintId: number;
    classification: BlueprintClassification;
    matchedNodes: Array<{ id: number; name: string; type: 'local' | 'remote' }>;
    plannedDeployments: Array<{ id: number; name: string }>;
    plannedDriftChecks: Array<{ id: number; name: string }>;
    plannedEvictions: number[];
}

export type WithdrawConfirm = 'standard' | 'snapshot_then_evict' | 'evict_and_destroy';
export type AcceptMode = 'fresh' | 'restore_from_snapshot';

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

async function expectNoContent(res: Response, fallback: string): Promise<void> {
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

// ---- Blueprints CRUD ----

export async function listBlueprints(): Promise<BlueprintListItem[]> {
    const res = await apiFetch('/blueprints', { localOnly: true });
    return expectJson<BlueprintListItem[]>(res, 'Failed to load blueprints');
}

export async function getBlueprint(id: number): Promise<BlueprintSummary> {
    const res = await apiFetch(`/blueprints/${id}`, { localOnly: true });
    return expectJson<BlueprintSummary>(res, 'Failed to load blueprint');
}

export interface CreateBlueprintInput {
    name: string;
    description?: string | null;
    compose_content: string;
    selector: BlueprintSelector;
    drift_mode?: DriftMode;
    enabled?: boolean;
}

export async function createBlueprint(input: CreateBlueprintInput): Promise<Blueprint> {
    const res = await apiFetch('/blueprints', {
        method: 'POST',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<Blueprint>(res, 'Failed to create blueprint');
}

export interface UpdateBlueprintInput {
    name?: string;
    description?: string | null;
    compose_content?: string;
    selector?: BlueprintSelector;
    drift_mode?: DriftMode;
    enabled?: boolean;
}

export async function updateBlueprint(id: number, input: UpdateBlueprintInput): Promise<Blueprint> {
    const res = await apiFetch(`/blueprints/${id}`, {
        method: 'PUT',
        body: JSON.stringify(input),
        localOnly: true,
    });
    return expectJson<Blueprint>(res, 'Failed to update blueprint');
}

export async function deleteBlueprint(id: number): Promise<void> {
    const res = await apiFetch(`/blueprints/${id}`, { method: 'DELETE', localOnly: true });
    return expectNoContent(res, 'Failed to delete blueprint');
}

// ---- Apply / Withdraw / Accept / Preview ----

export async function applyBlueprint(id: number): Promise<{ message: string }> {
    const res = await apiFetch(`/blueprints/${id}/apply`, { method: 'POST', localOnly: true });
    return expectJson(res, 'Failed to apply blueprint');
}

export async function pinBlueprint(id: number, nodeId: number | null): Promise<Blueprint> {
    const res = await apiFetch(`/blueprints/${id}/pin`, {
        method: 'PUT',
        body: JSON.stringify({ nodeId }),
        localOnly: true,
    });
    return expectJson<Blueprint>(res, 'Failed to update blueprint pin');
}

export async function withdrawDeployment(
    blueprintId: number,
    nodeId: number,
    confirm: WithdrawConfirm,
): Promise<{ status: BlueprintDeploymentStatus; error: string | null; snapshotPolicy: WithdrawConfirm; snapshotId: number | null }> {
    const res = await apiFetch(`/blueprints/${blueprintId}/withdraw/${nodeId}`, {
        method: 'POST',
        body: JSON.stringify({ confirm }),
        localOnly: true,
    });
    return expectJson(res, 'Failed to withdraw deployment');
}

export async function acceptDeployment(
    blueprintId: number,
    nodeId: number,
    mode: AcceptMode,
): Promise<{ status: string; mode: AcceptMode }> {
    const res = await apiFetch(`/blueprints/${blueprintId}/accept/${nodeId}`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
        localOnly: true,
    });
    return expectJson(res, 'Failed to accept deployment');
}

export async function previewBlueprint(id: number): Promise<BlueprintPreview> {
    const res = await apiFetch(`/blueprints/${id}/preview`, { localOnly: true });
    return expectJson<BlueprintPreview>(res, 'Failed to preview blueprint');
}

export async function analyzeCompose(composeContent: string): Promise<AnalyzerResult> {
    const res = await apiFetch('/blueprints/analyze', {
        method: 'POST',
        body: JSON.stringify({ compose_content: composeContent }),
        localOnly: true,
    });
    return expectJson<AnalyzerResult>(res, 'Failed to analyze compose');
}

// ---- Node labels ----

export async function listAllNodeLabels(): Promise<Record<number, string[]>> {
    const res = await apiFetch('/node-labels', { localOnly: true });
    return expectJson<Record<number, string[]>>(res, 'Failed to load node labels');
}

export async function listDistinctLabels(): Promise<string[]> {
    const res = await apiFetch('/node-labels/all', { localOnly: true });
    const data = await expectJson<{ labels: string[] }>(res, 'Failed to load distinct labels');
    return data.labels;
}

export async function getLabelsForNode(nodeId: number): Promise<string[]> {
    const res = await apiFetch(`/node-labels/${nodeId}`, { localOnly: true });
    const data = await expectJson<{ nodeId: number; labels: string[] }>(res, 'Failed to load labels for node');
    return data.labels;
}

export async function addNodeLabel(nodeId: number, label: string): Promise<{ nodeId: number; label: string }> {
    const res = await apiFetch(`/node-labels/${nodeId}`, {
        method: 'POST',
        body: JSON.stringify({ label }),
        localOnly: true,
    });
    return expectJson(res, 'Failed to add label');
}

export async function removeNodeLabel(nodeId: number, label: string): Promise<void> {
    const res = await apiFetch(`/node-labels/${nodeId}/${encodeURIComponent(label)}`, {
        method: 'DELETE',
        localOnly: true,
    });
    return expectNoContent(res, 'Failed to remove label');
}

// ---- helpers ----

export function describeSelector(selector: BlueprintSelector): string {
    if (selector.type === 'nodes') {
        return selector.ids.length === 0
            ? 'no nodes selected'
            : `${selector.ids.length} node${selector.ids.length === 1 ? '' : 's'}`;
    }
    const parts: string[] = [];
    if (selector.all.length > 0) parts.push(`all=[${selector.all.join(', ')}]`);
    if (selector.any.length > 0) parts.push(`any=[${selector.any.join(', ')}]`);
    return parts.length === 0 ? 'no labels selected' : parts.join(' · ');
}

export function statusTone(status: BlueprintDeploymentStatus): 'success' | 'brand' | 'warning' | 'destructive' | 'muted' {
    switch (status) {
        case 'active': return 'success';
        case 'deploying':
        case 'correcting': return 'brand';
        case 'pending':
        case 'pending_state_review':
        case 'evict_blocked':
        case 'drifted':
        case 'withdrawing': return 'warning';
        case 'failed':
        case 'name_conflict': return 'destructive';
        case 'withdrawn':
        default: return 'muted';
    }
}
