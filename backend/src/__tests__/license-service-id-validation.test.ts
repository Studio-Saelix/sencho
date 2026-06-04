/**
 * Tests for the Lemon Squeezy catalog-ID guard in LicenseService.activate()
 * and validate(). Without this guard, any LS license (from any store, any
 * product) returns valid: true on /v1/licenses/validate and unlocks Sencho.
 *
 * The pure-function tests below exercise isSenchoLicenseMeta() directly. The
 * activate() / validate() tests mock axios and DatabaseService so we can drive
 * each rejection branch and assert that no DB writes happen on a non-matching
 * response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    isSenchoLicenseMeta,
    SENCHO_LS_STORE_ID,
    SENCHO_LS_PRODUCT_ID_ADMIRAL,
} from '../services/LicenseService';

// The retired Skipper product id. Greenfield: it is no longer honored, so the
// guard must reject it. Referenced explicitly so a future catalog change forces
// an intentional test update.
const RETIRED_SKIPPER_PRODUCT_ID = 924135;

const buildMeta = (overrides: Partial<{ store_id: number; product_id: number }> = {}) => ({
    store_id: SENCHO_LS_STORE_ID,
    product_id: SENCHO_LS_PRODUCT_ID_ADMIRAL,
    ...overrides,
});

describe('isSenchoLicenseMeta()', () => {
    it('returns false for undefined meta', () => {
        expect(isSenchoLicenseMeta(undefined)).toBe(false);
    });

    it('returns false when store_id is missing', () => {
        expect(isSenchoLicenseMeta({ product_id: SENCHO_LS_PRODUCT_ID_ADMIRAL })).toBe(false);
    });

    it('returns false when store_id does not match the Sencho store', () => {
        expect(isSenchoLicenseMeta(buildMeta({ store_id: 999999 }))).toBe(false);
    });

    it('returns false when product_id is missing', () => {
        expect(isSenchoLicenseMeta({ store_id: SENCHO_LS_STORE_ID })).toBe(false);
    });

    it('returns false when product_id is not the Sencho paid product', () => {
        expect(isSenchoLicenseMeta(buildMeta({ product_id: 555555 }))).toBe(false);
    });

    it('returns false for the retired Skipper product (greenfield)', () => {
        expect(isSenchoLicenseMeta(buildMeta({ product_id: RETIRED_SKIPPER_PRODUCT_ID }))).toBe(false);
    });

    it('returns true for the Sencho paid (Admiral) product', () => {
        expect(isSenchoLicenseMeta(buildMeta())).toBe(true);
    });
});

const {
    mockAxiosPost,
    mockGetSystemState,
    mockSetSystemState,
} = vi.hoisted(() => ({
    mockAxiosPost: vi.fn(),
    mockGetSystemState: vi.fn(),
    mockSetSystemState: vi.fn(),
}));

vi.mock('axios', () => ({
    default: { post: mockAxiosPost, isAxiosError: () => false },
    isAxiosError: () => false,
}));

vi.mock('../services/DatabaseService', () => ({
    DatabaseService: {
        getInstance: () => ({
            getSystemState: mockGetSystemState,
            setSystemState: mockSetSystemState,
        }),
    },
}));

describe('LicenseService.activate() - catalog ID guard', () => {
    let svc: import('../services/LicenseService').LicenseService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockGetSystemState.mockReturnValue('test-instance-uuid');
        const mod = await import('../services/LicenseService');
        svc = mod.LicenseService.getInstance();
    });

    const buildActivationResponse = (meta: object | undefined) => ({
        data: {
            activated: true,
            license_key: { id: 1, status: 'active', key: 'k', activation_limit: 1, activation_usage: 1, created_at: '2026-01-01', expires_at: null },
            instance: { id: 'ls-inst', name: 'test', created_at: '2026-01-01' },
            meta,
        },
    });

    it('rejects activation when meta is absent', async () => {
        mockAxiosPost.mockResolvedValueOnce(buildActivationResponse(undefined));
        const result = await svc.activate('VALID-LOOKING-KEY');
        expect(result.success).toBe(false);
        expect(result.error).toBe('This license key is not valid for Sencho.');
        expect(mockSetSystemState).not.toHaveBeenCalledWith('license_status', 'active');
        expect(mockSetSystemState).not.toHaveBeenCalledWith('license_key', expect.any(String));
    });

    it('rejects activation when store_id does not match', async () => {
        mockAxiosPost.mockResolvedValueOnce(buildActivationResponse(buildMeta({ store_id: 999999 })));
        const result = await svc.activate('FOREIGN-STORE-KEY');
        expect(result.success).toBe(false);
        expect(result.error).toBe('This license key is not valid for Sencho.');
        expect(mockSetSystemState).not.toHaveBeenCalledWith('license_status', 'active');
    });

    it('rejects activation when product_id is not the Sencho paid product', async () => {
        mockAxiosPost.mockResolvedValueOnce(buildActivationResponse(buildMeta({ product_id: 555555 })));
        const result = await svc.activate('OTHER-PRODUCT-KEY');
        expect(result.success).toBe(false);
        expect(mockSetSystemState).not.toHaveBeenCalledWith('license_status', 'active');
    });

    it('rejects activation for a retired Skipper-product license (greenfield)', async () => {
        mockAxiosPost.mockResolvedValueOnce(buildActivationResponse(buildMeta({ product_id: RETIRED_SKIPPER_PRODUCT_ID })));
        const result = await svc.activate('OLD-SKIPPER-KEY');
        expect(result.success).toBe(false);
        expect(mockSetSystemState).not.toHaveBeenCalledWith('license_status', 'active');
    });

    it('rejects activation when the LS response is missing the instance object', async () => {
        // Storing an empty license_instance_id would silently break later
        // validate() and deactivate() calls. Reject up front so the user
        // sees a clear error instead of a deceptive "Activated successfully".
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                activated: true,
                license_key: { id: 1, status: 'active', key: 'k', activation_limit: 1, activation_usage: 1, created_at: '2026-01-01', expires_at: null },
                meta: {
                    store_id: SENCHO_LS_STORE_ID,
                    product_id: SENCHO_LS_PRODUCT_ID_ADMIRAL,
                    variant_name: 'Admiral Monthly',
                    product_name: 'Sencho Admiral',
                },
                // instance: omitted on purpose
            },
        });
        const result = await svc.activate('NO-INSTANCE-OBJECT-KEY');
        expect(result.success).toBe(false);
        expect(result.error).toBe('License server returned an incomplete activation. Please try again.');
        expect(mockSetSystemState).not.toHaveBeenCalled();
    });

    it('rejects activation when LS returns instance with empty id', async () => {
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                activated: true,
                license_key: { id: 1, status: 'active', key: 'k', activation_limit: 1, activation_usage: 1, created_at: '2026-01-01', expires_at: null },
                instance: { id: '', name: 'test', created_at: '2026-01-01' },
                meta: {
                    store_id: SENCHO_LS_STORE_ID,
                    product_id: SENCHO_LS_PRODUCT_ID_ADMIRAL,
                    variant_name: 'Admiral Lifetime',
                    product_name: 'Sencho Admiral',
                },
            },
        });
        const result = await svc.activate('EMPTY-INSTANCE-ID-KEY');
        expect(result.success).toBe(false);
        expect(result.error).toBe('License server returned an incomplete activation. Please try again.');
        expect(mockSetSystemState).not.toHaveBeenCalled();
    });

    it('writes nothing to system_state when the catalog guard rejects', async () => {
        // Stronger than checking individual keys: any future code that adds a
        // setSystemState() call above the guard would silently break the
        // "rejection persists no state" invariant unless the test catches it.
        mockAxiosPost.mockResolvedValueOnce(buildActivationResponse(buildMeta({ store_id: 999999 })));
        await svc.activate('FOREIGN-STORE-KEY');
        expect(mockSetSystemState).not.toHaveBeenCalled();
    });

    it('succeeds and goes active for a valid Sencho paid license', async () => {
        mockAxiosPost.mockResolvedValueOnce(buildActivationResponse({
            store_id: SENCHO_LS_STORE_ID,
            product_id: SENCHO_LS_PRODUCT_ID_ADMIRAL,
            variant_name: 'Admiral Lifetime',
            product_name: 'Sencho Admiral',
        }));
        const result = await svc.activate('GOOD-ADMIRAL-KEY');
        expect(result.success).toBe(true);
        expect(mockSetSystemState).toHaveBeenCalledWith('license_status', 'active');
        expect(mockSetSystemState).toHaveBeenCalledWith('license_key', 'GOOD-ADMIRAL-KEY');
    });
});

describe('LicenseService.validate() - catalog ID guard', () => {
    let svc: import('../services/LicenseService').LicenseService;

    beforeEach(async () => {
        vi.clearAllMocks();
        // validate() reads license_key + license_instance_id from DB before
        // calling LS; provide both so the call proceeds to the response check.
        mockGetSystemState.mockImplementation((key: string) => {
            if (key === 'license_key') return 'STORED-KEY';
            if (key === 'license_instance_id') return 'stored-instance';
            return null;
        });
        const mod = await import('../services/LicenseService');
        svc = mod.LicenseService.getInstance();
    });

    const buildValidationResponse = (meta: object | undefined) => ({
        data: {
            valid: true,
            license_key: { id: 1, status: 'active', key: 'k', activation_limit: 1, activation_usage: 1, created_at: '2026-01-01', expires_at: null },
            meta,
        },
    });

    it('rejects validation when meta is absent and disables the license', async () => {
        mockAxiosPost.mockResolvedValueOnce(buildValidationResponse(undefined));
        const result = await svc.validate();
        expect(result.success).toBe(false);
        expect(result.error).toBe('License is not valid for Sencho.');
        expect(mockSetSystemState).toHaveBeenCalledWith('license_status', 'disabled');
    });

    it('rejects validation when store_id no longer matches and disables the license', async () => {
        mockAxiosPost.mockResolvedValueOnce(buildValidationResponse(buildMeta({ store_id: 999999 })));
        const result = await svc.validate();
        expect(result.success).toBe(false);
        expect(mockSetSystemState).toHaveBeenCalledWith('license_status', 'disabled');
    });

    it('keeps the license active when the catalog meta still matches', async () => {
        mockAxiosPost.mockResolvedValueOnce(buildValidationResponse({
            store_id: SENCHO_LS_STORE_ID,
            product_id: SENCHO_LS_PRODUCT_ID_ADMIRAL,
            variant_name: 'Admiral Annual',
            product_name: 'Sencho Admiral',
        }));
        const result = await svc.validate();
        expect(result.success).toBe(true);
        expect(mockSetSystemState).toHaveBeenCalledWith('license_status', 'active');
    });

    it('marks the license expired when LS reports key_status=expired even with matching meta', async () => {
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                valid: true,
                license_key: { id: 1, status: 'expired', key: 'k', activation_limit: 1, activation_usage: 1, created_at: '2026-01-01', expires_at: '2026-04-01' },
                meta: {
                    store_id: SENCHO_LS_STORE_ID,
                    product_id: SENCHO_LS_PRODUCT_ID_ADMIRAL,
                    variant_name: 'Admiral Monthly',
                    product_name: 'Sencho Admiral',
                },
            },
        });
        const result = await svc.validate();
        expect(result.success).toBe(false);
        expect(result.error).toBe('License has expired');
        expect(mockSetSystemState).toHaveBeenCalledWith('license_status', 'expired');
        expect(mockSetSystemState).not.toHaveBeenCalledWith('license_status', 'active');
    });

    it('disables the license when LS reports key_status=disabled even with matching meta', async () => {
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                valid: true,
                license_key: { id: 1, status: 'disabled', key: 'k', activation_limit: 1, activation_usage: 1, created_at: '2026-01-01', expires_at: null },
                meta: {
                    store_id: SENCHO_LS_STORE_ID,
                    product_id: SENCHO_LS_PRODUCT_ID_ADMIRAL,
                    variant_name: 'Admiral Lifetime',
                    product_name: 'Sencho Admiral',
                },
            },
        });
        const result = await svc.validate();
        expect(result.success).toBe(false);
        expect(result.error).toBe('License has been disabled');
        expect(mockSetSystemState).toHaveBeenCalledWith('license_status', 'disabled');
        expect(mockSetSystemState).not.toHaveBeenCalledWith('license_status', 'active');
    });
});
