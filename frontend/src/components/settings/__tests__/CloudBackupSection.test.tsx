import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudBackupSection } from '../CloudBackupSection';
import { MastheadStatsProvider, useMastheadStatsValue } from '../MastheadStatsContext';
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

    async function fillCustomForm(user: ReturnType<typeof userEvent.setup>) {
        await user.type(await screen.findByPlaceholderText('https://s3.us-east-1.amazonaws.com'), 'https://s3.example.com');
        await user.type(screen.getByPlaceholderText('my-sencho-backups'), 'snap-bucket');
        await user.type(screen.getByPlaceholderText('AKIA...'), 'AKIAEXAMPLE');
    }

    it('rolls back to the server-confirmed provider after an encryption save made on an unsaved selection', async () => {
        mockProvider('disabled', [200, 500]);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        expect(await screen.findByText('Custom S3 Configuration')).toBeInTheDocument();

        await user.click(screen.getByRole('switch', { name: 'Encrypt archives' }));
        await user.type(screen.getByLabelText('Archive passphrase'), 'correct-horse-battery');
        await user.click(screen.getByRole('button', { name: 'Save passphrase' }));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archive passphrase saved.'));
        const puts = apiFetch.mock.calls.filter(call => call[1]?.method === 'PUT');
        expect(puts).toHaveLength(1);
        expect(JSON.parse(puts[0][1].body)).not.toHaveProperty('provider');

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByText('Disabled'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'));
        expect(screen.getByRole('combobox')).toHaveTextContent('Disabled');
        expect(screen.queryByText('Custom S3 Configuration')).not.toBeInTheDocument();
    });

    it('rolls back to Custom S3 after a failed switch following a Save of the Custom S3 form', async () => {
        mockProvider('disabled', [200, 500]);
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await fillCustomForm(user);
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Custom S3 configuration saved.'));

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByText('Disabled'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'));
        expect(screen.getByRole('combobox')).toHaveTextContent('Custom S3 (BYOB)');
    });

    it('holds the storage mode picker while an encryption save is in flight', async () => {
        const pending = deferredResponse();
        mockProvider('custom', 200, FILLED_CUSTOM);
        const base = apiFetch.getMockImplementation()!;
        apiFetch.mockImplementation(async (path: string, options?: { method?: string }) => (
            path === '/cloud-backup/config' && options?.method === 'PUT' ? pending.promise : base(path, options)
        ));
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('switch', { name: 'Encrypt archives' }));
        await user.type(screen.getByLabelText('Archive passphrase'), 'correct-horse-battery');
        await user.click(screen.getByRole('button', { name: 'Save passphrase' }));
        await waitFor(() => expect(screen.getByRole('combobox')).toBeDisabled());

        pending.resolve(json({}));
        await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    });

    it('holds the Encrypt archives switch while a provider save is in flight', async () => {
        const pending = deferredResponse();
        mockProvider('disabled', 200, FILLED_CUSTOM);
        const base = apiFetch.getMockImplementation()!;
        apiFetch.mockImplementation(async (path: string, options?: { method?: string }) => (
            path === '/cloud-backup/config' && options?.method === 'PUT' ? pending.promise : base(path, options)
        ));
        render(<CloudBackupSection />);
        const user = await openStorageModes();
        await user.click(await screen.findByText('Custom S3 (BYOB)'));
        await waitFor(() => expect(screen.getByRole('switch', { name: 'Encrypt archives' })).toBeDisabled());

        pending.resolve(json({}));
        await waitFor(() => expect(screen.getByRole('switch', { name: 'Encrypt archives' })).toBeEnabled());
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

describe('CloudBackupSection destination binding', () => {
    // A stateful stand-in for the hub: it keeps the stored destination, serves a
    // different inventory per destination, and records which destination every
    // Test, import, download, delete and recovery resolved against.
    const MANAGED_KEY = 'sencho/instances/inst/snapshots/managed-1.tar.gz.senc';
    const FIRST_KEY = 'sencho/instances/inst/snapshots/first-bucket-1.tar.gz.senc';
    const SECOND_KEY = 'sencho/instances/inst/snapshots/second-bucket-1.tar.gz.senc';

    const STORED = {
        endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'first-bucket', access_key: 'AKIA1',
        secret_key: '***', path_prefix: 'sencho/', auto_upload: false,
    };
    const BLANK = { ...STORED, endpoint: '', bucket: '', access_key: '', secret_key: '' };

    type StoredCustom = typeof STORED;

    interface Server {
        provider: 'disabled' | 'sencho' | 'custom';
        provisioned: boolean;
        custom: StoredCustom;
        log: string[];
        // Destination every listing request resolved against.
        lists: string[];
        putHolds: Array<ReturnType<typeof deferredResponse>>;
        snapshotHolds: Array<ReturnType<typeof deferredResponse>>;
        recoveryHolds: Array<ReturnType<typeof deferredResponse>>;
        opHold: ReturnType<typeof deferredResponse> | null;
        // Status for the next configuration writes, in order; 200 when empty.
        putStatuses: number[];
        // Next write is stored by the hub but its response never reaches the client.
        dropNextPutResponse: boolean;
        // Next listings answer 502.
        snapshotFailures: number;
    }

    function destinationOf(server: Server): string {
        if (server.provider === 'sencho') return 'managed';
        if (server.provider === 'custom') return `custom:${server.custom.bucket}`;
        return 'disabled';
    }

    function inventoryOf(destination: string): string[] {
        if (destination === 'managed') return [MANAGED_KEY];
        if (destination === 'custom:first-bucket') return [FIRST_KEY];
        if (destination === 'custom:second-bucket') return [SECOND_KEY];
        return [];
    }

    function entry(objectKey: string) {
        return { objectKey, sizeBytes: 20, lastModified: null, snapshotId: 1, encrypted: true };
    }

    function isSavableCustom(c: Partial<StoredCustom>): boolean {
        return /^https?:\/\//i.test(c.endpoint?.trim() ?? '') && !!c.bucket?.trim() && !!c.access_key?.trim();
    }

    function startServer(initial: Partial<Server> & { provider: Server['provider'] }): Server {
        const server: Server = {
            provisioned: initial.provider === 'sencho' || initial.provisioned === true,
            custom: STORED,
            log: [],
            lists: [],
            putHolds: [],
            snapshotHolds: [],
            recoveryHolds: [],
            opHold: null,
            putStatuses: [],
            dropNextPutResponse: false,
            snapshotFailures: 0,
            ...initial,
        };
        apiFetch.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
            const method = options?.method ?? 'GET';
            if (path === '/cloud-backup/config' && method === 'PUT') {
                const body = JSON.parse(options?.body ?? '{}');
                const status = server.putStatuses.shift() ?? 200;
                if (status >= 400) return json({ error: 'save refused' }, status);
                if (body.provider === 'custom' && !isSavableCustom(body.custom ?? {})) return json({ error: 'Invalid custom S3 settings' }, 400);
                if (body.provider) server.provider = body.provider;
                if (body.provider === 'custom') server.custom = { ...server.custom, ...body.custom };
                const hold = server.putHolds.shift();
                if (hold) await hold.promise;
                if (server.dropNextPutResponse) {
                    server.dropNextPutResponse = false;
                    throw new Error('network down');
                }
                return json({}, 200);
            }
            if (path === '/cloud-backup/config') {
                return json({
                    provider: server.provider,
                    sencho_provisioned: server.provisioned,
                    sencho_provisioned_at: null,
                    custom: server.custom,
                    encrypt_archives: true,
                    archive_passphrase: '***',
                });
            }
            if (path === '/cloud-backup/usage') return json({ used_bytes: 0, quota_bytes: 100, object_count: 0 });
            if (path === '/cloud-backup/snapshots') {
                server.lists.push(destinationOf(server));
                const rows = inventoryOf(destinationOf(server)).map(entry);
                const hold = server.snapshotHolds.shift();
                if (hold) await hold.promise;
                if (server.snapshotFailures > 0) {
                    server.snapshotFailures -= 1;
                    return json({ error: 'Failed to list cloud snapshots' }, 502);
                }
                return json(rows);
            }
            if (path === '/cloud-backup/recovery-archives') {
                const rows = destinationOf(server) === 'managed' ? [recoveryEntry] : [];
                const hold = server.recoveryHolds.shift();
                if (hold) await hold.promise;
                return json({ entries: rows, truncated: false });
            }
            const destination = destinationOf(server);
            if (path === '/cloud-backup/test') {
                server.log.push(`test@${destination}`);
                if (server.opHold) await server.opHold.promise;
                return json({ success: true });
            }
            if (path === '/cloud-backup/provision') {
                server.log.push('provision');
                if (server.opHold) await server.opHold.promise;
                server.provisioned = true;
                server.provider = 'sencho';
                return json({});
            }
            if (path === '/cloud-backup/recover') {
                server.log.push(`recover@${destination}`);
                return json({ snapshot_id: 9 }, 201);
            }
            if (path.startsWith('/cloud-backup/object/')) {
                server.log.push(`${method === 'DELETE' ? 'delete' : path.split('/').pop()}@${destination}`);
                if (server.opHold) await server.opHold.promise;
                return json({}, method === 'DELETE' ? 204 : 200);
            }
            return json({ error: 'unexpected' }, 500);
        });
        return server;
    }

    const DESTINATION_ACTIONS = ['Test', 'Import snapshot', 'Download snapshot', 'Delete snapshot', 'Recover archive', 'Reprovision', 'Refresh snapshots'];

    // Names of the destination-bound controls a click could act on right now.
    function enabledActions(): string[] {
        return DESTINATION_ACTIONS.filter(name => screen
            .queryAllByRole('button', { name })
            .some(button => !(button as HTMLButtonElement).disabled));
    }

    function snapshotRows(): string[] {
        return screen.queryAllByRole('button', { name: 'Delete snapshot' }).map(
            button => button.closest('li')?.querySelector('.font-mono')?.textContent ?? '',
        );
    }

    async function pick(user: ReturnType<typeof userEvent.setup>, label: string) {
        await user.click(await screen.findByRole('combobox'));
        await user.click(await screen.findByText(label));
    }

    const CUSTOM = 'Custom S3 (BYOB)';

    it.each([
        ['a blank form', BLANK],
        ['an endpoint without a scheme', { ...STORED, endpoint: 's3.example.com' }],
        ['a whitespace-only bucket', { ...STORED, bucket: '   ' }],
        ['a missing access key', { ...STORED, access_key: '' }],
    ])('offers no managed-vault action under an unsaved Custom selection with %s', async (_label, custom) => {
        const server = startServer({ provider: 'sencho', custom });
        render(<CloudBackupSection />);
        expect(await screen.findByRole('button', { name: 'Delete snapshot' })).toBeEnabled();
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        expect(await screen.findByText('Custom S3 Configuration')).toBeInTheDocument();

        expect(enabledActions()).toEqual([]);
        expect(snapshotRows()).toEqual([]);
        expect(screen.getByText(/once this Custom S3 configuration is saved/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Test' }));
        expect(server.log).toEqual([]);
        expect(apiFetch.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false);
    });

    it('offers no action under an unsaved Custom selection when the stored provider is Disabled', async () => {
        const server = startServer({ provider: 'disabled', custom: BLANK });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        expect(await screen.findByText('Custom S3 Configuration')).toBeInTheDocument();
        expect(enabledActions()).toEqual([]);
        expect(server.lists).toEqual([]);
    });

    it('lists and acts on a complete stored Custom bucket once it is saved from Disabled', async () => {
        const server = startServer({ provider: 'disabled' });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        expect(server.lists).toEqual(['custom:first-bucket']);
        await user.click(screen.getByRole('button', { name: 'Import snapshot' }));
        await waitFor(() => expect(server.log).toEqual(['import@custom:first-bucket']));
    });

    it('offers no custom-bucket action under an unprovisioned managed selection', async () => {
        useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
        const server = startServer({ provider: 'custom', provisioned: false });
        render(<CloudBackupSection />);
        expect(await screen.findByRole('button', { name: 'Delete snapshot' })).toBeEnabled();
        const user = userEvent.setup();
        await pick(user, 'Sencho Snapshot Vault (included)');
        expect(await screen.findByText('Activate Sencho Snapshot Vault')).toBeInTheDocument();

        expect(enabledActions()).toEqual([]);
        expect(snapshotRows()).toEqual([]);
        expect(screen.getByText(/once the Sencho Snapshot Vault is active/)).toBeInTheDocument();
        expect(server.log).toEqual([]);
    });

    it('holds every action while the switch is saving, then acts on the new destination only', async () => {
        const server = startServer({ provider: 'sencho' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('managed-1.tar.gz.senc')).toBeInTheDocument();
        const put = deferredResponse();
        server.putHolds.push(put);
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        await waitFor(() => expect(apiFetch.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(true));

        expect(enabledActions()).toEqual([]);
        expect(snapshotRows()).toEqual([]);

        put.resolve(json({}));
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        expect(screen.queryByText('managed-1.tar.gz.senc')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete snapshot' }));
        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(server.log).toEqual([`delete@custom:first-bucket`]));
    });

    it('drops a managed listing that answers after the switch to Custom S3 succeeded', async () => {
        const server = startServer({ provider: 'sencho' });
        const lateManaged = deferredResponse();
        server.snapshotHolds.push(lateManaged);
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();

        lateManaged.resolve(undefined);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(snapshotRows()).toEqual(['first-bucket-1.tar.gz.senc']);
        await user.click(screen.getByRole('button', { name: 'Delete snapshot' }));
        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(server.log).toEqual([`delete@custom:first-bucket`]));
    });

    it('keeps a pending listing for the stored destination when an unsaved Custom selection is abandoned', async () => {
        const server = startServer({ provider: 'sencho', custom: BLANK });
        const pendingManaged = deferredResponse();
        server.snapshotHolds.push(pendingManaged);
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        expect(await screen.findByText('Custom S3 Configuration')).toBeInTheDocument();
        expect(snapshotRows()).toEqual([]);

        await pick(user, 'Sencho Snapshot Vault (included)');
        pendingManaged.resolve(undefined);
        expect(await screen.findByText('managed-1.tar.gz.senc')).toBeInTheDocument();
        expect(enabledActions()).toContain('Delete snapshot');
    });

    it('holds the archive actions while the Custom S3 form has unsaved edits, then follows the saved bucket', async () => {
        const server = startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const user = userEvent.setup();
        const bucket = screen.getByPlaceholderText('my-sencho-backups');
        await user.clear(bucket);
        await user.type(bucket, 'second-bucket');

        expect(enabledActions()).toEqual([]);
        expect(snapshotRows()).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: 'Test' }));
        expect(server.log).toEqual([]);

        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('second-bucket-1.tar.gz.senc')).toBeInTheDocument();
        expect(enabledActions()).toContain('Delete snapshot');
        await user.click(screen.getByRole('button', { name: 'Test' }));
        await waitFor(() => expect(server.log).toEqual(['test@custom:second-bucket']));
    });

    it('treats a typed secret key as an unsaved edit until it is saved', async () => {
        startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.type(document.querySelector('input[type="password"]') as HTMLInputElement, 'new-secret');
        expect(enabledActions()).toEqual([]);
    });

    it('follows the destination an auto-upload toggle saves from the edited form', async () => {
        const server = startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const user = userEvent.setup();
        const bucket = screen.getByPlaceholderText('my-sencho-backups');
        await user.clear(bucket);
        await user.type(bucket, 'second-bucket');
        expect(enabledActions()).toEqual([]);

        await user.click(screen.getAllByRole('switch')[0]);
        expect(await screen.findByText('second-bucket-1.tar.gz.senc')).toBeInTheDocument();
        expect(screen.queryByText('first-bucket-1.tar.gz.senc')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete snapshot' }));
        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(server.log).toEqual(['delete@custom:second-bucket']));
    });

    it('holds every action while a configuration write for the same destination is in flight', async () => {
        const server = startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const put = deferredResponse();
        server.putHolds.push(put);
        const user = userEvent.setup();
        await user.click(screen.getAllByRole('switch')[0]);
        await waitFor(() => expect(apiFetch.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(true));
        expect(enabledActions()).toEqual([]);

        put.resolve(json({}));
        await waitFor(() => expect(enabledActions()).toContain('Delete snapshot'));
    });

    it('keeps the pending listing for the stored destination when the switch is refused', async () => {
        const server = startServer({ provider: 'sencho', putStatuses: [500] });
        const pendingManaged = deferredResponse();
        server.snapshotHolds.push(pendingManaged);
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'));
        expect(screen.getByRole('combobox')).toHaveTextContent('Sencho Snapshot Vault (included)');

        pendingManaged.resolve(undefined);
        expect(await screen.findByText('managed-1.tar.gz.senc')).toBeInTheDocument();
        expect(server.lists).toEqual(['managed']);
        await user.click(screen.getByRole('button', { name: 'Delete snapshot' }));
        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(server.log).toEqual(['delete@managed']));
    });

    it('rereads the stored destination when a switch fails without an answer', async () => {
        const server = startServer({ provider: 'sencho', dropNextPutResponse: true });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'));
        // The hub stored the switch before the connection dropped.
        await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent(CUSTOM));
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        expect(screen.queryByText('managed-1.tar.gz.senc')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete snapshot' }));
        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(server.log).toEqual(['delete@custom:first-bucket']));
    });

    it('locks the section when a switch fails without an answer and the stored destination cannot be read back', async () => {
        const server = startServer({ provider: 'sencho', dropNextPutResponse: true });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        await screen.findByText('managed-1.tar.gz.senc');
        const base = apiFetch.getMockImplementation()!;
        apiFetch.mockImplementation(async (path: string, options?: { method?: string }) => (
            path === '/cloud-backup/config' && !options?.method ? json({ error: 'boom' }, 500) : base(path, options)
        ));
        await pick(user, CUSTOM);
        expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toBeDisabled();
        expect(enabledActions()).toEqual([]);
        expect(server.log).toEqual([]);
    });

    it('keeps the unsaved form held after a refused Save and the stored bucket after a refused toggle', async () => {
        const server = startServer({ provider: 'custom', putStatuses: [500, 500] });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const user = userEvent.setup();
        const bucket = screen.getByPlaceholderText('my-sencho-backups');
        await user.clear(bucket);
        await user.type(bucket, 'second-bucket');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'));
        expect(enabledActions()).toEqual([]);
        expect(server.custom.bucket).toBe('first-bucket');

        await user.click(screen.getAllByRole('switch')[0]);
        await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
        expect(screen.getAllByRole('switch')[0]).not.toBeChecked();
        expect(enabledActions()).toEqual([]);

        await user.clear(bucket);
        await user.type(bucket, 'first-bucket');
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        expect(enabledActions()).toContain('Delete snapshot');
    });

    it('does not reload the listing when a Save stores the destination it already has', async () => {
        const server = startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Custom S3 configuration saved.'));
        expect(server.lists).toEqual(['custom:first-bucket']);
        expect(screen.getByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
    });

    it.each([
        ['endpoint', 'https://s3.us-east-1.amazonaws.com'],
        ['region', 'us-east-1'],
        ['access key', 'AKIA...'],
        ['path prefix', 'sencho/'],
    ])('holds the archive actions after an unsaved %s edit', async (_label, placeholder) => {
        const server = startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.type(screen.getByPlaceholderText(placeholder), 'x');
        expect(enabledActions()).toEqual([]);
        expect(snapshotRows()).toEqual([]);
        expect(server.log).toEqual([]);
    });

    it('holds the managed-vault controls while a switch from Custom S3 is saving', async () => {
        useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
        const server = startServer({ provider: 'custom', provisioned: true });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const put = deferredResponse();
        server.putHolds.push(put);
        const user = userEvent.setup();
        await pick(user, 'Sencho Snapshot Vault (included)');
        expect(await screen.findByRole('button', { name: 'Reprovision' })).toBeDisabled();
        expect(enabledActions()).toEqual([]);

        put.resolve(json({}));
        expect(await screen.findByText('managed-1.tar.gz.senc')).toBeInTheDocument();
        expect(enabledActions()).toContain('Test');
    });

    it('says the listing failed instead of reporting an empty vault, and retries', async () => {
        const server = startServer({ provider: 'custom', snapshotFailures: 1 });
        render(<CloudBackupSection />);
        expect(await screen.findByText('Failed to list cloud snapshots')).toBeInTheDocument();
        expect(screen.queryByText(/No cloud snapshots yet/)).not.toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        expect(screen.queryByText('Failed to list cloud snapshots')).not.toBeInTheDocument();
        expect(server.lists).toHaveLength(2);
    });

    it('shows a loading state, not an empty vault, while the listing runs', async () => {
        const server = startServer({ provider: 'custom' });
        const pending = deferredResponse();
        server.snapshotHolds.push(pending);
        render(<CloudBackupSection />);
        expect(await screen.findByText('Loading cloud snapshots...')).toBeInTheDocument();
        expect(screen.queryByText(/No cloud snapshots yet/)).not.toBeInTheDocument();
        pending.resolve(undefined);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
    });

    it('refreshes the listing for the confirmed destination only', async () => {
        const server = startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Refresh snapshots' }));
        await waitFor(() => expect(server.lists).toEqual(['custom:first-bucket', 'custom:first-bucket']));

        await user.type(screen.getByPlaceholderText('my-sencho-backups'), 'x');
        expect(screen.queryByRole('button', { name: 'Refresh snapshots' })).not.toBeInTheDocument();
    });

    it.each([
        ['a Test', 'managed'],
        ['a delete', 'managed'],
        ['a provision', 'unprovisioned'],
    ])('holds the storage mode picker while %s is in flight', async (_label, kind) => {
        useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
        const server = startServer(kind === 'managed' ? { provider: 'sencho' } : { provider: 'disabled' });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        server.opHold = deferredResponse();
        if (_label === 'a Test') {
            await user.click(await screen.findByRole('button', { name: 'Test' }));
            await waitFor(() => expect(server.log).toEqual(['test@managed']));
        } else if (_label === 'a delete') {
            await user.click(await screen.findByRole('button', { name: 'Delete snapshot' }));
            await user.click(await screen.findByRole('button', { name: 'Delete' }));
            await waitFor(() => expect(server.log).toEqual(['delete@managed']));
        } else {
            await pick(user, 'Sencho Snapshot Vault (included)');
            await user.click(await screen.findByRole('button', { name: 'Activate' }));
            await waitFor(() => expect(server.log).toEqual(['provision']));
        }
        // A confirmation dialog hides the page behind it from the accessibility tree.
        expect(screen.getByRole('combobox', { hidden: true })).toBeDisabled();

        server.opHold.resolve(undefined);
        await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    });

    it('holds every action while a reprovision is running', async () => {
        const server = startServer({ provider: 'sencho' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('managed-1.tar.gz.senc')).toBeInTheDocument();
        server.opHold = deferredResponse();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Reprovision' }));
        await waitFor(() => expect(server.log).toEqual(['provision']));
        expect(enabledActions()).toEqual([]);

        server.opHold.resolve(undefined);
        await waitFor(() => expect(enabledActions()).toContain('Delete snapshot'));
    });

    it('holds Save and the auto-upload toggle while an archive action is in flight', async () => {
        const server = startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        server.opHold = deferredResponse();
        await user.click(await screen.findByRole('button', { name: 'Import snapshot' }));
        await waitFor(() => expect(server.log).toEqual(['import@custom:first-bucket']));
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        expect(screen.getAllByRole('switch')[0]).toBeDisabled();

        server.opHold.resolve(undefined);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
        expect(screen.getAllByRole('switch')[0]).toBeEnabled();
    });

    it('keeps a secret key typed while a Save is in flight', async () => {
        const server = startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const put = deferredResponse();
        server.putHolds.push(put);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(apiFetch.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(true));
        const secret = document.querySelector('input[type="password"]') as HTMLInputElement;
        await user.type(secret, 'typed-late');

        put.resolve(json({}));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Custom S3 configuration saved.'));
        expect(secret).toHaveValue('typed-late');
        expect(enabledActions()).toEqual([]);
    });

    it('tells the operator when the auto-upload toggle stored a different destination', async () => {
        startServer({ provider: 'custom' });
        render(<CloudBackupSection />);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getAllByRole('switch')[0]);
        await waitFor(() => expect(screen.getAllByRole('switch')[0]).toBeChecked());
        expect(toast.success).not.toHaveBeenCalled();

        const bucket = screen.getByPlaceholderText('my-sencho-backups');
        await user.clear(bucket);
        await user.type(bucket, 'second-bucket');
        await user.click(screen.getAllByRole('switch')[0]);
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Custom S3 configuration saved.'));
    });

    it('never shows a managed recovery listing that answers after the switch to Custom S3', async () => {
        const server = startServer({ provider: 'sencho' });
        render(<CloudBackupSection />);
        const user = userEvent.setup();
        const late = deferredResponse();
        server.recoveryHolds.push(late);
        await user.click(await screen.findByRole('button', { name: 'Recover archive' }));
        expect(await screen.findByText(/Looking for sealed archives/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await pick(user, CUSTOM);
        expect(await screen.findByText('first-bucket-1.tar.gz.senc')).toBeInTheDocument();

        late.resolve(undefined);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(screen.queryByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Recover archive' }));
        expect(await screen.findByText('No sealed archives from other instances were found.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /2_2026-01-01_old\.tar\.gz\.senc/ })).not.toBeInTheDocument();
    });

    function MastheadProbe() {
        const stats = useMastheadStatsValue();
        return <output data-testid="masthead">{(stats ?? []).map(s => `${s.label}=${s.value}`).join(';')}</output>;
    }

    function renderWithMasthead() {
        render(<MastheadStatsProvider><CloudBackupSection /><MastheadProbe /></MastheadStatsProvider>);
    }

    it('reports the confirmed provider and inventory in the masthead, not the draft', async () => {
        startServer({ provider: 'sencho', custom: BLANK });
        renderWithMasthead();
        await waitFor(() => expect(screen.getByTestId('masthead')).toHaveTextContent(/PROVIDER=sencho;.*SNAPSHOTS=1/));
        const user = userEvent.setup();
        await pick(user, CUSTOM);
        expect(await screen.findByText('Custom S3 Configuration')).toBeInTheDocument();
        expect(screen.getByTestId('masthead')).toHaveTextContent(/PROVIDER=sencho;.*SNAPSHOTS=1/);
    });

    it('does not count a listing that answers after the switch to Disabled', async () => {
        const server = startServer({ provider: 'sencho' });
        const late = deferredResponse();
        server.snapshotHolds.push(late);
        renderWithMasthead();
        const user = userEvent.setup();
        await pick(user, 'Disabled');
        await waitFor(() => expect(screen.getByTestId('masthead')).toHaveTextContent('PROVIDER=disabled'));

        late.resolve(undefined);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(screen.getByTestId('masthead')).not.toHaveTextContent('SNAPSHOTS');
    });

});
