import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudBackupSection } from '../CloudBackupSection';
import { toast } from '@/components/ui/toast-store';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ isPaid: true }) }));

function json(body: unknown, status = 200) {
    return {
        ok: status < 400,
        status,
        json: async () => body,
        blob: async () => new Blob(['archive']),
    };
}

const snapshotKey = 'sencho/instances/inst/snapshots/1.tar.gz.senc';

let configPayload: Record<string, unknown>;

beforeEach(() => {
    apiFetch.mockReset();
    vi.mocked(toast.success).mockReset();
    configPayload = {
        provider: 'sencho',
        sencho_provisioned: true,
        sencho_provisioned_at: '2026-01-01T00:00:00Z',
        custom: {
            endpoint: '', region: '', bucket: '', access_key: '', secret_key: '',
            path_prefix: 'sencho/', auto_upload: false,
        },
        encrypt_archives: false,
        archive_passphrase: '',
    };
    apiFetch.mockImplementation(async (path: string, options?: { method?: string; body?: string; localOnly?: boolean }) => {
        if (path === '/cloud-backup/config') {
            return json(configPayload);
        }
        if (path === '/cloud-backup/usage') {
            return json({ used_bytes: 10, quota_bytes: 100, object_count: 1 });
        }
        if (path === '/cloud-backup/snapshots') {
            return json([{
                objectKey: snapshotKey,
                sizeBytes: 20,
                lastModified: null,
                snapshotId: 1,
                encrypted: true,
            }]);
        }
        if (path.includes('/import')) {
            const passphrase = options?.body ? JSON.parse(options.body).passphrase : '';
            if (!passphrase) return json({ error: 'A passphrase is required to read this archive', code: 'PASSPHRASE_REQUIRED' }, 409);
            if (passphrase !== 'correct-horse') return json({ error: 'Passphrase is incorrect', code: 'INVALID_PASSPHRASE' }, 400);
            return json({ snapshot_id: 4 }, 201);
        }
        return json({ error: 'unexpected' }, 500);
    });
});

describe('CloudBackupSection archive encryption', () => {
    it('shows the encryption row and keeps the passphrase on this instance', async () => {
        render(<CloudBackupSection />);
        expect(await screen.findByRole('switch', { name: 'Encrypt archives' })).toBeInTheDocument();
        expect(apiFetch).toHaveBeenCalledWith('/cloud-backup/config', expect.objectContaining({ localOnly: true }));
        const user = userEvent.setup();
        const encryptSwitch = screen.getByRole('switch', { name: 'Encrypt archives' });
        await user.click(encryptSwitch);
        expect(encryptSwitch).not.toBeChecked();
        expect(screen.getByText(/lost passphrase cannot be recovered/)).toBeInTheDocument();
        expect(apiFetch.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false);
    });

    it('asks for a passphrase in an overlay and leaves a wrong passphrase on that overlay', async () => {
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Import snapshot' }));
        expect(await screen.findByText(/adds a new local snapshot/)).toBeInTheDocument();
        expect(screen.getByText(/another copy/)).toBeInTheDocument();

        await user.type(screen.getByLabelText('Passphrase for this archive'), 'wrong-passphrase');
        await user.click(screen.getByRole('button', { name: 'Import' }));
        expect(await screen.findByText('Passphrase is incorrect')).toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();

        await user.clear(screen.getByLabelText('Passphrase for this archive'));
        await user.type(screen.getByLabelText('Passphrase for this archive'), 'correct-horse');
        await user.click(screen.getByRole('button', { name: 'Import' }));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported as a new local snapshot.'));
    });
});

const customConfig = {
    provider: 'custom',
    sencho_provisioned: false,
    sencho_provisioned_at: null,
    custom: {
        endpoint: 'https://saved.example.com',
        region: 'saved-region',
        bucket: 'saved-bucket',
        access_key: 'saved-key',
        secret_key: '***',
        path_prefix: 'saved/',
        auto_upload: false,
    },
};

function putBodies(): string[] {
    return apiFetch.mock.calls
        .filter(call => call[0] === '/cloud-backup/config' && call[1]?.method === 'PUT')
        .map(call => String(call[1]?.body));
}

function importCalls(): number {
    return apiFetch.mock.calls.filter(call => String(call[0]).includes('/import')).length;
}

describe('CloudBackupSection encryption writes', () => {
    it('saves only encryption settings, never unsaved destination drafts', async () => {
        configPayload = { ...customConfig, encrypt_archives: false, archive_passphrase: '' };
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        const bucket = await screen.findByDisplayValue('saved-bucket');
        await user.clear(bucket);
        await user.type(bucket, 'unsaved-bucket');

        // Turning encryption on without a saved passphrase opens the passphrase row.
        await user.click(screen.getByRole('switch', { name: 'Encrypt archives' }));
        await user.type(screen.getByLabelText('Archive passphrase'), 'correct-horse-battery');
        await user.click(screen.getByRole('button', { name: 'Save passphrase' }));

        await waitFor(() => expect(putBodies()).toHaveLength(1));
        const body = JSON.parse(putBodies()[0]) as Record<string, unknown>;
        expect(body).toEqual({
            encrypt_archives: true,
            archive_passphrase: 'correct-horse-battery',
        });
        expect(body).not.toHaveProperty('custom');
        expect(body).not.toHaveProperty('provider');
    });

    it('turning encryption off writes only the flag and the placeholder passphrase', async () => {
        configPayload = { ...customConfig, encrypt_archives: true, archive_passphrase: '***' };
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        const toggle = await screen.findByRole('switch', { name: 'Encrypt archives' });
        expect(toggle).toBeChecked();
        await user.click(toggle);
        await waitFor(() => expect(putBodies()).toHaveLength(1));
        expect(JSON.parse(putBodies()[0])).toEqual({
            encrypt_archives: false,
            archive_passphrase: '***',
        });
    });
});

describe('CloudBackupSection archive action locking', () => {
    it('issues one import for a double-click while the first request is pending', async () => {
        let resolveImport: () => void = () => {};
        const pending = new Promise<void>(resolve => { resolveImport = resolve; });
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') return json(configPayload);
            if (path === '/cloud-backup/snapshots') {
                return json([{ objectKey: snapshotKey, sizeBytes: 20, lastModified: null, snapshotId: 1, encrypted: true }]);
            }
            if (path.includes('/import')) {
                await pending;
                return json({ snapshot_id: 4 }, 201);
            }
            return json({}, 200);
        });
        render(<CloudBackupSection />);
        const button = await screen.findByRole('button', { name: 'Import snapshot' });
        fireEvent.click(button);
        fireEvent.click(button);
        expect(importCalls()).toBe(1);
        expect(button).toBeDisabled();

        resolveImport();
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported as a new local snapshot.'));
        expect(screen.getByRole('button', { name: 'Import snapshot' })).not.toBeDisabled();
    });

    it('locks delete while an archive action is pending', async () => {
        let resolveImport: () => void = () => {};
        const pending = new Promise<void>(resolve => { resolveImport = resolve; });
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') return json(configPayload);
            if (path === '/cloud-backup/snapshots') {
                return json([{ objectKey: snapshotKey, sizeBytes: 20, lastModified: null, snapshotId: 1, encrypted: true }]);
            }
            if (path.includes('/import')) {
                await pending;
                return json({ snapshot_id: 4 }, 201);
            }
            return json({}, 200);
        });
        render(<CloudBackupSection />);
        fireEvent.click(await screen.findByRole('button', { name: 'Import snapshot' }));
        expect(screen.getByRole('button', { name: 'Delete snapshot' })).toBeDisabled();
        resolveImport();
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported as a new local snapshot.'));
        expect(screen.getByRole('button', { name: 'Delete snapshot' })).not.toBeDisabled();
    });

    it('issues one delete for a double-confirm while the request is pending', async () => {
        let resolveDelete: () => void = () => {};
        const pending = new Promise<void>(resolve => { resolveDelete = resolve; });
        apiFetch.mockImplementation(async (path: string, options?: { method?: string }) => {
            if (path === '/cloud-backup/config') return json(configPayload);
            if (path === '/cloud-backup/snapshots') {
                return json([{ objectKey: snapshotKey, sizeBytes: 20, lastModified: null, snapshotId: 1, encrypted: true }]);
            }
            if (options?.method === 'DELETE') {
                await pending;
                return json({}, 204);
            }
            return json({}, 200);
        });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Delete snapshot' }));
        const confirm = await screen.findByRole('button', { name: 'Delete' });
        fireEvent.click(confirm);
        fireEvent.click(confirm);
        const deletes = apiFetch.mock.calls.filter(call => call[1]?.method === 'DELETE');
        expect(deletes).toHaveLength(1);
        resolveDelete();
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cloud snapshot deleted.'));
    });

    it('unlocks the row action after a failed import', async () => {
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') return json(configPayload);
            if (path === '/cloud-backup/snapshots') {
                return json([{ objectKey: snapshotKey, sizeBytes: 20, lastModified: null, snapshotId: 1, encrypted: true }]);
            }
            if (path.includes('/import')) return json({ error: 'Import failed' }, 502);
            return json({}, 200);
        });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Import snapshot' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Import failed'));
        expect(screen.getByRole('button', { name: 'Import snapshot' })).not.toBeDisabled();
    });
});

describe('CloudBackupSection recovery from another instance', () => {
    it('recovers a sealed archive with its passphrase', async () => {
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') return json({ ...customConfig, encrypt_archives: true, archive_passphrase: '***' });
            if (path === '/cloud-backup/snapshots') return json([]);
            if (path === '/cloud-backup/recovery-archives') {
                return json({
                    entries: [{
                        objectKey: 'sencho/instances/old-instance/snapshots/2_2026-01-01_old.tar.gz.senc',
                        sizeBytes: 40,
                        lastModified: null,
                        snapshotId: 2,
                        encrypted: true,
                    }],
                    truncated: false,
                });
            }
            if (path === '/cloud-backup/recover') {
                return json({ snapshot_id: 9 }, 201);
            }
            return json({}, 200);
        });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        await user.click(await screen.findByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ }));
        await user.type(screen.getByLabelText('Passphrase for this archive'), 'correct-horse-battery');
        await user.click(screen.getByRole('button', { name: 'Recover' }));

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archive recovered as a new local snapshot.'));
        const recoverCall = apiFetch.mock.calls.find(call => call[0] === '/cloud-backup/recover');
        expect(JSON.parse(String(recoverCall?.[1]?.body))).toEqual({
            object_key: 'sencho/instances/old-instance/snapshots/2_2026-01-01_old.tar.gz.senc',
            passphrase: 'correct-horse-battery',
        });
    });
});
