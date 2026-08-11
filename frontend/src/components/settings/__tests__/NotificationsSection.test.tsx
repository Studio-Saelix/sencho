/**
 * NotificationsSection Apprise channel: four-tab masthead, secret-preserving
 * save (omit redacted url/config when not dirty), and Test gating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
const authState = {
    isAdmin: true,
    permissionsReady: true,
    permissionsStatus: 'ready' as const,
    can: (action: string) => authState.isAdmin || action === 'never',
};
vi.mock('@/context/AuthContext', () => ({
    useAuth: () => authState,
}));
vi.mock('../MastheadStatsContext', () => ({
    useMastheadStats: (stats: MastheadMetadataItem[] | null) => {
        masthead.last = stats;
    },
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
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
        authState.isAdmin = true;
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string; nodeId?: number }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse();
            if (url === '/agents' && opts?.method === 'POST') {
                return { ok: true, json: async () => ({}) };
            }
            if (url === '/settings' && !opts?.method) {
                return { ok: true, json: async () => ({ notification_dispatch_retries: '0' }) };
            }
            if (url === '/settings' && opts?.method === 'PATCH') {
                return { ok: true, json: async () => ({ success: true }) };
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
        await waitFor(() => expect(masthead.last?.[0]?.value).toBe('1/5'));
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
            if (url === '/settings' && !opts?.method) {
                return { ok: true, json: async () => ({ notification_dispatch_retries: '0' }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const { rerender } = render(<NotificationsSection />);
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        await waitFor(() => expect(screen.getByLabelText(/Apprise endpoint/i)).toHaveValue('http://apprise.local/notify/<redacted>'));
        expect(masthead.last?.[0]?.value).toBe('1/5');

        nodeState.activeNode = { id: 2 };
        rerender(<NotificationsSection />);
        await waitFor(() => expect(masthead.last?.[0]?.value).toBe('0/5'));
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
            if (url === '/settings' && !opts?.method) {
                return { ok: true, json: async () => ({ notification_dispatch_retries: '0' }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const { rerender } = render(<NotificationsSection />);
        await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
        expect(mockedFetch.mock.calls[0]?.[1]).toMatchObject({ nodeId: 1 });

        nodeState.activeNode = { id: 2 };
        rerender(<NotificationsSection />);
        await waitFor(() => expect(masthead.last?.[0]?.value).toBe('0/5'));
        await waitFor(() =>
            expect(mockedFetch.mock.calls.some((call) => (call[1] as { nodeId?: number } | undefined)?.nodeId === 2)).toBe(true),
        );

        releaseNode1Body?.();
        await new Promise((r) => setTimeout(r, 40));
        expect(masthead.last?.[0]?.value).toBe('0/5');
        await userEvent.click(await screen.findByRole('tab', { name: 'Apprise' }));
        expect(screen.getByLabelText(/Apprise endpoint/i)).toHaveValue('');
    });

    it('preserves CHANNELS masthead and loads retries with explicit nodeId', async () => {
        render(<NotificationsSection />);
        await waitFor(() => expect(masthead.last?.[0]).toMatchObject({ label: 'CHANNELS', value: '1/5' }));
        await waitFor(() =>
            expect(mockedFetch.mock.calls.some(
                ([url, opts]) => url === '/settings' && (opts as { nodeId?: number })?.nodeId === 1,
            )).toBe(true),
        );
        expect(screen.getByText('Delivery retries')).toBeInTheDocument();
        expect(screen.getByText('0')).toBeInTheDocument();
        const discordTab = screen.getByRole('tab', { name: 'Discord' });
        const retriesHeading = screen.getByText('Delivery retries');
        expect(
            discordTab.compareDocumentPosition(retriesHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it('PATCHes only notification_dispatch_retries when saving retries', async () => {
        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());
        const chipButton = screen.getByRole('button', { name: /0\s*extra/i });
        await userEvent.click(chipButton);
        const input = screen.getByRole('spinbutton');
        await userEvent.clear(input);
        await userEvent.type(input, '2');
        await userEvent.keyboard('{Enter}');
        await userEvent.click(screen.getByRole('button', { name: 'Save retries' }));
        await waitFor(() => {
            const patch = mockedFetch.mock.calls.find(
                ([url, opts]) => url === '/settings' && (opts as { method?: string })?.method === 'PATCH',
            );
            expect(patch).toBeTruthy();
            expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({ notification_dispatch_retries: '2' });
            expect((patch![1] as { nodeId?: number }).nodeId).toBe(1);
        });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save retries' })).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /Saving/i })).toBeNull();
        expect(findAgentsPost()).toBeUndefined();
    });

    it('disables delivery retries controls for non-admins', async () => {
        authState.isAdmin = false;
        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('Delivery retries')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'Save retries' })).toBeDisabled();
    });

    it('ignores a stale settings body after a node switch', async () => {
        let releaseNode1Settings: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => { releaseNode1Settings = resolve; });

        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string; nodeId?: number | null }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/settings' && !opts?.method) {
                const targetId = opts?.nodeId ?? nodeState.activeNode.id;
                if (targetId === 1) {
                    return {
                        ok: true,
                        json: async () => {
                            await gate;
                            return { notification_dispatch_retries: '3' };
                        },
                    };
                }
                return { ok: true, json: async () => ({ notification_dispatch_retries: '0' }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const { rerender } = render(<NotificationsSection />);
        nodeState.activeNode = { id: 2 };
        rerender(<NotificationsSection />);
        await waitFor(() =>
            expect(mockedFetch.mock.calls.some(
                ([url, opts]) => url === '/settings' && (opts as { nodeId?: number })?.nodeId === 2,
            )).toBe(true),
        );
        releaseNode1Settings?.();
        await new Promise((r) => setTimeout(r, 40));
        expect(screen.getByRole('button', { name: /0\s*extra/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /3\s*extra/i })).toBeNull();
    });

    it('does not present default 0 as saved when settings GET fails', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/settings' && !opts?.method) {
                return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
        expect(screen.queryByText('saved')).toBeNull();
        expect(screen.getByRole('button', { name: 'Save retries' })).toBeDisabled();
        expect(screen.getByRole('button', { name: /0\s*extra/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Retry load' })).toBeInTheDocument();
    });

    it('disables retry controls until the settings GET succeeds', async () => {
        let releaseGet: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => { releaseGet = resolve; });

        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/settings' && !opts?.method) {
                return {
                    ok: true,
                    json: async () => {
                        await gate;
                        return { notification_dispatch_retries: '3' };
                    },
                };
            }
            return { ok: true, json: async () => ({}) };
        });

        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('loading')).toBeInTheDocument());
        expect(screen.queryByText('saved')).toBeNull();
        expect(screen.getByRole('button', { name: /0\s*extra/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Save retries' })).toBeDisabled();

        releaseGet?.();
        await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: /3\s*extra/i })).not.toBeDisabled();
    });

    it('keeps PATCH result when a deferred Reload GET returns stale data', async () => {
        let releaseStale: (() => void) | undefined;
        const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
        let settingsGetCount = 0;

        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/settings' && !opts?.method) {
                settingsGetCount += 1;
                if (settingsGetCount === 1) {
                    return { ok: true, json: async () => ({ notification_dispatch_retries: '0' }) };
                }
                return {
                    ok: true,
                    json: async () => {
                        await staleGate;
                        return { notification_dispatch_retries: '0' };
                    },
                };
            }
            if (url === '/settings' && opts?.method === 'PATCH') {
                return { ok: true, json: async () => ({ success: true }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());

        // Start a soft reload, then edit+save while that GET is still in flight.
        await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
        await waitFor(() => expect(mockedFetch.mock.calls.filter(
            ([url, opts]) => url === '/settings' && !(opts as { method?: string })?.method,
        ).length).toBeGreaterThan(1));

        await userEvent.click(screen.getByRole('button', { name: /0\s*extra/i }));
        const input = screen.getByRole('spinbutton');
        await userEvent.clear(input);
        await userEvent.type(input, '2');
        await userEvent.keyboard('{Enter}');
        await userEvent.click(screen.getByRole('button', { name: 'Save retries' }));
        await waitFor(() => expect(screen.getByRole('button', { name: /2\s*extra/i })).toBeInTheDocument());
        await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());

        releaseStale?.();
        await new Promise((r) => setTimeout(r, 40));
        expect(screen.getByRole('button', { name: /2\s*extra/i })).toBeInTheDocument();
        expect(screen.getByText('saved')).toBeInTheDocument();
    });


    it('clears Saving after edit-during-save supersedes the PATCH apply', async () => {
        let releasePatch: (() => void) | undefined;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });

        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/settings' && !opts?.method) {
                return { ok: true, json: async () => ({ notification_dispatch_retries: '0' }) };
            }
            if (url === '/settings' && opts?.method === 'PATCH') {
                await patchGate;
                return { ok: true, json: async () => ({ success: true }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());

        await userEvent.click(screen.getByRole('button', { name: /0\s*extra/i }));
        let input = screen.getByRole('spinbutton');
        await userEvent.clear(input);
        await userEvent.type(input, '2');
        await userEvent.keyboard('{Enter}');
        await userEvent.click(screen.getByRole('button', { name: 'Save retries' }));
        await waitFor(() => expect(screen.getByRole('button', { name: /Saving/i })).toBeInTheDocument());

        // Edit while the PATCH is in flight (bumps mutation gen).
        await userEvent.click(screen.getByRole('button', { name: /2\s*extra/i }));
        input = screen.getByRole('spinbutton');
        await userEvent.clear(input);
        await userEvent.type(input, '3');
        await userEvent.keyboard('{Enter}');

        releasePatch?.();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save retries' })).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /Saving/i })).toBeNull();
        expect(screen.getByRole('button', { name: /3\s*extra/i })).toBeInTheDocument();
        expect(screen.getByText('edited')).toBeInTheDocument();
    });

    it('clears Saving when the active node changes during an in-flight PATCH', async () => {
        let releasePatch: (() => void) | undefined;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });

        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string; nodeId?: number }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/settings' && !opts?.method) {
                const id = opts?.nodeId ?? nodeState.activeNode.id;
                return { ok: true, json: async () => ({ notification_dispatch_retries: id === 1 ? '0' : '1' }) };
            }
            if (url === '/settings' && opts?.method === 'PATCH') {
                await patchGate;
                return { ok: true, json: async () => ({ success: true }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const { rerender } = render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());

        await userEvent.click(screen.getByRole('button', { name: /0\s*extra/i }));
        const input = screen.getByRole('spinbutton');
        await userEvent.clear(input);
        await userEvent.type(input, '2');
        await userEvent.keyboard('{Enter}');
        await userEvent.click(screen.getByRole('button', { name: 'Save retries' }));
        await waitFor(() => expect(screen.getByRole('button', { name: /Saving/i })).toBeInTheDocument());

        nodeState.activeNode = { id: 2 };
        rerender(<NotificationsSection />);
        await waitFor(() => expect(screen.queryByRole('button', { name: /Saving/i })).toBeNull());
        await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'Save retries' })).toBeInTheDocument();

        releasePatch?.();
        await new Promise((r) => setTimeout(r, 40));
        expect(screen.queryByRole('button', { name: /Saving/i })).toBeNull();
        expect(screen.getByRole('button', { name: /1\s*extra/i })).toBeInTheDocument();
    });



    it('treats invalid stored notification_dispatch_retries as error, not clamped saved', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/settings' && !opts?.method) {
                return { ok: true, json: async () => ({ notification_dispatch_retries: '9' }) };
            }
            if (url === '/settings' && opts?.method === 'PATCH') {
                return { ok: true, json: async () => ({ success: true }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
        expect(screen.queryByText('saved')).toBeNull();
        expect(screen.getByText(/Stored delivery retries value is invalid/i)).toBeInTheDocument();
        // Chip may show 0 as a draft, but Save must be enabled so the operator can repair.
        expect(screen.getByRole('button', { name: 'Save retries' })).not.toBeDisabled();

        await userEvent.click(screen.getByRole('button', { name: 'Save retries' }));
        await waitFor(() => {
            const patch = mockedFetch.mock.calls.find(
                ([url, opts]) => url === '/settings' && (opts as { method?: string })?.method === 'PATCH',
            );
            expect(patch).toBeTruthy();
            expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({ notification_dispatch_retries: '0' });
        });
        await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: /0\s*extra/i })).toBeInTheDocument();
    });

    it('treats decimal stored notification_dispatch_retries as invalid, not truncated saved', async () => {
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/agents' && !opts?.method) return agentsResponse([]);
            if (url === '/settings' && !opts?.method) {
                return { ok: true, json: async () => ({ notification_dispatch_retries: '1.5' }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        render(<NotificationsSection />);
        await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
        expect(screen.queryByText('saved')).toBeNull();
        expect(screen.queryByRole('button', { name: /1\s*extra/i })).toBeNull();
        expect(screen.getByText(/Stored delivery retries value is invalid/i)).toBeInTheDocument();
    });

    describe('payload templates', () => {
        const DISCORD_AGENT = {
            type: 'discord',
            url: 'https://discord.com/api/webhooks/1/token',
            enabled: true,
            payload_template: null,
        };

        function mockDiscordAgents(discord: unknown = DISCORD_AGENT) {
            mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
                if (url === '/agents' && !opts?.method) return agentsResponse([discord]);
                if (url === '/agents' && opts?.method === 'POST') {
                    return { ok: true, json: async () => ({}) };
                }
                return { ok: true, json: async () => ([]) };
            });
        }

        // Interact only after the agents GET settles: a successful load resets
        // the template dirty flag by design, so typing before the load lands
        // would be overwritten.
        async function waitForLoadedUrl() {
            await waitFor(() => expect(screen.getByLabelText(/Webhook URL/i))
                .toHaveValue('https://discord.com/api/webhooks/1/token'));
        }

        it('opens the editor and sends the template on save', async () => {
            mockDiscordAgents();
            render(<NotificationsSection />);
            await waitForLoadedUrl();

            await userEvent.click(screen.getByRole('button', { name: 'Edit Payload' }));
            const editor = screen.getByLabelText(/Payload template/i);
            fireEvent.change(editor, { target: { value: '{"title": "{{level}}", "body": "{{message}}"}' } });

            await userEvent.click(screen.getByRole('button', { name: 'Save' }));

            await waitFor(() => expect(findAgentsPost()).toBeTruthy());
            const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
            expect(body).toMatchObject({ type: 'discord', enabled: true });
            expect(body.payload_template).toBe('{"title": "{{level}}", "body": "{{message}}"}');
        });

        it('omits payload_template from a clean save', async () => {
            mockDiscordAgents();
            render(<NotificationsSection />);
            await waitForLoadedUrl();
            await userEvent.click(screen.getByRole('button', { name: 'Save' }));

            await waitFor(() => expect(findAgentsPost()).toBeTruthy());
            const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
            expect(body).toEqual({
                type: 'discord',
                url: 'https://discord.com/api/webhooks/1/token',
                enabled: true,
            });
            expect(body).not.toHaveProperty('payload_template');
        });

        it('clears a stored template with an empty editor', async () => {
            mockDiscordAgents({
                type: 'discord',
                url: 'https://discord.com/api/webhooks/1/token',
                enabled: true,
                payload_template: '{"title": "{{level}}"}',
            });
            render(<NotificationsSection />);
            await waitForLoadedUrl();

            await userEvent.click(screen.getByRole('button', { name: 'Edit Payload' }));
            const editor = screen.getByLabelText(/Payload template/i);
            expect(editor).toHaveValue('{"title": "{{level}}"}');
            await userEvent.clear(editor);

            await userEvent.click(screen.getByRole('button', { name: 'Save' }));

            await waitFor(() => expect(findAgentsPost()).toBeTruthy());
            const body = JSON.parse((findAgentsPost()![1] as { body: string }).body);
            expect(body.payload_template).toBe('');
        });

        it('includes the current editor template in the test dispatch', async () => {
            mockDiscordAgents();
            render(<NotificationsSection />);
            await waitForLoadedUrl();

            await userEvent.click(screen.getByRole('button', { name: 'Edit Payload' }));
            fireEvent.change(screen.getByLabelText(/Payload template/i), {
                target: { value: '{"m": "{{message}}"}' },
            });

            await userEvent.click(screen.getByRole('button', { name: 'Test' }));

            await waitFor(() => {
                const testCall = mockedFetch.mock.calls.find(
                    ([url, opts]) => url === '/notifications/test'
                        && (opts as { method?: string } | undefined)?.method === 'POST',
                );
                expect(testCall).toBeTruthy();
                const body = JSON.parse((testCall![1] as { body: string }).body);
                expect(body).toMatchObject({
                    type: 'discord',
                    url: 'https://discord.com/api/webhooks/1/token',
                    payload_template: '{"m": "{{message}}"}',
                });
            });
        });

        it('keeps the editor content when the server rejects the template', async () => {
            mockDiscordAgents();
            render(<NotificationsSection />);
            await waitForLoadedUrl();

            await userEvent.click(screen.getByRole('button', { name: 'Edit Payload' }));
            const editor = screen.getByLabelText(/Payload template/i);
            fireEvent.change(editor, { target: { value: '{"a": "{{nope}}"}' } });

            mockedFetch.mockImplementationOnce(async (url: string, opts?: { method?: string }) => {
                if (url === '/agents' && opts?.method === 'POST') {
                    return {
                        ok: false,
                        status: 400,
                        json: async () => ({ error: 'payload_template Unknown template variable: {{nope}}.' }),
                    };
                }
                return { ok: true, json: async () => ({}) };
            });

            await userEvent.click(screen.getByRole('button', { name: 'Save' }));

            await waitFor(() => expect(toast.error)
                .toHaveBeenCalledWith(expect.stringContaining('Unknown template variable')));
            expect(editor).toHaveValue('{"a": "{{nope}}"}');
        });
    });
});
