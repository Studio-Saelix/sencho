/**
 * SecretsTab: one create affordance per state. The empty card owns the call to
 * action; the tab action row returns with the bundle list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SecretSummary } from '@/lib/secretsApi';

vi.mock('@/lib/secretsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/secretsApi')>();
    return {
        ...actual,
        listSecrets: vi.fn(),
        deleteSecret: vi.fn(),
    };
});

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/context/NodeContext', () => ({
    useNodes: () => ({ nodes: [] }),
}));

import { listSecrets } from '@/lib/secretsApi';
import { SecretsTab } from './SecretsTab';

const bundle: SecretSummary = {
    id: 4,
    name: 'app-config',
    description: 'Shared environment for the app stack',
    currentVersion: 1,
    keyCount: 2,
    createdAt: 0,
    createdBy: 'admin',
    updatedAt: 0,
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('SecretsTab create affordance', () => {
    it('offers a single create button in the empty state and opens the bundle sheet', async () => {
        vi.mocked(listSecrets).mockResolvedValue([]);
        render(<SecretsTab />);

        await waitFor(() => expect(screen.getByText('One source of truth for env')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: 'New bundle' })).toBeNull();
        const create = screen.getByRole('button', { name: /Create your first bundle/i });
        expect(screen.getAllByRole('button', { name: /bundle/i })).toHaveLength(1);

        await userEvent.click(create);
        expect(await screen.findByText('New secret bundle')).toBeInTheDocument();
    });

    it('keeps the action row button and drops the empty card once bundles exist', async () => {
        vi.mocked(listSecrets).mockResolvedValue([bundle]);
        render(<SecretsTab />);

        await waitFor(() => expect(screen.getByText('app-config')).toBeInTheDocument());
        expect(screen.queryByText('One source of truth for env')).toBeNull();
        expect(screen.queryByRole('button', { name: /Create your first bundle/i })).toBeNull();
        expect(screen.getAllByRole('button', { name: /bundle/i })).toHaveLength(1);

        await userEvent.click(screen.getByRole('button', { name: 'New bundle' }));
        expect(await screen.findByText('New secret bundle')).toBeInTheDocument();
    });
});
