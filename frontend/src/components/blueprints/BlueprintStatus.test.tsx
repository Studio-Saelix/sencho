/**
 * The Blueprint's own Answer: what its deployments say, with the verb that
 * resolves the loudest problem. The GitOps status speaks instead when it holds a
 * warning or worse that is louder than the deployments answer, and whichever
 * source does not speak is named in a marker.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { BlueprintDeploymentStatus, BlueprintSummary } from '@/lib/blueprintsApi';
import { facets, liveRevision, target } from '@/__tests__/gitopsFixtures';
import type { FutureRolloutAuthorizationBinding } from '@/types/gitops';
import { BlueprintStatus, type BlueprintStatusHandlers } from './BlueprintStatus';

const binding: FutureRolloutAuthorizationBinding = {
    rolloutCandidateId: 'rc-1',
    acceptedGenerationId: 'gen-accepted',
    artifactSetId: 'art-1',
    intentRevisionId: 'int-1',
    requiredNodeIds: [1],
    sourceAcceptanceRef: 'sa-1',
    placementApprovalRef: 'pa-1',
    preflightFingerprint: 'a'.repeat(64),
};

// What an Inline Blueprint always carries: a rollout that is "not executable"
// and a runtime nothing GitOps applied. Neither says anything about it.
const inlineRevision = liveRevision({
    targetMode: 'inline_blueprint',
    blueprintId: 1,
    facets: facets({
        source: { status: 'not_applicable' },
        placement: { status: 'blueprint_bound', completion: 'unknown' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'rc-1' },
    }),
    targets: [target({ runtime: { status: 'never_applied' } })],
});

function summary(
    rows: Array<[number, BlueprintDeploymentStatus, string?]>,
    over: Partial<BlueprintSummary> = {},
): BlueprintSummary {
    return {
        blueprint: { id: 1, name: 'web', enabled: true, content_origin: 'inline' },
        deployments: rows.map(([node_id, status, last_error], i) => ({ id: i, node_id, status, last_error: last_error ?? null })),
        statusCounts: {},
        effectiveApproval: 'approved',
        gitopsRevision: inlineRevision,
        ...over,
    } as unknown as BlueprintSummary;
}

const nodeName = (id: number) => ({ 1: 'alpha', 2: 'beta' }[id as 1 | 2] ?? `node ${id}`);

function renderStatus(s: BlueprintSummary, handlers: BlueprintStatusHandlers = {}) {
    return render(<BlueprintStatus summary={s} nodeName={nodeName} handlers={handlers} busy={false} />);
}

describe('BlueprintStatus', () => {
    it('reads in sync for a healthy Inline Blueprint, with no rollout or runtime alarm', () => {
        renderStatus(summary([[1, 'active']]));
        expect(screen.getByTestId('blueprint-answer')).toHaveTextContent('in sync');
        expect(screen.getByTestId('blueprint-status').textContent).not.toMatch(/rollout|never applied/i);
        expect(screen.queryByTestId('blueprint-verb')).toBeNull();
    });

    it('offers Re-apply on a failure and runs the shared handler', () => {
        const reapply = vi.fn();
        renderStatus(summary([[2, 'failed', 'Error response from daemon: port is already allocated']]), { reapply });
        expect(screen.getByTestId('blueprint-answer')).toHaveTextContent('Deploy failed on beta.');
        expect(screen.getByTestId('blueprint-answer')).not.toHaveTextContent('port is already allocated');
        fireEvent.click(screen.getByRole('button', { name: 'Re-apply' }));
        expect(reapply).toHaveBeenCalledTimes(1);
    });

    it('offers no verb the session cannot run', () => {
        renderStatus(summary([[2, 'failed']]));
        expect(screen.getByTestId('blueprint-answer')).toHaveTextContent('failed');
        expect(screen.queryByRole('button', { name: 'Re-apply' })).toBeNull();
    });

    it('names the node a state review is for, and only when that node may be deployed to', () => {
        const reviewState = vi.fn();
        const { unmount } = renderStatus(summary([[2, 'pending_state_review']]), { reviewState, canDeployOnNode: () => false });
        expect(screen.queryByRole('button', { name: /Review state/ })).toBeNull();
        unmount();
        renderStatus(summary([[2, 'pending_state_review']]), { reviewState, canDeployOnNode: (id) => id === 2 });
        fireEvent.click(screen.getByRole('button', { name: 'Review state on beta' }));
        expect(reviewState).toHaveBeenCalledWith(2);
    });

    it('gates Evict on the right to withdraw from that node', () => {
        const evict = vi.fn();
        renderStatus(summary([[1, 'evict_blocked']]), { evict, canWithdrawFromNode: () => true });
        fireEvent.click(screen.getByRole('button', { name: 'Evict on alpha' }));
        expect(evict).toHaveBeenCalledWith(1);
    });

    it('offers Enable when the reconciler is off', () => {
        const enable = vi.fn();
        const s = summary([[1, 'active']]);
        s.blueprint = { ...s.blueprint, enabled: false };
        renderStatus(s, { enable });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        expect(enable).toHaveBeenCalled();
    });

    it('lets a blocked placement speak instead, since the deployments cannot say it', () => {
        const reason = 'Registry credentials are missing for a required private image.';
        renderStatus(summary([[1, 'active']], {
            gitopsRevision: liveRevision({
                targetMode: 'inline_blueprint',
                blueprintId: 1,
                facets: facets({ source: { status: 'not_applicable' }, placement: { status: 'preflight_blocked', reason, binding } }),
            }),
        }));
        expect(screen.getByTestId('gitops-answer')).toHaveTextContent(reason);
        expect(screen.queryByTestId('blueprint-answer')).toBeNull();
    });

    it('keeps a failed deploy above a quieter GitOps stage', () => {
        renderStatus(summary([[1, 'failed']]));
        expect(screen.getByTestId('blueprint-answer')).toHaveTextContent('failed');
        expect(screen.queryByTestId('gitops-answer')).toBeNull();
    });

    const blocked = (reason: string) => liveRevision({
        targetMode: 'inline_blueprint',
        blueprintId: 1,
        facets: facets({ source: { status: 'not_applicable' }, placement: { status: 'preflight_blocked', reason, binding } }),
    });

    it('keeps a failed deploy and its verb when the GitOps blocker is equally loud, and names the blocker', () => {
        const reapply = vi.fn();
        renderStatus(summary([[1, 'failed']], { gitopsRevision: blocked('Registry credentials are missing.') }), { reapply });
        expect(screen.getByTestId('blueprint-answer')).toHaveTextContent('failed');
        expect(screen.getByTestId('blueprint-answer')).toHaveTextContent(/gitops .*preflight/i);
        expect(screen.queryByTestId('gitops-answer')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Re-apply' }));
        expect(reapply).toHaveBeenCalled();
    });

    it('names the deployments problem when the GitOps answer is louder', () => {
        renderStatus(summary([[1, 'drifted']], { gitopsRevision: blocked('Registry credentials are missing.') }));
        expect(screen.getByTestId('gitops-answer')).toHaveTextContent('Registry credentials are missing.');
        expect(screen.getByTestId('gitops-status')).toHaveTextContent('deployments drifted');
    });

    it('still shows a paused rollout, which is a real state for a Blueprint', () => {
        renderStatus(summary([[1, 'active']], {
            gitopsRevision: liveRevision({
                targetMode: 'inline_blueprint',
                blueprintId: 1,
                facets: facets({
                    source: { status: 'not_applicable' },
                    placement: { status: 'blueprint_bound', completion: 'unknown' },
                    rollout: { status: 'rollout_paused', pauseReason: 'operator pause' } as never,
                }),
            }),
        }));
        expect(screen.getByTestId('gitops-status').textContent).toMatch(/rollout/i);
    });

    it('does not offer Re-apply on a failure while the reconciler is off', () => {
        const s = summary([[2, 'failed']]);
        s.blueprint = { ...s.blueprint, enabled: false };
        renderStatus(s, { reapply: vi.fn(), enable: vi.fn() });
        expect(screen.queryByRole('button', { name: 'Re-apply' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    });

    it('does not repeat a failure through GitOps runtime, which mirrors the deployments', () => {
        renderStatus(summary([[1, 'failed']], {
            gitopsRevision: liveRevision({
                targetMode: 'inline_blueprint',
                blueprintId: 1,
                facets: facets({ source: { status: 'not_applicable' }, placement: { status: 'blueprint_bound', completion: 'unknown' } }),
                targets: [target({ runtime: { status: 'failed_after_mutation' } as never })],
            }),
        }));
        expect(screen.getByTestId('blueprint-answer')).toHaveTextContent('failed');
        expect(screen.getByTestId('blueprint-answer')).not.toHaveTextContent(/gitops failed after change/i);
    });
});
