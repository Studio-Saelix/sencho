import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetSystemState, mockPost } = vi.hoisted(() => ({
    mockGetSystemState: vi.fn(),
    mockPost: vi.fn(),
}));

vi.mock('../services/DatabaseService', () => ({
    DatabaseService: {
        getInstance: () => ({
            getSystemState: mockGetSystemState,
        }),
    },
}));

vi.mock('axios', () => ({
    default: {
        post: mockPost,
        isAxiosError: vi.fn(),
    },
}));

import { validateAllowedImageRefAgainstRequirement } from '../helpers/allowedImageRef';
import { HardenedEntitlementService } from '../services/HardenedEntitlementService';

const registryRequirement = {
    registry_host: 'ghcr.io',
    package_scope: 'studio-saelix/sencho-hardened',
    credential_instructions: 'Create a pull token.',
    supports_pull_token: true,
};

const entitlementFixture = {
    hardened_build_access: true,
    channel: 'hardened',
    allowed_image_ref: 'ghcr.io/studio-saelix/sencho-hardened@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pin_recommendation: 'Use the supplied digest.',
    registry_requirement: registryRequirement,
    checked_at: '2026-07-13T12:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
    HardenedEntitlementService.getInstance().invalidateCache();
    mockGetSystemState.mockImplementation((key: string) => ({
        license_key: 'license-for-test',
        instance_id: 'instance-for-test',
    })[key] ?? '');
    delete process.env.SENCHO_ASSURANCE_ENTITLEMENT_STUB;
});

describe('allowed Hardened image references', () => {
    it('rejects a bare digest', () => {
        expect(validateAllowedImageRefAgainstRequirement(
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            registryRequirement,
        )).toBe(false);
    });

    it('rejects an image outside the entitled package scope', () => {
        expect(validateAllowedImageRefAgainstRequirement(
            'ghcr.io/studio-saelix/other@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            registryRequirement,
        )).toBe(false);
    });
});

describe('HardenedEntitlementService', () => {
    it('returns the entitled stub response', async () => {
        process.env.SENCHO_ASSURANCE_ENTITLEMENT_STUB = 'entitled';

        await expect(HardenedEntitlementService.getInstance().getEntitlement('status'))
            .resolves.toMatchObject({
                success: true,
                entitlement: {
                    ...entitlementFixture,
                    checked_at: expect.any(String),
                },
            });
    });

    it('returns the unauthorized stub response', async () => {
        process.env.SENCHO_ASSURANCE_ENTITLEMENT_STUB = 'unauthorized';

        await expect(HardenedEntitlementService.getInstance().getEntitlement('status'))
            .resolves.toEqual({ success: false, code: 'unauthorized' });
    });

    it('invalidates a cached status entitlement', async () => {
        mockPost.mockResolvedValue({ status: 200, data: entitlementFixture });
        const service = HardenedEntitlementService.getInstance();

        await service.getEntitlement('status');
        await service.getEntitlement('status');
        expect(mockPost).toHaveBeenCalledTimes(1);

        service.invalidateCache();
        await service.getEntitlement('status');
        expect(mockPost).toHaveBeenCalledTimes(2);
    });
});
