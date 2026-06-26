/**
 * The System Limits split is only correct if each successor section saves just
 * its own keys. The old SystemSection PATCHed all nine keys at once; after the
 * split a save from one section must not carry another section's keys, otherwise
 * editing Host Alerts could clobber a concurrently-changed Docker setting.
 *
 * Each test loads a section, makes one change, saves, and asserts the PATCH body
 * contains exactly that section's key set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 'local' } }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: vi.fn(() => ({ isPaid: true })) }));
vi.mock('../MastheadStatsContext', () => ({ useMastheadStats: () => {} }));

import { apiFetch } from '@/lib/api';
import { useLicense } from '@/context/LicenseContext';
import { HostAlertsSection } from '../HostAlertsSection';
import { ContainerAlertsSection } from '../ContainerAlertsSection';
import { DockerStorageSection } from '../DockerStorageSection';
import { FleetMeshSection } from '../FleetMeshSection';
import { DataRetentionSection } from '../DataRetentionSection';
import { DeveloperSection } from '../DeveloperSection';
import { StacksSection } from '../StacksSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedLicense = useLicense as unknown as ReturnType<typeof vi.fn>;

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
    metrics_retention_hours: '24',
    log_retention_days: '30',
    audit_retention_days: '90',
    scan_history_per_image_limit: '50',
    prune_orphaned_scans: '1',
    developer_mode: '0',
    health_gate_enabled: '1',
    health_gate_window_seconds: '90',
    env_block_deploy_on_missing_required: '0',
};

function patchedKeys(): string[] {
    const patch = [...mockedFetch.mock.calls].reverse().find(c => c[1]?.method === 'PATCH');
    if (!patch) throw new Error('expected a PATCH /settings call');
    return Object.keys(JSON.parse(patch[1].body as string)).sort();
}

beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({ ok: true, json: async () => ({ ...FULL_SETTINGS }) });
    mockedLicense.mockReturnValue({ isPaid: true });
});

describe('split section save payloads', () => {
    it('HostAlertsSection patches only host alert keys', async () => {
        render(<HostAlertsSection />);
        const save = await screen.findByRole('button', { name: /save alerts/i });
        // NumberChip renders as a button until clicked; click the CPU chip to enter edit mode.
        fireEvent.click(screen.getAllByRole('button', { name: /90\s*%/i })[0]);
        const spinbutton = screen.getByRole('spinbutton');
        fireEvent.change(spinbutton, { target: { value: '95' } });
        fireEvent.blur(spinbutton);
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        expect(patchedKeys()).toEqual([
            'host_alert_suppression_mins',
            'host_alerts_enabled',
            'host_cpu_limit',
            'host_disk_limit',
            'host_ram_limit',
        ]);
    });

    it('ContainerAlertsSection patches only global_crash', async () => {
        render(<ContainerAlertsSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.click(screen.getByRole('switch')); // global_crash toggle
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        expect(patchedKeys()).toEqual(['global_crash']);
    });

    it('StacksSection guardrails patch only deploy guardrail keys', async () => {
        render(<StacksSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        // StacksSection has switches for health_gate_enabled and env_block. The first
        // switch is the Observe health toggle.
        fireEvent.click(screen.getAllByRole('switch')[0]);
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        expect(patchedKeys()).toEqual([
            'env_block_deploy_on_missing_required',
            'health_gate_enabled',
            'health_gate_window_seconds',
        ]);
    });

    it('DockerStorageSection patches only docker and storage keys', async () => {
        render(<DockerStorageSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.click(screen.getAllByRole('switch')[0]); // reclaim_hero
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        expect(patchedKeys()).toEqual(['docker_janitor_gb', 'prune_on_update', 'reclaim_hero']);
    });

    it('FleetMeshSection patches only the fleet keys', async () => {
        render(<FleetMeshSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.click(screen.getAllByRole('switch')[0]); // mesh_auto_recreate
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        expect(patchedKeys()).toEqual(['mesh_auto_recreate', 'snapshot_documentation']);
    });

    it('DataRetentionSection patches only retention keys, never developer_mode', async () => {
        render(<DataRetentionSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '48' } }); // metrics window
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        expect(patchedKeys()).toEqual([
            'audit_retention_days',
            'log_retention_days',
            'metrics_retention_hours',
            'prune_orphaned_scans',
            'scan_history_per_image_limit',
        ]);
    });

    it('DataRetentionSection omits the paid audit_retention_days key for a Community operator', async () => {
        mockedLicense.mockReturnValue({ isPaid: false });
        render(<DataRetentionSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '48' } }); // metrics window
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        // audit_retention_days is paid-gated; sending it would 403 the whole save.
        expect(patchedKeys()).toEqual([
            'log_retention_days',
            'metrics_retention_hours',
            'prune_orphaned_scans',
            'scan_history_per_image_limit',
        ]);
    });

    it('DataRetentionSection sends prune_orphaned_scans="0" when the toggle is turned off', async () => {
        render(<DataRetentionSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.click(screen.getByRole('switch')); // the only toggle: prune_orphaned_scans
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        const patch = [...mockedFetch.mock.calls].reverse().find(c => c[1]?.method === 'PATCH');
        const body = JSON.parse(patch![1].body as string);
        expect(body.prune_orphaned_scans).toBe('0');
    });

    it('DeveloperSection patches only developer_mode', async () => {
        render(<DeveloperSection />);
        const save = await screen.findByRole('button', { name: /save settings/i });
        fireEvent.click(screen.getByRole('switch')); // developer_mode
        fireEvent.click(save);
        await waitFor(() => expect(mockedFetch.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true));
        expect(patchedKeys()).toEqual(['developer_mode']);
    });
});
