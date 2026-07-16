/**
 * NotificationRoutingSection Apprise channel: tab render and secret-preserving
 * edit save (omit redacted channel_url/config when not dirty).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
    useNodes: () => ({
        nodes: [{ id: 1, type: 'local', name: 'Local' }],
        hasCapability: () => true,
        activeNode: { id: 1, type: 'local', name: 'Local' },
        activeNodeMeta: { version: '1.0.0' },
    }),
}));
vi.mock('@/components/CapabilityGate', () => ({
    CapabilityGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../MastheadStatsContext', () => ({
    useMastheadStats: () => {},
}));

import { apiFetch } from '@/lib/api';
import { NotificationRoutingSection } from '../NotificationRoutingSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const APPRISE_ROUTE = {
    id: 42,
    name: 'Ops Apprise',
    node_id: null,
    stack_patterns: ['app'],
    label_ids: null,
    categories: null,
    channel_type: 'apprise',
    channel_url: 'http://apprise.local/notify/<redacted>',
    config: {
        mode: 'keyed',
        tags: 'ops',
        has_urls: false,
        providers: [],
    },
    priority: 0,
    enabled: true,
    created_at: 1,
    updated_at: 1,
};

function findRoutePut() {
    return mockedFetch.mock.calls.find(
        ([url, opts]) =>
            url === '/notification-routes/42'
            && (opts as { method?: string } | undefined)?.method === 'PUT',
    );
}

describe('NotificationRoutingSection', () => {
    beforeEach(() => {
        mockedFetch.mockReset();
        mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (url === '/notification-routes' && !opts?.method) {
                return { ok: true, json: async () => [APPRISE_ROUTE] };
            }
            if (url === '/stacks') return { ok: true, json: async () => ['app'] };
            if (url === '/labels') return { ok: true, json: async () => [] };
            if (url === '/notification-routes/42' && opts?.method === 'PUT') {
                return { ok: true, json: async () => APPRISE_ROUTE };
            }
            return { ok: true, json: async () => ([]) };
        });
    });

    it('shows Apprise in the channel type tabs when creating a route', async () => {
        render(<NotificationRoutingSection />);
        await waitFor(() => expect(screen.getByText('Ops Apprise')).toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: /Add route/i }));
        expect(await screen.findByRole('tab', { name: 'Apprise' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('tab', { name: 'Apprise' }));
        expect(screen.getByPlaceholderText('http://apprise.local/notify')).toBeInTheDocument();
    });

    it('omits redacted Apprise channel_url and config on edit save when not dirty', async () => {
        render(<NotificationRoutingSection />);
        await waitFor(() => expect(screen.getByText('Ops Apprise')).toBeInTheDocument());

        const card = screen.getByText('Ops Apprise').closest('.rounded-lg');
        expect(card).toBeTruthy();
        const editBtn = card!.querySelector('svg.lucide-pencil')?.closest('button');
        expect(editBtn).toBeTruthy();
        await userEvent.click(editBtn!);

        expect(await screen.findByText('Edit routing rule')).toBeInTheDocument();
        const nameInput = screen.getByPlaceholderText('e.g. Production alerts');
        expect(nameInput).toHaveValue('Ops Apprise');
        expect(screen.getByDisplayValue('http://apprise.local/notify/<redacted>')).toBeInTheDocument();

        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, 'Ops Apprise renamed');

        await userEvent.click(screen.getByRole('button', { name: 'Update' }));

        await waitFor(() => expect(findRoutePut()).toBeTruthy());
        const body = JSON.parse((findRoutePut()![1] as { body: string }).body);
        expect(body.name).toBe('Ops Apprise renamed');
        expect(body.channel_type).toBe('apprise');
        expect(body).not.toHaveProperty('channel_url');
        expect(body).not.toHaveProperty('config');
        expect(JSON.stringify(body)).not.toContain('<redacted>');
        expect(JSON.stringify(body)).not.toContain('has_urls');
        expect(JSON.stringify(body)).not.toContain('providers');
    });
});
