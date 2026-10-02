/**
 * The evidence vocabulary and its availability policy. Both are pure, so the
 * rules that matter most are asserted directly: which states may authorize a
 * clean claim, which findings still count, and what the shipped defaults are.
 */
import { describe, it, expect } from 'vitest';
import {
    SECURITY_EVIDENCE_SOURCES,
    SECURITY_EVIDENCE_STATES,
    LEGACY_VOCABULARY_MAPPINGS,
    carriesFindings,
    classifyScanEvidence,
    classifyScannerEvidence,
    decideEvidenceGate,
    describeEvidenceState,
    mostRestrictiveOutcome,
    supportsCleanClaim,
    type SecurityEvidenceRecord,
    type SecurityEvidenceState,
} from '../services/securityEvidence';
import {
    DEFAULT_SECURITY_EVIDENCE_POLICY,
    resolveSecurityEvidencePolicy,
    serializeSecurityEvidencePolicy,
} from '../services/securityEvidencePolicy';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe('evidence states', () => {
    it('declares exactly the eight states the contract requires', () => {
        expect([...SECURITY_EVIDENCE_STATES].sort()).toEqual(
            ['current', 'failed', 'not_evaluated', 'partial', 'stale', 'unavailable', 'unknown', 'unsupported'].sort(),
        );
    });

    it('authorizes a clean claim only from current evidence', () => {
        const authorizing = SECURITY_EVIDENCE_STATES.filter(supportsCleanClaim);
        expect(authorizing).toEqual(['current']);
    });

    it('keeps stale findings blocking while refusing them as a clean claim', () => {
        // The asymmetry is deliberate: a stale scan still found what it found,
        // but its silence proves nothing.
        expect(carriesFindings('stale')).toBe(true);
        expect(supportsCleanClaim('stale')).toBe(false);
    });

    it('drops findings for every state where the source could not evaluate the target', () => {
        for (const state of ['unavailable', 'failed', 'partial', 'unsupported', 'not_evaluated', 'unknown'] as const) {
            expect(carriesFindings(state)).toBe(false);
        }
    });

    it('names every state, so a record can never surface as an empty label', () => {
        for (const state of SECURITY_EVIDENCE_STATES) {
            expect(describeEvidenceState(state)).toMatch(/\S/);
        }
    });
});

describe('classifyScanEvidence', () => {
    it('reports a failed scan as failed regardless of its timestamp', () => {
        expect(
            classifyScanEvidence({
                now: NOW,
                collectedAt: NOW,
                freshnessThresholdMs: null,
                failed: true,
                failureReason: 'the scan process crashed',
            }),
        ).toEqual({ state: 'failed', reason: 'the scan process crashed' });
    });

    it('never reaches current when there is no collection time', () => {
        // The absence of a timestamp must not be readable as a fresh answer.
        expect(classifyScanEvidence({ now: NOW, collectedAt: null, freshnessThresholdMs: null }).state).toBe(
            'not_evaluated',
        );
    });

    it('treats a scan with no configured bound as current however old it is', () => {
        expect(
            classifyScanEvidence({ now: NOW, collectedAt: NOW - 400 * DAY, freshnessThresholdMs: null }).state,
        ).toBe('current');
    });

    it('reports a scan past its bound as stale and names the age', () => {
        const result = classifyScanEvidence({ now: NOW, collectedAt: NOW - 9 * DAY, freshnessThresholdMs: 7 * DAY });
        expect(result.state).toBe('stale');
        expect(result.reason).toContain('9 day(s) old');
    });

    it('keeps a scan exactly at its bound current, and only beyond it stale', () => {
        expect(classifyScanEvidence({ now: NOW, collectedAt: NOW - 7 * DAY, freshnessThresholdMs: 7 * DAY }).state).toBe(
            'current',
        );
        expect(classifyScanEvidence({ now: NOW, collectedAt: NOW - 7 * DAY - 1, freshnessThresholdMs: 7 * DAY }).state).toBe(
            'stale',
        );
    });

    it('reports a scan timestamped in the future as unknown, never current', () => {
        // Clock skew between the scanning node and the reader must not be able to
        // manufacture a clean claim. `unknown` is the honest answer: the age
        // cannot be determined. Asserting the reason too, so deleting the branch
        // cannot silently fall through to `current` and still pass.
        const result = classifyScanEvidence({
            now: NOW,
            collectedAt: NOW + 5 * DAY,
            freshnessThresholdMs: 7 * DAY,
        });
        expect(result.state).toBe('unknown');
        expect(result.reason).toContain('future');
    });

    it('reports a future timestamp as unknown even with no freshness bound', () => {
        // The bound is not what makes this unknowable, so a null bound must not
        // short-circuit the check.
        expect(
            classifyScanEvidence({ now: NOW, collectedAt: NOW + 1, freshnessThresholdMs: null }).state,
        ).toBe('unknown');
    });

    it('describes a sub-day stale scan without inventing a day count', () => {
        const result = classifyScanEvidence({ now: NOW, collectedAt: NOW - 3_600_000, freshnessThresholdMs: 60_000 });
        expect(result.state).toBe('stale');
        expect(result.reason).toBe('The scan is past the configured freshness limit');
    });
});

describe('classifyScannerEvidence', () => {
    it('reports an installed scanner as current', () => {
        expect(classifyScannerEvidence({ available: true, collectedAt: NOW })).toEqual({ state: 'current' });
    });

    it('reports a missing scanner as unavailable, not failed', () => {
        // Nothing ran, so there is no run to have failed.
        expect(classifyScannerEvidence({ available: false, collectedAt: null }).state).toBe('unavailable');
    });
});

describe('legacy vocabulary mapping', () => {
    it('declares every source as a known name, with no duplicates', () => {
        expect([...SECURITY_EVIDENCE_SOURCES].sort()).toEqual(
            [
                'exploit_intelligence',
                'image_exposure_map',
                'image_trust',
                'scanner_availability',
                'vulnerability_database',
                'vulnerability_scan',
            ].sort(),
        );
    });

    it('maps only to declared states', () => {
        const known = new Set<string>(SECURITY_EVIDENCE_STATES);
        for (const entry of LEGACY_VOCABULARY_MAPPINGS) {
            for (const [value, state] of Object.entries(entry.values)) {
                expect(known.has(state), `${entry.vocabulary}.${value} -> ${state}`).toBe(true);
            }
        }
    });

    it('gives not_evaluated and unsupported a home, the two states nothing previously had', () => {
        const allValues = LEGACY_VOCABULARY_MAPPINGS.flatMap((e) => Object.values(e.values));
        expect(allValues).toContain('not_evaluated');
        expect(allValues).toContain('unsupported');
    });

    it('maps skipped scan attempts to unavailable rather than to a pass', () => {
        const attempts = LEGACY_VOCABULARY_MAPPINGS.find((e) => e.vocabulary.startsWith('stack_scan_attempts'));
        expect(attempts?.values.skipped).toBe('unavailable');
        expect(attempts?.values.partial).toBe('partial');
    });
});

describe('decideEvidenceGate', () => {
    const record = (state: SecurityEvidenceState): SecurityEvidenceRecord => ({
        source: 'vulnerability_scan',
        state,
        target: 'nginx:1.27',
        collectedAt: NOW,
    });

    it('takes the most restrictive outcome when several sources disagree', () => {
        const decision = decideEvidenceGate([record('current'), record('stale')], [
            { source: 'vulnerability_scan', state: 'current', outcome: 'allow', rule: 'a=allow' },
            { source: 'vulnerability_scan', state: 'stale', outcome: 'warn', rule: 'b=warn' },
        ]);
        expect(decision.outcome).toBe('warn');
    });

    it('lets a single block win over any number of allows', () => {
        expect(mostRestrictiveOutcome(['allow', 'allow', 'block', 'allow'])).toBe('block');
        expect(mostRestrictiveOutcome(['warn', 'warn', 'allow'])).toBe('warn');
        expect(mostRestrictiveOutcome([])).toBe('allow');
    });

    it('summarizes why, naming the state and the rule that produced the outcome', () => {
        const decision = decideEvidenceGate([record('unavailable')], [
            { source: 'scanner_availability', state: 'unavailable', outcome: 'allow', rule: 'security_scanner_unavailable=allow' },
        ]);
        expect(decision.summary).toContain('Unavailable');
        expect(decision.summary).toContain('security_scanner_unavailable=allow');
    });

    it('says plainly when no evidence was required', () => {
        expect(decideEvidenceGate([], []).summary).toBe('No security evidence was required for this decision');
    });
});

describe('resolveSecurityEvidencePolicy', () => {
    it('resolves to the values the gate hard-coded when nothing is configured', () => {
        // The deploy gate's equivalence to its previous hard-coded branches is
        // pinned by the 49 untouched tests in policy-enforcement.test.ts. The
        // candidate path's outcomes are unchanged as well, its one difference
        // being the reason string on a scanner-missing hold, pinned in
        // security-evidence-gate.test.ts.
        const policy = resolveSecurityEvidencePolicy({});
        expect(policy).toEqual(DEFAULT_SECURITY_EVIDENCE_POLICY);
        expect(policy.scannerUnavailable).toBe('allow');
        expect(policy.scanFailure).toBe('block');
        expect(policy.candidateUnproven).toBe('block');
    });

    it('falls back to the defaults on a null or absent settings read', () => {
        expect(resolveSecurityEvidencePolicy(null)).toEqual(DEFAULT_SECURITY_EVIDENCE_POLICY);
        expect(resolveSecurityEvidencePolicy(undefined)).toEqual(DEFAULT_SECURITY_EVIDENCE_POLICY);
    });

    it('ignores an unrecognized stored outcome rather than throwing on the deploy path', () => {
        const policy = resolveSecurityEvidencePolicy({ security_scanner_unavailable: 'nonsense' });
        expect(policy.scannerUnavailable).toBe('allow');
    });

    it('holds an unevaluable candidate by default, which is what the path did before it was configurable', () => {
        expect(DEFAULT_SECURITY_EVIDENCE_POLICY.candidateUnproven).toBe('block');
    });

    it('accepts every configured outcome on every field', () => {
        for (const outcome of ['allow', 'warn', 'block'] as const) {
            const policy = resolveSecurityEvidencePolicy({
                security_scanner_unavailable: outcome,
                security_scan_failure: outcome,
                security_candidate_unproven: outcome,
            });
            expect(policy.scannerUnavailable).toBe(outcome);
            expect(policy.scanFailure).toBe(outcome);
            expect(policy.candidateUnproven).toBe(outcome);
        }
    });

    it('keeps the candidate field independent of the deploy fields', () => {
        // The separation is the point: relaxing the interactive gate must not
        // relax the unattended acceptance path.
        const policy = resolveSecurityEvidencePolicy({
            security_scanner_unavailable: 'allow',
            security_scan_failure: 'allow',
        });
        expect(policy.candidateUnproven).toBe('block');
    });
});

describe('serializeSecurityEvidencePolicy', () => {
    it('reports the defaults as defaults', () => {
        expect(serializeSecurityEvidencePolicy(DEFAULT_SECURITY_EVIDENCE_POLICY)).toMatchObject({
            isDefault: true,
        });
    });

    it('reports any deviation from the default', () => {
        expect(
            serializeSecurityEvidencePolicy({ ...DEFAULT_SECURITY_EVIDENCE_POLICY, scannerUnavailable: 'block' }),
        ).toMatchObject({ isDefault: false, scannerUnavailable: 'block' });
    });

    it('reports a non-default candidate rule as a deviation', () => {
        expect(
            serializeSecurityEvidencePolicy({ ...DEFAULT_SECURITY_EVIDENCE_POLICY, candidateUnproven: 'allow' }),
        ).toMatchObject({ isDefault: false, candidateUnproven: 'allow' });
    });
});
