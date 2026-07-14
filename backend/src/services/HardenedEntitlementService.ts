import crypto from 'crypto';
import axios from 'axios';
import { validateAllowedImageRefAgainstRequirement } from '../helpers/allowedImageRef';
import { DatabaseService } from './DatabaseService';
import type {
    HardenedEntitlement,
    HardenedEntitlementErrorCode,
    HardenedEntitlementPurpose,
    HardenedEntitlementResult,
} from './hardenedEntitlementTypes';

const ASSURANCE_API_DEFAULT = 'https://sencho.io';
const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;

interface CacheEntry {
    expiresAt: number;
    result: HardenedEntitlementResult;
}

export class HardenedEntitlementService {
    private static instance: HardenedEntitlementService;
    private statusCache = new Map<string, CacheEntry>();

    private constructor() {}

    public static getInstance(): HardenedEntitlementService {
        if (!HardenedEntitlementService.instance) {
            HardenedEntitlementService.instance = new HardenedEntitlementService();
        }
        return HardenedEntitlementService.instance;
    }

    public invalidateCache(): void {
        this.statusCache.clear();
    }

    public async getEntitlement(
        purpose: HardenedEntitlementPurpose,
        requestedVersion?: string,
    ): Promise<HardenedEntitlementResult> {
        // Dynamic import avoids a circular dependency: LicenseService imports this service.
        const { LicenseService } = await import('./LicenseService');
        if (LicenseService.getInstance().getTier() !== 'paid') {
            return { success: false, code: 'unauthorized' };
        }
        const db = DatabaseService.getInstance();
        const licenseKey = db.getSystemState('license_key');
        const instanceId = db.getSystemState('instance_id');
        if (!licenseKey || !instanceId) return { success: false, code: 'unauthorized' };

        const cacheKey = this.cacheKey(licenseKey, instanceId);
        if (purpose === 'status') {
            const cached = this.statusCache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) return cached.result;
            this.statusCache.delete(cacheKey);
        }

        const result = this.getStubResponse()
            ?? await this.fetchEntitlement(licenseKey, instanceId, purpose, requestedVersion);

        if (purpose === 'status') {
            this.statusCache.set(cacheKey, { result, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
        }
        return result;
    }

    private async fetchEntitlement(
        licenseKey: string,
        instanceId: string,
        purpose: HardenedEntitlementPurpose,
        requestedVersion?: string,
    ): Promise<HardenedEntitlementResult> {
        const apiBase = process.env.SENCHO_ASSURANCE_API || ASSURANCE_API_DEFAULT;
        if (!isSecureAssuranceApi(apiBase)) return { success: false, code: 'unavailable' };

        try {
            const response = await axios.post<unknown>(
                `${apiBase.replace(/\/$/, '')}/api/assurance/hardened-entitlement`,
                {
                    license_key: licenseKey,
                    instance_id: instanceId,
                    purpose,
                    ...(requestedVersion ? { requested_version: requestedVersion } : {}),
                },
                {
                    timeout: 15000,
                    maxRedirects: 0,
                    maxContentLength: MAX_BODY_BYTES,
                    maxBodyLength: MAX_BODY_BYTES,
                    validateStatus: () => true,
                },
            );

            if (response.status < 200 || response.status >= 300) {
                return { success: false, code: statusToErrorCode(response.status) };
            }

            const entitlement = parseEntitlement(response.data);
            return entitlement
                ? { success: true, entitlement }
                : { success: false, code: 'unavailable' };
        } catch {
            return { success: false, code: 'unavailable' };
        }
    }

    private getStubResponse(): HardenedEntitlementResult | null {
        // Stub is non-production/test-only; ignore it entirely in production.
        if (process.env.NODE_ENV === 'production') return null;
        const stub = process.env.SENCHO_ASSURANCE_ENTITLEMENT_STUB;
        if (!stub) return null;
        if (stub === '1' || stub === 'entitled') {
            return { success: true, entitlement: entitledStubFixture() };
        }
        if (stub === 'unauthorized') return { success: false, code: 'unauthorized' };
        return { success: false, code: 'unavailable' };
    }

    private cacheKey(licenseKey: string, instanceId: string): string {
        const fingerprint = crypto.createHash('sha256').update(licenseKey).digest('hex');
        return `${fingerprint}:${instanceId}`;
    }
}

function parseEntitlement(value: unknown): HardenedEntitlement | null {
    if (!isRecord(value) || value.hardened_build_access !== true || value.channel !== 'hardened') return null;
    if (typeof value.allowed_image_ref !== 'string'
        || typeof value.pin_recommendation !== 'string'
        || typeof value.checked_at !== 'string'
        || !isRecord(value.registry_requirement)
        || typeof value.registry_requirement.registry_host !== 'string'
        || typeof value.registry_requirement.package_scope !== 'string'
        || typeof value.registry_requirement.credential_instructions !== 'string'
        || typeof value.registry_requirement.supports_pull_token !== 'boolean') {
        return null;
    }

    const entitlement: HardenedEntitlement = {
        hardened_build_access: true,
        channel: 'hardened',
        allowed_image_ref: value.allowed_image_ref,
        pin_recommendation: value.pin_recommendation,
        registry_requirement: {
            registry_host: value.registry_requirement.registry_host,
            package_scope: value.registry_requirement.package_scope,
            credential_instructions: value.registry_requirement.credential_instructions,
            supports_pull_token: value.registry_requirement.supports_pull_token,
        },
        checked_at: value.checked_at,
    };
    return validateAllowedImageRefAgainstRequirement(
        entitlement.allowed_image_ref,
        entitlement.registry_requirement,
    ) ? entitlement : null;
}

function statusToErrorCode(status: number): HardenedEntitlementErrorCode {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 404) return 'unpublished';
    if (status === 410) return 'expired';
    return 'unavailable';
}

function entitledStubFixture(): HardenedEntitlement {
    return {
        hardened_build_access: true,
        channel: 'hardened',
        allowed_image_ref: 'ghcr.io/studio-saelix/sencho-hardened@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pin_recommendation: 'Use the supplied digest.',
        registry_requirement: {
            registry_host: 'ghcr.io',
            package_scope: 'studio-saelix/sencho-hardened',
            credential_instructions: 'Create a pull token.',
            supports_pull_token: true,
        },
        checked_at: new Date().toISOString(),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isSecureAssuranceApi(apiBase: string): boolean {
    try {
        const url = new URL(apiBase);
        const isLoopback = url.hostname === 'localhost'
            || url.hostname === '127.0.0.1'
            || url.hostname === '::1';
        return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback);
    } catch {
        return false;
    }
}
