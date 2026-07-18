import { describe, it, expect } from 'vitest';
import {
    intentFingerprint,
    parseApprovedBlastJson,
    serializeApprovedBlast,
    deriveBlastFromConfirmableActions,
    evaluateEffectiveApproval,
    isActionAuthorized,
    outcomeForConfirmableAction,
    filterAuthorizedExecutorActions,
    confirmableActionsEqual,
    parseConfirmableActionsBody,
    type PreviewAction,
} from '../services/blueprintApproval';
import type { Blueprint } from '../services/DatabaseService';

function baseBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
    return {
        id: 1,
        name: 'web',
        description: null,
        compose_content: 'services:\n  web:\n    image: nginx\n',
        selector: { type: 'nodes', ids: [1] },
        drift_mode: 'suggest',
        classification: 'stateless',
        classification_reasons: [],
        enabled: true,
        revision: 1,
        created_at: 0,
        updated_at: 0,
        created_by: 'admin',
        pinned_node_id: null,
        approval_status: 'pending',
        approved_intent_fingerprint: null,
        approved_blast_json: null,
        approved_at: null,
        approved_by: null,
        ...overrides,
    };
}

describe('blueprintApproval matrix', () => {
    it('maps clear_stale_guard to remove and clear_reversed_evict to place', () => {
        expect(outcomeForConfirmableAction('clear_stale_guard')).toBe('remove');
        expect(outcomeForConfirmableAction('clear_reversed_evict')).toBe('place');
    });

    it('authorizes place for create/update/check and never remove', () => {
        expect(isActionAuthorized('place', 'create')).toBe(true);
        expect(isActionAuthorized('place', 'update')).toBe(true);
        expect(isActionAuthorized('place', 'check_enforce')).toBe(true);
        expect(isActionAuthorized('place', 'remove')).toBe(false);
        expect(isActionAuthorized('place', 'clear_stale_guard')).toBe(false);
        expect(isActionAuthorized('place', 'in_flight_deploy')).toBe(false);
    });

    it('authorizes remove for remove/await_evict/clear_stale and never create', () => {
        expect(isActionAuthorized('remove', 'remove')).toBe(true);
        expect(isActionAuthorized('remove', 'await_evict_confirm')).toBe(true);
        expect(isActionAuthorized('remove', 'clear_stale_guard')).toBe(true);
        expect(isActionAuthorized('remove', 'create')).toBe(false);
        expect(isActionAuthorized('remove', 'clear_reversed_evict')).toBe(false);
    });
});

describe('blast JSON', () => {
    it('round-trips canonical sorted blast', () => {
        const json = serializeApprovedBlast([
            { nodeId: 3, outcome: 'remove' },
            { nodeId: 1, outcome: 'place' },
        ]);
        const parsed = parseApprovedBlastJson(json);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.entries).toEqual([
            { nodeId: 1, outcome: 'place' },
            { nodeId: 3, outcome: 'remove' },
        ]);
    });

    it('rejects unknown keys and non-canonical order without mutating', () => {
        expect(parseApprovedBlastJson('[{"nodeId":1,"outcome":"place","extra":1}]').ok).toBe(false);
        expect(parseApprovedBlastJson('[{"nodeId":2,"outcome":"place"},{"nodeId":1,"outcome":"place"}]').ok).toBe(false);
        expect(parseApprovedBlastJson('not-json').ok).toBe(false);
    });

    it('derives place/remove from confirmable actions', () => {
        const blast = deriveBlastFromConfirmableActions([
            { nodeId: 1, action: 'create' },
            { nodeId: 2, action: 'clear_stale_guard' },
            { nodeId: 3, action: 'skip_cordoned' },
        ]);
        expect(blast).toEqual([
            { nodeId: 1, outcome: 'place' },
            { nodeId: 2, outcome: 'remove' },
        ]);
    });
});

describe('evaluateEffectiveApproval', () => {
    it('returns pending when approval is missing or fingerprint drifts', () => {
        const bp = baseBlueprint();
        const fp = intentFingerprint(bp);
        expect(evaluateEffectiveApproval(bp, [{ nodeId: 1, action: 'create' }]).effectiveApproval).toBe('pending');

        const approved = baseBlueprint({
            approval_status: 'approved',
            approved_intent_fingerprint: fp,
            approved_blast_json: serializeApprovedBlast([{ nodeId: 1, outcome: 'place' }]),
        });
        expect(evaluateEffectiveApproval(approved, [{ nodeId: 1, action: 'create' }]).effectiveApproval).toBe('approved');

        const renamed = { ...approved, name: 'renamed' };
        expect(evaluateEffectiveApproval(renamed, [{ nodeId: 1, action: 'create' }]).effectiveApproval).toBe('pending');
    });

    it('returns reapproval_required when a new node needs place without blast entry', () => {
        const bp = baseBlueprint();
        const fp = intentFingerprint(bp);
        const approved = baseBlueprint({
            approval_status: 'approved',
            approved_intent_fingerprint: fp,
            approved_blast_json: serializeApprovedBlast([{ nodeId: 1, outcome: 'place' }]),
        });
        const result = evaluateEffectiveApproval(approved, [
            { nodeId: 1, action: 'check_observe' },
            { nodeId: 2, action: 'create' },
        ]);
        expect(result.effectiveApproval).toBe('reapproval_required');
        expect(result.unauthorizedActions).toEqual([{ nodeId: 2, action: 'create' }]);
    });

    it('malformed blast reads as pending', () => {
        const bp = baseBlueprint({
            approval_status: 'approved',
            approved_intent_fingerprint: intentFingerprint(baseBlueprint()),
            approved_blast_json: '[{bad',
        });
        expect(evaluateEffectiveApproval(bp, [{ nodeId: 1, action: 'create' }]).effectiveApproval).toBe('pending');
    });

    it('filters executor actions by matrix and never keeps informational', () => {
        const blast = [{ nodeId: 1, outcome: 'place' as const }];
        const filtered = filterAuthorizedExecutorActions(blast, [
            { nodeId: 1, action: 'create' },
            { nodeId: 1, action: 'in_flight_deploy' as PreviewAction },
            { nodeId: 1, action: 'remove' },
        ]);
        expect(filtered).toEqual([{ nodeId: 1, action: 'create' }]);
    });
});

describe('confirm body parse', () => {
    it('accepts equal confirmable sets regardless of order', () => {
        const a = [{ nodeId: 2, action: 'remove' as const }, { nodeId: 1, action: 'create' as const }];
        const b = [{ nodeId: 1, action: 'create' as const }, { nodeId: 2, action: 'remove' as const }];
        expect(confirmableActionsEqual(a, b)).toBe(true);
    });

    it('rejects invalid POST bodies', () => {
        expect(parseConfirmableActionsBody(null).ok).toBe(false);
        expect(parseConfirmableActionsBody([{ nodeId: 1, action: 'nope' }]).ok).toBe(false);
        expect(parseConfirmableActionsBody([{ nodeId: 1, action: 'create', extra: 1 }]).ok).toBe(false);
    });
});
