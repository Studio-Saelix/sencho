/**
 * Tier / variant types and license result shapes consumed across the
 * backend. Types live alongside `LicenseService` (their owner) rather
 * than behind an abstraction layer, since there is a single in-tree
 * implementation today.
 *
 * If a future build needs a second implementation (e.g. a SaaS
 * entitlement source) re-introduce an explicit interface and adapter.
 * See `docs/internal/adrs/2026-05-02-collapse-entitlement-provider.md`
 * for the trigger conditions.
 */

export type LicenseTier = 'community' | 'paid';
export type LicenseStatus = 'community' | 'trial' | 'active' | 'expired' | 'disabled';

export interface ActivationResult {
    success: boolean;
    error?: string;
}

export interface DeactivationResult {
    success: boolean;
    error?: string;
}

export interface ValidationResult {
    success: boolean;
    error?: string;
}

export interface BillingPortalResult {
    url: string;
}

export interface BillingPortalError {
    error: string;
}

export interface LicenseInfo {
    tier: LicenseTier;
    status: LicenseStatus;
    customerName: string | null;
    productName: string | null;
    maskedKey: string | null;
    validUntil: string | null;
    trialDaysRemaining: number | null;
    instanceId: string;
    portalUrl: string | null;
    isLifetime: boolean;
}
