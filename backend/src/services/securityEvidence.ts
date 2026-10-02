/**
 * Canonical security-evidence contract.
 *
 * One vocabulary for "what did the scanner actually manage to find out, and how
 * old is that answer", shared by the deploy gate, the Security posture, the
 * pre-deploy advisory and (later) Update Readiness. Before this module each
 * surface carried its own approximation of the same idea, and a source that
 * could not evaluate its target was indistinguishable from a source that
 * evaluated it and found nothing. That conflation is the defect this file exists
 * to make impossible: a positive safety claim requires `current`, and only
 * `current`.
 *
 * Two rules are encoded as named predicates rather than left to call sites,
 * because both are safety-relevant and easy to get backwards:
 *
 * - `carriesFindings` - findings in this state are real and may still block. A
 *   stale scan still reports what it found. Discarding stale findings would
 *   lower reported risk, which is the opposite of the point.
 * - `supportsCleanClaim` - the evidence is fresh enough to support "this target
 *   is clean". Stale-clean is not clean; it is unproven.
 *
 * The module is pure: no service imports, no clock, no I/O. Every classifier
 * takes `now` so the freshness boundary is testable rather than sampled.
 */

/**
 * The eight evidence states. `current` is the only one that authorizes a clean
 * claim; every other value means the answer is absent, incomplete, old, or was
 * never obtainable.
 */
export const SECURITY_EVIDENCE_STATES = [
    'current',
    'stale',
    'unavailable',
    'failed',
    'partial',
    'unsupported',
    'not_evaluated',
    'unknown',
] as const;

export type SecurityEvidenceState = (typeof SECURITY_EVIDENCE_STATES)[number];

/**
 * The sources a policy may name as required evidence.
 *
 * The full set is declared up front even though only `scanner_availability` and
 * `vulnerability_scan` are populated today, for two reasons. A decision record
 * names the sources its policy required, so the enum is part of a persisted
 * shape and widening it once here is cheaper than reshaping stored records
 * three times. And a consumer on a node too old to report a field needs to be
 * able to say `unsupported` about it, which requires the name to exist.
 *
 * `image_trust` is the one member with no producer at all: signatures,
 * provenance and admission land with the trust-admission work, and this contract
 * reserves the slot rather than shipping a setting nothing fills.
 */
export const SECURITY_EVIDENCE_SOURCES = [
    'scanner_availability',
    'vulnerability_scan',
    'vulnerability_database',
    'exploit_intelligence',
    'image_exposure_map',
    'image_trust',
] as const;

export type SecurityEvidenceSource = (typeof SECURITY_EVIDENCE_SOURCES)[number];

/** What an operator-configured rule decided to do about one evidence state. */
export type EvidenceAvailabilityOutcome = 'allow' | 'warn' | 'block';

/**
 * One source's verdict about one target.
 *
 * `collectedAt` and `freshnessThresholdMs` are stored separately rather than
 * pre-summed into an expiry instant so the record stays legible to a reader and
 * so a consumer can recompute the boundary under a different `now`.
 */
export interface SecurityEvidenceRecord {
    source: SecurityEvidenceSource;
    state: SecurityEvidenceState;
    /** What the evidence describes: an image reference, `stack:<name>`, or `node`. */
    target: string;
    /** Epoch ms the evidence was produced, or null when nothing was produced. */
    collectedAt: number | null;
    /** The image digest this evidence is bound to, when it is digest-scoped. */
    digest?: string | null;
    /** The platform this evidence was produced for, when platform-scoped. */
    platform?: string | null;
    /** Age beyond which this evidence is `stale`, or null when no bound applies. */
    freshnessThresholdMs?: number | null;
    /** Always present when `state !== 'current'`; names the cause in one clause. */
    reason?: string;
}

/** What one rule decided about one record, for the decision record. */
export interface EvidenceRuleApplication {
    source: SecurityEvidenceSource;
    state: SecurityEvidenceState;
    outcome: EvidenceAvailabilityOutcome;
    /** The configured rule that produced `outcome`, as an audit-readable clause. */
    rule: string;
    /**
     * The target this application is about, when it is about one. Present so a
     * multi-image stack does not produce several indistinguishable rows in the
     * block dialog, and so a reader can tell which image the rule acted on.
     * Absent for a node-wide source such as scanner availability.
     */
    target?: string;
}

/**
 * The evidence half of a gate decision: every source the policy required, what
 * each one actually said, and which rule turned that into an outcome.
 */
export interface EvidenceGateDecision {
    /** The most restrictive outcome any required source produced. */
    outcome: EvidenceAvailabilityOutcome;
    records: SecurityEvidenceRecord[];
    applications: EvidenceRuleApplication[];
    /** One sentence naming why, safe to show an operator verbatim. */
    summary: string;
}

const AUTHORITATIVE_STATES: ReadonlySet<SecurityEvidenceState> = new Set<SecurityEvidenceState>(['current']);
const FINDING_BEARING_STATES: ReadonlySet<SecurityEvidenceState> = new Set<SecurityEvidenceState>(['current', 'stale']);

/**
 * Whether evidence in this state may support a positive safety claim. True only
 * for `current`: `stale`, `partial`, and everything else are unproven, not safe.
 */
export function supportsCleanClaim(state: SecurityEvidenceState): boolean {
    return AUTHORITATIVE_STATES.has(state);
}

/**
 * Whether findings in this state are real enough to keep blocking. True for
 * `stale` as well as `current`, because a stale scan's findings do not expire.
 */
export function carriesFindings(state: SecurityEvidenceState): boolean {
    return FINDING_BEARING_STATES.has(state);
}

/** Order for combining several outcomes into one, most restrictive last. */
const OUTCOME_SEVERITY: Readonly<Record<EvidenceAvailabilityOutcome, number>> = {
    allow: 0,
    warn: 1,
    block: 2,
};

export function mostRestrictiveOutcome(
    outcomes: readonly EvidenceAvailabilityOutcome[],
): EvidenceAvailabilityOutcome {
    let worst: EvidenceAvailabilityOutcome = 'allow';
    for (const outcome of outcomes) {
        if (OUTCOME_SEVERITY[outcome] > OUTCOME_SEVERITY[worst]) worst = outcome;
    }
    return worst;
}

/** Human-facing name for one state, used in alerts, summaries and the UI. */
export function describeEvidenceState(state: SecurityEvidenceState): string {
    switch (state) {
        case 'current':
            return 'Current';
        case 'stale':
            return 'Stale';
        case 'unavailable':
            return 'Unavailable';
        case 'failed':
            return 'Failed';
        case 'partial':
            return 'Partial';
        case 'unsupported':
            return 'Unsupported';
        case 'not_evaluated':
            return 'Not evaluated';
        case 'unknown':
            return 'Unknown';
    }
}

export interface ScanEvidenceInput {
    now: number;
    /** Epoch ms the scan ran, or null when the scan was never evaluated. */
    collectedAt: number | null;
    /** Age beyond which the scan is stale, or null when no bound is configured. */
    freshnessThresholdMs: number | null;
    /** True when the scanner ran and failed. */
    failed?: boolean;
    /** Cause to report when `failed`. */
    failureReason?: string;
}

/**
 * Classify one vulnerability scan's evidence.
 *
 * Order matters and is the point of the function: a failed scan is `failed`
 * whatever its timestamp, an unrun scan is `not_evaluated`, and only a scan that
 * actually completed can be `current` or `stale`. A caller that cannot produce a
 * timestamp must never be able to reach `current` by omission.
 */
export function classifyScanEvidence(input: ScanEvidenceInput): Pick<SecurityEvidenceRecord, 'state' | 'reason'> {
    if (input.failed) {
        return { state: 'failed', reason: input.failureReason ?? 'The scan did not complete' };
    }
    if (input.collectedAt === null) {
        return { state: 'not_evaluated', reason: 'The scan has not been evaluated' };
    }
    const ageMs = input.now - input.collectedAt;
    if (ageMs < 0) {
        // A collection time in the future means the two clocks disagree, so the
        // age is unknown rather than zero. Reading it as `current` would let
        // skew manufacture a clean claim, which is the exact failure this
        // contract exists to prevent.
        return {
            state: 'unknown',
            reason: 'The scan is timestamped in the future, so its age cannot be determined',
        };
    }
    const threshold = input.freshnessThresholdMs;
    if (threshold === null) {
        return { state: 'current' };
    }
    if (ageMs > threshold) {
        const ageDays = Math.floor(ageMs / 86_400_000);
        return {
            state: 'stale',
            reason: ageDays >= 1
                ? `The scan is ${ageDays} day(s) old, past the configured ${Math.floor(threshold / 86_400_000)} day limit`
                : 'The scan is past the configured freshness limit',
        };
    }
    return { state: 'current' };
}

/**
 * Classify scanner availability. A scanner that is not installed or not
 * responding produced no answer at all, which is `unavailable` rather than
 * `failed`: nothing ran, so there is no run to have failed.
 */
export function classifyScannerEvidence(input: {
    available: boolean;
    collectedAt: number | null;
    reason?: string;
}): Pick<SecurityEvidenceRecord, 'state' | 'reason'> {
    if (input.available) {
        return { state: 'current' };
    }
    return { state: 'unavailable', reason: input.reason ?? 'The vulnerability scanner is not available on this node' };
}

/** One legacy vocabulary and how its values land on the eight states. */
export interface LegacyVocabularyMapping {
    /** Owning module, so a reader can find the type. */
    readonly vocabulary: string;
    /** Literal values in that vocabulary. */
    readonly values: Readonly<Record<string, SecurityEvidenceState>>;
}

/**
 * How the six pre-existing status vocabularies map onto the eight states.
 *
 * This table is the reason the contract is a single enum rather than one per
 * surface. Each row replaces a local union that answered the same question
 * slightly differently; keeping the mapping here (rather than leaving each
 * reader to guess) is what stops a seventh approximation appearing.
 *
 * `not_evaluated` and `unsupported` had no counterpart anywhere before this
 * module: no existing union could express "we never tried" separately from "we
 * tried and it broke", which is precisely how an absent answer came to read as
 * a clean one.
 */
export const LEGACY_VOCABULARY_MAPPINGS: readonly LegacyVocabularyMapping[] = [
    {
        vocabulary: 'VulnScanStatus (vulnerability_scans.status)',
        values: {
            in_progress: 'not_evaluated',
            // `completed` is `current` only while it is inside the freshness
            // bound; an old completed scan is `stale`. Age is a classifier input,
            // not a property of the status, which is why it is not a state here.
            completed: 'current',
            failed: 'failed',
        },
    },
    {
        vocabulary: 'stack_scan_attempts.status',
        values: {
            ok: 'current',
            partial: 'partial',
            failed: 'failed',
            skipped: 'unavailable',
        },
    },
    {
        vocabulary: 'DomainState (readiness)',
        values: {
            attention: 'current',
            degraded: 'stale',
            unavailable: 'unavailable',
            unknown: 'unknown',
            healthy: 'current',
        },
    },
    {
        vocabulary: 'ObservedArtifactIdentity (GitOps artifact identity)',
        values: {
            exact: 'current',
            qualified: 'partial',
            stale: 'stale',
            unavailable: 'unavailable',
            missing: 'not_evaluated',
            unknown: 'unknown',
            local_build_unverified: 'not_evaluated',
        },
    },
    {
        vocabulary: 'ArtifactServiceFailureClass (GitOps artifact resolution)',
        values: {
            unresolved: 'not_evaluated',
            registry_unavailable: 'unavailable',
            credential_failure: 'unavailable',
            unsupported_registry: 'unsupported',
            platform_ambiguity: 'unknown',
            digest_unavailable: 'unavailable',
            stale_resolution: 'stale',
        },
    },
    {
        vocabulary: 'HealthGateStatus (health gate runs)',
        values: {
            observing: 'not_evaluated',
            passed: 'current',
            failed: 'failed',
            unknown: 'unknown',
        },
    },
];

/**
 * One sentence naming every rule that acted, safe to show an operator verbatim.
 *
 * Split out from `decideEvidenceGate` because a caller may add an application
 * of its own and set the outcome the caller actually reached. Folding the new
 * applications in without rebuilding the sentence would leave the summary
 * describing the pre-override decision, so the two fields of the same object
 * would disagree.
 */
export function summarizeEvidenceApplications(
  applications: readonly EvidenceRuleApplication[],
): string {
  return applications.length === 0
    ? 'No security evidence was required for this decision'
    : applications
        .map((a) => `${describeEvidenceState(a.state)} evidence for ${a.source}: ${a.outcome} (${a.rule})`)
        .join('; ');
}

/**
 * Fold every application into one decision. Pure, so the worst-case-wins rule
 * and the summary sentence are unit-testable without a gate, a database, or a
 * clock.
 */
export function decideEvidenceGate(
    records: readonly SecurityEvidenceRecord[],
    applications: readonly EvidenceRuleApplication[],
): EvidenceGateDecision {
    const outcome = mostRestrictiveOutcome(applications.map((a) => a.outcome));
    return { outcome, records: [...records], applications: [...applications], summary: summarizeEvidenceApplications(applications) };
}
