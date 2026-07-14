export type HardenedEntitlementPurpose = 'status' | 'switch' | 'update';

export type HardenedEntitlementErrorCode =
    | 'unauthorized'
    | 'unpublished'
    | 'expired'
    | 'unavailable';

export type LocalRegistryAccess = 'ready' | 'missing' | 'decrypt_failed' | 'rejected';

export interface RegistryRequirement {
    registry_host: string;
    package_scope: string;
    credential_instructions: string;
    supports_pull_token: boolean;
}

export interface HardenedEntitlement {
    hardened_build_access: boolean;
    channel: 'hardened';
    allowed_image_ref: string;
    pin_recommendation: string;
    registry_requirement: RegistryRequirement;
    checked_at: string;
}

export interface HardenedEntitlementRequest {
    license_key: string;
    instance_id: string;
    purpose: HardenedEntitlementPurpose;
    requested_version?: string;
}

export type HardenedEntitlementResult =
    | { success: true; entitlement: HardenedEntitlement }
    | { success: false; code: HardenedEntitlementErrorCode };
