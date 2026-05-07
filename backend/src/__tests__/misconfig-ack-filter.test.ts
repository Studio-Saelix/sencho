/**
 * Unit tests for the read-time misconfig acknowledgement filter.
 *
 * Mirrors the structure of suppression-filter.test.ts. The matching dimension
 * is `rule_id` plus an optional `stack_pattern` glob; ack reasons must never
 * be reported as a separate failure mode.
 */
import { describe, it, expect } from 'vitest';
import {
    applyMisconfigAcknowledgements,
    findMisconfigAcknowledgement,
} from '../utils/misconfig-ack-filter';
import type { MisconfigAcknowledgement } from '../services/DatabaseService';

const NOW = 1_700_000_000_000;

function makeAck(overrides: Partial<MisconfigAcknowledgement> = {}): MisconfigAcknowledgement {
    return {
        id: 1,
        rule_id: 'DS002',
        stack_pattern: null,
        reason: 'traefik legitimately needs root',
        created_by: 'admin',
        created_at: NOW - 1000,
        expires_at: null,
        replicated_from_control: 0,
        ...overrides,
    };
}

describe('findMisconfigAcknowledgement', () => {
    it('returns null when no ack exists for the rule', () => {
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS099' },
            'web',
            [makeAck({ rule_id: 'DS002' })],
            NOW,
        );
        expect(match).toBeNull();
    });

    it('matches a fleet-wide ack (null stack_pattern)', () => {
        const a = makeAck({ id: 42 });
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'web',
            [a],
            NOW,
        );
        expect(match?.id).toBe(42);
    });

    it('matches a stack-pinned ack against the exact stack name', () => {
        const a = makeAck({ id: 7, stack_pattern: 'traefik' });
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'traefik',
            [a],
            NOW,
        );
        expect(match?.id).toBe(7);
    });

    it('matches a stack-pinned ack with a glob', () => {
        const a = makeAck({ id: 9, stack_pattern: 'traefik-*' });
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'traefik-prod',
            [a],
            NOW,
        );
        expect(match?.id).toBe(9);
    });

    it('does not match a stack-pinned ack against a different stack', () => {
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'web',
            [makeAck({ stack_pattern: 'traefik' })],
            NOW,
        );
        expect(match).toBeNull();
    });

    it('does not match a stack-pinned ack against a null stack context (image scan)', () => {
        // Image scans have no stack_context. A stack-scoped ack should not
        // bleed into image-scan results.
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            null,
            [makeAck({ stack_pattern: 'traefik' })],
            NOW,
        );
        expect(match).toBeNull();
    });

    it('matches a fleet-wide ack against a null stack context', () => {
        const a = makeAck({ stack_pattern: null });
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            null,
            [a],
            NOW,
        );
        expect(match).toBeTruthy();
    });

    it('ignores expired acks', () => {
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'web',
            [makeAck({ expires_at: NOW - 1 })],
            NOW,
        );
        expect(match).toBeNull();
    });

    it('matches non-expired acks (expires_at strictly in the future)', () => {
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'web',
            [makeAck({ expires_at: NOW + 1 })],
            NOW,
        );
        expect(match).toBeTruthy();
    });

    it('prefers a stack-pinned ack over a fleet-wide ack', () => {
        const fleetWide = makeAck({ id: 1, stack_pattern: null });
        const pinned = makeAck({ id: 2, stack_pattern: 'web' });
        const match = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'web',
            [fleetWide, pinned],
            NOW,
        );
        expect(match?.id).toBe(2);
    });

    it('escapes regex special chars in stack_pattern before glob expansion', () => {
        // A stack named "v1.0" should NOT be matched by pattern "v1.0" because
        // the dot in the pattern is treated literally, not as ".any char". This
        // confirms regex escape happens before * gets expanded to .*.
        const a = makeAck({ stack_pattern: 'v1.0' });
        const exact = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'v1.0',
            [a],
            NOW,
        );
        expect(exact?.id).toBe(1);

        const cheating = findMisconfigAcknowledgement(
            { rule_id: 'DS002' },
            'v1X0',
            [a],
            NOW,
        );
        expect(cheating).toBeNull();
    });
});

describe('applyMisconfigAcknowledgements', () => {
    it('returns an empty array unchanged', () => {
        expect(applyMisconfigAcknowledgements([], 'web', [makeAck()], NOW)).toEqual([]);
    });

    it('marks matched findings as acknowledged with id and reason', () => {
        const findings = [
            { rule_id: 'DS002', target: 'docker-compose.yml' },
            { rule_id: 'DS099', target: 'docker-compose.yml' },
        ];
        const out = applyMisconfigAcknowledgements(
            findings,
            'web',
            [makeAck({ id: 11, reason: 'accepted by sec team' })],
            NOW,
        );
        expect(out[0].acknowledged).toBe(true);
        expect(out[0].acknowledgement_id).toBe(11);
        expect(out[0].acknowledgement_reason).toBe('accepted by sec team');
        expect(out[1].acknowledged).toBe(false);
    });

    it('does not mutate inputs', () => {
        const findings = [{ rule_id: 'DS002', target: 'docker-compose.yml' }];
        const acks = [makeAck()];
        const out = applyMisconfigAcknowledgements(findings, 'web', acks, NOW);
        expect(out[0]).not.toBe(findings[0]);
        expect((findings[0] as Record<string, unknown>).acknowledged).toBeUndefined();
    });

    it('amortises bucketing across many findings (perf smoke test)', () => {
        // 5000 acks across 200 unique rules x ~25 each, then 2000 findings.
        // Each finding's lookup must be O(matching-rule-acks), not O(all-acks).
        const acks: MisconfigAcknowledgement[] = [];
        for (let i = 0; i < 5000; i++) {
            const ruleIdx = i % 200;
            acks.push(makeAck({
                id: i + 1,
                rule_id: `DS${String(ruleIdx).padStart(3, '0')}`,
                stack_pattern: i % 5 === 0 ? null : `stack-${i % 50}`,
            }));
        }
        const findings: Array<{ rule_id: string; target: string }> = [];
        for (let j = 0; j < 2000; j++) {
            findings.push({
                rule_id: `DS${String(j % 250).padStart(3, '0')}`,
                target: 'docker-compose.yml',
            });
        }
        const t0 = Date.now();
        const out = applyMisconfigAcknowledgements(findings, 'stack-3', acks, NOW);
        const elapsed = Date.now() - t0;
        // Generous bound; the real win is amortised bucketing, not raw speed.
        expect(elapsed).toBeLessThan(1500);
        expect(out.length).toBe(findings.length);
    });
});
