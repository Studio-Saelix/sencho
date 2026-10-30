import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudBackupSection } from '../CloudBackupSection';
import { toast } from '@/components/ui/toast-store';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
const useLicenseMock = vi.fn(() => ({ isPaid: true }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => useLicenseMock() }));
const useExperimentalMock = vi.fn(() => ({ experimental: false, experimentalReady: true }));
vi.mock('@/hooks/useExperimental', () => ({ useExperimental: () => useExperimentalMock() }));

function json(body: unknown, status = 200) {
    return {
        ok: status < 400,
        status,
        json: async () => body,
        blob: async () => new Blob(['archive']),
    };
}

function deferredResponse() {
    let resolve: (value: unknown) => void = () => {};
    const promise = new Promise<unknown>(res => { resolve = res; });
    return { promise, resolve };
}

const recoveryEntry = {
    objectKey: 'sencho/instances/old-instance/snapshots/2_2026-01-01_old.tar.gz.senc',
    sizeBytes: 40,
    lastModified: null,
    snapshotId: 2,
    encrypted: true,
};

const snapshotKey = 'sencho/instances/inst/snapshots/1.tar.gz.senc';

let configPayload: Record<string, unknown>;

beforeEach(() => {
    apiFetch.mockReset();
    useLicenseMock.mockReturnValue({ isPaid: true });
    useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: true });
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
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

describe('CloudBackupSection managed vault discovery', () => {
    const FILLED_CUSTOM = {
        endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'b', access_key: 'a', secret_key: '',
        path_prefix: 'sencho/', auto_upload: false,
    };

    function mockProvider(
        provider: 'disabled' | 'sencho' | 'custom',
        putStatus: number | 'network-error' | number[] = 200,
        customConfig: typeof FILLED_CUSTOM | null = null,
    ) {
        let putCount = 0;
        apiFetch.mockImplementation(async (path: string, options?: { method?: string }) => {
            if (path === '/cloud-backup/config' && options?.method === 'PUT') {
                const status = Array.isArray(putStatus) ? putStatus[Math.min(putCount, putStatus.length - 1)] : putStatus;
                putCount += 1;
                if (status === 'network-error') throw new Error('network down');
                return json(status < 400 ? {} : { error: 'save refused' }, status);
            }
            if (path === '/cloud-backup/config') {
                return json({
                    provider,
                    sencho_provisioned: provider === 'sencho',
                    sencho_provisioned_at: null,
                    custom: customConfig ?? {
                        endpoint: '', region: '', bucket: '', access_key: '', secret_key: '',
                        path_prefix: 'sencho/', auto_upload: false,
                    },
                    encrypt_archives: false,
                    archive_passphrase: '',
                });
            }
            if (path === '/cloud-backup/usage') return json({ used_bytes: 0, quota_bytes: 100, object_count: 0 });
            if (path === '/cloud-backup/snapshots') return json([]);
            return json({ error: 'unexpected' }, 500);
        });
    }

    async function openStorageModes() {
        const user = userEvent.setup();
        await user.click(await screen.findByRole('combobox'));
        return user;
    }

    const MANAGED_OPTION = 'Sencho Snapshot Vault (included)';

    it('offers only Custom S3 when the experimental flag is off and nothing is configured', async () => {
        mockProvider('disabled');
        render(<CloudBackupSection />);
        await openStorageModes();
        expect(await screen.findByText('Custom S3 (BYOB)')).toBeInTheDocument();
        expect(screen.queryByText(MANAGED_OPTION)).not.toBeInTheDocument();
    });

    it('offers Sencho Snapshot Vault to Admiral when the experimental flag is on', async () => {
        useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
        mockProvider('disabled');
        render(<CloudBackupSection />);
        await openStorageModes();
        expect(await screen.findByText(MANAGED_OPTION)).toBeInTheDocument();
    });

    it('shows the option once the experimental flag resolves after the first render', async () => {
        useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: false });
        mockProvider('disabled');
        const { rerender } = render(<CloudBackupSection />);
        const user = await openStorageModes();
        expect(await screen.findByText('Custom S3 (BYOB)')).toBeInTheDocument();
        expect(screen.queryByText(MANAGED_OPTION)).not.toBeInTheDocument();
        await user.keyboard('{Escape}');

        useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
        rerender(<CloudBackupSection />);
        await openStorageModes();
        expect(await screen.findByText(MANAGED_OPTION)).toBeInTheDocument();
    });

    it('never offers it on Community, even with the experimental flag on', async () => {
        useLicenseMock.mockReturnValue({ isPaid: false });
        useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
        mockProvider('disabled');
        render(<CloudBackupSection />);
        await openStorageModes();
        expect(await screen.findByText('Custom S3 (BYOB)')).toBeInTheDocument();
        expect(screen.queryByText(MANAGED_OPTION)).not.toBeInTheDocument();
    });

    it('shows no managed option or panel when Community has a stored managed provider', async () => {
        useLicenseMock.mockReturnValue({ isPaid: false });
        mockProvider('sencho');
        render(<CloudBackupSection />);
        await openStorageModes();
        expect(await screen.findByText('Custom S3 (BYOB)')).toBeInTheDocument();
        expect(screen.queryByText(MANAGED_OPTION)).not.toBeInTheDocument();
        expect(screen.queryByText('Sencho Snapshot Vault')).not.toBeInTheDocument();
    });

    it('keeps the managed option visible for an instance already configured for it', async () => {
        mockProvider('sencho');
        render(<CloudBackupSection />);
        expect(await screen.findByText(MANAGED_OPTION)).toBeInTheDocument();
        expect(screen.getByText('Sencho Snapshot Vault')).toBeInTheDocument();
    });

    it('keeps the managed option after switching away from it in the same session', async () => {
        mockProvider('sencho', 200, FILLED_CUSTOM);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cloud backup provider updated.'));
        await openStorageModes();
        expect(await screen.findByText(MANAGED_OPTION)).toBeInTheDocument();
    });

    it('returns to the stored provider when saving the switch fails', async () => {
        mockProvider('sencho', 500, FILLED_CUSTOM);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'));
        expect(screen.getByRole('combobox')).toHaveTextContent(MANAGED_OPTION);
        expect(screen.queryByText('Custom S3 Configuration')).not.toBeInTheDocument();
    });

    it('does not offer the managed option to an Admiral instance on Custom S3 while the flag is off', async () => {
        mockProvider('custom');
        render(<CloudBackupSection />);
        await openStorageModes();
        expect(await screen.findByText('Disabled')).toBeInTheDocument();
        expect(screen.queryByText(MANAGED_OPTION)).not.toBeInTheDocument();
    });

    it('returns to the stored provider when the save throws a network error', async () => {
        mockProvider('sencho', 'network-error', FILLED_CUSTOM);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'));
        expect(screen.getByRole('combobox')).toHaveTextContent(MANAGED_OPTION);
    });

    it('rolls back to the server-confirmed provider after an unsaved managed selection', async () => {
        useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
        mockProvider('disabled', 500, FILLED_CUSTOM);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText(MANAGED_OPTION));
        expect(await screen.findByText('Activate Sencho Snapshot Vault')).toBeInTheDocument();
        expect(apiFetch.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false);

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'));
        expect(screen.getByRole('combobox')).toHaveTextContent('Disabled');
        expect(screen.queryByText('Activate Sencho Snapshot Vault')).not.toBeInTheDocument();
    });

    it('locks the storage mode picker when the stored configuration could not be read', async () => {
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') return json({ error: 'boom' }, 500);
            return json([]);
        });
        render(<CloudBackupSection />);
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to load config (500)'));
        expect(await screen.findByRole('combobox')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('shows the blank Custom S3 form without saving a selection the server would reject', async () => {
        mockProvider('disabled', 400);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        expect(await screen.findByText('Custom S3 Configuration')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toHaveTextContent('Custom S3 (BYOB)');
        expect(apiFetch.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('saves the Custom S3 selection when a complete configuration is already stored', async () => {
        mockProvider('disabled', 200, FILLED_CUSTOM);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cloud backup provider updated.'));
        expect(apiFetch.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1);
    });

    it('rolls back to the last saved provider, not the one loaded, after a later failed save', async () => {
        mockProvider('disabled', [200, 500], FILLED_CUSTOM);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cloud backup provider updated.'));

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByText('Disabled'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'));
        expect(screen.getByRole('combobox')).toHaveTextContent('Custom S3 (BYOB)');
    });

    it('unlocks the picker when a retry reads the stored configuration', async () => {
        let attempts = 0;
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') {
                attempts += 1;
                if (attempts === 1) return json({ error: 'boom' }, 500);
                return json({
                    provider: 'disabled', sencho_provisioned: false, sencho_provisioned_at: null,
                    custom: { endpoint: '', region: '', bucket: '', access_key: '', secret_key: '', path_prefix: 'sencho/', auto_upload: false },
                    encrypt_archives: false, archive_passphrase: '',
                });
            }
            return json([]);
        });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        expect(await screen.findByText('The stored configuration could not be read, so the storage mode is locked.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
        expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
    });

    it.each([
        ['an endpoint without a scheme', { ...FILLED_CUSTOM, endpoint: 's3.example.com' }],
        ['a whitespace-only bucket', { ...FILLED_CUSTOM, bucket: '   ' }],
        ['a missing access key', { ...FILLED_CUSTOM, access_key: '' }],
    ])('opens the Custom S3 form without saving when the stored config has %s', async (_label, stored) => {
        mockProvider('disabled', 400, stored);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        expect(await screen.findByText('Custom S3 Configuration')).toBeInTheDocument();
        expect(apiFetch.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('rolls back to Custom S3 after a toggle on the unsaved form wrote it to the server', async () => {
        mockProvider('disabled', [200, 500]);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await user.type(await screen.findByPlaceholderText('https://s3.us-east-1.amazonaws.com'), 'https://s3.example.com');
        await user.type(screen.getByPlaceholderText('my-sencho-backups'), 'snap-bucket');
        await user.type(screen.getByPlaceholderText('AKIA...'), 'AKIAEXAMPLE');
        await user.click(screen.getAllByRole('switch')[0]);
        await waitFor(() => expect(apiFetch.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1));

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByText('Disabled'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'));
        expect(screen.getByRole('combobox')).toHaveTextContent('Custom S3 (BYOB)');
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

describe('CloudBackupSection object-key encoding', () => {
    const unicodeKey = 'sencho/instances/inst/snapshots/2_été/復旧-2026.tar.gz.senc';

    function decodeObjectKey(segment: string): string {
        const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    }

    function objectPath(path: string, suffix = ''): string {
        const prefix = '/cloud-backup/object/';
        expect(path.startsWith(prefix)).toBe(true);
        if (suffix) expect(path.endsWith(suffix)).toBe(true);
        return path.slice(prefix.length, suffix ? path.length - suffix.length : undefined);
    }

    beforeEach(() => {
        apiFetch.mockReset();
        apiFetch.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
            if (path === '/cloud-backup/config') {
                return json({ ...customConfig, encrypt_archives: true, archive_passphrase: '***' });
            }
            if (path === '/cloud-backup/snapshots') {
                return json([{ objectKey: unicodeKey, sizeBytes: 20, lastModified: null, snapshotId: 2, encrypted: true }]);
            }
            if (path.includes('/import')) {
                const passphrase = options?.body ? JSON.parse(options.body).passphrase : '';
                if (passphrase === 'correct-horse') return json({ snapshot_id: 4 }, 201);
                return json({ error: 'A passphrase is required to read this archive', code: 'PASSPHRASE_REQUIRED' }, 409);
            }
            if (path.includes('/download')) {
                if (options?.method === 'POST') return json({});
                return json({ error: 'A passphrase is required to read this archive', code: 'PASSPHRASE_REQUIRED' }, 409);
            }
            if (options?.method === 'DELETE') return json({}, 204);
            return json({}, 200);
        });
    });

    it('keeps a UTF-8 object key intact for import, download, and delete', async () => {
        render(<CloudBackupSection />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Import snapshot' }));
        const importCall = apiFetch.mock.calls.find(call => String(call[0]).includes('/import'));
        expect(decodeObjectKey(objectPath(String(importCall?.[0]), '/import'))).toBe(unicodeKey);
        // Dismiss the passphrase overlay so the next action is not blocked.
        await user.click(await screen.findByRole('button', { name: 'Cancel' }));

        await user.click(await screen.findByRole('button', { name: 'Download snapshot' }));
        const downloadCall = apiFetch.mock.calls.find(call => String(call[0]).includes('/download'));
        expect(decodeObjectKey(objectPath(String(downloadCall?.[0]), '/download'))).toBe(unicodeKey);
        // The GET download answered PASSPHRASE_REQUIRED; dismiss its overlay.
        await user.click(await screen.findByRole('button', { name: 'Cancel' }));

        await user.click(await screen.findByRole('button', { name: 'Delete snapshot' }));
        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        const deleteCall = apiFetch.mock.calls.find(call => call[1]?.method === 'DELETE');
        expect(decodeObjectKey(objectPath(String(deleteCall?.[0])))).toBe(unicodeKey);
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cloud snapshot deleted.'));
    });

    it('keeps a UTF-8 object key intact when a download needs its passphrase', async () => {
        render(<CloudBackupSection />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Download snapshot' }));
        // The GET attempt answered PASSPHRASE_REQUIRED; retry through the overlay.
        await user.type(await screen.findByLabelText('Passphrase for this archive'), 'correct-horse');
        await user.click(screen.getByRole('button', { name: 'Download' }));

        await waitFor(() => expect(apiFetch.mock.calls.some(
            call => call[1]?.method === 'POST' && String(call[0]).includes('/download'),
        )).toBe(true));
        const postCall = apiFetch.mock.calls.find(
            call => call[1]?.method === 'POST' && String(call[0]).includes('/download'),
        );
        expect(decodeObjectKey(objectPath(String(postCall?.[0]), '/download'))).toBe(unicodeKey);
    });
});

describe('CloudBackupSection recovery from another instance', () => {
    function mockRecoveryApi(
        provider: 'sencho' | 'custom',
        overrides: {
            recoveryArchives: (path: string) => unknown;
            recover?: () => unknown;
            recoveryConfig?: Record<string, unknown>;
        },
    ) {
        const config = provider === 'sencho'
            ? { ...configPayload, encrypt_archives: true, archive_passphrase: '***' }
            : { ...customConfig, encrypt_archives: true, archive_passphrase: '***' };
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') return json(overrides.recoveryConfig ?? config);
            if (path === '/cloud-backup/usage') return json({ used_bytes: 10, quota_bytes: 100, object_count: 1 });
            if (path === '/cloud-backup/snapshots') return json([]);
            if (path === '/cloud-backup/recovery-archives') return overrides.recoveryArchives(path);
            if (path === '/cloud-backup/recover') return overrides.recover ? overrides.recover() : json({ snapshot_id: 9 }, 201);
            return json({}, 200);
        });
    }

    it('recovers a sealed archive with its passphrase', async () => {
        mockRecoveryApi('custom', {
            recoveryArchives: () => json({ entries: [recoveryEntry], truncated: true }),
        });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        expect(await screen.findByText(/stopped at the first 10,000 archives/)).toBeInTheDocument();
        await user.click(await screen.findByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ }));
        await user.type(screen.getByLabelText('Passphrase for this archive'), 'correct-horse-battery');
        await user.click(screen.getByRole('button', { name: 'Recover' }));

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archive recovered as an imported snapshot. Find it in Fleet → Snapshots.'));
        const recoverCall = apiFetch.mock.calls.find(call => call[0] === '/cloud-backup/recover');
        expect(JSON.parse(String(recoverCall?.[1]?.body))).toEqual({
            object_key: 'sencho/instances/old-instance/snapshots/2_2026-01-01_old.tar.gz.senc',
            passphrase: 'correct-horse-battery',
        });
    });

    it.each(['sencho', 'custom'] as const)(
        'shows discovery progress and no absence claim while the %s listing is pending',
        async (provider) => {
            const listing = deferredResponse();
            mockRecoveryApi(provider, { recoveryArchives: () => listing.promise });

            render(<CloudBackupSection />);
            const user = userEvent.setup();
            await user.click(await screen.findByRole('button', { name: 'Recover archive' }));

            expect(await screen.findByText(/Looking for sealed archives/)).toBeInTheDocument();
            expect(screen.queryByText(/No sealed archives from other instances/)).toBeNull();
            expect(screen.getByRole('button', { name: 'Recover' })).toBeDisabled();

            listing.resolve(json({ entries: [recoveryEntry], truncated: false }));

            expect(await screen.findByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ })).toBeInTheDocument();
            expect(screen.queryByText(/Looking for sealed archives/)).toBeNull();
            expect(screen.queryByText(/No sealed archives from other instances/)).toBeNull();
        },
    );

    it('reports an empty result only once the listing has settled', async () => {
        const listing = deferredResponse();
        mockRecoveryApi('custom', { recoveryArchives: () => listing.promise });

        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        expect(await screen.findByText(/Looking for sealed archives/)).toBeInTheDocument();

        listing.resolve(json({ entries: [], truncated: false }));

        expect(await screen.findByText('No sealed archives from other instances were found.')).toBeInTheDocument();
        expect(screen.queryByText(/Looking for sealed archives/)).toBeNull();
    });

    it('keeps a discovery failure visible and offers a retry', async () => {
        const retry = deferredResponse();
        let attempts = 0;
        mockRecoveryApi('custom', {
            recoveryArchives: () => {
                attempts += 1;
                if (attempts === 1) return json({ error: 'Bucket listing failed' }, 502);
                return retry.promise;
            },
        });

        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));

        expect(await screen.findByText('Bucket listing failed')).toBeInTheDocument();
        expect(screen.queryByText(/No sealed archives from other instances/)).toBeNull();
        expect(screen.queryByText(/Looking for sealed archives/)).toBeNull();

        // A passphrase typed for a later action must not erase the discovery failure.
        await user.type(screen.getByLabelText('Passphrase for this archive'), 'correct-horse-battery');
        expect(screen.getByText('Bucket listing failed')).toBeInTheDocument();
        expect(screen.queryByText(/No sealed archives from other instances/)).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText(/Looking for sealed archives/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
        expect(screen.queryByText('Bucket listing failed')).toBeNull();
        expect(screen.queryByText(/No sealed archives from other instances/)).toBeNull();

        retry.resolve(json({ entries: [recoveryEntry], truncated: false }));
        expect(await screen.findByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ })).toBeInTheDocument();
        expect(screen.queryByText('Bucket listing failed')).toBeNull();
    });

    it('issues one recovery for a double-click while the request is pending', async () => {
        const pending = deferredResponse();
        let recoverCalls = 0;
        mockRecoveryApi('custom', {
            recoveryArchives: () => json({ entries: [recoveryEntry], truncated: false }),
            recover: () => {
                recoverCalls += 1;
                return pending.promise;
            },
        });

        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        await user.click(await screen.findByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ }));
        await user.type(screen.getByLabelText('Passphrase for this archive'), 'correct-horse-battery');

        const recover = screen.getByRole('button', { name: 'Recover' });
        fireEvent.click(recover);
        fireEvent.click(recover);
        expect(recoverCalls).toBe(1);
        expect(recover).toBeDisabled();

        pending.resolve(json({ snapshot_id: 9 }, 201));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archive recovered as an imported snapshot. Find it in Fleet → Snapshots.'));
    });

    it('keeps a failed recovery in the dialog with the archive still selected', async () => {
        mockRecoveryApi('custom', {
            recoveryArchives: () => json({ entries: [recoveryEntry], truncated: false }),
            recover: () => json({ error: 'Archive could not be recovered' }, 502),
        });

        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        const archive = await screen.findByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ });
        await user.click(archive);
        await user.type(screen.getByLabelText('Passphrase for this archive'), 'correct-horse-battery');
        await user.click(screen.getByRole('button', { name: 'Recover' }));

        expect(await screen.findByText('Archive could not be recovered')).toBeInTheDocument();
        expect(archive).toHaveAttribute('aria-pressed', 'true');
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('puts a failed recovery alert above the archive list and scrolls it into view', async () => {
        const scrollIntoView = vi.fn();
        const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView,
        });
        const entries = Array.from({ length: 7 }, (_, index) => ({
            ...recoveryEntry,
            objectKey: `sencho/instances/old-instance/snapshots/${index + 1}_2026-01-01_old.tar.gz.senc`,
        }));
        mockRecoveryApi('custom', {
            recoveryArchives: () => json({ entries, truncated: false }),
            recover: () => json({ error: 'Passphrase is incorrect', code: 'INVALID_PASSPHRASE' }, 400),
        });

        try {
            render(<CloudBackupSection />);
            const user = userEvent.setup();
            await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
            await user.click(await screen.findByRole('button', { name: /7_2026-01-01_old\.tar\.gz\.senc/ }));
            await user.type(screen.getByLabelText('Passphrase for this archive'), 'wrong-passphrase');
            await user.click(screen.getByRole('button', { name: 'Recover' }));

            const alert = await screen.findByRole('alert');
            expect(alert).toHaveTextContent('Passphrase is incorrect');
            expect(scrollIntoView).toHaveBeenCalled();
            expect(scrollIntoView.mock.contexts[0]).toBe(alert);
            const list = within(screen.getByRole('dialog')).getByRole('list');
            expect(alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        } finally {
            Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
                configurable: true,
                writable: true,
                value: originalScrollIntoView,
            });
        }
    });

    it('issues one recovery request when Recover is clicked twice before the dialog re-renders', async () => {
        const recover = deferredResponse();
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') return json({ ...customConfig, encrypt_archives: true, archive_passphrase: '***' });
            if (path === '/cloud-backup/snapshots') return json([]);
            if (path === '/cloud-backup/recovery-archives') return json({ entries: [recoveryEntry], truncated: false });
            if (path === '/cloud-backup/recover') return recover.promise;
            return json({}, 200);
        });

        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        await user.click(await screen.findByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ }));
        await user.type(screen.getByLabelText('Passphrase for this archive'), 'correct-horse-battery');

        const button = screen.getByRole('button', { name: 'Recover' });
        fireEvent.click(button);
        fireEvent.click(button);
        expect(apiFetch.mock.calls.filter(call => call[0] === '/cloud-backup/recover')).toHaveLength(1);
        expect(button).toBeDisabled();

        recover.resolve(json({ snapshot_id: 9 }, 201));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archive recovered as an imported snapshot. Find it in Fleet → Snapshots.'));
    });

    it('keeps a failed recovery in the dialog without reporting success or hiding the listing', async () => {
        apiFetch.mockImplementation(async (path: string) => {
            if (path === '/cloud-backup/config') return json({ ...customConfig, encrypt_archives: true, archive_passphrase: '***' });
            if (path === '/cloud-backup/snapshots') return json([]);
            if (path === '/cloud-backup/recovery-archives') return json({ entries: [recoveryEntry], truncated: false });
            if (path === '/cloud-backup/recover') return json({ error: 'The archive could not be decrypted' }, 400);
            return json({}, 200);
        });

        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        await user.click(await screen.findByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ }));
        await user.type(screen.getByLabelText('Passphrase for this archive'), 'wrong-passphrase');
        await user.click(screen.getByRole('button', { name: 'Recover' }));

        expect(await screen.findByText('The archive could not be decrypted')).toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ })).toBeInTheDocument();
        expect(screen.queryByText(/No sealed archives from other instances/)).toBeNull();
    });

    it('starts discovery again on reopen and discards an older pending listing', async () => {
        const first = deferredResponse();
        const second = deferredResponse();
        let calls = 0;
        mockRecoveryApi('custom', {
            recoveryArchives: () => {
                calls += 1;
                return calls === 1 ? first.promise : second.promise;
            },
        });

        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        expect(await screen.findByText(/Looking for sealed archives/)).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByText(/Looking for sealed archives/)).toBeNull());

        await user.click(screen.getByRole('button', { name: 'Recover archive' }));
        expect(await screen.findByText(/Looking for sealed archives/)).toBeInTheDocument();

        second.resolve(json({ entries: [], truncated: false }));
        expect(await screen.findByText('No sealed archives from other instances were found.')).toBeInTheDocument();

        // The first, superseded request must not repopulate the list afterwards.
        first.resolve(json({ entries: [recoveryEntry], truncated: false }));
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(screen.getByText('No sealed archives from other instances were found.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ })).toBeNull();
    });
});
