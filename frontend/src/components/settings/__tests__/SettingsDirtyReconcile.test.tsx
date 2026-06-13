/**
 * After a successful save the section must reconcile its dirty state immediately,
 * with no remount: the parent dirty flag (onDirtyChange) clears, the masthead
 * EDITED stat flips from pending to saved, and the Save button disables. A failed
 * save must keep the section dirty and retryable, and an edit made while a save is
 * in flight must survive (the submitted snapshot, not the live state, becomes the
 * new baseline).
 *
 * The onDirtyChange boolean asserted here is exactly the value SettingsPage stores
 * in its dirtyFlags map and the sidebar renders the unsaved dot from, so a clean
 * transition here proves the parent indicators clear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import type { MastheadMetadataItem } from '@/components/ui/PageMasthead';

const { masthead } = vi.hoisted(() => ({
    masthead: { last: null as MastheadMetadataItem[] | null },
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 'local' } }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: vi.fn(() => ({ isPaid: true })) }));
vi.mock('../MastheadStatsContext', () => ({
    useMastheadStats: (stats: MastheadMetadataItem[] | null) => { masthead.last = stats; },
}));

import { apiFetch } from '@/lib/api';
import { useLicense } from '@/context/LicenseContext';
import { HostAlertsSection } from '../HostAlertsSection';
import { DockerStorageSection } from '../DockerStorageSection';
import { FleetMeshSection } from '../FleetMeshSection';
import { DataRetentionSection } from '../DataRetentionSection';
import { DeveloperSection } from '../DeveloperSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedLicense = useLicense as unknown as ReturnType<typeof vi.fn>;

const FULL_SETTINGS: Record<string, string> = {
    host_cpu_limit: '90',
    host_ram_limit: '90',
    host_disk_limit: '90',
    host_alert_suppression_mins: '60',
    global_crash: '1',
    docker_janitor_gb: '5',
    prune_on_update: '1',
    reclaim_hero: '1',
    mesh_auto_recreate: '0',
    metrics_retention_hours: '24',
    log_retention_days: '30',
    audit_retention_days: '90',
    scan_history_per_image_limit: '50',
    developer_mode: '0',
};

/** GET /settings resolves load data; PATCH resolves ok unless overridden per-test. */
function wireDefaultFetch() {
    mockedFetch.mockImplementation((_url: string, opts?: { method?: string }) => {
        if (opts?.method === 'PATCH') return Promise.resolve({ ok: true, json: async () => ({}) });
        return Promise.resolve({ ok: true, json: async () => ({ ...FULL_SETTINGS }) });
    });
}

function lastDirty(spy: ReturnType<typeof vi.fn>): boolean | undefined {
    const calls = spy.mock.calls;
    return calls.length ? (calls[calls.length - 1][0] as boolean) : undefined;
}

beforeEach(() => {
    mockedFetch.mockReset();
    mockedLicense.mockReturnValue({ isPaid: true });
    masthead.last = null;
    wireDefaultFetch();
});

describe('settings dirty reconcile on save', () => {
    it('clears the masthead, parent dirty flag, and Save button after a successful save (no remount)', async () => {
        const onDirty = vi.fn();
        render(<HostAlertsSection onDirtyChange={onDirty} />);
        const save = await screen.findByRole('button', { name: /save alerts/i });

        // Edit: section becomes dirty.
        fireEvent.click(screen.getAllByRole('switch')[0]); // global_crash
        await waitFor(() => expect(lastDirty(onDirty)).toBe(true));
        expect(masthead.last?.[0]).toMatchObject({ label: 'EDITED', value: '1 pending', tone: 'warn' });
        expect(save).not.toBeDisabled();

        // Save succeeds: everything reconciles without a remount.
        fireEvent.click(save);
        await waitFor(() => expect(lastDirty(onDirty)).toBe(false));
        expect(masthead.last?.[0]).toMatchObject({ label: 'EDITED', value: 'saved', tone: 'value' });
        expect(save).toBeDisabled();
        // A remount would re-run the load effect; the section loads exactly once.
        const getCalls = mockedFetch.mock.calls.filter(c => c[1]?.method !== 'PATCH');
        expect(getCalls).toHaveLength(1);
    });

    it('keeps the section dirty and retryable when the save fails', async () => {
        mockedFetch.mockImplementation((_url: string, opts?: { method?: string }) => {
            if (opts?.method === 'PATCH') return Promise.resolve({ ok: false, json: async () => ({ error: 'nope' }) });
            return Promise.resolve({ ok: true, json: async () => ({ ...FULL_SETTINGS }) });
        });
        const onDirty = vi.fn();
        render(<HostAlertsSection onDirtyChange={onDirty} />);
        const save = await screen.findByRole('button', { name: /save alerts/i });

        fireEvent.click(screen.getAllByRole('switch')[0]);
        await waitFor(() => expect(lastDirty(onDirty)).toBe(true));

        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        // Still dirty, still enabled, masthead still pending: the operator can retry.
        expect(lastDirty(onDirty)).toBe(true);
        expect(save).not.toBeDisabled();
        expect(masthead.last?.[0]).toMatchObject({ label: 'EDITED', value: '1 pending', tone: 'warn' });
    });

    it('preserves an edit made while the PATCH is in flight', async () => {
        let resolvePatch: ((v: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
        mockedFetch.mockImplementation((_url: string, opts?: { method?: string }) => {
            if (opts?.method === 'PATCH') {
                return new Promise<{ ok: boolean; json: () => Promise<unknown> }>(res => { resolvePatch = res; });
            }
            return Promise.resolve({ ok: true, json: async () => ({ ...FULL_SETTINGS }) });
        });
        const onDirty = vi.fn();
        render(<HostAlertsSection onDirtyChange={onDirty} />);
        const save = await screen.findByRole('button', { name: /save alerts/i });

        // Change field A and submit (PATCH now pending).
        fireEvent.click(screen.getAllByRole('switch')[0]); // global_crash
        await waitFor(() => expect(lastDirty(onDirty)).toBe(true));
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));

        // Change field B while the save is still in flight (fieldset stays editable).
        const healthGate = screen.getAllByRole('switch')[1]; // health_gate_enabled
        const healthBefore = healthGate.getAttribute('aria-checked');
        fireEvent.click(healthGate);
        expect(healthGate.getAttribute('aria-checked')).not.toBe(healthBefore);

        // Resolve the save: only the submitted snapshot becomes the baseline.
        await act(async () => {
            resolvePatch?.({ ok: true, json: async () => ({}) });
        });

        // The later edit survives and keeps the section dirty/retryable.
        expect(healthGate.getAttribute('aria-checked')).not.toBe(healthBefore);
        await waitFor(() => expect(lastDirty(onDirty)).toBe(true));
        expect(save).not.toBeDisabled();
    });
});

describe('every migrated section clears its dirty flag on save', () => {
    interface Case {
        name: string;
        render: (onDirty: (d: boolean) => void) => void;
        saveName: RegExp;
        edit: () => void;
    }

    const cases: Case[] = [
        {
            name: 'HostAlertsSection',
            render: onDirty => render(<HostAlertsSection onDirtyChange={onDirty} />),
            saveName: /save alerts/i,
            edit: () => fireEvent.click(screen.getAllByRole('switch')[0]),
        },
        {
            name: 'DockerStorageSection',
            render: onDirty => render(<DockerStorageSection onDirtyChange={onDirty} />),
            saveName: /save settings/i,
            edit: () => fireEvent.click(screen.getAllByRole('switch')[0]),
        },
        {
            name: 'FleetMeshSection',
            render: onDirty => render(<FleetMeshSection onDirtyChange={onDirty} />),
            saveName: /save settings/i,
            edit: () => fireEvent.click(screen.getAllByRole('switch')[0]),
        },
        {
            name: 'DataRetentionSection',
            render: onDirty => render(<DataRetentionSection onDirtyChange={onDirty} />),
            saveName: /save settings/i,
            edit: () => fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '48' } }),
        },
        {
            name: 'DeveloperSection',
            render: onDirty => render(<DeveloperSection onDirtyChange={onDirty} />),
            saveName: /save settings/i,
            edit: () => fireEvent.click(screen.getByRole('switch')),
        },
    ];

    for (const c of cases) {
        it(`${c.name} reports clean after a successful save`, async () => {
            const onDirty = vi.fn();
            c.render(onDirty);
            const save = await screen.findByRole('button', { name: c.saveName });
            c.edit();
            await waitFor(() => expect(lastDirty(onDirty)).toBe(true));
            fireEvent.click(save);
            await waitFor(() => expect(lastDirty(onDirty)).toBe(false));
            cleanup();
        });
    }

    it('DataRetentionSection reconciles for a Community operator even though the paid key is omitted from the payload', async () => {
        // markSaved adopts the full submitted snapshot (incl. audit_retention_days),
        // not the trimmed Community payload, so the section re-baselines and clears.
        mockedLicense.mockReturnValue({ isPaid: false });
        const onDirty = vi.fn();
        render(<DataRetentionSection onDirtyChange={onDirty} />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '48' } });
        await waitFor(() => expect(lastDirty(onDirty)).toBe(true));
        fireEvent.click(save);
        await waitFor(() => expect(lastDirty(onDirty)).toBe(false));
        expect(save).toBeDisabled();
    });

    it('DeveloperSection masthead stays a DEV MODE stat, not an EDITED pending count', async () => {
        const onDirty = vi.fn();
        render(<DeveloperSection onDirtyChange={onDirty} />);
        await screen.findByRole('button', { name: /save settings/i });
        fireEvent.click(screen.getByRole('switch')); // developer_mode 0 -> 1
        await waitFor(() => expect(lastDirty(onDirty)).toBe(true));
        expect(masthead.last?.[0]).toMatchObject({ label: 'DEV MODE', value: 'on' });
    });
});
