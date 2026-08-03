/**
 * SecretPushSheet: stale-preview invalidation and push-result always surfaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SecretPushPlanEntry, SecretPushResultEntry } from '@/lib/secretsApi';

vi.mock('@/lib/secretsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/secretsApi')>();
    return { ...actual, previewPush: vi.fn(), executePush: vi.fn() };
});

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
    return { ...actual, listDistinctLabels: vi.fn() };
});

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/context/NodeContext', () => ({
    useNodes: () => ({ nodes: [{ id: 1, name: 'central', type: 'local' }] }),
}));

vi.mock('@/lib/api', () => ({
    apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ envFiles: ['.env'] }) }),
}));

import { previewPush, executePush } from '@/lib/secretsApi';
import { listDistinctLabels } from '@/lib/blueprintsApi';
import { toast } from '@/components/ui/toast-store';
import { SecretPushSheet } from './SecretPushSheet';

function planEntry(overrides: Partial<SecretPushPlanEntry> = {}): SecretPushPlanEntry {
    return {
        nodeId: 1, nodeName: 'central', stackName: 'my-app', envFileBasename: '.env',
        reachable: true, stackExists: true,
        diff: [{ key: 'DB_PASSWORD', status: 'changed', before: '***', after: '***' }],
        added: 0, changed: 1, unchanged: 4, removedInformational: 0,
        ...overrides,
    };
}

function resultEntry(overrides: Partial<SecretPushResultEntry> = {}): SecretPushResultEntry {
    return {
        nodeId: 1, nodeName: 'central', stackName: 'my-app', envFileBasename: '.env',
        status: 'ok', added: 0, changed: 1, unchanged: 4,
        ...overrides,
    };
}

const secret = { id: 7, name: 'db-creds', description: '', currentVersion: 2, keyCount: 5, createdAt: 0, createdBy: 'admin', updatedAt: 0 };

beforeEach(() => {
    vi.mocked(listDistinctLabels).mockResolvedValue(['app', 'web', 'db']);
    vi.mocked(previewPush).mockResolvedValue([planEntry()]);
    vi.mocked(executePush).mockResolvedValue({ pushId: 'p1', results: [resultEntry()] });
});

function renderSheet() {
    return render(<SecretPushSheet open onOpenChange={vi.fn()} secret={secret} />);
}

/** Select a label, fill stack name, click Preview. */
async function fillAndPreview() {
    // Wait for labels to load
    await screen.findByText('Target');
    // Open label combobox (first element with role combobox; <select> is second)
    const combos = screen.getAllByRole('combobox');
    await userEvent.click(combos[0]);
    // Click a label option
    const option = await screen.findByText('app');
    await userEvent.click(option);
    // Fill stack name
    const stackInput = screen.getByPlaceholderText('my-app');
    await userEvent.clear(stackInput);
    await userEvent.type(stackInput, 'my-app');
    // Click Preview
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
}

describe('SecretPushSheet', () => {
    it('clears the plan when the stack name changes after preview', async () => {
        renderSheet();
        await fillAndPreview();

        // Plan entry visible on Preview tab
        await waitFor(() => {
            expect(screen.getByText('central')).toBeInTheDocument();
        });

        // Switch to Target tab and change stack name
        await userEvent.click(screen.getByRole('tab', { name: /target/i }));
        await userEvent.type(screen.getByDisplayValue('my-app'), '-v2');

        // Preview tab click should be blocked (plan cleared)
        await userEvent.click(screen.getByRole('tab', { name: /preview/i }));
        expect(screen.getByPlaceholderText('my-app')).toBeInTheDocument();
        expect(screen.queryByText('central')).not.toBeInTheDocument();
    });

    it('discards a stale in-flight preview response when inputs change', async () => {
        let resolvePreview!: (value: SecretPushPlanEntry[]) => void;
        vi.mocked(previewPush).mockReturnValue(new Promise((r) => { resolvePreview = r; }));

        renderSheet();

        await screen.findByText('Target');
        await userEvent.click(screen.getAllByRole('combobox')[0]);
        await userEvent.click(await screen.findByText('app'));
        const stackInput = screen.getByPlaceholderText('my-app');
        await userEvent.clear(stackInput);
        await userEvent.type(stackInput, 'my-app');
        await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));

        // Switch to Target while preview is in flight, change an input
        await userEvent.click(screen.getByRole('tab', { name: /target/i }));
        await userEvent.type(screen.getByDisplayValue('my-app'), '-changed');

        // Resolve stale preview
        resolvePreview([planEntry({ nodeName: 'stale-result' })]);
        await waitFor(() => {
            expect(screen.queryByText('stale-result')).not.toBeInTheDocument();
        });
        expect(screen.getByPlaceholderText('my-app')).toBeInTheDocument();
    });

    it('always surfaces push results even when inputs change mid-flight', async () => {
        // Real preview so Push button appears
        vi.mocked(previewPush).mockResolvedValue([planEntry()]);

        let resolvePush!: (v: { pushId: string; results: SecretPushResultEntry[] }) => void;
        vi.mocked(executePush).mockReturnValue(new Promise((r) => { resolvePush = r; }));

        renderSheet();
        await fillAndPreview();
        await waitFor(() => {
            expect(screen.getByText('central')).toBeInTheDocument();
        });

        // Click Push
        await userEvent.click(screen.getByRole('button', { name: /push to 1 node/i }));

        // Switch to Target while push is in flight, change an input
        await userEvent.click(screen.getByRole('tab', { name: /target/i }));
        await userEvent.type(screen.getByDisplayValue('my-app'), '-changed');

        // Resolve push. Must always surface (C1 fix).
        resolvePush({ pushId: 'p1', results: [resultEntry({ nodeName: 'push-result' })] });
        await waitFor(() => {
            expect(screen.getByText('push-result')).toBeInTheDocument();
        });
        expect(vi.mocked(toast.success)).toHaveBeenCalled();
    });
});
