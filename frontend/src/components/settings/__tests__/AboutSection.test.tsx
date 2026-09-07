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

vi.mock('@/hooks/useBuildInfo', () => ({
    useBuildInfo: vi.fn(() => ({ buildInfo: null, status: 'ready', retry: vi.fn() })),
}));
import { useBuildInfo } from '@/hooks/useBuildInfo';
import type { BuildInfo } from '@/context/BuildInfoProvider';

const { mockCopyToClipboard, mockToastError } = vi.hoisted(() => ({
    mockCopyToClipboard: vi.fn(),
    mockToastError: vi.fn(),
}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: mockCopyToClipboard }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: mockToastError, success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const mockUseBuildInfo = vi.mocked(useBuildInfo);

function buildInfo(over: Partial<BuildInfo> = {}): BuildInfo {
    return {
        version: '0.97.1',
        channel: 'dev',
        imageChannel: 'community',
        imageRef: 'ghcr.io/studio-saelix/sencho-dev:dev',
        imageId: 'a'.repeat(64),
        revision: 'dev-abc1234',
        restricted: false,
        ...over,
    };
}

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

describe('AboutSection Build identity', () => {
    it('shows the runtime channel, current image, revision and version', () => {
        mockUseBuildInfo.mockReturnValue({ buildInfo: buildInfo(), status: 'ready', retry: vi.fn() });
        render(<AboutSection />);
        expect(screen.getByText('Dev')).toBeTruthy();
        expect(screen.getByText('ghcr.io/studio-saelix/sencho-dev:dev')).toBeTruthy();
        expect(screen.getByText('dev-abc1234')).toBeTruthy();
        expect(screen.getByText('v0.97.1')).toBeTruthy();
    });

    it('labels redacted hardened reference fields Restricted, not Unknown', () => {
        mockUseBuildInfo.mockReturnValue({
            buildInfo: buildInfo({ channel: 'stable', restricted: true, imageRef: null, revision: null }),
            status: 'ready',
            retry: vi.fn(),
        });
        render(<AboutSection />);
        expect(screen.getByText('Stable')).toBeTruthy();
        expect(screen.getAllByText('Restricted').length).toBeGreaterThanOrEqual(2);
        expect(screen.queryByText('Unknown')).toBeNull();
    });

    it('shows Unknown for reference fields when build info is unavailable', () => {
        mockUseBuildInfo.mockReturnValue({ buildInfo: null, status: 'error', retry: vi.fn() });
        render(<AboutSection />);
        expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    });

    it('wraps long image and revision tokens so they do not overflow', () => {
        mockUseBuildInfo.mockReturnValue({ buildInfo: buildInfo(), status: 'ready', retry: vi.fn() });
        render(<AboutSection />);
        expect(screen.getByText('ghcr.io/studio-saelix/sencho-dev:dev')).toHaveClass('break-all');
        expect(screen.getByText('dev-abc1234')).toHaveClass('break-all');
    });

    it('surfaces an error toast when copying the image id fails', async () => {
        mockUseBuildInfo.mockReturnValue({ buildInfo: buildInfo(), status: 'ready', retry: vi.fn() });
        mockCopyToClipboard.mockRejectedValue(new Error('clipboard blocked'));
        render(<AboutSection />);

        await userEvent.click(screen.getByRole('button', { name: /sha256:/ }));
        expect(mockCopyToClipboard).toHaveBeenCalledWith(`sha256:${'a'.repeat(64)}`);
        expect(mockToastError).toHaveBeenCalledWith('Could not copy the image id.');
    });
});
