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

describe('the catalog tile reflects a held repair', () => {
    /**
     * The tile's status dot is the first aria-hidden span: it is the one whose
     * colour comes from the priority list. The tile carries other dots (the
     * content-origin badge, a health indicator), so asserting on "any warning
     * class" would pass on the wrong element.
     */
    function statusDotClass(list: BlueprintListItem[]): string {
        const { container } = renderCatalog(list);
        const dot = container.querySelector('span[aria-hidden="true"]');
        return dot?.className ?? '';
    }

    it('ranks a held target above a healthy one, and warns rather than reads as fine', () => {
        // A Blueprint with one held target and one healthy target must read as
        // warning, not as the success an `active` target alone would give it: a
        // hold is drift Sencho declined to fix, so it is the state an operator has
        // to act on.
        expect(statusDotClass([blueprint({ deploymentCounts: { active: 1, repair_held: 1 } })]))
            .toContain('bg-warning');
    });

    it('reads as healthy when nothing is drifted or held', () => {
        expect(statusDotClass([blueprint({ deploymentCounts: { active: 1 } })]))
            .toContain('bg-success');
    });

    it('ranks a held target above a merely drifted one', () => {
        // Both warn, so the dot alone cannot show the ordering. What it shows is
        // that a held target is never hidden behind a state that outranks it: with
        // `active` also present, the warning tone is what survives.
        expect(statusDotClass([blueprint({ deploymentCounts: { drifted: 1, repair_held: 1, active: 1 } })]))
            .toContain('bg-warning');
    });
});

