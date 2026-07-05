/**
 * Read-time Compose Doctor acknowledgement filter.
 *
 * Acknowledgements never modify stored finding rows. They are applied at read time
 * so clearing an ack resurfaces findings without re-running preflight.
 */
import type { PreflightAckExpiryMode, PreflightAcknowledgement } from '../services/DatabaseService';
import type { PreflightFinding } from '../services/preflight/types';

export interface PreflightAcknowledgementDecision {
    acknowledged: boolean;
    acknowledgementId?: number;
    acknowledgementReason?: string;
    acknowledgementExpiry?: PreflightAckExpiryMode;
}

export interface PreflightAckFilterContext {
    renderedHash: string | null;
    /** Parsed service name to image ref from the latest stored run. */
    serviceImages: Record<string, string>;
}

function matchesService(ackService: string | null, findingService: string | undefined): boolean {
    if (ackService === null) return true;
    return ackService === (findingService ?? null);
}

function isActive(
    ack: PreflightAcknowledgement,
    ctx: PreflightAckFilterContext,
    findingService: string | undefined,
    now: number,
): boolean {
    switch (ack.expiry_mode) {
        case 'forever':
            return true;
        case 'until_compose_change':
            return ctx.renderedHash !== null
                && ack.anchor_rendered_hash !== null
                && ctx.renderedHash === ack.anchor_rendered_hash;
        case 'days':
            return ack.expires_at !== null && ack.expires_at > now;
        case 'until_image_change': {
            const svc = findingService ?? ack.service ?? null;
            if (!svc) return false;
            const current = ctx.serviceImages[svc] ?? null;
            return current !== null
                && ack.anchor_image_ref !== null
                && current === ack.anchor_image_ref;
        }
        default:
            return false;
    }
}

function specificityScore(ack: PreflightAcknowledgement): number {
    return ack.service ? 1 : 0;
}

function pickFromBucket(
    bucket: PreflightAcknowledgement[],
    findingService: string | undefined,
    ctx: PreflightAckFilterContext,
    now: number,
): PreflightAcknowledgement | null {
    let best: PreflightAcknowledgement | null = null;
    let bestScore = -1;
    for (const ack of bucket) {
        if (!matchesService(ack.service, findingService)) continue;
        if (!isActive(ack, ctx, findingService, now)) continue;
        const score = specificityScore(ack);
        if (score > bestScore) {
            best = ack;
            bestScore = score;
        }
    }
    return best;
}

export function parseServiceImages(json: string | null | undefined): Record<string, string> {
    if (!json) return {};
    try {
        const parsed = JSON.parse(json) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && value.length > 0) out[key] = value;
        }
        return out;
    } catch {
        return {};
    }
}

export function applyPreflightAcknowledgements<T extends PreflightFinding>(
    findings: T[],
    ctx: PreflightAckFilterContext,
    acks: PreflightAcknowledgement[],
    now: number = Date.now(),
): Array<T & PreflightAcknowledgementDecision> {
    if (findings.length === 0) return [];
    const buckets = new Map<string, PreflightAcknowledgement[]>();
    for (const ack of acks) {
        const existing = buckets.get(ack.rule_id);
        if (existing) {
            existing.push(ack);
        } else {
            buckets.set(ack.rule_id, [ack]);
        }
    }
    return findings.map((f) => {
        const bucket = buckets.get(f.ruleId);
        const match = bucket ? pickFromBucket(bucket, f.service, ctx, now) : null;
        if (!match) return { ...f, acknowledged: false };
        return {
            ...f,
            acknowledged: true,
            acknowledgementId: match.id,
            acknowledgementReason: match.reason,
            acknowledgementExpiry: match.expiry_mode,
        };
    });
}

export function isPreflightAckActive(
    ack: PreflightAcknowledgement,
    ctx: PreflightAckFilterContext,
    now: number = Date.now(),
): boolean {
    return isActive(ack, ctx, ack.service ?? undefined, now);
}
