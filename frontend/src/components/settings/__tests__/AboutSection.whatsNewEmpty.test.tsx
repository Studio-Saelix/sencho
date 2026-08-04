import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AboutSection } from '../AboutSection';

beforeAll(() => {
    // Vite injects this at build time; tests need a stand-in.
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
});

// Separate file so entries can be mocked empty at module scope, matching the
// state that ships until the first entry is authored.
vi.mock('@/whats-new/entries', () => ({ whatsNewEntries: [] }));

vi.mock('@/context/LicenseContext', () => ({
    useLicense: () => ({
        license: {
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
        },
        isPaid: false,
        loading: false,
        licenseStatus: 'ready',
        licenseReady: true,
        refresh: vi.fn(),
        activate: vi.fn(),
        deactivate: vi.fn(),
    }),
}));

vi.mock('@/components/TierBadge', () => ({
    TierBadge: () => <span>Community</span>,
}));

vi.mock('@/hooks/useWhatsNewPreference', () => ({
    useWhatsNewPreference: () => ({ enabled: true, setEnabled: vi.fn(), hasUnseen: false, markSeen: vi.fn() }),
}));

describe("AboutSection with no What's New entries authored", () => {
    it('hides the Preferences section entirely, so no toggle describes an absent icon', () => {
        render(<AboutSection />);
        expect(screen.queryByText('Preferences')).toBeNull();
        expect(screen.queryByText("Show What's New")).toBeNull();
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('still renders the rest of the About panel', () => {
        render(<AboutSection />);
        expect(screen.getByText('Plan status')).toBeTruthy();
        expect(screen.getByText('Source code')).toBeTruthy();
    });
});
