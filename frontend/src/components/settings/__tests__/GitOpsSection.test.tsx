/**
 * The GitOps section: how often this node fetches Git sources, and how fast it
 * retries proving the images a Blueprint target is running.
 *
 * The two controls save through different routes on purpose, so the tests assert
 * each one reaches its own: the poll interval owns an endpoint because writing it
 * reschedules live fetchers, and the retry interval rides the shared node
 * settings because it is only read when a check needs it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GitOpsSection } from '../GitOpsSection';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
type AuthMock = {
    isAdmin: boolean;
    permissionsReady: boolean;
    permissionsStatus: 'ready';
    can: (action?: string) => boolean;
};
const useAuthMock = vi.fn((): AuthMock => ({
    isAdmin: true,
    permissionsReady: true,
    permissionsStatus: 'ready',
    can: () => true,
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
// The polling control gates on the source-controller capability and refuses to
// fetch until the active node's meta has loaded, so both are controllable here.
const nodeCtl = vi.hoisted(() => ({
    activeNode: { id: 1 } as { id: number } | null,
    activeNodeMeta: { capabilities: ['gitops-source-controller'] } as { capabilities: string[] } | null,
    hasCapability: vi.fn(() => true),
}));
vi.mock('@/context/NodeContext', () => ({
    useNodes: () => ({
        activeNode: nodeCtl.activeNode,
        activeNodeMeta: nodeCtl.activeNodeMeta,
        hasCapability: nodeCtl.hasCapability,
    }),
}));
vi.mock('@/context/LicenseContext', () => ({ useLicense: vi.fn(() => ({ isPaid: true })) }));
vi.mock('../MastheadStatsContext', () => ({ useMastheadStats: () => {} }));

import { apiFetch } from '@/lib/api';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const SETTINGS: Record<string, string> = { gitops_artifact_retry_interval_mins: '5' };

beforeEach(() => {
    mockedFetch.mockReset();
    nodeCtl.activeNode = { id: 1 };
    nodeCtl.activeNodeMeta = { capabilities: ['gitops-source-controller'] };
    nodeCtl.hasCapability.mockReturnValue(true);
    useAuthMock.mockReturnValue({
        isAdmin: true,
        permissionsReady: true,
        permissionsStatus: 'ready',
        can: () => true,
    });
    // Every read answers; each write echoes the submitted value back, which is
    // what both routes do, so the assertion can read the persisted interval.
    mockedFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'PATCH') {
            const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
            return { ok: true, json: async () => ({ ...body, poll_interval_mins: body.poll_interval_mins }) };
        }
        if (path === '/git-sources/polling') return { ok: true, json: async () => ({ poll_interval_mins: 0 }) };
        return { ok: true, json: async () => ({ ...SETTINGS }) };
    });
});

describe('GitOpsSection', () => {
    /**
     * The chip renders a button showing the value and swaps to a number input on
     * click, so reading and writing the value both go through that click.
     */
    function chipShowing(text: string) {
        return screen.getByRole('button', { name: new RegExp(text) });
    }

    async function editChip(text: string, next: string) {
        fireEvent.click(chipShowing(text));
        const input = screen.getByRole('spinbutton');
        fireEvent.change(input, { target: { value: next } });
        fireEvent.keyDown(input, { key: 'Enter' });
    }

    it('renders the drift verification control with the stored interval', async () => {
        mockedFetch.mockImplementation(async (path: string) => (
            path === '/git-sources/polling'
                ? { ok: true, json: async () => ({ poll_interval_mins: 0 }) }
                : { ok: true, json: async () => ({ gitops_artifact_retry_interval_mins: '17' }) }
        ));
        render(<GitOpsSection />);
        await waitFor(() => expect(screen.getByText('Drift verification')).toBeInTheDocument());
        expect(screen.getByText('Retry an unresolved image identity')).toBeInTheDocument();
        await waitFor(() => expect(chipShowing('17')).toBeInTheDocument());
    });

    it('saves a changed interval through the shared node settings, carrying only that key', async () => {
        render(<GitOpsSection />);
        await waitFor(() => expect(chipShowing('5')).toBeInTheDocument());

        await editChip('5', '30');
        fireEvent.click(screen.getByText('Save settings'));

        await waitFor(() => {
            const call = mockedFetch.mock.calls.find(
                (c) => c[0] === '/settings' && (c[1] as { method?: string } | undefined)?.method === 'PATCH',
            );
            expect(call).toBeDefined();
            expect(JSON.parse((call![1] as { body: string }).body))
                .toEqual({ gitops_artifact_retry_interval_mins: '30' });
        });
    });

    it('keeps the Git polling control, and saves it on its own endpoint', async () => {
        render(<GitOpsSection />);
        await waitFor(() => expect(screen.getByText('Poll Git sources')).toBeInTheDocument());
        expect(screen.getByText('Git sources')).toBeInTheDocument();
        // The interval row only appears once polling is on, so the toggle has to
        // be turned on before it is there to change.
        expect(screen.queryByText('Poll interval')).not.toBeInTheDocument();

        fireEvent.click(screen.getByLabelText('Poll Git sources'));
        await waitFor(() => {
            const call = mockedFetch.mock.calls.find(
                (c) => c[0] === '/git-sources/polling' && (c[1] as { method?: string } | undefined)?.method === 'PATCH',
            );
            expect(call).toBeDefined();
            expect(JSON.parse((call![1] as { body: string }).body)).toEqual({ poll_interval_mins: 5 });
        });
    });

    it('reads and writes the instance, not the selected node', async () => {
        // The reconciler that consults this value is the one on the instance you
        // are signed into, and it runs the checks for every node it manages. A
        // value stored on the selected remote node's own database would govern
        // nothing, so both the read and the write must stay on this instance.
        render(<GitOpsSection />);
        await waitFor(() => expect(chipShowing('5')).toBeInTheDocument());

        const read = mockedFetch.mock.calls.find((c) => c[0] === '/settings' && !(c[1] as { method?: string } | undefined)?.method);
        expect(read?.[1]).toMatchObject({ localOnly: true });
        expect((read?.[1] as { nodeId?: unknown }).nodeId).toBeUndefined();

        await editChip('5', '15');
        fireEvent.click(screen.getByText('Save settings'));
        await waitFor(() => {
            const write = mockedFetch.mock.calls.find(
                (c) => c[0] === '/settings' && (c[1] as { method?: string } | undefined)?.method === 'PATCH',
            );
            expect(write).toBeDefined();
            expect(write?.[1]).toMatchObject({ localOnly: true });
            expect((write?.[1] as { nodeId?: unknown }).nodeId).toBeUndefined();
        });
    });

    it('hides the Git polling control on a node with no GitOps source controller', async () => {
        nodeCtl.hasCapability.mockReturnValue(false);
        render(<GitOpsSection />);
        await waitFor(() => expect(screen.getByText('Drift verification')).toBeInTheDocument());
        expect(screen.queryByText('Poll Git sources')).not.toBeInTheDocument();
        // The drift control is this node's own, so it is unaffected by whether
        // this node happens to be a GitOps source controller.
        expect(screen.getByText('Retry an unresolved image identity')).toBeInTheDocument();
    });

    it('disables the retry control without system:settings and offers no save', async () => {
        // The retry interval is instance-scoped, so its permission is
        // system:settings rather than node:manage. A scoped node admin who
        // cannot edit a value that governs the whole fleet must not be shown a
        // live control whose save would 403.
        useAuthMock.mockReturnValue({
            isAdmin: false,
            permissionsReady: true,
            permissionsStatus: 'ready',
            can: (action?: string) => action === 'node:manage',
        });
        render(<GitOpsSection />);
        await waitFor(() => expect(screen.getByText('Drift verification')).toBeInTheDocument());
        expect(document.querySelectorAll('fieldset[disabled]').length).toBeGreaterThan(0);
        expect(screen.queryByText('Save settings')).not.toBeInTheDocument();
    });

    it('leaves the poll control usable for a node admin who cannot edit the retry interval', async () => {
        useAuthMock.mockReturnValue({
            isAdmin: false,
            permissionsReady: true,
            permissionsStatus: 'ready',
            can: (action?: string) => action === 'node:manage',
        });
        render(<GitOpsSection />);
        const toggle = await screen.findByRole('switch', { name: /poll git sources/i });
        expect(toggle).not.toBeDisabled();
    });
});
