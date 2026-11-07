/**
 * SecretPushSheet: stale-preview invalidation and push-result always surfaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SecretPushPlanEntry, SecretPushPreview, SecretPushResultEntry } from '@/lib/secretsApi';

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
        diff: [{ key: 'DB_PASSWORD', status: 'changed' }],
        added: 0, changed: 1, unchanged: 4, removedInformational: 0,
        fingerprint: 'a'.repeat(64),
        ...overrides,
    };
}

function previewPlan(overrides: Partial<SecretPushPreview> = {}): SecretPushPreview {
    return { version: 2, targets: [planEntry()], ...overrides };
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
    vi.mocked(previewPush).mockResolvedValue(previewPlan());
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
        let resolvePreview!: (value: SecretPushPreview) => void;
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
        resolvePreview(previewPlan({ targets: [planEntry({ nodeName: 'stale-result' })] }));
        await waitFor(() => {
            expect(screen.queryByText('stale-result')).not.toBeInTheDocument();
        });
        expect(screen.getByPlaceholderText('my-app')).toBeInTheDocument();
    });

    it('always surfaces push results even when inputs change mid-flight', async () => {
        // Real preview so Push button appears
        vi.mocked(previewPush).mockResolvedValue(previewPlan());

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

    it('sends the previewed version and per-target digests, not the live fields', async () => {
        // The live bundle is at version 2; the preview answered with version 3,
        // so the request must carry the previewed version.
        vi.mocked(previewPush).mockResolvedValue(previewPlan({ version: 3 }));
        renderSheet();
        await fillAndPreview();
        await waitFor(() => {
            expect(screen.getByText('central')).toBeInTheDocument();
        });

        await userEvent.click(screen.getByRole('button', { name: /push to 1 node/i }));

        await waitFor(() => expect(vi.mocked(executePush)).toHaveBeenCalled());
        expect(vi.mocked(executePush)).toHaveBeenCalledWith(7, {
            selector: { type: 'labels', any: ['app'], all: [] },
            stackName: 'my-app',
            envFileBasename: '.env',
            expectedVersion: 3,
            expectedTargets: [{ nodeId: 1, fingerprint: 'a'.repeat(64) }],
        });
    });

    it('drops the plan and returns to Target when a target changed after preview', async () => {
        vi.mocked(executePush).mockRejectedValue(Object.assign(
            new Error('A target env file changed since you previewed the push. Preview again before pushing.'),
            { status: 409, code: 'PUSH_TARGET_CHANGED' },
        ));

        renderSheet();
        await fillAndPreview();
        await waitFor(() => {
            expect(screen.getByText('central')).toBeInTheDocument();
        });

        await userEvent.click(screen.getByRole('button', { name: /push to 1 node/i }));

        await waitFor(() => {
            expect(screen.getByPlaceholderText('my-app')).toBeInTheDocument();
        });
        expect(screen.queryByText('central')).not.toBeInTheDocument();
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
            'A target env file changed since you previewed it. Preview again before pushing.',
        );
    });

    it('drops the plan and returns to Target when the bundle changed after preview', async () => {
        vi.mocked(executePush).mockRejectedValue(Object.assign(
            new Error('This bundle changed since you opened it. Reload it and apply your edit again.'),
            { status: 409, code: 'VERSION_CONFLICT', currentVersion: 3 },
        ));

        renderSheet();
        await fillAndPreview();
        await waitFor(() => {
            expect(screen.getByText('central')).toBeInTheDocument();
        });

        await userEvent.click(screen.getByRole('button', { name: /push to 1 node/i }));

        await waitFor(() => {
            expect(screen.getByPlaceholderText('my-app')).toBeInTheDocument();
        });
        expect(screen.queryByText('central')).not.toBeInTheDocument();
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
            'This bundle changed since you previewed it. Preview again before pushing.',
        );
    });

    it('keeps the preview when another push for the bundle is already running', async () => {
        vi.mocked(executePush).mockRejectedValue(Object.assign(
            new Error('A push for this secret is already running'),
            { status: 409, code: 'PUSH_BUSY' },
        ));

        renderSheet();
        await fillAndPreview();
        await waitFor(() => {
            expect(screen.getByText('central')).toBeInTheDocument();
        });

        await userEvent.click(screen.getByRole('button', { name: /push to 1 node/i }));

        await waitFor(() => {
            expect(vi.mocked(toast.error)).toHaveBeenCalledWith('A push for this secret is already running');
        });
        expect(screen.getByText('central')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /push to 1 node/i })).toBeInTheDocument();
    });
});
