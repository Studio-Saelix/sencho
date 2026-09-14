import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LicenseInfo } from '@/context/LicenseContext';
import type { BuildInfoContextType } from '@/context/BuildInfoProvider';

const useLicenseMock = vi.fn();

vi.mock('@/context/LicenseContext', () => ({
    useLicense: () => useLicenseMock(),
}));

vi.mock('../MastheadStatsContext', () => ({
    useMastheadStats: () => {},
}));

const useBuildInfoMock = vi.fn<() => BuildInfoContextType>(() => ({ buildInfo: null, status: 'ready', retry: vi.fn() }));

vi.mock('@/hooks/useBuildInfo', () => ({
    useBuildInfo: () => useBuildInfoMock(),
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

describe('LicenseSection pricing link', () => {
    beforeEach(() => {
        useLicenseMock.mockReset();
    });

    it('hides the pricing section on Community tier', () => {
        mockLicense(baseLicense());
        render(<LicenseSection />);
        expect(screen.queryByText('See pricing')).toBeNull();
    });

    it('shows the pricing section for an expired license', () => {
        mockLicense(
            baseLicense({
                tier: 'community',
                status: 'expired',
            }),
            false,
        );
        render(<LicenseSection />);
        expect(screen.getByText('See pricing')).toBeTruthy();
    });
});

describe('LicenseSection build rows (running identity consistency)', () => {
    beforeEach(() => {
        useLicenseMock.mockReset();
        useBuildInfoMock.mockReset();
        useBuildInfoMock.mockReturnValue({ buildInfo: null, status: 'ready', retry: vi.fn() });
        mockLicense(baseLicense());
    });

    it('renders the running Community channel and image ref, regardless of configured target', () => {
        useBuildInfoMock.mockReturnValue({
            buildInfo: {
                version: '0.97.1',
                channel: 'stable',
                imageChannel: 'community',
                imageRef: 'ghcr.io/studio-saelix/sencho:0.97.1',
                imageId: 'a'.repeat(64),
                revision: null,
                restricted: false,
            },
            status: 'ready',
            retry: vi.fn(),
        });
        render(<LicenseSection />);
        // The configured/compose target is hardened, but the running build is
        // Community: the row must show the running image, never the target.
        expect(screen.getByText('ghcr.io/studio-saelix/sencho:0.97.1')).toBeTruthy();
        expect(screen.queryByText('Hardened')).toBeNull();
    });

    it('renders a hardened running image as Hardened channel and Restricted image, not Unknown', () => {
        useBuildInfoMock.mockReturnValue({
            buildInfo: {
                version: '0.97.1',
                channel: 'stable',
                imageChannel: 'hardened',
                imageRef: null,
                imageId: 'b'.repeat(64),
                revision: null,
                restricted: true,
            },
            status: 'ready',
            retry: vi.fn(),
        });
        render(<LicenseSection />);
        expect(screen.getByText('Hardened')).toBeTruthy();
        expect(screen.getByText('Restricted')).toBeTruthy();
        expect(screen.queryByText('Unknown')).toBeNull();
    });

    it('labels an unclassifiable running image Channel Unknown, never Custom', () => {
        useBuildInfoMock.mockReturnValue({
            buildInfo: {
                version: '0.97.1',
                channel: 'unknown',
                imageChannel: 'unknown',
                imageRef: null,
                imageId: null,
                revision: null,
                restricted: false,
            },
            status: 'ready',
            retry: vi.fn(),
        });
        render(<LicenseSection />);
        expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
        expect(screen.queryByText('Custom')).toBeNull();
    });
});
