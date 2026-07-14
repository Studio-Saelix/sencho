import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LicenseInfo } from '@/context/LicenseContext';

const useLicenseMock = vi.fn();

vi.mock('@/context/LicenseContext', () => ({
    useLicense: () => useLicenseMock(),
}));

vi.mock('../MastheadStatsContext', () => ({
    useMastheadStats: () => {},
}));

vi.mock('@/components/TierBadge', () => ({
    TierBadge: () => <span data-testid="tier-badge">tier</span>,
}));

vi.mock('@/lib/api', () => ({
    apiFetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({ channel: 'community' }),
    })),
}));

import { LicenseSection } from '../LicenseSection';

const ASSURANCE =
    'Admiral assurance (priority support, Recovery Vault, Hardened Build, and governance)';

function baseLicense(overrides: Partial<LicenseInfo> = {}): LicenseInfo {
    return {
        tier: 'community',
        status: 'community',
        customerName: null,
        productName: null,
        maskedKey: null,
        validUntil: null,
        trialDaysRemaining: null,
        instanceId: 'abcdef0123456789',
        portalUrl: null,
        isLifetime: false,
        ...overrides,
    };
}

function mockLicense(license: LicenseInfo, isPaid = license.tier === 'paid') {
    useLicenseMock.mockReturnValue({
        license,
        isPaid,
        loading: false,
        licenseStatus: 'ready',
        licenseReady: true,
        refresh: vi.fn(),
        activate: vi.fn(),
        deactivate: vi.fn(),
    });
}

describe('LicenseSection assurance copy', () => {
    beforeEach(() => {
        useLicenseMock.mockReset();
    });

    it('describes Community as the full AGPLv3 self-hosted control plane', () => {
        mockLicense(baseLicense());
        render(<LicenseSection />);
        expect(screen.getByText('Community plan. Full AGPLv3 self-hosted control plane.')).toBeTruthy();
        expect(screen.queryByText(/plan benefits/i)).toBeNull();
    });

    it('describes trial countdown as evaluating current Admiral assurance', () => {
        mockLicense(
            baseLicense({
                tier: 'paid',
                status: 'trial',
                trialDaysRemaining: 5,
            }),
            true,
        );
        render(<LicenseSection />);
        expect(
            screen.getByText(
                `Activate before the trial ends to keep ${ASSURANCE}.`,
            ),
        ).toBeTruthy();
        expect(screen.queryByText(/plan benefits/i)).toBeNull();
        expect(screen.queryByText(/Release Safety|Fleet Beacon|Production Assurance/i)).toBeNull();
    });

    it('describes expired licenses with current assurance, not generic plan benefits', () => {
        mockLicense(
            baseLicense({
                tier: 'community',
                status: 'expired',
            }),
            false,
        );
        render(<LicenseSection />);
        expect(
            screen.getByText(
                `Your Admiral license has expired. Renew to restore ${ASSURANCE}.`,
            ),
        ).toBeTruthy();
        expect(
            screen.getByText(
                `Renew to restore ${ASSURANCE}.`,
            ),
        ).toBeTruthy();
        expect(screen.queryByText(/plan benefits/i)).toBeNull();
        expect(screen.queryByText(/Release Safety|Fleet Beacon|Production Assurance/i)).toBeNull();
    });
});
