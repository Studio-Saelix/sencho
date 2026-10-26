import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const snapshotKey = 'sencho/instances/inst/snapshots/1.tar.gz.senc';

beforeEach(() => {
    apiFetch.mockReset();
    useLicenseMock.mockReturnValue({ isPaid: true });
    useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: true });
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    apiFetch.mockImplementation(async (path: string, options?: { method?: string; body?: string; localOnly?: boolean }) => {
        if (path === '/cloud-backup/config') {
            return json({
                provider: 'sencho',
                sencho_provisioned: true,
                sencho_provisioned_at: '2026-01-01T00:00:00Z',
                custom: {
                    endpoint: '', region: '', bucket: '', access_key: '', secret_key: '',
                    path_prefix: 'sencho/', auto_upload: false,
                },
                encrypt_archives: false,
                archive_passphrase: '',
            });
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
