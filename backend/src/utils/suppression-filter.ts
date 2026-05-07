/**
 * Read-time CVE suppression filter.
 *
 * Suppressions never modify stored scan rows. They are applied at read time so
 * toggling them off resurfaces findings without rescanning.
 *
 * A suppression matches a finding when:
 *   - cve_id equals the finding's vulnerability_id, AND
 *   - pkg_name is null OR equals the finding's pkg_name, AND
 *   - image_pattern is null OR matches the image reference (glob), AND
 *   - expires_at is null OR still in the future.
 */
import type { CveSuppression } from '../services/DatabaseService';

export interface SuppressionDecision {
    suppressed: boolean;
    suppression_id?: number;
    suppression_reason?: string;
}

export interface SuppressibleFinding {
    vulnerability_id: string;
    pkg_name: string;
}

function matchesImagePattern(pattern: string | null, imageRef: string): boolean {
    if (!pattern) return true;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(imageRef);
}

function isActive(suppression: CveSuppression, now: number): boolean {
    return suppression.expires_at === null || suppression.expires_at > now;
}

function specificityScore(s: CveSuppression): number {
    return (s.pkg_name ? 2 : 0) + (s.image_pattern ? 1 : 0);
}

/**
 * Pick the highest-specificity active suppression from a candidate bucket
 * already filtered to a single CVE. Returns null when no candidate matches the
 * finding's pkg/image constraints.
 */
function pickFromBucket(
    bucket: CveSuppression[],
    finding: SuppressibleFinding,
    imageRef: string,
    now: number,
): CveSuppression | null {
    let best: CveSuppression | null = null;
    let bestScore = -1;
    for (const s of bucket) {
        if (!isActive(s, now)) continue;
        if (s.pkg_name !== null && s.pkg_name !== finding.pkg_name) continue;
        if (!matchesImagePattern(s.image_pattern, imageRef)) continue;
        const score = specificityScore(s);
        if (score > bestScore) {
            best = s;
            bestScore = score;
        }
    }
    return best;
}

/**
 * Find the most specific active suppression matching a single finding.
 * Specificity: entries that pin a specific pkg or image beat wildcard entries.
 *
 * For one-shot lookups. When enriching many findings, prefer applySuppressions,
 * which builds the cve_id bucket once and amortizes the lookup.
 */
export function findSuppression(
    finding: SuppressibleFinding,
    imageRef: string,
    suppressions: CveSuppression[],
    now: number = Date.now(),
): CveSuppression | null {
    const bucket: CveSuppression[] = [];
    for (const s of suppressions) {
        if (s.cve_id === finding.vulnerability_id) bucket.push(s);
    }
    if (bucket.length === 0) return null;
    return pickFromBucket(bucket, finding, imageRef, now);
}

/**
 * Enrich a list of findings with suppression decisions. Does not mutate inputs.
 *
 * Suppressions are bucketed by cve_id once before the per-finding scan, so the
 * per-finding work is O(matching-cve-suppressions) rather than O(suppressions).
 * This matters: a fleet-wide suppression list capped at MAX_SYNC_ROWS combined
 * with a multi-thousand-finding scan would otherwise drift into the tens of
 * millions of comparisons per render.
 */
export function applySuppressions<T extends SuppressibleFinding>(
    findings: T[],
    imageRef: string,
    suppressions: CveSuppression[],
    now: number = Date.now(),
): Array<T & SuppressionDecision> {
    if (findings.length === 0) return [];
    const buckets = new Map<string, CveSuppression[]>();
    for (const s of suppressions) {
        const existing = buckets.get(s.cve_id);
        if (existing) {
            existing.push(s);
        } else {
            buckets.set(s.cve_id, [s]);
        }
    }
    return findings.map((f) => {
        const bucket = buckets.get(f.vulnerability_id);
        const match = bucket ? pickFromBucket(bucket, f, imageRef, now) : null;
        if (!match) return { ...f, suppressed: false };
        return {
            ...f,
            suppressed: true,
            suppression_id: match.id,
            suppression_reason: match.reason,
        };
    });
}
