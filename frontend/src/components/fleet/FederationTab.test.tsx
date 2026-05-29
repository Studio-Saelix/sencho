/**
 * Render-gate coverage for FederationTab's pin control.
 *
 * Pinning a blueprint to a node is admin-only on the backend
 * (PUT /api/blueprints/:id/pin requires admin). This test locks the matching UI
 * gate: an admin sees an editable Select, a non-admin sees the placement
 * read-only with an explanatory hint. Without this the affordance can drift
 * back to rendering an enabled control that the API rejects with 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BlueprintListItem } from '@/lib/blueprintsApi';
import type { NodeRecord } from '@/lib/nodesApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
    return { ...actual, listBlueprints: vi.fn(), pinBlueprint: vi.fn() };
});

vi.mock('@/lib/nodesApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/nodesApi')>();
    return { ...actual, listNodes: vi.fn() };
});

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { listBlueprints, pinBlueprint } from '@/lib/blueprintsApi';
import { listNodes } from '@/lib/nodesApi';
import { FederationTab } from './FederationTab';

function node(id: number, name: string, overrides: Partial<NodeRecord> = {}): NodeRecord {
    return { id, name, type: 'local', status: 'online', cordoned: false, cordoned_at: null, cordoned_reason: null, ...overrides };
}

function blueprint(overrides: Partial<BlueprintListItem> = {}): BlueprintListItem {
    return {
        id: 1,
        name: 'web-blueprint',
        description: 'edge web tier',
        compose_content: 'services:\n  web:\n    image: nginx\n',
        selector: { type: 'labels', any: ['prod'], all: [] },
        drift_mode: 'suggest',
        classification: 'stateless',
        classification_reasons: [],
        enabled: true,
        revision: 1,
        created_at: 0,
        updated_at: 0,
        created_by: 'admin',
        pinned_node_id: null,
        deploymentCounts: {},
        deploymentTotal: 0,
        ...overrides,
    };
}

beforeEach(() => {
    vi.mocked(listNodes).mockResolvedValue([node(1, 'node-alpha')]);
    vi.mocked(listBlueprints).mockResolvedValue([blueprint()]);
});

describe('FederationTab pin gating', () => {
    it('renders an editable pin control for an admin', async () => {
        render(<FederationTab canManage={true} />);

        expect(await screen.findByText('web-blueprint')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toBeInTheDocument();
        expect(screen.queryByText(/Pin changes require an administrator/i)).not.toBeInTheDocument();
    });

    it('renders the pin placement read-only for a non-admin', async () => {
        render(<FederationTab canManage={false} />);

        expect(await screen.findByText('web-blueprint')).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(screen.getByText(/Pin changes require an administrator/i)).toBeInTheDocument();
        expect(screen.getByText('(unpinned)')).toBeInTheDocument();
        // The read-only branch must never be able to issue the admin-only pin request.
        expect(vi.mocked(pinBlueprint)).not.toHaveBeenCalled();
    });

    it('shows the pinned node name read-only for a non-admin when a pin exists', async () => {
        vi.mocked(listBlueprints).mockResolvedValue([blueprint({ pinned_node_id: 1 })]);
        render(<FederationTab canManage={false} />);

        expect(await screen.findByText('web-blueprint')).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        // The pinned node name renders in both the read-only "Pinned to" cell and the
        // "Effective" column, so getAllByText (not getByText) is required.
        expect(screen.getAllByText('node-alpha').length).toBeGreaterThan(0);
    });
});
