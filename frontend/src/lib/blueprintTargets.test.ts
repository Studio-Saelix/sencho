import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./blueprintsApi', () => ({ addNodeLabel: vi.fn() }));

import { addNodeLabel } from './blueprintsApi';
import {
    distinctLabels,
    describeStagedWrite,
    draftFromSelector,
    isDraftEmpty,
    matchNodes,
    selectorFromDraft,
    stagedInUse,
    validateLabelName,
    withStagedLabels,
    writeStagedLabels,
} from './blueprintTargets';

const nodes = [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }, { id: 3, name: 'gamma' }];
const labels = { 1: ['prod', 'edge'], 2: ['prod'], 3: ['dev'] };

describe('selector draft round trip', () => {
    it('reads a single any list as Match any', () => {
        const draft = draftFromSelector({ type: 'labels', any: ['prod'], all: [] });
        expect(draft).toMatchObject({ type: 'labels', labels: ['prod'], mode: 'any', compound: null });
        expect(selectorFromDraft(draft)).toEqual({ type: 'labels', any: ['prod'], all: [] });
    });

    it('reads a single all list as Match all', () => {
        const draft = draftFromSelector({ type: 'labels', any: [], all: ['prod', 'edge'] });
        expect(draft).toMatchObject({ labels: ['prod', 'edge'], mode: 'all', compound: null });
        expect(selectorFromDraft(draft)).toEqual({ type: 'labels', any: [], all: ['prod', 'edge'] });
    });

    it('keeps a selector that uses both lists unchanged', () => {
        const selector = { type: 'labels' as const, any: ['prod'], all: ['edge'] };
        const draft = draftFromSelector(selector);
        expect(draft.compound).toEqual({ any: ['prod'], all: ['edge'] });
        expect(selectorFromDraft(draft)).toEqual(selector);
    });

    it('switches a label list between modes without losing labels', () => {
        const draft = draftFromSelector({ type: 'labels', any: ['prod', 'edge'], all: [] });
        expect(selectorFromDraft({ ...draft, mode: 'all' })).toEqual({ type: 'labels', any: [], all: ['prod', 'edge'] });
    });

    it('round trips a node selector', () => {
        const draft = draftFromSelector({ type: 'nodes', ids: [2, 3] });
        expect(selectorFromDraft(draft)).toEqual({ type: 'nodes', ids: [2, 3] });
    });

    it('treats a draft with no target as empty', () => {
        expect(isDraftEmpty(draftFromSelector({ type: 'labels', any: [], all: [] }))).toBe(true);
        expect(isDraftEmpty(draftFromSelector({ type: 'nodes', ids: [] }))).toBe(true);
        expect(isDraftEmpty(draftFromSelector({ type: 'labels', any: ['prod'], all: [] }))).toBe(false);
    });
});

describe('matchNodes', () => {
    it('matches any of the listed labels', () => {
        const matched = matchNodes({ type: 'labels', any: ['edge', 'dev'], all: [] }, nodes, labels);
        expect(matched.map(n => n.name)).toEqual(['alpha', 'gamma']);
    });

    it('requires every label for all', () => {
        const matched = matchNodes({ type: 'labels', any: [], all: ['prod', 'edge'] }, nodes, labels);
        expect(matched.map(n => n.name)).toEqual(['alpha']);
    });

    it('applies both lists together', () => {
        const matched = matchNodes({ type: 'labels', any: ['edge'], all: ['prod'] }, nodes, labels);
        expect(matched.map(n => n.name)).toEqual(['alpha']);
    });

    it('matches nothing when no label is chosen', () => {
        expect(matchNodes({ type: 'labels', any: [], all: [] }, nodes, labels)).toEqual([]);
    });

    it('matches chosen nodes by id', () => {
        expect(matchNodes({ type: 'nodes', ids: [3] }, nodes, labels).map(n => n.name)).toEqual(['gamma']);
    });

    it('sees a staged label before it is written', () => {
        const staged = [{ nodeId: 3, label: 'prod' }];
        const matched = matchNodes({ type: 'labels', any: ['prod'], all: [] }, nodes, withStagedLabels(labels, staged));
        expect(matched.map(n => n.name)).toEqual(['alpha', 'beta', 'gamma']);
        expect(labels[3]).toEqual(['dev']);
    });
});

describe('label helpers', () => {
    it('lists each label once, sorted', () => {
        expect(distinctLabels(labels)).toEqual(['dev', 'edge', 'prod']);
    });

    it('does not duplicate a label a node already has', () => {
        expect(withStagedLabels(labels, [{ nodeId: 1, label: 'prod' }])[1]).toEqual(['prod', 'edge']);
    });

    it.each([
        ['', 'Enter a label name'],
        ['has space', 'Use letters, digits, dot, dash or underscore'],
        ['x'.repeat(41), 'Use 40 characters or fewer'],
    ])('rejects %j', (input, message) => {
        expect(validateLabelName(input)).toBe(message);
    });

    it('accepts a normal label', () => {
        expect(validateLabelName(' prod-eu.1 ')).toBeNull();
    });
});

describe('writeStagedLabels', () => {
    beforeEach(() => vi.mocked(addNodeLabel).mockReset());

    const revision = (blueprintId: number) => ({ applicationId: `bp:${blueprintId}`, blueprintId });

    it('writes each label and counts other Blueprints that moved, not the new one', async () => {
        vi.mocked(addNodeLabel)
            .mockResolvedValueOnce({ nodeId: 2, label: 'prod', gitopsRevisions: [revision(7), revision(9)] } as never)
            .mockResolvedValueOnce({ nodeId: 3, label: 'prod', gitopsRevisions: [revision(7)] } as never);
        const result = await writeStagedLabels([{ nodeId: 2, label: 'prod' }, { nodeId: 3, label: 'prod' }], 9);
        expect(result.written).toHaveLength(2);
        expect(result.failed).toEqual([]);
        expect(result.movedOthers).toBe(1);
    });

    it('keeps going after a failure and reports it', async () => {
        vi.mocked(addNodeLabel)
            .mockRejectedValueOnce(new Error('nodes can have at most 50 labels'))
            .mockResolvedValueOnce({ nodeId: 3, label: 'prod', gitopsRevisions: [] } as never);
        const result = await writeStagedLabels([{ nodeId: 2, label: 'prod' }, { nodeId: 3, label: 'prod' }], null);
        expect(result.written).toEqual([{ nodeId: 3, label: 'prod' }]);
        expect(result.failed).toEqual([{ nodeId: 2, label: 'prod', message: 'nodes can have at most 50 labels' }]);
    });
});

describe('describeStagedWrite', () => {
    it('says nothing when nothing was staged', () => {
        expect(describeStagedWrite({ written: [], failed: [], movedOthers: 0 })).toBeNull();
    });

    it('reports labels added and other Blueprints moved', () => {
        const notice = describeStagedWrite({ written: [{ nodeId: 1, label: 'prod' }], failed: [], movedOthers: 2 });
        expect(notice).toEqual({ tone: 'success', message: 'Added 1 node label. 2 other blueprints re-placed.' });
    });

    it('warns with the first failure when some labels did not land', () => {
        const notice = describeStagedWrite({
            written: [{ nodeId: 1, label: 'prod' }],
            failed: [{ nodeId: 2, label: 'prod', message: 'nodes can have at most 50 labels' }],
            movedOthers: 0,
        });
        expect(notice?.tone).toBe('warning');
        expect(notice?.message).toBe('Added 1 of 2 node labels. nodes can have at most 50 labels. Edit the Blueprint to add the rest.');
    });
});

describe('stagedInUse', () => {
    const staged = [{ nodeId: 2, label: 'edge' }, { nodeId: 3, label: 'dev' }];

    it('keeps only the staged labels the selector uses', () => {
        expect(stagedInUse(staged, { type: 'labels', any: ['edge'], all: [] })).toEqual([{ nodeId: 2, label: 'edge' }]);
        expect(stagedInUse(staged, { type: 'labels', any: [], all: ['dev', 'edge'] })).toEqual(staged);
    });

    it('drops every staged label under a node selector', () => {
        expect(stagedInUse(staged, { type: 'nodes', ids: [2] })).toEqual([]);
    });
});

describe('writeStagedLabels edge cases', () => {
    beforeEach(() => vi.mocked(addNodeLabel).mockReset());

    it('counts a label once when the response carries no revisions', async () => {
        vi.mocked(addNodeLabel).mockResolvedValueOnce({ nodeId: 2, label: 'prod' } as never);
        const result = await writeStagedLabels([{ nodeId: 2, label: 'prod' }], null);
        expect(result.written).toHaveLength(1);
        expect(result.failed).toEqual([]);
    });
});

describe('label map shapes', () => {
  it('adds a staged label for a node the map has no entry for', () => {
    expect(withStagedLabels({}, [{ nodeId: 2, label: 'x' }])).toEqual({ 2: ['x'] });
  });

  it('treats an emptied compound draft as empty', () => {
    expect(isDraftEmpty({ type: 'labels', labels: [], mode: 'any', compound: { any: [], all: [] }, nodeIds: [] })).toBe(true);
    expect(isDraftEmpty({ type: 'labels', labels: [], mode: 'any', compound: { any: [], all: ['x'] }, nodeIds: [] })).toBe(false);
  });

  it('ignores revisions that name no Blueprint when counting what moved', async () => {
    vi.mocked(addNodeLabel).mockReset();
    vi.mocked(addNodeLabel).mockResolvedValueOnce({
      nodeId: 2, label: 'x',
      gitopsRevisions: [{ applicationId: null, blueprintId: 7 }, { applicationId: 'bp:7', blueprintId: null }],
    } as never);
    const result = await writeStagedLabels([{ nodeId: 2, label: 'x' }], null);
    expect(result.movedOthers).toBe(0);
  });
});
