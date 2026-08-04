import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AboutSection } from '../AboutSection';
import { ABOUT_LINK_URLS } from '../aboutLinks';

beforeAll(() => {
    // Vite injects this at build time; tests need a stand-in.
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
});

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

const mockSetEnabled = vi.fn();
vi.mock('@/hooks/useWhatsNewPreference', () => ({
    useWhatsNewPreference: () => ({ enabled: true, setEnabled: mockSetEnabled, hasUnseen: false, markSeen: vi.fn() }),
}));

// The shipped entries.json is empty, so populate it here; the empty state has its own file.
vi.mock('@/whats-new/entries', () => ({
    whatsNewEntries: [{ id: 'entry-a', title: 'A feature', blurb: 'Does a thing.' }],
}));

describe('AboutSection', () => {
    it('renders Plan status and Source, License, and Licensing docs links with exact URLs', () => {
        render(<AboutSection />);

        expect(screen.getByText('Plan status')).toBeTruthy();
        expect(screen.queryByText('License status')).toBeNull();

        const source = screen.getByRole('link', { name: 'github.com/studio-saelix/sencho →' });
        expect(source.getAttribute('href')).toBe(ABOUT_LINK_URLS.source);
        expect(source.getAttribute('target')).toBe('_blank');
        expect(source.getAttribute('rel')).toBe('noopener noreferrer');

        const license = screen.getByRole('link', { name: 'LICENSE →' });
        expect(license.getAttribute('href')).toBe(ABOUT_LINK_URLS.license);
        expect(license.getAttribute('target')).toBe('_blank');
        expect(license.getAttribute('rel')).toBe('noopener noreferrer');

        const licensingDocs = screen.getByRole('link', {
            name: 'docs.sencho.io/features/licensing →',
        });
        expect(licensingDocs.getAttribute('href')).toBe(ABOUT_LINK_URLS.licensingDocs);
        expect(licensingDocs.getAttribute('target')).toBe('_blank');
        expect(licensingDocs.getAttribute('rel')).toBe('noopener noreferrer');

        expect(screen.getByText('Source code')).toBeTruthy();
        expect(screen.getByText('AGPLv3 License')).toBeTruthy();
        expect(screen.getByText('Licensing documentation')).toBeTruthy();
    });
});

describe('AboutSection Preferences', () => {
    it('shows the Preferences section once an entry exists', () => {
        render(<AboutSection />);
        expect(screen.getByText('Preferences')).toBeTruthy();
        expect(screen.getByText("Show What's New")).toBeTruthy();
    });

    it('toggling "Show What\'s New" calls setEnabled', async () => {
        render(<AboutSection />);
        // Name-scoped so a second toggle landing in About cannot break this.
        await userEvent.click(screen.getByRole('switch', { name: /Show What's New/i }));
        expect(mockSetEnabled).toHaveBeenCalledWith(false);
    });
});
