/**
 * The shared post-accept follow-up. Accept source and an operator pull both
 * read this result. A deadline answers without starting the step a second time,
 * and the pending promise is the work that outlasted the answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as gitManagedHandoff from '../services/gitops/gitManagedHandoff';
import * as gitManagedMaterialization from '../services/gitops/gitManagedMaterialization';
import { runBoundedGitManagedPostAccept } from '../services/gitops/boundedPostAccept';

const refusalNote = 'the artifact identity cannot be resolved for this content: the accepted generation materializes 2 compose files, which this freeze cannot model';
const transientNote = 'the accepted generation could not be materialized yet; the next reconcile retries it';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('runBoundedGitManagedPostAccept', () => {
    it('answers while preparation continues and settles when that work finishes', async () => {
        vi.useFakeTimers();
        let release!: (value: { materialized: boolean; artifact: 'resolved'; note: null }) => void;
        const prepare = vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration')
            .mockReturnValue(new Promise((resolve) => { release = resolve; }));
        const dispatch = vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockResolvedValue({ status: 'skipped', reason: gitManagedHandoff.GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON });

        const pending = runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });
        await vi.advanceTimersByTimeAsync(15_000);
        const settled = await pending;

        expect(settled.rollout).toBe('not_started');
        expect(settled.authorityNote).toBe('preparation is still running; the rollout becomes authorizable when it completes');
        expect(settled.acceptNote).toContain('Preparation is still running');
        expect(settled.acceptNote).not.toContain('is not resolved yet');
        expect(settled.materialized).toBe(false);
        expect(settled.artifactResolved).toBe(false);
        expect(settled.dispatched).toBe(false);
        expect(settled.pending).not.toBeNull();
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledTimes(1);

        release({ materialized: true, artifact: 'resolved', note: null });
        await settled.pending;
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('answers while dispatch continues', async () => {
        vi.useFakeTimers();
        const prepare = vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration').mockResolvedValue({
            materialized: true,
            artifact: 'resolved',
            note: null,
        });
        const dispatch = vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockReturnValue(new Promise(() => {}));

        const pending = runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: null,
            trigger: 'manual',
        });
        await vi.advanceTimersByTimeAsync(15_000);
        const settled = await pending;

        expect(settled.authorityNote).toBe('the rollout is starting; watch the application for progress');
        expect(settled.acceptNote).toBe('The rollout is starting; watch the application for progress.');
        expect(settled.materialized).toBe(true);
        expect(settled.artifactResolved).toBe(true);
        expect(settled.dispatched).toBe(false);
        expect(settled.pending).not.toBeNull();
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ actor: 'operator' }));
    });

    it('keeps a preparation refusal and drops the unresolved-artifact skip', async () => {
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration').mockResolvedValue({
            materialized: true,
            artifact: 'refused',
            note: refusalNote,
        });
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration').mockResolvedValue({
            status: 'skipped',
            reason: gitManagedHandoff.GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON,
        });

        const reported = await runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });

        expect(reported.authorityNote).toBe(refusalNote);
        expect(reported.acceptNote).toContain('cannot be resolved for this content');
        expect(reported.acceptNote).not.toContain('is not resolved yet');
        expect(reported.pending).toBeNull();
    });

    it('keeps a distinct handoff reason beside a preparation note', async () => {
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration').mockResolvedValue({
            materialized: false,
            artifact: 'none',
            note: transientNote,
        });
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration').mockResolvedValue({
            status: 'skipped',
            reason: 'the rollout is paused',
        });

        const settled = await runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'system:source-controller',
            trigger: 'poll',
        });

        expect(settled.pending).toBeNull();
        expect(settled.authorityNote).toBe(`${transientNote}. The rollout is paused`);
        expect(settled.acceptNote).toContain('could not be materialized yet');
        expect(settled.acceptNote).toContain('The rollout is paused.');
    });

    it('keeps a blocked reason when preparation is still running', async () => {
        vi.useFakeTimers();
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration')
            .mockReturnValue(new Promise(() => {}));
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockResolvedValue({ status: 'blocked', reason: 'a target has an unfinished rollback' });

        const pending = runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'system:source-controller',
            trigger: 'manual',
        });
        await vi.advanceTimersByTimeAsync(15_000);
        const settled = await pending;

        expect(settled.rollout).toBe('held');
        expect(settled.authorityNote).toBe('a target has an unfinished rollback');
        expect(settled.acceptNote).toContain('unfinished rollback');
    });

    it('keeps a blocked reason whatever the artifact evidence says', async () => {
        // A blocked dispatch is a finished refusal, so its reason is always the
        // report. Suppressing it because the artifact is unresolved would swap
        // "this target has an unfinished rollback" for a generic sentence that
        // names a different problem entirely.
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration')
            .mockResolvedValue({ materialized: false, artifact: 'refused', note: transientNote });
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockResolvedValue({
                status: 'blocked',
                reason: gitManagedHandoff.GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON,
            });

        const settled = await runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });

        expect(settled.rollout).toBe('held');
        expect(settled.authorityNote).toBe(`${transientNote}. The artifact identity is not resolved yet`);
        expect(settled.acceptNote).toContain('could not be materialized yet');
    });

    it('keeps a blocked reason while preparation is still running', async () => {
        // Preparation that has not answered says nothing about why the dispatch
        // was blocked, so the blocked reason stands alone rather than being
        // padded with a continuing note that names a different step.
        vi.useFakeTimers();
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration')
            .mockReturnValue(new Promise(() => {}));
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockResolvedValue({ status: 'blocked', reason: gitManagedHandoff.GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON });

        const pending = runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });
        await vi.advanceTimersByTimeAsync(15_000);
        const settled = await pending;

        expect(settled.rollout).toBe('held');
        expect(settled.authorityNote).toBe(gitManagedHandoff.GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON);
        // The accept note still says preparation is running: that is true, and
        // it is the note the operator reads for the preparation step.
        expect(settled.acceptNote).toContain('Preparation is still running');
    });

    it('treats a rejected step as finished so the slot can release', async () => {
        const prepare = vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration')
            .mockRejectedValue(new Error('registry down'));
        const dispatch = vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockResolvedValue({ status: 'skipped', reason: 'the rollout is paused' });

        const settled = await runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });

        expect(settled.pending).toBeNull();
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    // The three below separate a step that is still running from one that
    // finished and failed. Both settle inside the deadline and release the
    // slot, so only the wording tells them apart, and calling a settled
    // failure "starting" sends the operator to wait for work that is not
    // running. The deadline cases above keep the continuing wording.
    it('holds the rollout when the dispatch rejects before the deadline', async () => {
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration').mockResolvedValue({
            materialized: true,
            artifact: 'resolved',
            note: null,
        });
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockRejectedValue(new Error('could not read the dispatch entry'));

        const settled = await runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });

        expect(settled.pending).toBeNull();
        expect(settled.rollout).toBe('held');
        expect(settled.dispatched).toBe(false);
        expect(settled.authorityNote).toBe('the rollout could not be started');
        expect(settled.acceptNote).toBe('The rollout could not be started.');
        expect(settled.acceptNote).not.toMatch(/starting|still running/);
    });

    it('reports a rejected preparation as failed rather than still running', async () => {
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration')
            .mockRejectedValue(new Error('registry down'));
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockResolvedValue({ status: 'skipped', reason: gitManagedHandoff.GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON });

        const settled = await runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });

        expect(settled.pending).toBeNull();
        expect(settled.rollout).toBe('not_started');
        expect(settled.authorityNote).toBe('preparation failed; the next reconcile retries it');
        expect(settled.acceptNote).toBe('Preparation failed; the next reconcile retries it.');
        expect(settled.acceptNote).not.toMatch(/starting|still running/);
    });

    it('reports both steps failing once, rather than repeating one failure', async () => {
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration')
            .mockRejectedValue(new Error('registry down'));
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockRejectedValue(new Error('could not read the dispatch entry'));

        const settled = await runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });

        expect(settled.pending).toBeNull();
        expect(settled.rollout).toBe('held');
        expect(settled.authorityNote).toBe(
            'preparation failed; the next reconcile retries it. The rollout could not be started',
        );
        expect(settled.acceptNote).toBe(
            'Preparation failed; the next reconcile retries it. The rollout could not be started.',
        );
    });

    it('reports a preparation still running beside a dispatch that failed', async () => {
        // Both statements are true at once and neither cancels the other:
        // preparation carries on, and the rollout did not start. Reporting only
        // one would misdescribe the other.
        vi.useFakeTimers();
        vi.spyOn(gitManagedMaterialization, 'prepareAcceptedGitManagedGeneration')
            .mockReturnValue(new Promise(() => {}));
        vi.spyOn(gitManagedHandoff, 'dispatchPreparedGitManagedGeneration')
            .mockRejectedValue(new Error('could not read the dispatch entry'));

        const pending = runBoundedGitManagedPostAccept({
            applicationId: 'app-1',
            generationId: 'gen-1',
            actor: 'ada',
            trigger: 'manual',
        });
        await vi.advanceTimersByTimeAsync(15_000);
        const settled = await pending;

        // Preparation outlived the deadline, so the slot is still held on it.
        expect(settled.pending).not.toBeNull();
        expect(settled.rollout).toBe('held');
        expect(settled.acceptNote).toBe(
            'Preparation is still running; the rollout becomes authorizable when it completes. The rollout could not be started.',
        );
    });
});
