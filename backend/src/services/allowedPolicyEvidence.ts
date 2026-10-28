/**
 * The response-side half of an allowed gate decision.
 *
 * Its own module, importing the enforcement engine by type only, so a handler
 * can build the response field without loading the engine's runtime, and so the
 * engine and the HTTP helpers share one definition instead of one importing the
 * other.
 */
import type { PolicyEnforcementResult } from './PolicyEnforcement';
import { isCleanEvidenceDecision, type EvidenceGateDecision } from './securityEvidence';

/**
 * What an allowed operation reports about the evidence it was allowed on. Only
 * built when that evidence was not a clean pass or a bypass was used; a clean
 * allow has nothing to report. The same decision is written to the audit log by
 * the gate itself (as `policy.evidence_allowed`, or on the `policy.bypass` row)
 * unless the caller opted out of the `policy.evidence_allowed` entry with
 * `recordAllowedEvidence: false` (a bypass entry is always written), so this is
 * the response-side half of one record, not a second source of truth.
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

/**
 * Read the `policyEvidence` field off a remote node's success body, so a hub
 * that drove the operation can pass the decision on to its own caller. The body
 * crossed a network hop, so the shape is checked rather than cast: a node that
 * sent something else is treated as having sent nothing.
 */
export function parseRemotePolicyEvidence(body: unknown): AllowedPolicyEvidence | undefined {
    if (typeof body !== 'object' || body === null) return undefined;
    const candidate = (body as { policyEvidence?: unknown }).policyEvidence;
    if (candidate === undefined) return undefined;
    const parsed = readPolicyEvidence(candidate);
    // A field that is present but unreadable is dropped from the response, so the
    // drop is logged: the remote node's own audit row is the only other record.
    if (!parsed) console.warn('[Policy] Ignored a malformed policyEvidence field in a remote node response');
    return parsed;
}

function readPolicyEvidence(candidate: unknown): AllowedPolicyEvidence | undefined {
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const { policy, bypassed, evidence } = candidate as Partial<Record<keyof AllowedPolicyEvidence, unknown>>;
    if (typeof policy !== 'object' || policy === null) return undefined;
    const { id, name } = policy as { id?: unknown; name?: unknown };
    if (typeof id !== 'number' || typeof name !== 'string' || typeof bypassed !== 'boolean') return undefined;
    if (typeof evidence !== 'object' || evidence === null) return undefined;
    const decision = evidence as Partial<Record<keyof EvidenceGateDecision, unknown>>;
    if (
        (decision.outcome !== 'allow' && decision.outcome !== 'warn' && decision.outcome !== 'block')
        || typeof decision.summary !== 'string'
        || !Array.isArray(decision.records)
        || !Array.isArray(decision.applications)
    ) return undefined;
    return { policy: { id, name }, bypassed, evidence: evidence as EvidenceGateDecision };
}
