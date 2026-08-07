/**
 * Focused coverage for the "Keep active sessions alive" (session_sliding_refresh)
 * toggle added to UsersSection. Does not re-test the pre-existing user CRUD
 * table, which has no prior test file and is out of this change's scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: true, user: { username: 'admin' } }) }));
vi.mock('../MastheadStatsContext', () => ({ useMastheadStats: () => {} }));
vi.mock('@/components/CapabilityGate', () => ({ CapabilityGate: ({ children }: { children: React.ReactNode }) => children }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { UsersSection } from '../UsersSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToastError = toast.error as unknown as ReturnType<typeof vi.fn>;

function mockApi(settingsOverrides: Record<string, string> = {}) {
    mockedFetch.mockImplementation(async (path: string, opts?: { method?: string }) => {
        if (path === '/users') return { ok: true, json: async () => [] };
        if (path === '/settings' && (!opts?.method || opts.method === 'GET')) {
            return { ok: true, json: async () => ({ session_sliding_refresh: '1', ...settingsOverrides }) };
        }
        if (path === '/settings' && opts?.method === 'PATCH') {
            return { ok: true, json: async () => ({ success: true }) };
        }
        return { ok: true, json: async () => ({}) };
    });
}

beforeEach(() => {
    mockedFetch.mockReset();
    mockApi();
});

describe('UsersSection > session policy', () => {
    it('renders the toggle in the ON state from a fresh-install default payload', async () => {
        render(<UsersSection />);
        const toggle = await screen.findByRole('switch');
        await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    });

    it('shows an error state and does not present the default value as real when the load fails', async () => {
        mockedFetch.mockImplementation(async (path: string, opts?: { method?: string }) => {
            if (path === '/users') return { ok: true, json: async () => [] };
            if (path === '/settings' && (!opts?.method || opts.method === 'GET')) {
                return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
            }
            return { ok: true, json: async () => ({}) };
        });
        render(<UsersSection />);

        await screen.findByText(/could not load session policy/i);
        expect(screen.queryByRole('switch')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /save session policy/i })).not.toBeInTheDocument();
        expect(mockedToastError).toHaveBeenCalled();
    });

    it('renders OFF when the settings payload has it disabled, and PATCHes only that key on save', async () => {
        mockApi({ session_sliding_refresh: '0' });
        render(<UsersSection />);
        const toggle = await screen.findByRole('switch');
        await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));

        await userEvent.click(toggle);
        const save = await screen.findByRole('button', { name: /save session policy/i });
        await userEvent.click(save);

        await waitFor(() => {
            const patchCall = [...mockedFetch.mock.calls].reverse().find((c) => c[1]?.method === 'PATCH');
            expect(patchCall).toBeDefined();
            expect(JSON.parse(patchCall![1].body as string)).toEqual({ session_sliding_refresh: '1' });
        });
    });
});
