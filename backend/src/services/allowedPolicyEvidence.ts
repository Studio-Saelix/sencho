/**
 * The response-side half of an allowed gate decision.
 *
 * Its own module, with type-only imports, so a handler can build the response
 * field without importing the enforcement engine's runtime, and so the engine and
 * the HTTP helpers share one definition instead of one importing the other.
 */
import type { PolicyEnforcementResult } from './PolicyEnforcement';
import { isCleanEvidenceDecision, type EvidenceGateDecision } from './securityEvidence';

/**
 * What an allowed operation reports about the evidence it was allowed on. Only
 * built when that evidence was not a clean pass or a bypass was used; a clean
 * allow has nothing to report. The same decision is written to the audit log by
 * the gate itself (as `policy.evidence_allowed`, or on the `policy.bypass` row),
 * so this is the response-side half of one record, not a second source of truth.
 */
export interface AllowedPolicyEvidence {
    policy: { id: number; name: string };
    /** True when an authorized bypass was used to proceed. */
    bypassed: boolean;
    evidence: EvidenceGateDecision;
}

/** The optional response field for an allowed gate result; empty when there is nothing to report. */
export function allowedPolicyEvidence(
    gate: PolicyEnforcementResult,
): { policyEvidence?: AllowedPolicyEvidence } {
    const { policy, evidence } = gate;
    if (!gate.ok || !policy || !evidence) return {};
    if (!gate.bypassed && isCleanEvidenceDecision(evidence)) return {};
    return { policyEvidence: { policy: { id: policy.id, name: policy.name }, bypassed: gate.bypassed, evidence } };
}
