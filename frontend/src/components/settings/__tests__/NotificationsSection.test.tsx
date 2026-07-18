/**
 * NotificationsSection Apprise channel: four-tab masthead, secret-preserving
 * save (omit redacted url/config when not dirty), and Test gating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MastheadMetadataItem } from '@/components/ui/PageMasthead';

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
const { masthead, nodeState } = vi.hoisted(() => ({
    masthead: { last: null as MastheadMetadataItem[] | null },
    nodeState: { activeNode: { id: 1 } as { id: number } },
}));
vi.mock('@/context/NodeContext', () => ({
    useNodes: () => ({ activeNode: nodeState.activeNode }),
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
        nodeState.activeNode = { id: 1 };
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
        // Public DTO masks the notify key; Tags must stay editable without re-entering the raw key.
        expect(screen.getByLabelText(/^Tags$/i)).toBeInTheDocument();

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

    it('omits url and config on stateless enable-only save so destinations are preserved', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) {
                return agentsResponse([{
                    type: 'apprise',
                    url: 'http://apprise.local/notify',
                    enabled: false,
                    secrets_redacted: true,
                    config: {
                        mode: 'stateless',
                        has_urls: true,
                        providers: ['discord'],
                        url_count: 1,
                    },
                }]);
            }
            if (url === '/agents' && opts?.method === 'POST') {
                return { ok: true, json: async () => ({}) };
            }
            return { ok: true, json: async () => ([]) };
        });

        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        await waitFor(() => expect(screen.getByLabelText(/Apprise endpoint/i)).toHaveValue('http://apprise.local/notify'));

        await userEvent.click(screen.getByRole('switch'));
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(findAgentsPost()).toBeTruthy());
        const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
        expect(body).toEqual({ type: 'apprise', enabled: true });
        expect(body).not.toHaveProperty('url');
        expect(body).not.toHaveProperty('config');
    });

    it('sends destination URLs when stateless destinations are edited', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) {
                return agentsResponse([{
                    type: 'apprise',
                    url: 'http://apprise.local/notify',
                    enabled: true,
                    secrets_redacted: true,
                    config: { mode: 'stateless', has_urls: true, url_count: 1, providers: ['discord'] },
                }]);
            }
            if (url === '/agents' && opts?.method === 'POST') {
                return { ok: true, json: async () => ({}) };
            }
            return { ok: true, json: async () => ([]) };
        });

        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        const dest = await screen.findByLabelText(/Destination URLs/i);
        await userEvent.clear(dest);
        await userEvent.type(dest, 'discord://hook');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(findAgentsPost()).toBeTruthy());
        const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
        expect(body).toEqual({
            type: 'apprise',
            enabled: true,
            config: { urls: 'discord://hook' },
        });
        expect(body).not.toHaveProperty('url');
    });

    it('omits config on same-mode endpoint-only edit so destinations stay preserved', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) {
                return agentsResponse([{
                    type: 'apprise',
                    url: 'http://apprise.local/notify',
                    enabled: true,
                    secrets_redacted: true,
                    config: { mode: 'stateless', has_urls: true, url_count: 1, providers: ['discord'] },
                }]);
            }
            if (url === '/agents' && opts?.method === 'POST') {
                return { ok: true, json: async () => ({}) };
            }
            return { ok: true, json: async () => ([]) };
        });

        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        const endpoint = await screen.findByLabelText(/Apprise endpoint/i);
        await userEvent.clear(endpoint);
        await userEvent.type(endpoint, 'http://apprise.local:8080/notify');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(findAgentsPost()).toBeTruthy());
        const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
        expect(body).toEqual({
            type: 'apprise',
            enabled: true,
            url: 'http://apprise.local:8080/notify',
        });
        expect(body).not.toHaveProperty('config');
    });
    it('shows Destination URLs for a query-bearing stateless endpoint', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            return { ok: true, json: async () => ({}) };
        });

        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        const endpoint = await screen.findByLabelText(/Apprise endpoint/i);
        await userEvent.clear(endpoint);
        await userEvent.type(endpoint, 'http://apprise.local/notify?token=x');
        expect(await screen.findByLabelText(/Destination URLs/i)).toBeInTheDocument();
        expect(screen.queryByLabelText(/^Tags$/i)).toBeNull();
    });

    it('disables Test when the Apprise endpoint is still redacted', async () => {
        render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled());
        expect(screen.getByText(/Replace the redacted endpoint/i)).toBeInTheDocument();
    });

    it('replaces agent state when switching to a node with no agents', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) {
                if (nodeState.activeNode.id === 1) return agentsResponse([REDACTED_APPRISE]);
                return agentsResponse([]);
            }
            return { ok: true, json: async () => ({}) };
        });

        const { rerender } = render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        await waitFor(() => expect(screen.getByLabelText(/Apprise endpoint/i)).toHaveValue('http://apprise.local/notify/<redacted>'));
        expect(masthead.last?.[0]?.value).toBe('1/4');

        nodeState.activeNode = { id: 2 };
        rerender(<NotificationsSection />);
        await waitFor(() => expect(masthead.last?.[0]?.value).toBe('0/4'));
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        await waitFor(() => expect(screen.getByLabelText(/Apprise endpoint/i)).toHaveValue(''));
    });

    it('ignores a stale agents body when json() resolves after a node switch', async () => {
        let releaseNode1Body: (() => void) | undefined;
        const node1BodyGate = new Promise<void>((resolve) => { releaseNode1Body = resolve; });

        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string; nodeId?: number | null }) => {
            if (url === '/agents' && !opts?.method) {
                const targetId = opts?.nodeId ?? nodeState.activeNode.id;
                if (targetId === 1) {
                    // Response headers arrive immediately; body stays pending across the switch.
                    return {
                        ok: true,
                        json: async () => {
                            await node1BodyGate;
                            return [REDACTED_APPRISE];
                        },
                    };
                }
                return agentsResponse([]);
            }
            return { ok: true, json: async () => ({}) };
        });

        const { rerender } = render(<NotificationsSection />);
        await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
        expect(mockedFetch.mock.calls[0]?.[1]).toMatchObject({ nodeId: 1 });

        nodeState.activeNode = { id: 2 };
        rerender(<NotificationsSection />);
        await waitFor(() => expect(masthead.last?.[0]?.value).toBe('0/4'));
        await waitFor(() =>
            expect(mockedFetch.mock.calls.some((call) => (call[1] as { nodeId?: number } | undefined)?.nodeId === 2)).toBe(true),
        );

        releaseNode1Body?.();
        await new Promise((r) => setTimeout(r, 40));
        expect(masthead.last?.[0]?.value).toBe('0/4');
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        expect(screen.getByLabelText(/Apprise endpoint/i)).toHaveValue('');
    });

});
