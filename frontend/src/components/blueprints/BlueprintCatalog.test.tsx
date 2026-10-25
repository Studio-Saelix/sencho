/**
 * A held repair is drift Sencho will not fix, so every surface that exists to
 * surface drift has to know about it. The catalog is where an operator looks
 * when something is wrong, and a status missing from it does not read as
 * "nothing to do here", it reads as "no information".
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    it('counts a held-only Blueprint in the Needs attention chip', () => {
        renderCatalog([blueprint()]);

        const chip = screen.getByRole('button', { name: /needs attention/i });
        expect(chip.textContent, 'a held target is drift the operator has to resolve').toMatch(/1/);
    });

    it('reports zero when nothing is drifted or held', () => {
        renderCatalog([blueprint({ deploymentCounts: { active: 1 } })]);

        // A zero count is the honest state: a Blueprint exists and none of its
        // targets need attention.
        const chip = screen.getByRole('button', { name: /needs attention/i });
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

describe('Needs attention covers more than drift', () => {
    const list = [
        blueprint({ id: 1, name: 'ok-bp', deploymentCounts: { active: 1 } }),
        blueprint({ id: 2, name: 'failed-bp', deploymentCounts: { failed: 1 } }),
        blueprint({ id: 3, name: 'conflict-bp', deploymentCounts: { name_conflict: 1 } }),
        blueprint({ id: 4, name: 'review-bp', deploymentCounts: { pending_state_review: 1 } }),
        blueprint({ id: 5, name: 'blocked-bp', deploymentCounts: { evict_blocked: 1 } }),
        blueprint({ id: 6, name: 'reapprove-bp', deploymentCounts: { active: 1 }, effectiveApproval: 'reapproval_required' }),
        blueprint({ id: 7, name: 'busy-bp', deploymentCounts: { deploying: 1 } }),
        blueprint({ id: 8, name: 'drift-bp', deploymentCounts: { active: 1, drifted: 1 } }),
    ];

    it('lists failed, conflicting, awaiting, blocked and reconfirm Blueprints, and leaves healthy and in-flight ones out', () => {
        renderCatalog(list);
        fireEvent.click(screen.getByRole('button', { name: /needs attention/i }));
        for (const name of ['failed-bp', 'conflict-bp', 'review-bp', 'blocked-bp', 'reapprove-bp', 'drift-bp']) {
            expect(screen.getByText(name)).toBeInTheDocument();
        }
        expect(screen.queryByText('ok-bp')).toBeNull();
        expect(screen.queryByText('busy-bp')).toBeNull();
        expect(screen.getByRole('button', { name: /needs attention/i }).textContent).toMatch(/6/);
    });

    it('names the dominant state on the tile, and says nothing extra for a healthy one', () => {
        renderCatalog(list);
        const failed = screen.getByText('failed-bp').closest('button')!;
        expect(failed.textContent).toMatch(/failed/);
        const ok = screen.getByText('ok-bp').closest('button')!;
        expect(ok.textContent).not.toMatch(/failed|drifted|pending/);
        expect(ok.textContent!.match(/active/g)).toHaveLength(1);
    });

    it('shows the strongest state when several apply, in plain words', () => {
        renderCatalog([
            blueprint({ id: 1, name: 'mixed-bp', deploymentCounts: { active: 1, drifted: 1, repair_held: 1 } }),
            blueprint({ id: 2, name: 'review-bp', deploymentCounts: { pending_state_review: 1 } }),
            blueprint({ id: 3, name: 'reapprove-bp', deploymentCounts: { active: 1 }, effectiveApproval: 'reapproval_required' }),
        ]);
        const text = (n: string) => screen.getByText(n).closest('button')!.textContent!;
        expect(text('mixed-bp')).toMatch(/repair held/);
        expect(text('mixed-bp')).not.toMatch(/drifted/);
        expect(text('review-bp')).toMatch(/awaiting confirmation/);
        expect(text('reapprove-bp')).toMatch(/reapproval required/);
    });

    it('offers a way back when the active filter matches nothing', () => {
        renderCatalog([blueprint({ id: 1, name: 'ok-bp', deploymentCounts: { active: 1 } })]);
        fireEvent.click(screen.getByRole('button', { name: /needs attention/i }));
        expect(screen.getByText(/No blueprints match this filter/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
        expect(screen.getByText('ok-bp')).toBeInTheDocument();
    });

    it('uses the singular for one Blueprint and hides New Blueprint without create rights', () => {
        renderCatalog([blueprint()]);
        expect(screen.getByText('1 Blueprint')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /new blueprint/i })).toBeNull();
    });

    it('counts the Blueprints in one header row beside New Blueprint', () => {
        render(<BlueprintCatalog blueprints={list} onSelect={() => {}} onCreate={() => {}} canCreate />);
        expect(screen.getByText('8 Blueprints')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /new blueprint/i })).toBeInTheDocument();
    });
});
