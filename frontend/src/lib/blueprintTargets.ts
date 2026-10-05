import { addNodeLabel, type BlueprintSelector } from './blueprintsApi';

/** A node label assignment held in the Blueprint form until the operator commits it. */
export interface StagedLabel {
    nodeId: number;
    label: string;
}

export type NodeLabelMap = Record<number, string[]>;
export type MatchMode = 'any' | 'all';

/**
 * What the targets control edits. A Blueprint saved with both an `any` and an
 * `all` list cannot be shown as one chip row plus Match any/all, so it keeps
 * its two lists in `compound` and the form edits them as two rows.
 */
export interface TargetsDraft {
    type: 'labels' | 'nodes';
    labels: string[];
    mode: MatchMode;
    compound: { any: string[]; all: string[] } | null;
    nodeIds: number[];
}

const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_LABEL_LENGTH = 40;

/** Mirrors the server's format rules (pattern, length, non-empty). The per-node label cap is only enforced on write. */
export function validateLabelName(raw: string): string | null {
    const label = raw.trim();
    if (!label) return 'Enter a label name';
    if (label.length > MAX_LABEL_LENGTH) return `Use ${MAX_LABEL_LENGTH} characters or fewer`;
    if (!LABEL_PATTERN.test(label)) return 'Use letters, digits, dot, dash or underscore';
    return null;
}

export function draftFromSelector(selector: BlueprintSelector): TargetsDraft {
    if (selector.type === 'nodes') {
        return { type: 'nodes', labels: [], mode: 'any', compound: null, nodeIds: selector.ids };
    }
    const any = selector.any ?? [];
    const all = selector.all ?? [];
    if (any.length > 0 && all.length > 0) {
        return { type: 'labels', labels: [], mode: 'any', compound: { any, all }, nodeIds: [] };
    }
    if (all.length > 0) return { type: 'labels', labels: all, mode: 'all', compound: null, nodeIds: [] };
    return { type: 'labels', labels: any, mode: 'any', compound: null, nodeIds: [] };
}

export function selectorFromDraft(draft: TargetsDraft): BlueprintSelector {
    if (draft.type === 'nodes') return { type: 'nodes', ids: draft.nodeIds };
    if (draft.compound) return { type: 'labels', any: draft.compound.any, all: draft.compound.all };
    return draft.mode === 'all'
        ? { type: 'labels', any: [], all: draft.labels }
        : { type: 'labels', any: draft.labels, all: [] };
}

/** True when the draft names no target yet; the form refuses to submit it. */
export function isDraftEmpty(draft: TargetsDraft): boolean {
    if (draft.type === 'nodes') return draft.nodeIds.length === 0;
    if (draft.compound) return draft.compound.any.length === 0 && draft.compound.all.length === 0;
    return draft.labels.length === 0;
}

/**
 * The staged assignments the selector actually uses. A label that was staged and
 * then deselected, or a staged label under a node-ID selector, would tag nodes
 * for a Blueprint that never selects on it, so it is neither shown nor written.
 */
export function stagedInUse(staged: readonly StagedLabel[], selector: BlueprintSelector): StagedLabel[] {
    if (selector.type !== 'labels') return [];
    const used = new Set([...(selector.any ?? []), ...(selector.all ?? [])]);
    return staged.filter(s => used.has(s.label));
}

/** The label map as it will be once the staged assignments are written. */
export function withStagedLabels(map: NodeLabelMap, staged: readonly StagedLabel[]): NodeLabelMap {
    const next: NodeLabelMap = {};
    for (const [id, labels] of Object.entries(map)) next[Number(id)] = [...labels];
    for (const { nodeId, label } of staged) {
        const existing = next[nodeId] ?? [];
        if (!existing.includes(label)) next[nodeId] = [...existing, label];
    }
    return next;
}

export function distinctLabels(map: NodeLabelMap): string[] {
    const all = new Set<string>();
    for (const labels of Object.values(map)) for (const label of labels) all.add(label);
    return [...all].sort((a, b) => a.localeCompare(b));
}

/** Mirrors the server's selector match. The reconciler can still skip cordoned or severed nodes, so this is the selector's own match, not the rollout's final plan. */
export function matchNodes<T extends { id: number }>(
    selector: BlueprintSelector,
    nodes: readonly T[],
    labels: NodeLabelMap,
): T[] {
    if (selector.type === 'nodes') {
        const ids = new Set(selector.ids);
        return nodes.filter(n => ids.has(n.id));
    }
    const all = (selector.all ?? []).filter(l => l.length > 0);
    const any = (selector.any ?? []).filter(l => l.length > 0);
    if (all.length === 0 && any.length === 0) return [];
    return nodes.filter(node => {
        const own = new Set(labels[node.id] ?? []);
        if (all.length > 0 && !all.every(l => own.has(l))) return false;
        if (any.length > 0 && !any.some(l => own.has(l))) return false;
        return true;
    });
}

export interface StagedWriteResult {
    written: StagedLabel[];
    failed: Array<StagedLabel & { message: string }>;
    /** Other Blueprints whose placement moved because of the new labels. */
    movedOthers: number;
}

/**
 * Writes staged labels one at a time through the same endpoint Settings uses,
 * so each write is recorded as a placement shift. A failure does not stop the
 * rest; the caller reports what landed and what did not.
 */
export async function writeStagedLabels(
    staged: readonly StagedLabel[],
    ownBlueprintId: number | null,
): Promise<StagedWriteResult> {
    const result: StagedWriteResult = { written: [], failed: [], movedOthers: 0 };
    const movedBlueprints = new Set<number>();
    for (const entry of staged) {
        let response: Awaited<ReturnType<typeof addNodeLabel>>;
        try {
            response = await addNodeLabel(entry.nodeId, entry.label);
        } catch (err) {
            result.failed.push({ ...entry, message: err instanceof Error ? err.message : 'Failed to add label' });
            continue;
        }
        result.written.push(entry);
        for (const revision of response.gitopsRevisions ?? []) {
            if (revision.applicationId !== null && revision.blueprintId !== null && revision.blueprintId !== ownBlueprintId) {
                movedBlueprints.add(revision.blueprintId);
            }
        }
    }
    result.movedOthers = movedBlueprints.size;
    return result;
}

export interface StagedWriteNotice {
    tone: 'success' | 'warning';
    message: string;
}

export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Toast text after staged labels were written, or null when nothing was staged. */
export function describeStagedWrite(result: StagedWriteResult): StagedWriteNotice | null {
    const total = result.written.length + result.failed.length;
    if (total === 0) return null;
    if (result.failed.length > 0) {
        const reasons = [...new Set(result.failed.map(f => f.message.replace(/\.$/, '')))].slice(0, 2).join('; ');
        return {
            tone: 'warning',
            message: `Added ${result.written.length} of ${plural(total, 'node label')}. ${reasons}. Edit the Blueprint to add the rest.`,
        };
    }
    const moved = result.movedOthers > 0 ? ` ${plural(result.movedOthers, 'other blueprint')} re-placed.` : '';
    return { tone: 'success', message: `Added ${plural(result.written.length, 'node label')}.${moved}` };
}
