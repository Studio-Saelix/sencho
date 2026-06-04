import type { LicenseTier } from './license-types';

/**
 * Tier guards / normalizers. Domain knowledge about Sencho's tier model
 * (which strings are accepted on input, how the legacy name maps to the
 * current name). Used by:
 *
 *   - The proxy layer (`auth.ts`, `remoteNodeProxy.ts`) to parse and
 *     validate the tier header from inbound forwarded requests.
 *   - The host-console upgrade handler to decode trusted proxy tier
 *     claims attached to bearer tokens.
 */

const VALID_TIERS: readonly string[] = ['community', 'paid'] satisfies readonly LicenseTier[];

/**
 * Legacy tier name accepted on input from older proxy headers;
 * normalized to the current name on read.
 */
const LEGACY_TIER_MAP: Record<string, LicenseTier> = { pro: 'paid' };

/** Check if value is a recognized tier (current or legacy name). */
export function isLicenseTier(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        ((VALID_TIERS as readonly string[]).includes(value) || value in LEGACY_TIER_MAP)
    );
}

/**
 * Normalize a tier value, mapping legacy names to current equivalents.
 * Must be called after `isLicenseTier` validation.
 */
export function normalizeTier(value: string): LicenseTier {
    return LEGACY_TIER_MAP[value] ?? (value as LicenseTier);
}
