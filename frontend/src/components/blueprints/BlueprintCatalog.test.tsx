/**
 * A held repair is drift Sencho will not fix, so every surface that exists to
 * surface drift has to know about it. The catalog is where an operator looks
 * when something is wrong, and a status missing from it does not read as
 * "nothing to do here", it reads as "no information".
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BlueprintCatalog } from './BlueprintCatalog';
import type { BlueprintListItem } from '@/lib/blueprintsApi';

vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ nodes: [] }) }));

function blueprint(overrides: Partial<BlueprintListItem> = {}): BlueprintListItem {
    return {
        id: 1,
        name: 'held-bp',
        description: null,
        compose_content: 'services: {}\n',
        selector: { type: 'nodes', ids: [1] },
        drift_mode: 'enforce',
        classification: 'stateless',
        enabled: true,
        deploymentCounts: { repair_held: 1 },
        deploymentTotal: 1,
        gitopsRevision: null,
        ...overrides,
    } as unknown as BlueprintListItem;
}

function renderCatalog(list: BlueprintListItem[]) {
    return render(
        <BlueprintCatalog blueprints={list} onSelect={() => {}} onCreate={() => {}} canCreate={false} />,
    );
}

describe('the catalog shows a held repair as something to act on', () => {
    it('counts a held-only Blueprint in the Drifted chip', () => {
        renderCatalog([blueprint()]);

        const chip = screen.getByRole('button', { name: /drifted/i });
        expect(chip.textContent, 'a held target is drift the operator has to resolve').toMatch(/1/);
    });

    it('reports zero when nothing is drifted or held', () => {
        renderCatalog([blueprint({ deploymentCounts: { active: 1 } })]);

        // A zero count is the honest state: a Blueprint exists and none of its
        // targets need attention.
        const chip = screen.getByRole('button', { name: /drifted/i });
        expect(chip.textContent).not.toMatch(/[1-9]/);
    });
});
