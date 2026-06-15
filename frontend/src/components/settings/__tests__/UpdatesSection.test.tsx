/**
 * UpdatesSection drives the registry-check cadence from the feature endpoint
 * (GET /image-updates/status, PUT /image-updates/interval). It must load and
 * show the current cadence, and present a read-only (disabled) control to
 * non-admins while keeping the section visible. The PUT round-trip itself is
 * covered by the backend route tests and the end-to-end check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
const authState = { isAdmin: true };
vi.mock('@/context/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 'local' } }) }));
vi.mock('../MastheadStatsContext', () => ({ useMastheadStats: () => {} }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { UpdatesSection } from '../UpdatesSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const STATUS = {
    checking: false,
    intervalMinutes: 120,
    lastCheckedAt: Date.now() - 5 * 60 * 1000,
    nextCheckAt: Date.now() + 115 * 60 * 1000,
    manualCooldownMinutes: 2,
    manualCooldownRemainingMs: 0,
};

beforeEach(() => {
    mockedFetch.mockReset();
    authState.isAdmin = true;
    mockedFetch.mockResolvedValue({ ok: true, json: async () => ({ ...STATUS }) });
});

describe('UpdatesSection', () => {
    it('loads the cadence status and enables the control for admins', async () => {
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByText(/Last checked 5m ago/)).toBeInTheDocument());
        expect(mockedFetch).toHaveBeenCalledWith('/image-updates/status');
        expect(screen.getByRole('combobox', { name: /interval/i })).toBeEnabled();
    });

    it('shows the section read-only (control disabled) for non-admins', async () => {
        authState.isAdmin = false;
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByText(/Last checked/)).toBeInTheDocument());
        expect(screen.getByRole('combobox', { name: /interval/i })).toBeDisabled();
    });

    it('toasts an error and leaves the control disabled when the status load fails', async () => {
        mockedFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'boom' }) });
        render(<UpdatesSection />);
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(screen.getByRole('combobox', { name: /interval/i })).toBeDisabled();
    });
});
