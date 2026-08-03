/**
 * Load-failure and node-ownership guards for node-scoped settings sections.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ComponentType } from 'react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/context/AuthContext', () => ({
    useAuth: () => ({
        isAdmin: true,
        permissionsReady: true,
        permissionsStatus: 'ready',
        can: () => true,
    }),
}));
vi.mock('@/context/LicenseContext', () => ({ useLicense: vi.fn(() => ({ isPaid: true })) }));
vi.mock('../MastheadStatsContext', () => ({ useMastheadStats: () => {} }));
const useExperimentalMock = vi.fn(() => ({ experimental: true, experimentalReady: true }));
vi.mock('@/hooks/useExperimental', () => ({
    useExperimental: () => useExperimentalMock(),
}));

const activeNodeState = { id: 1 as number };
vi.mock('@/context/NodeContext', () => ({
    useNodes: () => ({ activeNode: { id: activeNodeState.id } }),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { HostAlertsSection } from '../HostAlertsSection';
import { ContainerAlertsSection } from '../ContainerAlertsSection';
import { DockerStorageSection } from '../DockerStorageSection';
import { FleetMeshSection } from '../FleetMeshSection';
import { DataRetentionSection } from '../DataRetentionSection';
import { DeveloperSection } from '../DeveloperSection';
import { StacksSection } from '../StacksSection';
import { AppStoreSection } from '../AppStoreSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };

const FULL_SETTINGS: Record<string, string> = {
    host_cpu_limit: '90',
    host_ram_limit: '90',
    host_disk_limit: '90',
    host_alert_suppression_mins: '60',
    host_alerts_enabled: '1',
    global_crash: '1',
    docker_janitor_gb: '5',
    prune_on_update: '1',
    reclaim_hero: '1',
    mesh_auto_recreate: '0',
    snapshot_documentation: '0',
    metrics_retention_hours: '24',
    log_retention_days: '30',
    audit_retention_days: '90',
    scan_history_per_image_limit: '50',
    prune_orphaned_scans: '1',
    developer_mode: '0',
    health_gate_enabled: '1',
    health_gate_window_seconds: '90',
    env_block_deploy_on_missing_required: '0',
    auto_create_missing_external_networks: '0',
    template_registry_url: 'https://example.com/templates.json',
};

function okSettings(extra: Record<string, string> = {}) {
    return { ok: true, json: async () => ({ ...FULL_SETTINGS, ...extra }) };
}

function failSettings(status = 502) {
    return { ok: false, status, json: async () => ({ error: 'unavailable' }) };
}

function patchCalls() {
    return mockedFetch.mock.calls.filter((c) => c[1]?.method === 'PATCH');
}

function refreshCacheCalls() {
    return mockedFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('refresh-cache'),
    );
}

function expectFailedLoadToast() {
    expect(mockedToast.error).toHaveBeenCalledTimes(1);
    expect(mockedToast.error).toHaveBeenCalledWith('Failed to load settings.');
}

async function waitForActiveNodeFetch(nodeId: number) {
    await waitFor(() => {
        expect(mockedFetch.mock.calls.some((c) => c[1]?.nodeId === nodeId && c[1]?.method !== 'PATCH')).toBe(true);
    });
}

beforeEach(() => {
    activeNodeState.id = 1;
    mockedFetch.mockReset();
    mockedToast.error.mockReset();
    mockedToast.success.mockReset();
    useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

interface DirtyCase {
    name: string;
    Section: ComponentType<{ onDirtyChange?: (d: boolean) => void }>;
    saveName: RegExp;
    edit: () => void;
}

const dirtyCases: DirtyCase[] = [
    {
        name: 'HostAlertsSection',
        Section: HostAlertsSection,
        saveName: /save alerts/i,
        edit: () => {
            fireEvent.click(screen.getAllByRole('button', { name: /90\s*%/i })[0]);
            fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '95' } });
            fireEvent.blur(screen.getByRole('spinbutton'));
        },
    },
    {
        name: 'ContainerAlertsSection',
        Section: ContainerAlertsSection,
        saveName: /save settings/i,
        edit: () => fireEvent.click(screen.getByRole('switch')),
    },
    {
        name: 'DockerStorageSection',
        Section: DockerStorageSection,
        saveName: /save settings/i,
        edit: () => fireEvent.click(screen.getAllByRole('switch')[0]),
    },
    {
        name: 'FleetMeshSection',
        Section: FleetMeshSection,
        saveName: /save settings/i,
        edit: () => fireEvent.click(screen.getAllByRole('switch')[0]),
    },
    {
        name: 'DataRetentionSection',
        Section: DataRetentionSection,
        saveName: /save settings/i,
        edit: () => fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '48' } }),
    },
    {
        name: 'DeveloperSection',
        Section: DeveloperSection,
        saveName: /save settings/i,
        edit: () => fireEvent.click(screen.getByRole('switch')),
    },
    {
        name: 'StacksSection',
        Section: StacksSection,
        saveName: /save settings/i,
        edit: () => fireEvent.click(screen.getAllByRole('switch')[0]),
    },
];

describe('settings load failures (dirty sections)', () => {
    for (const c of dirtyCases) {
        it(`${c.name}: failed load shows error, toasts once, blocks save, and never PATCHes`, async () => {
            mockedFetch.mockResolvedValue(failSettings());
            const onDirty = vi.fn();
            render(<c.Section onDirtyChange={onDirty} />);

            await waitFor(() => {
                expect(screen.getByText(/could not load settings/i)).toBeTruthy();
            });
            expectFailedLoadToast();
            expect(screen.queryByRole('button', { name: c.saveName })).toBeNull();
            expect(patchCalls()).toHaveLength(0);
            expect(onDirty).not.toHaveBeenCalledWith(true);
        });

        it(`${c.name}: successful load recovers and allows save after edit`, async () => {
            mockedFetch.mockResolvedValue(okSettings());
            render(<c.Section />);
            const save = await screen.findByRole('button', { name: c.saveName });
            expect(save).toBeDisabled();
            c.edit();
            await waitFor(() => expect(save).not.toBeDisabled());
            fireEvent.click(save);
            await waitFor(() => expect(patchCalls().length).toBeGreaterThan(0));
            const opts = patchCalls()[0][1] as { nodeId?: number | null };
            expect(opts.nodeId).toBe(1);
        });
    }

    it('HostAlertsSection: malformed 200 body fails closed instead of seeding defaults', async () => {
        mockedFetch.mockResolvedValue({ ok: true, json: async () => null });
        const onDirty = vi.fn();
        render(<HostAlertsSection onDirtyChange={onDirty} />);

        await waitFor(() => {
            expect(screen.getByText(/could not load settings/i)).toBeTruthy();
        });
        expectFailedLoadToast();
        expect(screen.queryByRole('button', { name: /save alerts/i })).toBeNull();
        expect(screen.queryByRole('spinbutton')).toBeNull();
        expect(patchCalls()).toHaveLength(0);
        expect(onDirty).not.toHaveBeenCalledWith(true);
    });
});

describe('AppStoreSection load failures', () => {
    it('failed load shows error, toasts once, and keeps Save disabled with no PATCH', async () => {
        mockedFetch.mockResolvedValue(failSettings());
        render(<AppStoreSection />);
        await waitFor(() => {
            expect(screen.getByText(/could not load settings/i)).toBeTruthy();
        });
        expectFailedLoadToast();
        expect(screen.queryByRole('button', { name: /save & refresh/i })).toBeNull();
        expect(patchCalls()).toHaveLength(0);
    });

    it('successful load shows registry URL and pins save nodeId', async () => {
        mockedFetch.mockImplementation((url: string, opts?: { method?: string; nodeId?: number | null }) => {
            if (opts?.method === 'PATCH') {
                return Promise.resolve({ ok: true, json: async () => ({}) });
            }
            if (typeof url === 'string' && url.includes('refresh-cache')) {
                return Promise.resolve({ ok: true, json: async () => ({}) });
            }
            return Promise.resolve(okSettings());
        });
        render(<AppStoreSection />);
        const input = await screen.findByLabelText(/registry url/i);
        expect((input as HTMLInputElement).value).toBe('https://example.com/templates.json');
        fireEvent.change(input, { target: { value: 'https://example.com/other.json' } });
        const save = screen.getByRole('button', { name: /save & refresh/i });
        fireEvent.click(save);
        await waitFor(() => expect(patchCalls()).toHaveLength(1));
        expect((patchCalls()[0][1] as { nodeId?: number | null }).nodeId).toBe(1);
    });

    it('refreshes App Store cache on the PATCH node after a mid-save switch', async () => {
        let resolvePatch: ((v: unknown) => void) | undefined;
        mockedFetch.mockImplementation((url: string, opts?: { method?: string; nodeId?: number | null }) => {
            if (opts?.method === 'PATCH') {
                return new Promise((resolve) => {
                    resolvePatch = resolve;
                });
            }
            if (typeof url === 'string' && url.includes('refresh-cache')) {
                return Promise.resolve({ ok: true, json: async () => ({}) });
            }
            if (opts?.nodeId === 2) {
                return Promise.resolve(okSettings({ template_registry_url: 'https://b.example.com/templates.json' }));
            }
            return Promise.resolve(okSettings());
        });

        const { rerender } = render(<AppStoreSection />);
        const input = await screen.findByLabelText(/registry url/i);
        fireEvent.change(input, { target: { value: 'https://example.com/other.json' } });
        fireEvent.click(screen.getByRole('button', { name: /save & refresh/i }));

        await waitFor(() => expect(patchCalls()).toHaveLength(1));
        expect((patchCalls()[0][1] as { nodeId?: number | null }).nodeId).toBe(1);

        activeNodeState.id = 2;
        rerender(<AppStoreSection />);
        await waitForActiveNodeFetch(2);

        mockedToast.success.mockClear();
        mockedToast.error.mockClear();
        await act(async () => {
            resolvePatch?.({ ok: true, json: async () => ({}) });
        });

        await waitFor(() => expect(refreshCacheCalls()).toHaveLength(1));
        expect((refreshCacheCalls()[0][1] as { nodeId?: number | null }).nodeId).toBe(1);
        expect(mockedToast.success).not.toHaveBeenCalled();
        // Node B's form must not adopt A's edited URL from the stale save completion.
        const bInput = await screen.findByLabelText(/registry url/i);
        expect((bInput as HTMLInputElement).value).toBe('https://b.example.com/templates.json');
    });
});

describe('node ownership races', () => {
    it('does not attribute node A dirty state to node B after B load fails', async () => {
        let resolveA: ((v: unknown) => void) | undefined;
        mockedFetch.mockImplementation((_url: string, opts?: { nodeId?: number | null }) => {
            if (opts?.nodeId === 1) {
                return new Promise((resolve) => {
                    resolveA = resolve;
                });
            }
            return Promise.resolve(failSettings());
        });

        const onDirty = vi.fn();
        const { rerender } = render(<HostAlertsSection onDirtyChange={onDirty} />);

        // Finish A successfully, then dirty it.
        await act(async () => {
            resolveA?.(okSettings({ host_cpu_limit: '70' }));
        });
        const saveA = await screen.findByRole('button', { name: /save alerts/i });
        fireEvent.click(screen.getAllByRole('button', { name: /70\s*%/i })[0]);
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '75' } });
        fireEvent.blur(screen.getByRole('spinbutton'));
        await waitFor(() => expect(onDirty).toHaveBeenCalledWith(true));
        expect(saveA).not.toBeDisabled();

        activeNodeState.id = 2;
        onDirty.mockClear();
        rerender(<HostAlertsSection onDirtyChange={onDirty} />);

        await waitFor(() => {
            expect(screen.getByText(/could not load settings/i)).toBeTruthy();
        });
        expect(screen.queryByRole('button', { name: /save alerts/i })).toBeNull();
        expect(screen.queryByDisplayValue('75')).toBeNull();
        expect(onDirty).not.toHaveBeenCalledWith(true);
        expect(patchCalls()).toHaveLength(0);
    });

    it('keeps node B loading while a stale node A response settles', async () => {
        let resolveA: ((v: unknown) => void) | undefined;
        let resolveB: ((v: unknown) => void) | undefined;
        mockedFetch.mockImplementation((_url: string, opts?: { nodeId?: number | null }) => {
            if (opts?.nodeId === 1) {
                return new Promise((resolve) => {
                    resolveA = resolve;
                });
            }
            return new Promise((resolve) => {
                resolveB = resolve;
            });
        });

        const { rerender } = render(<HostAlertsSection />);
        // Switch before A resolves.
        activeNodeState.id = 2;
        rerender(<HostAlertsSection />);

        // Stale A finishes with success; B must still be loading (skeleton, no form/error yet).
        await act(async () => {
            resolveA?.(okSettings({ host_cpu_limit: '11' }));
        });
        expect(screen.queryByRole('button', { name: /save alerts/i })).toBeNull();
        expect(screen.queryByText(/could not load settings/i)).toBeNull();

        await act(async () => {
            resolveB?.(okSettings({ host_cpu_limit: '22' }));
        });
        await screen.findByRole('button', { name: /save alerts/i });
        // Form shows B's value, not A's.
        expect(screen.getAllByRole('button', { name: /22\s*%/i }).length).toBeGreaterThan(0);
        expect(screen.queryByRole('button', { name: /11\s*%/i })).toBeNull();
    });

    it('suppresses stale save toasts after switching nodes', async () => {
        let resolvePatch: ((v: unknown) => void) | undefined;
        mockedFetch.mockImplementation((_url: string, opts?: { method?: string; nodeId?: number | null }) => {
            if (opts?.method === 'PATCH') {
                return new Promise((resolve) => {
                    resolvePatch = resolve;
                });
            }
            if (opts?.nodeId === 2) {
                return Promise.resolve(okSettings({ host_cpu_limit: '50' }));
            }
            return Promise.resolve(okSettings({ host_cpu_limit: '90' }));
        });

        const { rerender } = render(<DeveloperSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.click(screen.getByRole('switch'));
        fireEvent.click(save);

        activeNodeState.id = 2;
        rerender(<DeveloperSection />);
        // Allow node B's load effect to run; do not require a dirty Save button.
        await waitForActiveNodeFetch(2);

        mockedToast.success.mockClear();
        await act(async () => {
            resolvePatch?.({ ok: true, json: async () => ({}) });
        });
        expect(mockedToast.success).not.toHaveBeenCalled();
    });
});
