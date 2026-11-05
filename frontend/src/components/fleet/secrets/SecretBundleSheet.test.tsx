/**
 * SecretBundleSheet: masked-by-default editing, explicit per-value reveal with
 * an expiry, and per-key writes that never send the whole bundle back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SecretDetail } from '@/lib/secretsApi';

vi.mock('@/lib/secretsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/secretsApi')>();
    return {
        ...actual,
        getSecret: vi.fn(),
        createSecret: vi.fn(),
        patchSecret: vi.fn(),
        listSecretVersions: vi.fn(),
        revealValue: vi.fn(),
        previewImport: vi.fn(),
        applyImport: vi.fn(),
    };
});

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/context/NodeContext', () => ({
    useNodes: () => ({ nodes: [{ id: 1, name: 'central', type: 'local' }] }),
}));

import { getSecret, patchSecret, revealValue } from '@/lib/secretsApi';
import { toast } from '@/components/ui/toast-store';
import { SecretBundleSheet } from './SecretBundleSheet';

const MASK = '••••••••';

function detail(overrides: Partial<SecretDetail> = {}): SecretDetail {
    return {
        id: 7,
        name: 'db-creds',
        description: 'db and api',
        currentVersion: 3,
        keyCount: 2,
        createdAt: 0,
        createdBy: 'admin',
        updatedAt: 0,
        masked: true,
        keys: [
            { key: 'API_KEY', masked: MASK },
            { key: 'DB_PASSWORD', masked: MASK },
        ],
        ...overrides,
    };
}

const summary = {
    id: 7, name: 'db-creds', description: 'db and api', currentVersion: 3,
    keyCount: 2, createdAt: 0, createdBy: 'admin', updatedAt: 0,
};

function renderSheet(onSaved = vi.fn()) {
    return render(
        <SecretBundleSheet open onOpenChange={vi.fn()} secret={summary} onSaved={onSaved} />,
    );
}

beforeEach(() => {
    vi.mocked(getSecret).mockResolvedValue(detail());
    vi.mocked(patchSecret).mockResolvedValue({ version: 4 });
    vi.mocked(revealValue).mockResolvedValue({
        key: 'DB_PASSWORD', version: 3, value: 'hunter2', expiresAt: Date.now() + 30_000,
    });
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('SecretBundleSheet masked editing', () => {
    it('renders key names with masked placeholders and no value', async () => {
        renderSheet();
        expect(await screen.findByDisplayValue('API_KEY')).toBeInTheDocument();
        expect(screen.getByDisplayValue('DB_PASSWORD')).toBeInTheDocument();

        const apiValue = screen.getByLabelText('Value for API_KEY') as HTMLInputElement;
        expect(apiValue.value).toBe('');
        expect(apiValue.placeholder).toBe(MASK);

        expect(document.body.textContent).not.toContain('hunter2');
        expect(vi.mocked(getSecret)).toHaveBeenCalledWith(7);
    });

    it('reveals one value, shows its window, then re-masks', async () => {
        vi.mocked(revealValue).mockResolvedValue({
            key: 'DB_PASSWORD', version: 3, value: 'hunter2', expiresAt: Date.now() + 1_200,
        });
        renderSheet();
        await screen.findByDisplayValue('API_KEY');

        const revealButtons = screen.getAllByLabelText('Reveal value');
        await userEvent.click(revealButtons[1]);

        const input = screen.getByLabelText('Value for DB_PASSWORD') as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('hunter2'));
        expect(vi.mocked(revealValue)).toHaveBeenCalledWith(7, 'DB_PASSWORD', 3);
        expect(screen.getByText(/hides in/i)).toBeInTheDocument();

        await waitFor(() => expect(input.value).toBe(''), { timeout: 4000 });
        expect(screen.queryByText(/hides in/i)).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain('hunter2');
    });

    it('saves one typed value as a per-key operation, not a whole map', async () => {
        const onSaved = vi.fn();
        renderSheet(onSaved);
        await screen.findByDisplayValue('API_KEY');

        const apiValue = screen.getByLabelText('Value for API_KEY');
        await userEvent.type(apiValue, 'rotated-key');
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() => expect(vi.mocked(patchSecret)).toHaveBeenCalled());
        expect(vi.mocked(patchSecret).mock.calls[0][0]).toBe(7);
        const payload = vi.mocked(patchSecret).mock.calls[0][1];
        expect(payload.expectedVersion).toBe(3);
        expect(payload.ops).toEqual([{ op: 'set', key: 'API_KEY', value: 'rotated-key' }]);
        expect(payload).not.toHaveProperty('kv');
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    it('renames a key without revealing its value', async () => {
        renderSheet();
        await screen.findByDisplayValue('API_KEY');

        const keyInput = screen.getByDisplayValue('DB_PASSWORD');
        await userEvent.clear(keyInput);
        await userEvent.type(keyInput, 'DATABASE_PASSWORD');
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() => expect(vi.mocked(patchSecret)).toHaveBeenCalled());
        expect(vi.mocked(patchSecret).mock.calls[0][1].ops).toEqual([
            { op: 'rename', from: 'DB_PASSWORD', to: 'DATABASE_PASSWORD' },
        ]);
    });

    it('removes a key only after an explicit mark, and can undo it', async () => {
        renderSheet();
        await screen.findByDisplayValue('API_KEY');

        await userEvent.click(screen.getAllByLabelText('Remove key')[0]);
        expect(screen.getByLabelText('Keep key')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() => expect(vi.mocked(patchSecret)).toHaveBeenCalled());
        expect(vi.mocked(patchSecret).mock.calls[0][1].ops).toEqual([{ op: 'remove', key: 'API_KEY' }]);

        vi.mocked(patchSecret).mockClear();
        await userEvent.click(screen.getByLabelText('Keep key'));
        expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
        expect(vi.mocked(patchSecret)).not.toHaveBeenCalled();
    });

    it('reloads the bundle when the server reports a stale version', async () => {
        vi.mocked(patchSecret).mockRejectedValue(Object.assign(new Error('This bundle changed since you opened it.'), { status: 409 }));
        renderSheet();
        await screen.findByDisplayValue('API_KEY');

        await userEvent.type(screen.getByLabelText('Value for API_KEY'), 'late-edit');
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() => expect(vi.mocked(getSecret)).toHaveBeenCalledTimes(2));
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringMatching(/reloading/i));
    });
});
