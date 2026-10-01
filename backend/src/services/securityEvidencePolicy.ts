/**
 * Evidence-availability policy: the operator's answer to "what may Sencho do
 * when it cannot prove a target is safe?"
 *
 * Instance-level and deliberately separate from `ScanPolicy`. A scan policy
 * describes what the evidence may say (which severities, KEV, fixability); this
 * describes whether there is any evidence to read. Folding the two together
 * would mean restating scanner availability on every policy card and would give
 * one setting two unrelated meanings.
 *
 * Every default here reproduces the behaviour the deploy gate had before this
 * module existed, branch for branch. That is the contract that makes the first
 * change safe to land: the gate reads a policy instead of an `if`, and an
 * operator who changes nothing gets byte-identical outcomes.
 *
 * A settings read failure resolves to these same defaults rather than to the
 * strictest value. The strictest reading of an unreadable policy is to refuse
 * every deploy, which turns a database hiccup into a locked-out operator; the
 * issue this serves is "an unavailable tool must not be an implicit clean pass",
 * and locking an operator out of deploying is a worse failure with the same
 * shape. The audit record names the resolved rule, so a fail-open decision is
 * still attributable.
 */
import type { EvidenceAvailabilityOutcome } from './securityEvidence';

export interface SecurityEvidencePolicy {
    /**
     * What to do when the scanner cannot run at all (not installed, not
     * responding). Default `allow`, because a missing tool must not
     * permanently lock an operator out of deploying.
     */
    scannerUnavailable: EvidenceAvailabilityOutcome;
    /**
     * What to do when a scan was attempted for an image and failed. Default
     * `block`: unlike an absent scanner, this is a real attempt that produced no
     * answer, and a transient failure should be retried rather than waved
     * through.
     */
    scanFailure: EvidenceAvailabilityOutcome;
    /**
     * What to do when a scan cannot be evaluated for a *candidate*: an image a
     * Git-managed source is about to accept without a person in the loop.
     *
     * Its own field rather than an inherited one, and it defaults to `block`
     * unlike the deploy gate's fail-open fields. Two reasons. The issue names
     * "candidate image not scanned" as a control in its own right, so the
     * operator can hold it stricter than an interactive deploy. And a setting an
     * operator relaxes to get past a scanner outage at the keyboard must not
     * silently become authority for an unattended automation to accept code
     * nothing proved safe.
     */
    candidateUnproven: EvidenceAvailabilityOutcome;
}

/**
 * The operator-visible default, and the value every unchanged installation
 * resolves to. Stated in the UI rather than hidden, so "why was this allowed"
 * always has an answer on screen.
 */
export const DEFAULT_SECURITY_EVIDENCE_POLICY: SecurityEvidencePolicy = {
    scannerUnavailable: 'allow',
    scanFailure: 'block',
    candidateUnproven: 'block',
};

export const SECURITY_EVIDENCE_SETTING_KEYS = {
    scannerUnavailable: 'security_scanner_unavailable',
    scanFailure: 'security_scan_failure',
    candidateUnproven: 'security_candidate_unproven',
} as const;

const VALID_OUTCOMES: ReadonlySet<string> = new Set<EvidenceAvailabilityOutcome>(['allow', 'warn', 'block']);

function readOutcome(
    settings: Record<string, string>,
    key: string,
    fallback: EvidenceAvailabilityOutcome,
): EvidenceAvailabilityOutcome {
    const raw = settings[key];
    // An unrecognised stored value is a write that predates this reader or a
    // hand-edited row. Falling back to the default beats throwing: this is read
    // on the deploy path, where an exception would block the deploy for a
    // reason unrelated to security.
    if (typeof raw !== 'string' || !VALID_OUTCOMES.has(raw)) return fallback;
    return raw as EvidenceAvailabilityOutcome;
}

/**
 * Resolve the policy from raw `global_settings` rows. Pure, so the mapping and
 * every fallback are unit-testable without a database.
 */
export function resolveSecurityEvidencePolicy(
    settings: Record<string, string> | null | undefined,
): SecurityEvidencePolicy {
    const source = settings ?? {};
    return {
        scannerUnavailable: readOutcome(
            source,
            SECURITY_EVIDENCE_SETTING_KEYS.scannerUnavailable,
            DEFAULT_SECURITY_EVIDENCE_POLICY.scannerUnavailable,
        ),
        scanFailure: readOutcome(
            source,
            SECURITY_EVIDENCE_SETTING_KEYS.scanFailure,
            DEFAULT_SECURITY_EVIDENCE_POLICY.scanFailure,
        ),
        candidateUnproven: readOutcome(
            source,
            SECURITY_EVIDENCE_SETTING_KEYS.candidateUnproven,
            DEFAULT_SECURITY_EVIDENCE_POLICY.candidateUnproven,
        ),
    };
}

/** One field as the settings row it is stored in, for the API response shape. */
export interface SerializedSecurityEvidencePolicy {
    scannerUnavailable: EvidenceAvailabilityOutcome;
    scanFailure: EvidenceAvailabilityOutcome;
    candidateUnproven: EvidenceAvailabilityOutcome;
    /** True when the resolved policy equals the shipped default. */
    isDefault: boolean;
}

export function serializeSecurityEvidencePolicy(policy: SecurityEvidencePolicy): SerializedSecurityEvidencePolicy {
    return {
        scannerUnavailable: policy.scannerUnavailable,
        scanFailure: policy.scanFailure,
        candidateUnproven: policy.candidateUnproven,
        isDefault:
            policy.scannerUnavailable === DEFAULT_SECURITY_EVIDENCE_POLICY.scannerUnavailable &&
            policy.scanFailure === DEFAULT_SECURITY_EVIDENCE_POLICY.scanFailure &&
            policy.candidateUnproven === DEFAULT_SECURITY_EVIDENCE_POLICY.candidateUnproven,
    };
}
