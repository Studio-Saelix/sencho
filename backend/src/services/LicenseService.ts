import crypto from 'crypto';
import axios from 'axios';
import { DatabaseService } from './DatabaseService';
import type {
    LicenseInfo,
    LicenseStatus,
    LicenseTier,
} from './license-types';

interface LemonSqueezyActivationResponse {
    activated: boolean;
    error?: string;
    license_key?: {
        id: number;
        status: string;
        key: string;
        activation_limit: number;
        activation_usage: number;
        created_at: string;
        expires_at: string | null;
    };
    instance?: {
        id: string;
        name: string;
        created_at: string;
    };
    meta?: {
        store_id: number;
        order_id: number;
        order_item_id: number;
        product_id: number;
        product_name: string;
        variant_id: number;
        variant_name: string;
        customer_id: number;
        customer_name: string;
        customer_email: string;
    };
}

interface LemonSqueezyValidationResponse {
    valid: boolean;
    error?: string;
    license_key?: {
        id: number;
        status: string;
        key: string;
        activation_limit: number;
        activation_usage: number;
        created_at: string;
        expires_at: string | null;
    };
    meta?: {
        store_id: number;
        order_id: number;
        order_item_id: number;
        product_id: number;
        product_name: string;
        variant_id: number;
        variant_name: string;
        customer_id: number;
        customer_name: string;
        customer_email: string;
    };
}

const LEMON_SQUEEZY_API = 'https://api.lemonsqueezy.com/v1/licenses';
const VALIDATION_INTERVAL_MS = 72 * 60 * 60 * 1000; // 72 hours
const OFFLINE_GRACE_DAYS = 30;

/**
 * Lemon Squeezy catalog identifiers Sencho is willing to honor. Without this
 * check, a license issued for any other LS store or product could activate
 * Sencho, because LS's /licenses/validate endpoint returns valid: true for
 * any well-formed license key regardless of which product it belongs to.
 *
 * The validate response carries store_id / product_id under meta;
 * isSenchoLicenseMeta() rejects any license that is not the Sencho paid
 * product. If the paid product changes in the LS dashboard, update this in
 * the same release.
 */
export const SENCHO_LS_STORE_ID = 321715;
export const SENCHO_LS_PRODUCT_ID_ADMIRAL = 924153;

/**
 * True only when a Lemon Squeezy validate / activate meta block belongs to
 * the Sencho paid product. Callers must reject the activation/validation
 * when this returns false; persisting state from a non-matching response
 * would let a foreign LS license unlock paid features.
 */
export function isSenchoLicenseMeta(
    meta: { store_id?: number; product_id?: number } | undefined,
): boolean {
    if (!meta) return false;
    if (meta.store_id !== SENCHO_LS_STORE_ID) return false;
    if (meta.product_id !== SENCHO_LS_PRODUCT_ID_ADMIRAL) return false;
    return true;
}

// Short TTL for the proxy-headers cache. The remote-node proxy reads the
// tier on every forwarded request; without caching, each call hits
// system_state 5+ times. Every license_status write goes through
// setLicenseStatus() which invalidates the cache, so the TTL is a safety
// net against any future bypass rather than a load-bearing freshness bound.
const PROXY_HEADERS_CACHE_TTL_MS = 30_000;

/**
 * Single in-tree license service. Owns Lemon Squeezy validation and
 * exposes the tier API consumed across the backend. See
 * `docs/internal/adrs/2026-05-02-collapse-entitlement-provider.md`
 * for the conditions that would justify reintroducing an interface seam.
 */
export class LicenseService {
    private static instance: LicenseService;
    private validationTimer: ReturnType<typeof setInterval> | null = null;
    private cachedProxyHeaders: { value: { tier: LicenseTier }; expiresAt: number } | null = null;

    private constructor() { }

    public static getInstance(): LicenseService {
        if (!LicenseService.instance) {
            LicenseService.instance = new LicenseService();
        }
        return LicenseService.instance;
    }

    /**
     * Two distinct identifiers live in `system_state` and the names are
     * confusingly close, so for future maintainers (and audit agents):
     *
     *   `instance_id`           local UUID generated once on first boot. We
     *                           send it to LS as the activation's
     *                           `instance_name` (LS treats this as a
     *                           free-form label, e.g. a hostname).
     *
     *   `license_instance_id`   the activation ID LS returns on /activate.
     *                           We send it back to LS as the `instance_id`
     *                           parameter on /validate and /deactivate.
     *
     * They are NOT redundant and NEITHER overwrites the other. Renaming
     * `instance_id` to e.g. `local_install_id` would be clearer but would
     * churn frontend consumers and migrations for no functional change.
     */

    /**
     * Initialize the license service on startup.
     * Ensures an instance ID exists and starts periodic validation for active licenses.
     * Fresh installs land on Community; trials are issued by Lemon Squeezy via the
     * hosted checkout (email + card required) and activated locally by pasting the key.
     */
    public initialize(): void {
        const db = DatabaseService.getInstance();

        // Generate persistent instance ID on first boot
        if (!db.getSystemState('instance_id')) {
            db.setSystemState('instance_id', crypto.randomUUID());
        }

        this.startPeriodicValidation();
    }

    /**
     * Returns the current license tier. Synchronous - reads from cached DB state only.
     */
    public getTier(): LicenseTier {
        const db = DatabaseService.getInstance();
        const status = db.getSystemState('license_status') as LicenseStatus | null;

        if (!status || status === 'community') return 'community';
        if (status === 'disabled' || status === 'expired') return 'community';

        if (status === 'trial') {
            const validUntil = db.getSystemState('license_valid_until');
            if (validUntil && new Date(validUntil) > new Date()) {
                return 'paid';
            }
            // Trial expired - update status
            this.setLicenseStatus('community');
            return 'community';
        }

        if (status === 'active') {
            // Check offline grace period
            const lastValidated = db.getSystemState('license_last_validated');
            if (lastValidated) {
                const daysSinceValidation = (Date.now() - parseInt(lastValidated, 10)) / (1000 * 60 * 60 * 24);
                if (daysSinceValidation > OFFLINE_GRACE_DAYS) {
                    console.warn('[License] Offline grace period exceeded. Degrading to community.');
                    this.setLicenseStatus('community');
                    return 'community';
                }
            }

            // Check expiry for subscription licenses
            const validUntil = db.getSystemState('license_valid_until');
            if (validUntil && new Date(validUntil) < new Date()) {
                this.setLicenseStatus('expired');
                return 'community';
            }

            return 'paid';
        }

        return 'community';
    }

    /**
     * Tier snapshot for the remote-node proxy headers, cached for
     * a short window to spare the proxy hot path from re-running getTier()
     * on every forwarded request. All license-status writes route through
     * setLicenseStatus(), which invalidates this cache, so tier changes take
     * effect within one proxy call.
     */
    public getProxyHeaders(): { tier: LicenseTier } {
        const now = Date.now();
        if (this.cachedProxyHeaders && this.cachedProxyHeaders.expiresAt > now) {
            return this.cachedProxyHeaders.value;
        }
        const value = { tier: this.getTier() };
        this.cachedProxyHeaders = { value, expiresAt: now + PROXY_HEADERS_CACHE_TTL_MS };
        return value;
    }

    /**
     * Single chokepoint for license_status writes. Persists the new status
     * and invalidates the proxy-headers cache so tier-gated routes on
     * remote nodes observe the change on the next forwarded request.
     * Every license_status write must go through this method; bypassing
     * it leaves the cache stale until the TTL expires.
     */
    private setLicenseStatus(status: LicenseStatus): void {
        DatabaseService.getInstance().setSystemState('license_status', status);
        this.cachedProxyHeaders = null;
    }

    /**
     * Get full license information for the API response.
     */
    public getLicenseInfo(): LicenseInfo {
        const db = DatabaseService.getInstance();
        const status = (db.getSystemState('license_status') || 'community') as LicenseStatus;
        const key = db.getSystemState('license_key');
        const validUntil = db.getSystemState('license_valid_until');
        const instanceId = db.getSystemState('instance_id') || '';

        let trialDaysRemaining: number | null = null;
        if (status === 'trial' && validUntil) {
            const remaining = (new Date(validUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
            trialDaysRemaining = Math.max(0, Math.ceil(remaining));
        }

        // Lifetime license: active with a stored key but no expiry date
        const isLifetime = status === 'active' && !!key && !validUntil;

        return {
            tier: this.getTier(),
            status,
            customerName: db.getSystemState('license_customer_name'),
            productName: db.getSystemState('license_product_name'),
            maskedKey: key ? `****-****-****-${key.slice(-4)}` : null,
            validUntil,
            trialDaysRemaining,
            instanceId,
            portalUrl: db.getSystemState('billing_portal_url') || db.getSystemState('customer_portal_url') || null,
            isLifetime,
        };
    }

    /**
     * Activate a license key with Lemon Squeezy.
     */
    public async activate(licenseKey: string): Promise<{ success: boolean; error?: string }> {
        const db = DatabaseService.getInstance();
        const instanceId = db.getSystemState('instance_id') || crypto.randomUUID();

        try {
            const response = await axios.post<LemonSqueezyActivationResponse>(
                `${LEMON_SQUEEZY_API}/activate`,
                {
                    license_key: licenseKey,
                    instance_name: instanceId,
                },
                { timeout: 15000 }
            );

            const data = response.data;
            if (!data.activated) {
                return { success: false, error: data.error || 'Activation failed' };
            }

            // Reject licenses that don't belong to the Sencho LS catalog.
            // LS's /activate succeeds for any product in any store, so without
            // this check a license bought elsewhere could unlock Sencho.
            if (!isSenchoLicenseMeta(data.meta)) {
                console.warn('[License] Activation rejected: license does not match the Sencho catalog.');
                return { success: false, error: 'This license key is not valid for Sencho.' };
            }

            // Reject if LS did not return a usable instance id. Storing an
            // empty license_instance_id would silently break later validate()
            // and deactivate() calls, both of which short-circuit on a falsy
            // instance id with a generic "no active license" error. Better to
            // surface the broken activation immediately than ship a state where
            // the user thinks they are activated but every subsequent call
            // fails. LS has historically always returned data.instance.id on
            // a successful activation; this is a defense against an API change
            // or transient malformed response, not a routinely-hit branch.
            const lsInstanceId = data.instance?.id;
            if (!lsInstanceId) {
                console.warn('[License] Activation rejected: LS response missing instance.id.');
                return { success: false, error: 'License server returned an incomplete activation. Please try again.' };
            }

            // Store license data
            db.setSystemState('license_key', licenseKey);
            db.setSystemState('license_instance_id', lsInstanceId);
            this.setLicenseStatus('active');
            db.setSystemState('license_last_validated', Date.now().toString());

            if (data.license_key?.expires_at) {
                db.setSystemState('license_valid_until', data.license_key.expires_at);
            } else {
                // Lifetime license - no expiry
                db.setSystemState('license_valid_until', '');
            }

            if (data.meta?.customer_name) {
                db.setSystemState('license_customer_name', data.meta.customer_name);
            }
            if (data.meta?.product_name) {
                db.setSystemState('license_product_name', data.meta.product_name);
            }
            if (data.meta?.customer_id) {
                db.setSystemState('customer_id', String(data.meta.customer_id));
            }

            // Clear any cached portal URL so it's refreshed on next request
            db.setSystemState('billing_portal_url', '');
            db.setSystemState('billing_portal_expires', '');

            console.log('[License] Activated successfully.');
            return { success: true };
        } catch (err) {
            // Handle Lemon Squeezy error responses (4xx)
            if (axios.isAxiosError(err) && err.response?.data) {
                const errorMsg = err.response.data.error || 'Activation failed';
                console.error('[License] Activation error:', errorMsg);
                return { success: false, error: errorMsg };
            }
            console.error('[License] Activation network error:', (err as Error).message);
            return { success: false, error: 'Unable to reach license server. Check your internet connection.' };
        }
    }

    /**
     * Deactivate the current license, reverting to community.
     */
    public async deactivate(): Promise<{ success: boolean; error?: string }> {
        const db = DatabaseService.getInstance();
        const licenseKey = db.getSystemState('license_key');
        const instanceId = db.getSystemState('license_instance_id');

        if (licenseKey && instanceId) {
            try {
                await axios.post(
                    `${LEMON_SQUEEZY_API}/deactivate`,
                    {
                        license_key: licenseKey,
                        instance_id: instanceId,
                    },
                    { timeout: 15000 }
                );
            } catch (err) {
                console.warn('[License] Deactivation API call failed (proceeding with local cleanup):', (err as Error).message);
            }
        }

        // Clear all license state
        const keysToRemove = [
            'license_key',
            'license_instance_id',
            'license_status',
            'license_valid_until',
            'license_last_validated',
            'license_customer_name',
            'license_product_name',
            'license_variant_name',
            'license_variant_type',
            'license_variant_id',
            'subscription_id',
            'customer_id',
            'customer_portal_url',
            'update_payment_url',
            'order_id',
            'receipt_url',
            'billing_portal_url',
            'billing_portal_expires',
        ];
        for (const key of keysToRemove) {
            db.setSystemState(key, '');
        }
        this.setLicenseStatus('community');

        console.log('[License] Deactivated. Reverted to Community tier.');
        return { success: true };
    }

    /**
     * Validate the current license against Lemon Squeezy.
     */
    public async validate(): Promise<{ success: boolean; error?: string }> {
        const db = DatabaseService.getInstance();
        const licenseKey = db.getSystemState('license_key');
        const instanceId = db.getSystemState('license_instance_id');

        if (!licenseKey || !instanceId) {
            return { success: false, error: 'No active license to validate' };
        }

        try {
            const response = await axios.post<LemonSqueezyValidationResponse>(
                `${LEMON_SQUEEZY_API}/validate`,
                {
                    license_key: licenseKey,
                    instance_id: instanceId,
                },
                { timeout: 15000 }
            );

            const data = response.data;

            if (!data.valid) {
                // License revoked or invalid
                this.setLicenseStatus('disabled');
                console.warn('[License] Validation failed: license is no longer valid.');
                return { success: false, error: data.error || 'License is no longer valid' };
            }

            // Reject if the license is no longer recognized as a Sencho catalog
            // entry (e.g. variant_id removed, product moved). Same defense as
            // activate(): without this, any LS license can pass periodic
            // validation and keep paid features unlocked.
            if (!isSenchoLicenseMeta(data.meta)) {
                this.setLicenseStatus('disabled');
                console.warn('[License] Validation rejected: license does not match the Sencho catalog.');
                return { success: false, error: 'License is not valid for Sencho.' };
            }

            // license_last_validated means "we got an authoritative answer from
            // LS for a recognized Sencho license," not just "we reached the LS
            // API." Writing it before the catalog guard would let a foreign LS
            // license refresh the offline grace window during the brief window
            // the rejected status is being persisted.
            db.setSystemState('license_last_validated', Date.now().toString());

            // Update status based on key status
            const keyStatus = data.license_key?.status;
            if (keyStatus === 'expired') {
                this.setLicenseStatus('expired');
                return { success: false, error: 'License has expired' };
            }
            if (keyStatus === 'disabled') {
                this.setLicenseStatus('disabled');
                return { success: false, error: 'License has been disabled' };
            }

            this.setLicenseStatus('active');

            // Update expiry if changed
            if (data.license_key?.expires_at) {
                db.setSystemState('license_valid_until', data.license_key.expires_at);
            }

            // Update customer/product info if available
            if (data.meta?.customer_name) {
                db.setSystemState('license_customer_name', data.meta.customer_name);
            }
            if (data.meta?.product_name) {
                db.setSystemState('license_product_name', data.meta.product_name);
            }
            if (data.meta?.customer_id && !db.getSystemState('customer_id')) {
                db.setSystemState('customer_id', String(data.meta.customer_id));
            }

            console.log('[License] Validation successful.');
            return { success: true };
        } catch (err) {
            // Network failure - don't change status, just log
            console.warn('[License] Validation network error (keeping current status):', (err as Error).message);
            return { success: false, error: 'Unable to reach license server' };
        }
    }

    /**
     * Fetch a signed billing portal URL via the sencho.io proxy.
     * Returns a pre-signed Lemon Squeezy Customer Portal URL (valid 24hrs).
     * Caches the URL for 12 hours to reduce external API calls.
     */
    public async getBillingPortalUrl(): Promise<{ url: string } | { error: string }> {
        const db = DatabaseService.getInstance();
        const status = db.getSystemState('license_status');
        const licenseKey = db.getSystemState('license_key');

        if (status !== 'active' || !licenseKey) {
            return { error: 'No billing portal available. Ensure you have an active license.' };
        }

        // Lifetime licenses have no recurring subscription to manage
        const validUntil = db.getSystemState('license_valid_until');
        if (!validUntil) {
            return { error: 'Billing portal is not available for lifetime licenses.' };
        }

        // Check cache (12hr TTL)
        const cachedUrl = db.getSystemState('billing_portal_url');
        const cachedExpires = db.getSystemState('billing_portal_expires');
        if (cachedUrl && cachedExpires && Date.now() < parseInt(cachedExpires, 10)) {
            return { url: cachedUrl };
        }

        try {
            const response = await axios.post<{ url: string }>(
                'https://sencho.io/api/billing-portal',
                { license_key: licenseKey },
                { timeout: 15000 }
            );

            const url = response.data?.url;
            if (!url) {
                return { error: 'No billing portal available. Ensure you have an active license.' };
            }

            // Cache for 12 hours
            const ttl = 12 * 60 * 60 * 1000;
            db.setSystemState('billing_portal_url', url);
            db.setSystemState('billing_portal_expires', String(Date.now() + ttl));

            return { url };
        } catch (err) {
            console.warn('[License] Failed to fetch billing portal URL:', (err as Error).message);
            // Return stale cache if available
            if (cachedUrl) return { url: cachedUrl };
            return { error: 'Failed to retrieve billing portal URL.' };
        }
    }

    /**
     * Start periodic background validation every 72 hours.
     */
    public startPeriodicValidation(): void {
        if (this.validationTimer) {
            clearInterval(this.validationTimer);
        }

        this.validationTimer = setInterval(async () => {
            const db = DatabaseService.getInstance();
            const status = db.getSystemState('license_status');
            // Only validate active licenses (not trial, community, etc.)
            if (status === 'active') {
                await this.validate();
            }
        }, VALIDATION_INTERVAL_MS);

        // Run an initial validation on startup for active licenses (after a short delay)
        const db = DatabaseService.getInstance();
        if (db.getSystemState('license_status') === 'active') {
            setTimeout(() => this.validate(), 5000);
        }
    }

    /**
     * Cleanup on shutdown.
     */
    public destroy(): void {
        if (this.validationTimer) {
            clearInterval(this.validationTimer);
            this.validationTimer = null;
        }
    }
}
