/**
 * Read-time misconfiguration acknowledgement filter.
 *
 * Acknowledgements never modify stored finding rows. They are applied at read
 * time so deleting an ack resurfaces findings without rescanning.
 *
 * An acknowledgement matches a finding when:
 *   - rule_id equals the finding's rule_id, AND
 *   - stack_pattern is null OR matches the scan's stack_context (glob), AND
 *   - expires_at is null OR still in the future.
 *
 * Mirrors the design of `suppression-filter.ts`. The bucketing pass is shared
 * spirit: pre-group by rule_id once so a multi-thousand-finding scan does not
 * cross-multiply with the fleet ack list on every render.
 */
import type { MisconfigAcknowledgement } from '../services/DatabaseService';

export interface MisconfigAcknowledgementDecision {
    acknowledged: boolean;
    acknowledgement_id?: number;
    acknowledgement_reason?: string;
}

export interface AcknowledgeableFinding {
    rule_id: string;
}

function matchesStackPattern(pattern: string | null, stackContext: string | null): boolean {
    // No pattern means fleet-wide; matches any stack including null contexts
    // (e.g. image scans where stack_context is null).
    if (!pattern) return true;
    // Stack-scoped acks against an image scan (no stack_context) cannot match.
    if (stackContext === null) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(stackContext);
}

function isActive(ack: MisconfigAcknowledgement, now: number): boolean {
    return ack.expires_at === null || ack.expires_at > now;
}

function specificityScore(a: MisconfigAcknowledgement): number {
    return a.stack_pattern ? 1 : 0;
}

/**
 * Pick the highest-specificity active ack from a candidate bucket already
 * filtered to a single rule_id. A stack-scoped ack beats a fleet-wide ack.
 */
function pickFromBucket(
    bucket: MisconfigAcknowledgement[],
    stackContext: string | null,
    now: number,
): MisconfigAcknowledgement | null {
    let best: MisconfigAcknowledgement | null = null;
    let bestScore = -1;
    for (const a of bucket) {
        if (!isActive(a, now)) continue;
        if (!matchesStackPattern(a.stack_pattern, stackContext)) continue;
        const score = specificityScore(a);
        if (score > bestScore) {
            best = a;
            bestScore = score;
        }
    }
    return best;
}

/**
 * Find the most specific active acknowledgement matching a single finding.
 * For one-shot lookups; prefer applyMisconfigAcknowledgements when enriching
 * a list because that path amortizes the bucketing.
 */
export function findMisconfigAcknowledgement(
    finding: AcknowledgeableFinding,
    stackContext: string | null,
    acks: MisconfigAcknowledgement[],
    now: number = Date.now(),
): MisconfigAcknowledgement | null {
    const bucket: MisconfigAcknowledgement[] = [];
    for (const a of acks) {
        if (a.rule_id === finding.rule_id) bucket.push(a);
    }
    if (bucket.length === 0) return null;
    return pickFromBucket(bucket, stackContext, now);
}

/**
 * Enrich a list of misconfig findings with acknowledgement decisions. Does
 * not mutate inputs.
 *
 * Acks are bucketed by rule_id once before the per-finding scan, so the
 * per-finding work is O(matching-rule-acks) rather than O(acks).
 */
export function applyMisconfigAcknowledgements<T extends AcknowledgeableFinding>(
    findings: T[],
    stackContext: string | null,
    acks: MisconfigAcknowledgement[],
    now: number = Date.now(),
): Array<T & MisconfigAcknowledgementDecision> {
    if (findings.length === 0) return [];
    const buckets = new Map<string, MisconfigAcknowledgement[]>();
    for (const a of acks) {
        const existing = buckets.get(a.rule_id);
        if (existing) {
            existing.push(a);
        } else {
            buckets.set(a.rule_id, [a]);
        }
    }
    return findings.map((f) => {
        const bucket = buckets.get(f.rule_id);
        const match = bucket ? pickFromBucket(bucket, stackContext, now) : null;
        if (!match) return { ...f, acknowledged: false };
        return {
            ...f,
            acknowledged: true,
            acknowledgement_id: match.id,
            acknowledgement_reason: match.reason,
        };
    });
}
