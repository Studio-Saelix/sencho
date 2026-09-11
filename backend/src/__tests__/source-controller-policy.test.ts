/**
 * SourceController automatic acceptance: when a poll settles with a staged
 * candidate and the source policy is 'automatic', the controller reads the
 * candidate's compose files off disk as evidence, evaluates them against the
 * security policy, and, when the verdict is allowed, accepts the candidate
 * on the policy's behalf (authority: configured_policy) and drives the
 * apply. Blocked or unprovable candidates hold for a human instead.
 *
 * evaluateCandidatePolicy is stubbed (the evaluator itself is covered by
 * policy-enforcement.test.ts) so each test decides the verdict, but the
 * compose file the controller reads as evidence is staged for real: a
 * verdict is only reachable when the evidence read succeeded, so these
 * tests cannot pass because of an unreadable candidate.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { stackManagedRoot } from '../services/gitops/directApplication';
import { GitSourceService } from '../services/GitSourceService';
import { SourceController } from '../services/gitops/SourceController';
import type { GitOpsApplicationRow } from '../services/gitops/types';
import type { ReconcileResult } from '../services/gitops/outcomes';

const TICK_MS = 60_000;
const okResult: ReconcileResult = { outcome: 'no_source_change', reason: 'ok', nextAction: 'none' };

type EvaluateCandidatePolicy = typeof import('../services/PolicyEnforcement')['evaluateCandidatePolicy'];

const evaluateCandidatePolicy = vi.hoisted(() =>
    vi.fn<(...args: Parameters<EvaluateCandidatePolicy>) => ReturnType<EvaluateCandidatePolicy>>(),
);
vi.mock('../services/PolicyEnforcement', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/PolicyEnforcement')>();
    return {
        ...actual,
        evaluateCandidatePolicy: ((...args: Parameters<EvaluateCandidatePolicy>) =>
            evaluateCandidatePolicy(...args)) as EvaluateCandidatePolicy,
    };
});

let tmpDir: string;
let controller: SourceController;

function mockDue(duePoll: GitOpsApplicationRow[], dueRetry: GitOpsApplicationRow[] = []): void {
    vi.spyOn(GitOpsStore.getInstance(), 'listSourcesDueForPoll').mockReturnValue(duePoll);
    vi.spyOn(GitOpsStore.getInstance(), 'listApplicationsDueForRetry').mockReturnValue(dueRetry);
}

function spyOnReconcile() {
    return vi.spyOn(GitSourceService.getInstance(), 'reconcile');
}

async function advanceOneTick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(TICK_MS);
}

function getApp(id: string): GitOpsApplicationRow {
    const app = GitOpsStore.getInstance().getApplication(id);
    if (!app) throw new Error(`application ${id} not found`);
    return app;
}

/** Write the compose file the controller reads as candidate evidence. */
function stageCandidateComposeFile(stackName: string, generationId: string): void {
    const dir = path.join(stackManagedRoot(stackName), 'generations', `candidate-${generationId}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
}

/**
 * Stage a live candidate through the real transitions, mirroring the fetch
 * success sequence GitSourceService drives: fetch opens, generation is
 * inserted, the commit lands, the candidate passes validation. reviewRequired
 * follows the production rule (anything not automatic needs a human sign-off).
 *
 * With opts.blocked the generation carries plan_blocked: 1 and the sequence
 * ends in sourceConflictBlocker instead: the durable state of a real
 * conflict-blocked candidate, which the acceptance boundary must refuse no
 * matter what the policy evaluator says.
 */
function stageCandidate(
    appId: string,
    stackName: string,
    generationId: string,
    policy: 'manual' | 'review' | 'automatic' = 'automatic',
    opts: { blocked?: boolean } = {},
): void {
    const app = { ...directApplicationFixture(appId, stackName), source_policy: policy };
    GitOpsTransitions.getInstance().activateDirect({
        application: app,
        nodeId: 1,
        envelope: { operationId: `seed-${appId}`, actor: 'test', trigger: 'config_change', at: Date.now() },
    });
    GitOpsStore.getInstance().insertGeneration({
        id: generationId,
        application_id: appId,
        commit_sha: 'c'.repeat(40),
        repo_url: 'https://github.com/example/repo.git',
        resolved_ref_kind: 'branch',
        configured_ref: 'main',
        repo_identity_json: '{"host":"github.com","pathname":"/example/repo.git"}',
        manifest_version: 1,
        candidate_dir: `generations/candidate-${generationId}`,
        applied_dir: `generations/applied-${generationId}-0`,
        expected_invocation_json: '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
        materialization_fingerprint: app.materialization_fingerprint ?? 'a'.repeat(64),
        validation_ok: 1,
        plan_blocked: opts.blocked ? 1 : 0,
        change_plan_fingerprint: 'f'.repeat(64),
        operation_id: `gen-${generationId}`,
        trigger: 'poll',
        actor: 'system:source-controller',
        previous_generation_id: null,
        redacted_limitations_json: '[]',
        portable_manifest_json: null,
        compose_inputs_json: null,
        source_policy_evidence_json: null,
        security_policy_evidence_json: null,
        support_requirements_json: null,
        compatibility_requirements_json: null,
        created_at: Date.now(),
    });
    const env = { operationId: `fetch-${appId}`, actor: 'test', trigger: 'poll', at: Date.now() };
    GitOpsTransitions.getInstance().fetchStarted(appId, env);
    GitOpsTransitions.getInstance().fetched(appId, 'c'.repeat(40), env);
    if (opts.blocked) {
        GitOpsTransitions.getInstance().sourceConflictBlocker(appId, generationId, env);
    } else {
        GitOpsTransitions.getInstance().candidateReady(appId, generationId, policy !== 'automatic', env);
    }
    stageCandidateComposeFile(stackName, generationId);
}

/** Arm the poll cursor in the past through the real transition, making the row poll-due. */
function armDuePoll(id: string): GitOpsApplicationRow {
    GitOpsTransitions.getInstance().sourcePollScheduled(
        id,
        Date.now() - 1_000,
        { operationId: `arm-${id}`, actor: 'test', trigger: 'poll', at: Date.now() },
    );
    return getApp(id);
}

/** A stored policy row shaped the way the evaluator hands it back. */
function policyRow() {
    return {
        id: 7,
        name: 'prod-gate',
        node_id: null,
        node_identity: 'control',
        stack_pattern: null,
        max_severity: 'HIGH' as const,
        block_on_deploy: 1,
        enabled: 1,
        replicated_from_control: 0,
        block_on_severity: 1,
        block_on_kev: 0,
        block_on_fixable: 1,
        created_at: 0,
        updated_at: 0,
    };
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    vi.useFakeTimers();
    SourceController.resetForTests();
    controller = SourceController.getInstance();
    evaluateCandidatePolicy.mockReset();
});

afterEach(() => {
    controller.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('SourceController automatic acceptance', () => {
    it('accepts a staged candidate on an automatic source and drives the apply', async () => {
        stageCandidate('app-accept', 'accept-web', 'gen-accept');
        mockDue([armDuePoll('app-accept')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        const reconcile = spyOnReconcile()
            .mockResolvedValueOnce({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' })
            .mockResolvedValueOnce(okResult);

        controller.start();
        await advanceOneTick();

        const row = getApp('app-accept');
        expect(row.accepted_generation_id).toBe('gen-accept');
        expect(row.review_required).toBe(0);
        expect(evaluateCandidatePolicy).toHaveBeenCalledWith(
            'accept-web',
            expect.any(Number),
            expect.any(Array),
            expect.objectContaining({ actor: 'system:source-controller', bypass: false }),
        );
        expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({
            intent: 'apply',
            applicationId: 'app-accept',
            stackName: 'accept-web',
            trigger: 'poll',
            actor: 'system:source-controller',
            commitSha: 'c'.repeat(40),
            planFingerprint: 'f'.repeat(64),
            deploy: false,
        }));
    });

    it('holds a blocked candidate for review without accepting it', async () => {
        stageCandidate('app-blocked', 'blocked-web', 'gen-blocked');
        mockDue([armDuePoll('app-blocked')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'blocked',
            violations: [],
        });
        const reconcile = spyOnReconcile()
            .mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });

        controller.start();
        await advanceOneTick();

        const row = getApp('app-blocked');
        // The evaluator was reached (the evidence read succeeded) and its
        // verdict, not a missing candidate file, is what holds the candidate.
        expect(evaluateCandidatePolicy).toHaveBeenCalled();
        expect(row.accepted_generation_id).toBeNull();
        expect(row.candidate_generation_id).toBe('gen-blocked');
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ intent: 'fetch' }));
    });

    it('holds a candidate the evaluator could not prove either way', async () => {
        stageCandidate('app-unproven', 'unproven-web', 'gen-unproven');
        mockDue([armDuePoll('app-unproven')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'unavailable',
            reason: 'Vulnerability scanner is unavailable',
        });
        const reconcile = spyOnReconcile()
            .mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });

        controller.start();
        await advanceOneTick();

        expect(evaluateCandidatePolicy).toHaveBeenCalled();
        expect(getApp('app-unproven').accepted_generation_id).toBeNull();
        expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('never auto-accepts on a review-policy source', async () => {
        stageCandidate('app-review', 'review-web', 'gen-review', 'review');
        mockDue([armDuePoll('app-review')]);
        const reconcile = spyOnReconcile()
            .mockResolvedValue({ outcome: 'pending_review', reason: 'ok', nextAction: 'review' });

        controller.start();
        await advanceOneTick();

        expect(getApp('app-review').accepted_generation_id).toBeNull();
        expect(evaluateCandidatePolicy).not.toHaveBeenCalled();
        expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('never auto-accepts a source whose policy is manual', async () => {
        stageCandidate('app-manual-cand', 'manual-cand-web', 'gen-manual', 'manual');
        mockDue([armDuePoll('app-manual-cand')]);
        const reconcile = spyOnReconcile()
            .mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });

        controller.start();
        await advanceOneTick();

        // The manual guard skips the row before any fetch or acceptance.
        expect(reconcile).not.toHaveBeenCalled();
        expect(evaluateCandidatePolicy).not.toHaveBeenCalled();
        const row = getApp('app-manual-cand');
        expect(row.accepted_generation_id).toBeNull();
        expect(row.candidate_generation_id).toBe('gen-manual');
    });

    it('does not re-accept a generation that is already accepted', async () => {
        stageCandidate('app-twice', 'twice-web', 'gen-twice');
        GitOpsTransitions.getInstance().sourceAccepted({
            applicationId: 'app-twice',
            generationId: 'gen-twice',
            artifactSetId: 'as-twice',
            sourceAcceptanceId: 'sa-twice',
            authority: 'operator',
            envelope: { operationId: 'accept-first', actor: 'operator', trigger: 'manual', at: Date.now() },
        });
        mockDue([armDuePoll('app-twice')]);
        const reconcile = spyOnReconcile()
            .mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });

        controller.start();
        await advanceOneTick();

        expect(evaluateCandidatePolicy).not.toHaveBeenCalled();
        expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('never accepts a durably conflict-blocked candidate, even through an allowed verdict', async () => {
        // A real sourceConflictBlocker candidate (durable
        // candidate_plan_blocked = 1) driven through an allowed security
        // verdict must not be accepted or applied. In production a blocked
        // candidate settles into the 'blocked' outcome, so automatic
        // acceptance must not run at all on that tick, and the boundary
        // refusal below backstops a success-shaped outcome on a blocked row.
        stageCandidate('app-real-blk', 'real-blk-web', 'gen-real-blk', 'automatic', { blocked: true });
        mockDue([armDuePoll('app-real-blk')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        const reconcile = spyOnReconcile()
            .mockResolvedValue({ outcome: 'blocked', reason: 'conflict', nextAction: 'resolve_conflict' });

        controller.start();
        await advanceOneTick();

        const row = getApp('app-real-blk');
        expect(row.accepted_generation_id).toBeNull();
        expect(row.candidate_generation_id).toBe('gen-real-blk');
        expect(row.candidate_plan_blocked).toBe(1);
        expect(evaluateCandidatePolicy).not.toHaveBeenCalled();
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ intent: 'fetch' }));
        expect(reconcile).not.toHaveBeenCalledWith(expect.objectContaining({ intent: 'apply' }));
    });

    it('refuses acceptance at the durable boundary when the row is blocked even under a success-shaped outcome', async () => {
        // Defense in depth: the reconcile mock reports a success-shaped
        // outcome while the durable row says the candidate is blocked, so the
        // outcome gate alone would run acceptance. The boundary re-reads the
        // row inside its own transaction and must refuse on the live state.
        stageCandidate('app-blk-durable', 'blk-durable-web', 'gen-blk-durable', 'automatic', { blocked: true });
        mockDue([armDuePoll('app-blk-durable')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        const reconcile = spyOnReconcile()
            .mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });

        controller.start();
        await advanceOneTick();

        expect(getApp('app-blk-durable').accepted_generation_id).toBeNull();
        expect(getApp('app-blk-durable').candidate_generation_id).toBe('gen-blk-durable');
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(reconcile).not.toHaveBeenCalledWith(expect.objectContaining({ intent: 'apply' }));
    });

    it('refuses acceptance when the policy changed during evaluation', async () => {
        // The race: a completed manual/review policy change must not be
        // bypassed by a policy evaluation that was already running when the
        // change landed. The evaluation returns 'allowed', but by then the
        // durable row has left 'automatic' through the real transition, so
        // the acceptance boundary re-reading the row inside its transaction
        // must refuse and the candidate must stay staged.
        stageCandidate('app-raced', 'raced-web', 'gen-raced');
        mockDue([armDuePoll('app-raced')]);
        evaluateCandidatePolicy.mockImplementation(async () => {
            GitOpsTransitions.getInstance().sourcePolicyChanged(
                'app-raced',
                'review',
                { operationId: 'policy-flip-mid-eval', actor: 'test', trigger: 'config_change', at: Date.now() },
            );
            return { status: 'allowed' };
        });
        const reconcile = spyOnReconcile()
            .mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });

        controller.start();
        await advanceOneTick();

        expect(evaluateCandidatePolicy).toHaveBeenCalled();
        const row = getApp('app-raced');
        expect(row.source_policy).toBe('review');
        expect(row.accepted_generation_id).toBeNull();
        expect(row.candidate_generation_id).toBe('gen-raced');
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(reconcile).not.toHaveBeenCalledWith(expect.objectContaining({ intent: 'apply' }));
    });

    it('leaves the accepted generation row byte-for-byte unchanged', async () => {
        stageCandidate('app-evidence', 'evidence-web', 'gen-evidence');
        mockDue([armDuePoll('app-evidence')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'allowed',
            policy: policyRow(),
        });
        spyOnReconcile().mockResolvedValue(okResult);
        const before = { ...GitOpsStore.getInstance().getGeneration('gen-evidence')! };

        controller.start();
        await advanceOneTick();

        // Acceptance moves the application pointer only. The generation row
        // is immutable candidate-time evidence: rewriting it to record the
        // acceptance verdict would break that contract, so the verdict lives
        // in the audit history instead and the row is left exactly as
        // inserted.
        expect(getApp('app-evidence').accepted_generation_id).toBe('gen-evidence');
        expect(GitOpsStore.getInstance().getGeneration('gen-evidence')).toEqual(before);
    });

    it('leaves no security-policy evidence behind when the candidate is held', async () => {
        stageCandidate('app-ev-held', 'ev-held-web', 'gen-ev-held');
        mockDue([armDuePoll('app-ev-held')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'blocked',
            violations: [],
        });
        spyOnReconcile().mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });

        controller.start();
        await advanceOneTick();

        // No acceptance, no evidence: a generation row must never imply a
        // policy verdict it does not have.
        expect(getApp('app-ev-held').accepted_generation_id).toBeNull();
        expect(GitOpsStore.getInstance().getGeneration('gen-ev-held')?.security_policy_evidence_json).toBeNull();
    });
});
