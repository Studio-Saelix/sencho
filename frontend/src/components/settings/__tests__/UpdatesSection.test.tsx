/**
 * UpdatesSection drives the registry-check cadence from the feature endpoint
 * (GET /image-updates/status, PUT /image-updates/interval). It must load and
 * show the current cadence, and present a read-only (disabled) control to
 * non-admins while keeping the section visible. The PUT round-trip itself is
 * covered by the backend route tests and the end-to-end check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
const authState = {
    isAdmin: true,
    permissionsReady: true,
    permissionsStatus: 'ready' as const,
    can: (action: string) => authState.isAdmin || action === 'never',
};
vi.mock('@/context/AuthContext', () => ({ useAuth: () => authState }));
const nodeState = { activeNode: { id: 1, type: 'local' }, activeNodeMeta: { capabilities: [] as string[] } };
vi.mock('@/context/NodeContext', () => ({ useNodes: () => nodeState }));
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
    mode: 'interval' as const,
    cronExpression: null,
    sidebarIndicators: true,
    enabled: true,
};

beforeEach(() => {
    mockedFetch.mockReset();
    authState.isAdmin = true;
    nodeState.activeNode = { id: 1, type: 'local' };
    nodeState.activeNodeMeta = { capabilities: [] };
    mockedFetch.mockResolvedValue({ ok: true, json: async () => ({ ...STATUS }) });
});

describe('UpdatesSection', () => {
    it('reads independent hub overlay and target status for a capable remote', async () => {
        nodeState.activeNode = { id: 2, type: 'remote' };
        nodeState.activeNodeMeta.capabilities = ['remote-image-inspect-v1'];
        mockedFetch.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('overlay-status') ? {
                ...STATUS, scannerOwner: 'hub', capability: 'remote-image-inspect-v1',
                nextRunAt: STATUS.nextCheckAt, intervalUnit: 'minutes', cooldownEndsAt: null,
                lastCheckedAt: Date.now() - 10 * 60 * 1000,
            } : STATUS,
        }));
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByText(/Last checked 10m ago/)).toBeInTheDocument());
        expect(screen.getByText(/Last checked 5m ago/)).toBeInTheDocument();
        expect(mockedFetch).toHaveBeenCalledWith('/image-updates/overlay-status?targetNodeId=2', { nodeId: null });
        expect(mockedFetch).toHaveBeenCalledWith('/image-updates/status', { nodeId: 2 });
        expect(mockedFetch).not.toHaveBeenCalledWith('/image-updates/status', { nodeId: null });
    });

    it('routes enable writes to the newly selected node', async () => {
        const user = userEvent.setup();
        nodeState.activeNode = { id: 2, type: 'remote' };
        const { rerender } = render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByLabelText(/Enable image update checks/i)).toBeEnabled());

        nodeState.activeNode = { id: 3, type: 'remote' };
        rerender(<UpdatesSection />);
        await waitFor(() => expect(screen.getByLabelText(/Enable image update checks/i)).toBeEnabled());
        await user.click(screen.getByLabelText(/Enable image update checks/i));

        expect(mockedFetch).toHaveBeenCalledWith('/image-updates/enabled', {
            nodeId: 3, method: 'PUT', body: JSON.stringify({ enabled: false }),
        });
        expect(mockedFetch).not.toHaveBeenCalledWith('/image-updates/enabled', expect.objectContaining({ nodeId: 2 }));
    });

    it('writes hub scanner settings to the hub and node scanner settings to the node', async () => {
        const user = userEvent.setup();
        nodeState.activeNode = { id: 2, type: 'remote' };
        nodeState.activeNodeMeta.capabilities = ['remote-image-inspect-v1'];
        mockedFetch.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('overlay-status') ? {
                ...STATUS, scannerOwner: 'hub', capability: 'remote-image-inspect-v1',
                nextRunAt: STATUS.nextCheckAt, intervalUnit: 'minutes', cooldownEndsAt: null,
            } : STATUS,
        }));
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getAllByLabelText(/Enable image update checks/i)).toHaveLength(2));
        const hubToggle = screen.getAllByLabelText(/Enable image update checks/i)[0];
        await waitFor(() => expect(hubToggle).toBeEnabled());
        await user.click(hubToggle);

        expect(mockedFetch).toHaveBeenCalledWith('/image-updates/enabled', {
            nodeId: null, method: 'PUT', body: JSON.stringify({ enabled: false }),
        });
        expect(mockedFetch).not.toHaveBeenCalledWith('/image-updates/enabled', expect.objectContaining({ nodeId: 2 }));
        mockedFetch.mockClear();

        await user.click(screen.getAllByLabelText(/Enable image update checks/i)[1]);
        expect(mockedFetch).toHaveBeenCalledWith('/image-updates/enabled', {
            nodeId: 2, method: 'PUT', body: JSON.stringify({ enabled: false }),
        });
        expect(mockedFetch).not.toHaveBeenCalledWith('/image-updates/enabled', expect.objectContaining({ nodeId: null }));
    });

    it.each(['success', 'failure'])('ignores a late enable %s after switching nodes', async outcome => {
        let complete!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
        const pending = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(resolve => { complete = resolve; });
        mockedFetch.mockImplementation(async (url: string) => url === '/image-updates/enabled'
            ? pending
            : { ok: true, json: async () => STATUS });
        const { rerender } = render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByLabelText(/Enable image update checks/i)).toBeEnabled());
        await userEvent.setup().click(screen.getByLabelText(/Enable image update checks/i));
        nodeState.activeNode = { id: 3, type: 'remote' };
        rerender(<UpdatesSection />);
        await waitFor(() => expect(screen.getByLabelText(/Enable image update checks/i)).toBeEnabled());
        const events = vi.spyOn(window, 'dispatchEvent');
        vi.mocked(toast.error).mockClear();
        try {
            await act(async () => {
                complete({ ok: outcome === 'success', json: async () => outcome === 'success'
                    ? { ...STATUS, enabled: false } : { error: 'Old node write failed' } });
                await pending;
            });
            expect(events).not.toHaveBeenCalled();
            expect(toast.error).not.toHaveBeenCalled();
            expect(screen.getByLabelText(/Enable image update checks/i)).toBeChecked();
        } finally {
            events.mockRestore();
        }
    });

    it('preserves remote scan timing and independent enabled states after a hub write', async () => {
        nodeState.activeNode = { id: 2, type: 'remote' };
        nodeState.activeNodeMeta.capabilities = ['remote-image-inspect-v1'];
        mockedFetch.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('overlay-status') ? {
                ...STATUS, scannerOwner: 'hub', capability: 'remote-image-inspect-v1',
                nextRunAt: STATUS.nextCheckAt, intervalUnit: 'minutes', cooldownEndsAt: null,
                lastCheckedAt: Date.now() - 10 * 60 * 1000,
            } : url === '/image-updates/enabled' ? {
                ...STATUS, enabled: false, nextCheckAt: null,
            } : STATUS,
        }));
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByText(/Last checked 10m ago/)).toBeInTheDocument());
        await userEvent.setup().click(screen.getAllByLabelText(/Enable image update checks/i)[0]);
        await waitFor(() => expect(screen.getAllByLabelText(/Enable image update checks/i)[0]).not.toBeChecked());
        expect(screen.getAllByLabelText(/Enable image update checks/i)[1]).toBeChecked();
        expect(screen.getByText(/Last checked 10m ago · Next check disabled/)).toBeInTheDocument();
        expect(screen.getByText(/Last checked 5m ago · Next check in/)).toBeInTheDocument();
    });

    it('uses target controls when the overlay reports target ownership', async () => {
        nodeState.activeNode = { id: 2, type: 'remote' };
        nodeState.activeNodeMeta.capabilities = ['remote-image-inspect-v1'];
        mockedFetch.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('overlay-status') ? {
                ...STATUS, scannerOwner: 'target', capability: null,
                nextRunAt: STATUS.nextCheckAt, cooldownEndsAt: null,
            } : STATUS,
        }));
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByRole('heading', { name: 'Registry checks' })).toBeInTheDocument());
        expect(screen.queryByRole('heading', { name: 'Hub scanner' })).not.toBeInTheDocument();
        expect(screen.getAllByLabelText(/Enable image update checks/i)).toHaveLength(1);
        await userEvent.setup().click(screen.getByLabelText(/Enable image update checks/i));
        expect(mockedFetch).toHaveBeenCalledWith('/image-updates/enabled', {
            nodeId: 2, method: 'PUT', body: JSON.stringify({ enabled: false }),
        });
    });

    it('loads the cadence status and enables the control for admins', async () => {
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByText(/Last checked 5m ago/)).toBeInTheDocument());
        expect(mockedFetch).toHaveBeenCalledWith('/image-updates/status', { nodeId: 1 });
        expect(screen.getByRole('combobox', { name: /interval/i })).toBeEnabled();
        expect(screen.getByLabelText(/Enable image update checks/i)).toBeChecked();
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

    it('greys out cadence and shows Next check disabled when checks are off', async () => {
        mockedFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ ...STATUS, enabled: false, nextCheckAt: null }),
        });
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByText(/Next check disabled/)).toBeInTheDocument());
        expect(screen.getByRole('combobox', { name: /interval/i })).toBeDisabled();
        expect(screen.queryByText(/Show update status in sidebar/i)).not.toBeInTheDocument();
    });

    it('disables the enable toggle with upgrade copy when enabled is absent', async () => {
        const older = {
            checking: STATUS.checking,
            intervalMinutes: STATUS.intervalMinutes,
            lastCheckedAt: STATUS.lastCheckedAt,
            nextCheckAt: STATUS.nextCheckAt,
            manualCooldownMinutes: STATUS.manualCooldownMinutes,
            manualCooldownRemainingMs: STATUS.manualCooldownRemainingMs,
            mode: STATUS.mode,
            cronExpression: STATUS.cronExpression,
            sidebarIndicators: STATUS.sidebarIndicators,
        };
        mockedFetch.mockResolvedValue({ ok: true, json: async () => older });
        render(<UpdatesSection />);
        await waitFor(() => expect(screen.getByText(/older version of Sencho/i)).toBeInTheDocument());
        expect(screen.getByLabelText(/Enable image update checks/i)).toBeDisabled();
        expect(screen.getByRole('combobox', { name: /interval/i })).toBeEnabled();
    });
});
