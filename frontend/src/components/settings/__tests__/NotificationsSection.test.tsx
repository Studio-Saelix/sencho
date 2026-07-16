/**
 * NotificationsSection Apprise channel: four-tab masthead, secret-preserving
 * save (omit redacted url/config when not dirty), and Test gating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MastheadMetadataItem } from '@/components/ui/PageMasthead';

const { masthead } = vi.hoisted(() => ({
    masthead: { last: null as MastheadMetadataItem[] | null },
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
        loading: vi.fn(),
        dismiss: vi.fn(),
    },
}));
vi.mock('@/context/NodeContext', () => ({
    useNodes: () => ({ activeNode: { id: 'local' } }),
}));
vi.mock('../MastheadStatsContext', () => ({
    useMastheadStats: (stats: MastheadMetadataItem[] | null) => {
        masthead.last = stats;
    },
}));

import { apiFetch } from '@/lib/api';
import { NotificationsSection } from '../NotificationsSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const REDACTED_APPRISE = {
    type: 'apprise',
    url: 'http://apprise.local/notify/<redacted>',
    enabled: true,
    secrets_redacted: true,
    config: {
        mode: 'keyed' as const,
        tags: 'ops',
        has_urls: false,
        providers: [] as string[],
    },
};

function agentsResponse(agents: unknown[] = [REDACTED_APPRISE]) {
    return { ok: true, json: async () => agents };
}

function findAgentsPost() {
    return mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/agents' && (opts as { method?: string } | undefined)?.method === 'POST',
    );
}

describe('NotificationsSection', () => {
    beforeEach(() => {
        mockedFetch.mockReset();
        masthead.last = null;
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse();
            if (url === '/agents' && opts?.method === 'POST') {
                return { ok: true, json: async () => ({}) };
            }
            return { ok: true, json: async () => ([]) };
        });
    });

    it('renders four channel tabs including Apprise', async () => {
        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByRole('tab', { name: 'Apprise' })).toBeInTheDocument());
        expect(screen.getByRole('tab', { name: 'Discord' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Slack' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Webhook' })).toBeInTheDocument();
    });

    it('reports CHANNELS as n/4 in the masthead', async () => {
        render(<NotificationsSection />);
        await waitFor(() => expect(masthead.last?.[0]?.value).toBe('1/4'));
        expect(masthead.last?.[0]?.label).toBe('CHANNELS');
    });

    it('omits redacted Apprise url and config on save when not dirty', async () => {
        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        await waitFor(() => expect(screen.getByLabelText(/Apprise endpoint/i)).toHaveValue(
            'http://apprise.local/notify/<redacted>',
        ));

        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(findAgentsPost()).toBeTruthy());
        const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
        expect(body).toEqual({ type: 'apprise', enabled: true });
        expect(body).not.toHaveProperty('url');
        expect(body).not.toHaveProperty('config');
        expect(JSON.stringify(body)).not.toContain('<redacted>');
        expect(JSON.stringify(body)).not.toContain('has_urls');
        expect(JSON.stringify(body)).not.toContain('providers');
    });

    it('sends only raw url/config fields when Apprise fields are edited', async () => {
        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));

        const endpoint = await screen.findByLabelText(/Apprise endpoint/i);
        await userEvent.clear(endpoint);
        await userEvent.type(endpoint, 'http://apprise.local/notify/new-key');

        const tags = screen.getByLabelText(/^Tags$/i);
        await userEvent.clear(tags);
        await userEvent.type(tags, 'night');

        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(findAgentsPost()).toBeTruthy());
        const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
        expect(body).toEqual({
            type: 'apprise',
            enabled: true,
            url: 'http://apprise.local/notify/new-key',
            config: { tags: 'night' },
        });
        expect(body.config).not.toHaveProperty('has_urls');
        expect(body.config).not.toHaveProperty('providers');
        expect(body.config).not.toHaveProperty('mode');
    });

    it('sends keyed config when creating with endpoint only (no tags)', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/agents' && opts?.method === 'POST') {
                return { ok: true, json: async () => ({}) };
            }
            return { ok: true, json: async () => ([]) };
        });

        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));

        const endpoint = await screen.findByLabelText(/Apprise endpoint/i);
        await userEvent.clear(endpoint);
        await userEvent.type(endpoint, 'http://apprise.local/notify/create-key');
        expect(screen.getByLabelText(/^Tags$/i)).toBeInTheDocument();
        expect(screen.queryByLabelText(/Destination URLs/i)).toBeNull();

        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(findAgentsPost()).toBeTruthy());
        const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
        expect(body).toEqual({
            type: 'apprise',
            enabled: false,
            url: 'http://apprise.local/notify/create-key',
            config: { tags: '' },
        });
    });

    it('shows Destination URLs for stateless endpoints and hides Tags', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) {
                return agentsResponse([{
                    ...REDACTED_APPRISE,
                    url: 'http://apprise.local/notify',
                    config: {
                        mode: 'stateless',
                        has_urls: true,
                        providers: ['discord'],
                        url_count: 1,
                        urls: '',
                    },
                }]);
            }
            return { ok: true, json: async () => ({}) };
        });

        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));

        expect(await screen.findByLabelText(/Destination URLs/i)).toBeInTheDocument();
        expect(screen.queryByLabelText(/^Tags$/i)).toBeNull();
    });

    it('disables Test when the Apprise endpoint is still redacted', async () => {
        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled());
        expect(screen.getByText(/Replace the redacted endpoint/i)).toBeInTheDocument();
    });
});
