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
import { candidateContentFingerprint } from '../services/gitops/fingerprint';
import { GitSourceService } from '../services/GitSourceService';
import { SourceController } from '../services/gitops/SourceController';
import { attentionReasons } from '../services/gitops/attention';
import { projectApplication } from '../services/gitops/derive';
import { DatabaseService } from '../services/DatabaseService';
import type { GitOpsApplicationRow } from '../services/gitops/types';
import type { ReconcileResult } from '../services/gitops/outcomes';

const TICK_MS = 60_000;
const okResult: ReconcileResult = { outcome: 'no_source_change', reason: 'ok', nextAction: 'none' };
const fetchedResult: ReconcileResult = { outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' };

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

/** Stub the shared dispatch boundary so an accepted candidate never runs a
 *  real promotion against these fixtures; acceptance tests assert the handoff,
 *  and dispatch's own behavior is covered in git-source-service.test.ts. */
function spyOnDispatch() {
    return vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
        .mockResolvedValue({ status: 'dispatched' });
}

async function advanceOneTick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(TICK_MS);
}

function getApp(id: string): GitOpsApplicationRow {
    const app = GitOpsStore.getInstance().getApplication(id);
    if (!app) throw new Error(`application ${id} not found`);
    return app;
}

const STAGED_COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n';

/** Write the compose file the controller reads as candidate evidence. */
function writeCandidateCompose(stackName: string, generationId: string, compose: string): void {
    const dir = path.join(stackManagedRoot(stackName), 'generations', `candidate-${generationId}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), compose);
}

/** Write the applied copy of a generation, the content the guard diffs against. */
function writeAppliedCompose(stackName: string, generationId: string, compose: string): void {
    const dir = path.join(stackManagedRoot(stackName), 'generations', `applied-${generationId}-0`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), compose);
}

type StageOpts = {
    blocked?: boolean;
    sourceEvidence?: string | null;
    securityEvidence?: string | null;
    composeInputs?: string | null;
    compose?: string;
};

/**
 * Insert a generation and drive it through the real fetch transitions,
 * mirroring the sequence GitSourceService drives: fetch opens, generation is
 * inserted, the commit lands, the candidate passes validation. reviewRequired
 * follows the production rule (anything not automatic needs a human sign-off).
 *
 * With opts.blocked the generation carries plan_blocked: 1 and the sequence
 * ends in sourceConflictBlocker instead: the durable state of a real
 * conflict-blocked candidate, which the acceptance boundary must refuse no
 * matter what the policy evaluator says.
 */
function insertAndStageGeneration(
    app: GitOpsApplicationRow,
    stackName: string,
    generationId: string,
    opts: StageOpts = {},
): void {
    const appId = app.id;
    const policy = app.source_policy;
    const compose = opts.compose ?? STAGED_COMPOSE;
    const contentSha = candidateContentFingerprint([{ path: 'compose.yaml', content: compose }]);
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
        compose_inputs_json: opts.composeInputs === undefined
            ? JSON.stringify({ candidateContentSha256: contentSha })
            : opts.composeInputs,
        source_policy_evidence_json: opts.sourceEvidence === undefined
            ? JSON.stringify({ sourcePolicy: policy })
            : opts.sourceEvidence,
        security_policy_evidence_json: opts.securityEvidence === undefined
            ? JSON.stringify({ status: 'allowed', policyId: null })
            : opts.securityEvidence,
        support_requirements_json: null,
        compatibility_requirements_json: null,
    secret_capability_json: null,
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
    writeCandidateCompose(stackName, generationId, compose);
}

/** Activate a fresh Direct application and stage its first candidate. */
function stageCandidate(
    appId: string,
    stackName: string,
    generationId: string,
    policy: 'manual' | 'review' | 'automatic' = 'automatic',
    opts: StageOpts = {},
): void {
    const app = { ...directApplicationFixture(appId, stackName), source_policy: policy };
    GitOpsTransitions.getInstance().activateDirect({
        application: app,
        nodeId: 1,
        envelope: { operationId: `seed-${appId}`, actor: 'test', trigger: 'config_change', at: Date.now() },
    });
    insertAndStageGeneration(app, stackName, generationId, opts);
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
            .mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });
        const dispatch = spyOnDispatch();

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
        // The apply is no longer a fused reconcile: the accepted generation
        // travels through the shared dispatch boundary with the generation's
        // own contract, a direct-mode context, and the poll trigger.
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                generationId: 'gen-accept',
                applicationId: 'app-accept',
                commitSha: 'c'.repeat(40),
                changePlanFingerprint: 'f'.repeat(64),
            }),
            expect.objectContaining({ targetMode: 'direct', bindingRevision: null }),
            { trigger: 'poll', actor: 'system:source-controller' },
        );
    });

    it('logs the refusal when the dispatch boundary blocks an accepted generation', async () => {
        stageCandidate('app-dispatch-blocked', 'dispatch-blocked-web', 'gen-dispatch-blocked');
        mockDue([armDuePoll('app-dispatch-blocked')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });
        // The acceptance stands while the apply is refused, so the durable
        // rows alone cannot explain why nothing moved: the blocked arm must
        // log the reason the boundary returned.
        const dispatch = vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
            .mockResolvedValue({ status: 'blocked', reason: 'The live target no longer matches the accepted generation.' });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        controller.start();
        await advanceOneTick();

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(getApp('app-dispatch-blocked').accepted_generation_id).toBe('gen-dispatch-blocked');
        expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('[SourceController] automatic dispatch blocked for app-dispatch-blocked')
            && String(args[0]).includes('no longer matches'))).toBe(true);
    });

    it('logs the manual remedy, without the credential, when the dispatch fails before reserving an attempt', async () => {
        stageCandidate('app-dispatch-throw', 'dispatch-throw-web', 'gen-dispatch-throw');
        mockDue([armDuePoll('app-dispatch-throw')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue({ outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' });
        // A throw means nothing was reserved, so no row exists and the next
        // tick will not retry: the log is the only evidence, and it must say
        // what stands (the acceptance) and what the operator must do. The
        // error text emulates a transport failure embedding a credential,
        // which the handler must redact before the stack reaches the server
        // log: this line is the only record that will ever exist.
        const dispatch = vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
            .mockRejectedValue(Object.assign(
                new Error("fatal: cannot reach 'https://user:sup3rs3cr3t@example.com/repo.git/'"),
                { stack: "Error: fatal: cannot reach 'https://user:sup3rs3cr3t@example.com/repo.git/'\n    at dispatchAcceptedGeneration (test)" },
            ));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        controller.start();
        await advanceOneTick();

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(getApp('app-dispatch-throw').accepted_generation_id).toBe('gen-dispatch-throw');
        const calls = errorSpy.mock.calls.filter((args) => String(args[0]).includes('[SourceController] automatic dispatch failed for app-dispatch-throw before reserving an attempt'));
        expect(calls.some((args) => String(args[0]).includes('dispatch it manually'))).toBe(true);
        // The scrubbed error is the second argument, and neither the message
        // nor the stack may carry the credential through to the server log.
        expect(calls).toHaveLength(1);
        const loggedError = String(calls[0]![1]);
        expect(loggedError).not.toContain('sup3rs3cr3t');
        expect(loggedError).toContain('[redacted]');
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
        // must refuse. Revalidation mints a replacement that records the
        // live source policy; the original generation stays byte-identical
        // and nothing is accepted.
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
        const original = { ...GitOpsStore.getInstance().getGeneration('gen-raced')! };

        controller.start();
        await advanceOneTick();

        expect(evaluateCandidatePolicy).toHaveBeenCalled();
        const row = getApp('app-raced');
        expect(row.source_policy).toBe('review');
        expect(row.accepted_generation_id).toBeNull();
        expect(row.candidate_generation_id).not.toBe('gen-raced');
        expect(GitOpsStore.getInstance().getGeneration('gen-raced')).toEqual(original);
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(reconcile).not.toHaveBeenCalledWith(expect.objectContaining({ intent: 'apply' }));
    });

    it('leaves the accepted generation row byte-for-byte unchanged', async () => {
        stageCandidate('app-evidence', 'evidence-web', 'gen-evidence', 'automatic', {
            securityEvidence: JSON.stringify({ status: 'allowed', policyId: 7 }),
        });
        mockDue([armDuePoll('app-evidence')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'allowed',
            policy: policyRow(),
        });
        spyOnReconcile().mockResolvedValue(okResult);
        // The apply leg is this test's only side effect on the generation row
        // path; stubbing it keeps the assertion about acceptance evidence,
        // not dispatch.
        spyOnDispatch();
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

    it('inserts a new generation when security-policy evidence changed after candidate creation', async () => {
        stageCandidate('app-ev-changed', 'ev-changed-web', 'gen-ev-changed', 'automatic', {
            securityEvidence: JSON.stringify({ status: 'allowed', policyId: 1 }),
        });
        mockDue([armDuePoll('app-ev-changed')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'allowed',
            policy: policyRow(),
        });
        spyOnReconcile().mockResolvedValue(okResult);
        const dispatch = spyOnDispatch();
        const before = { ...GitOpsStore.getInstance().getGeneration('gen-ev-changed')! };

        controller.start();
        await advanceOneTick();

        expect(GitOpsStore.getInstance().getGeneration('gen-ev-changed')).toEqual(before);
        const generations = GitOpsStore.getInstance().listGenerationsForApplication('app-ev-changed');
        expect(generations).toHaveLength(2);
        const replacement = generations.find((row) => row.id !== 'gen-ev-changed');
        expect(replacement).toBeDefined();
        expect(replacement!.previous_generation_id).toBe('gen-ev-changed');
        expect(replacement!.security_policy_evidence_json).toContain('"policyId":7');
        expect(getApp('app-ev-changed').accepted_generation_id).toBe(replacement!.id);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0].generationId).toBe(replacement!.id);
    });

    it('does not accept when the application fingerprint changed after candidate creation', async () => {
        stageCandidate('app-fp-changed', 'fp-changed-web', 'gen-fp-changed');
        DatabaseService.getInstance().getDb().prepare(
            'UPDATE gitops_applications SET materialization_fingerprint = ? WHERE id = ?',
        ).run('b'.repeat(64), 'app-fp-changed');
        mockDue([armDuePoll('app-fp-changed')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'allowed',
            policy: policyRow(),
        });
        spyOnReconcile().mockResolvedValue(okResult);
        const dispatch = spyOnDispatch();
        const before = { ...GitOpsStore.getInstance().getGeneration('gen-fp-changed')! };

        controller.start();
        await advanceOneTick();

        expect(GitOpsStore.getInstance().getGeneration('gen-fp-changed')).toEqual(before);
        expect(GitOpsStore.getInstance().listGenerationsForApplication('app-fp-changed')).toHaveLength(1);
        expect(getApp('app-fp-changed').accepted_generation_id).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not accept when the recorded content digest is missing', async () => {
        stageCandidate('app-ev-nohash', 'ev-nohash-web', 'gen-ev-nohash', 'automatic', {
            composeInputs: null,
        });
        mockDue([armDuePoll('app-ev-nohash')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(okResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('app-ev-nohash').accepted_generation_id).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
        expect(GitOpsStore.getInstance().listGenerationsForApplication('app-ev-nohash')).toHaveLength(1);
    });

    it('does not accept when a compose path escapes the candidate directory', async () => {
        stageCandidate('app-ev-escape', 'ev-escape-web', 'gen-ev-escape');
        DatabaseService.getInstance().getDb().prepare(
            'UPDATE gitops_applications SET compose_paths_json = ? WHERE id = ?',
        ).run(JSON.stringify(['compose.yaml', '../outside.yaml']), 'app-ev-escape');
        mockDue([armDuePoll('app-ev-escape')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(okResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('app-ev-escape').accepted_generation_id).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
        expect(GitOpsStore.getInstance().listGenerationsForApplication('app-ev-escape')).toHaveLength(1);
    });

    it('does not accept when candidate compose files were removed after staging', async () => {
        stageCandidate('app-ev-removed', 'ev-removed-web', 'gen-ev-removed');
        const composePath = path.join(
            stackManagedRoot('ev-removed-web'),
            'generations',
            'candidate-gen-ev-removed',
            'compose.yaml',
        );
        fs.unlinkSync(composePath);
        mockDue([armDuePoll('app-ev-removed')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'allowed',
            policy: policyRow(),
        });
        spyOnReconcile().mockResolvedValue(okResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('app-ev-removed').accepted_generation_id).toBeNull();
        expect(getApp('app-ev-removed').candidate_generation_id).toBe('gen-ev-removed');
        expect(dispatch).not.toHaveBeenCalled();
        expect(GitOpsStore.getInstance().listGenerationsForApplication('app-ev-removed')).toHaveLength(1);
    });

    it('does not accept when candidate compose files were replaced after staging', async () => {
        stageCandidate('app-ev-replaced', 'ev-replaced-web', 'gen-ev-replaced');
        const composePath = path.join(
            stackManagedRoot('ev-replaced-web'),
            'generations',
            'candidate-gen-ev-replaced',
            'compose.yaml',
        );
        fs.writeFileSync(composePath, 'services:\n  web:\n    image: nginx:1.28\n');
        mockDue([armDuePoll('app-ev-replaced')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'allowed',
            policy: policyRow(),
        });
        spyOnReconcile().mockResolvedValue(okResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('app-ev-replaced').accepted_generation_id).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
        expect(GitOpsStore.getInstance().listGenerationsForApplication('app-ev-replaced')).toHaveLength(1);
    });

    it('does not accept when candidate compose files were modified after staging', async () => {
        stageCandidate('app-ev-modified', 'ev-modified-web', 'gen-ev-modified');
        const composePath = path.join(
            stackManagedRoot('ev-modified-web'),
            'generations',
            'candidate-gen-ev-modified',
            'compose.yaml',
        );
        fs.appendFileSync(composePath, '# drifted\n');
        mockDue([armDuePoll('app-ev-modified')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'allowed',
            policy: policyRow(),
        });
        spyOnReconcile().mockResolvedValue(okResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('app-ev-modified').accepted_generation_id).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('reuses the existing generation when evidence is unchanged', async () => {
        stageCandidate('app-ev-same', 'ev-same-web', 'gen-ev-same', 'automatic', {
            securityEvidence: JSON.stringify({ status: 'allowed', policyId: 7 }),
        });
        mockDue([armDuePoll('app-ev-same')]);
        evaluateCandidatePolicy.mockResolvedValue({
            status: 'allowed',
            policy: policyRow(),
        });
        spyOnReconcile().mockResolvedValue(okResult);
        spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('app-ev-same').accepted_generation_id).toBe('gen-ev-same');
        expect(GitOpsStore.getInstance().listGenerationsForApplication('app-ev-same')).toHaveLength(1);
    });

    it('inserts a new generation when source-policy evidence changed after candidate creation', async () => {
        stageCandidate('app-src-changed', 'src-changed-web', 'gen-src-changed', 'automatic', {
            sourceEvidence: JSON.stringify({ sourcePolicy: 'review' }),
        });
        mockDue([armDuePoll('app-src-changed')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(okResult);
        const dispatch = spyOnDispatch();
        const before = { ...GitOpsStore.getInstance().getGeneration('gen-src-changed')! };

        controller.start();
        await advanceOneTick();

        expect(GitOpsStore.getInstance().getGeneration('gen-src-changed')).toEqual(before);
        const generations = GitOpsStore.getInstance().listGenerationsForApplication('app-src-changed');
        expect(generations).toHaveLength(2);
        const replacement = generations.find((row) => row.id !== 'gen-src-changed');
        expect(replacement).toBeDefined();
        expect(replacement!.previous_generation_id).toBe('gen-src-changed');
        expect(replacement!.source_policy_evidence_json).toContain('"sourcePolicy":"automatic"');
        expect(getApp('app-src-changed').accepted_generation_id).toBe(replacement!.id);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0].generationId).toBe(replacement!.id);
    });

    it('leaves no security-policy evidence behind when the candidate is held', async () => {
        stageCandidate('app-ev-held', 'ev-held-web', 'gen-ev-held', 'automatic', {
            securityEvidence: null,
        });
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

/**
 * The automatic path is the only acceptance route with no human in the loop,
 * so it must never withdraw a stateful workload on its own. Each test stages a
 * real accepted generation with a stateful service on disk, then drives the
 * controller against a follow-up candidate that either preserves or withdraws
 * it. The block falls back to the review behavior and must be visible as a
 * canonical attention state, never a silent skip.
 */
describe('SourceController stateful withdrawal guard', () => {
    const STATEFUL_COMPOSE = [
        'services:',
        '  db:',
        '    image: postgres:16',
        '    volumes:',
        '      - pgdata:/var/lib/postgresql/data',
        'volumes:',
        '  pgdata:',
        '',
    ].join('\n');
    const KEEPS_STATEFUL_COMPOSE = [
        'services:',
        '  db:',
        '    image: postgres:17',
        '    volumes:',
        '      - pgdata:/var/lib/postgresql/data',
        '  cache:',
        '    image: redis:7',
        'volumes:',
        '  pgdata:',
        '',
    ].join('\n');
    const WITHDRAWN_COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n';

    /** Accept the staged candidate through the real transition and lay down the applied copy. */
    function acceptAndApply(appId: string, stackName: string, generationId: string, compose: string): void {
        GitOpsTransitions.getInstance().sourceAccepted({
            applicationId: appId,
            generationId,
            artifactSetId: `as-${generationId}`,
            sourceAcceptanceId: `sa-${generationId}`,
            authority: 'operator',
            envelope: { operationId: `accept-${generationId}`, actor: 'operator', trigger: 'manual', at: Date.now() },
        });
        writeAppliedCompose(stackName, generationId, compose);
    }

    function stageFollowUp(
        appId: string,
        stackName: string,
        generationId: string,
        compose: string,
    ): void {
        insertAndStageGeneration(getApp(appId), stackName, generationId, { compose });
    }

    it('holds a candidate that withdraws a stateful service instead of auto-accepting', async () => {
        stageCandidate('app-withdraw', 'withdraw-web', 'wd-prev', 'automatic', { compose: STATEFUL_COMPOSE });
        acceptAndApply('app-withdraw', 'withdraw-web', 'wd-prev', STATEFUL_COMPOSE);
        stageFollowUp('app-withdraw', 'withdraw-web', 'wd-next', WITHDRAWN_COMPOSE);
        mockDue([armDuePoll('app-withdraw')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        const dispatch = spyOnDispatch();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        controller.start();
        await advanceOneTick();

        const row = getApp('app-withdraw');
        // The refusal falls back to review exactly as if the policy were
        // 'review': the candidate stays staged, nothing is accepted or
        // dispatched, and the reason names the stateful block.
        expect(row.accepted_generation_id).toBe('wd-prev');
        expect(row.candidate_generation_id).toBe('wd-next');
        expect(row.review_required).toBe(1);
        expect(row.review_block_reason).toBe('stateful_withdrawal');
        expect(dispatch).not.toHaveBeenCalled();
        expect(warnSpy.mock.calls.some((args) =>
            String(args[0]).includes('[SourceController] automatic candidate held for app-withdraw')
            && String(args[0]).includes('withdraws or renames stateful services')
            && String(args[0]).includes('db'))).toBe(true);

        // The block reaches the hub-side classifier as its own named reason.
        const projection = projectApplication('app-withdraw', false);
        expect(attentionReasons(projection)).toContain('stateful_withdrawal_blocked');
    });

    it('blocks a renamed stateful service the same as a removed one', async () => {
        stageCandidate('app-rename', 'rename-web', 'rn-prev', 'automatic', { compose: STATEFUL_COMPOSE });
        acceptAndApply('app-rename', 'rename-web', 'rn-prev', STATEFUL_COMPOSE);
        // The same data-bearing service under a new name: the old name leaves
        // the stateful set, so the data it owned is orphaned by the rename.
        stageFollowUp('app-rename', 'rename-web', 'rn-next', [
            'services:',
            '  database:',
            '    image: postgres:17',
            '    volumes:',
            '      - pgdata:/var/lib/postgresql/data',
            'volumes:',
            '  pgdata:',
            '',
        ].join('\n'));
        mockDue([armDuePoll('app-rename')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('app-rename').review_block_reason).toBe('stateful_withdrawal');
        expect(getApp('app-rename').accepted_generation_id).toBe('rn-prev');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('still auto-accepts a change that keeps every stateful service', async () => {
        stageCandidate('app-additive', 'additive-web', 'ad-prev', 'automatic', { compose: STATEFUL_COMPOSE });
        acceptAndApply('app-additive', 'additive-web', 'ad-prev', STATEFUL_COMPOSE);
        stageFollowUp('app-additive', 'additive-web', 'ad-next', KEEPS_STATEFUL_COMPOSE);
        mockDue([armDuePoll('app-additive')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        const row = getApp('app-additive');
        expect(row.accepted_generation_id).toBe('ad-next');
        expect(row.review_required).toBe(0);
        expect(row.review_block_reason).toBeNull();
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('does not re-evaluate a source that already fell back to review', async () => {
        stageCandidate('app-once', 'once-web', 'on-prev', 'automatic', { compose: STATEFUL_COMPOSE });
        acceptAndApply('app-once', 'once-web', 'on-prev', STATEFUL_COMPOSE);
        stageFollowUp('app-once', 'once-web', 'on-next', WITHDRAWN_COMPOSE);
        mockDue([armDuePoll('app-once')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        spyOnDispatch();

        controller.start();
        await advanceOneTick();
        await advanceOneTick();

        // The refusal is durable: the next tick re-runs the fetch mock but
        // never re-evaluates the policy, so the block cannot turn into a
        // retry loop that eventually slips an acceptance through.
        expect(evaluateCandidatePolicy).toHaveBeenCalledTimes(1);
        expect(getApp('app-once').review_block_reason).toBe('stateful_withdrawal');
    });

    it('holds when the generation in force cannot be read', async () => {
        stageCandidate('app-unreadable', 'unreadable-web', 'un-prev', 'automatic', { compose: STATEFUL_COMPOSE });
        acceptAndApply('app-unreadable', 'unreadable-web', 'un-prev', STATEFUL_COMPOSE);
        // Both copies of the generation in force disappear (an operator pruned
        // the managed area by hand): the guard cannot prove the stateful
        // services survive, so it holds rather than guess.
        fs.rmSync(path.join(stackManagedRoot('unreadable-web'), 'generations', 'applied-un-prev-0'), { recursive: true, force: true });
        fs.rmSync(path.join(stackManagedRoot('unreadable-web'), 'generations', 'candidate-un-prev'), { recursive: true, force: true });
        stageFollowUp('app-unreadable', 'unreadable-web', 'un-next', KEEPS_STATEFUL_COMPOSE);
        mockDue([armDuePoll('app-unreadable')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        const dispatch = spyOnDispatch();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        controller.start();
        await advanceOneTick();

        expect(getApp('app-unreadable').accepted_generation_id).toBe('un-prev');
        expect(getApp('app-unreadable').review_block_reason).toBe('stateful_withdrawal');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('holds a candidate that keeps a stateful service name but strips its volumes', async () => {
        stageCandidate('app-strip', 'strip-web', 'st-prev', 'automatic', { compose: STATEFUL_COMPOSE });
        acceptAndApply('app-strip', 'strip-web', 'st-prev', STATEFUL_COMPOSE);
        // Same service name, no mount: the data the service owned is left
        // behind, which is a withdrawal even though the name survives.
        stageFollowUp('app-strip', 'strip-web', 'st-next', 'services:\n  db:\n    image: postgres:17\n');
        mockDue([armDuePoll('app-strip')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        const dispatch = spyOnDispatch();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        controller.start();
        await advanceOneTick();

        // The withdrawal branch, not an unreadable-evidence hold.
        expect(warnSpy.mock.calls.some((args) =>
            String(args[0]).includes('withdraws or renames stateful services (db)'))).toBe(true);
        expect(getApp('app-strip').accepted_generation_id).toBe('st-prev');
        expect(getApp('app-strip').review_block_reason).toBe('stateful_withdrawal');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('holds when the candidate compose does not parse', async () => {
        // A stateless baseline, so no withdrawal is possible: only the parse
        // failure itself can hold. It must read as missing evidence, never as
        // "nothing stateful here".
        stageCandidate('app-badyaml', 'badyaml-web', 'by-prev', 'automatic', { compose: WITHDRAWN_COMPOSE });
        acceptAndApply('app-badyaml', 'badyaml-web', 'by-prev', WITHDRAWN_COMPOSE);
        stageFollowUp('app-badyaml', 'badyaml-web', 'by-next', 'services:\n  db: [unclosed\n');
        mockDue([armDuePoll('app-badyaml')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        const dispatch = spyOnDispatch();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        controller.start();
        await advanceOneTick();

        expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('compose does not parse'))).toBe(true);
        expect(getApp('app-badyaml').accepted_generation_id).toBe('by-prev');
        expect(getApp('app-badyaml').review_block_reason).toBe('stateful_withdrawal');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('accepts the first candidate when no generation is in force yet', async () => {
        // No managed baseline exists, so the first acceptance defines it,
        // even for a stateful compose.
        stageCandidate('app-first', 'first-web', 'fi-first', 'automatic', { compose: STATEFUL_COMPOSE });
        mockDue([armDuePoll('app-first')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('app-first').accepted_generation_id).toBe('fi-first');
        expect(getApp('app-first').review_block_reason).toBeNull();
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});

/**
 * The durable block makes the controller skip the source on every tick, so
 * every exit from the held state must clear the reason. A reason left behind
 * would silently stop automatic acceptance for that application forever.
 */
describe('stateful review block lifecycle', () => {
    function envelope(id: string) {
        return { operationId: id, actor: 'operator', trigger: 'manual' as const, at: Date.now() };
    }

    /** Stage an accepted baseline plus a follow-up candidate, then record the block. */
    function blocked(appId: string, stackName: string): void {
        stageCandidate(appId, stackName, `${appId}-prev`, 'automatic');
        GitOpsTransitions.getInstance().sourceAccepted({
            applicationId: appId,
            generationId: `${appId}-prev`,
            artifactSetId: `as-${appId}-prev`,
            sourceAcceptanceId: `sa-${appId}-prev`,
            authority: 'operator',
            envelope: envelope(`accept-${appId}-prev`),
        });
        insertAndStageGeneration(getApp(appId), stackName, `${appId}-next`);
        GitOpsTransitions.getInstance().sourceReviewBlocked({
            applicationId: appId,
            generationId: `${appId}-next`,
            reason: 'stateful_withdrawal',
            envelope: envelope(`block-${appId}`),
        });
        expect(getApp(appId).review_block_reason).toBe('stateful_withdrawal');
        expect(getApp(appId).review_required).toBe(1);
    }

    it('clears on explicit operator acceptance', () => {
        blocked('blk-accept', 'blk-accept-web');
        GitOpsTransitions.getInstance().sourceAccepted({
            applicationId: 'blk-accept',
            generationId: 'blk-accept-next',
            artifactSetId: 'as-blk-accept-next',
            sourceAcceptanceId: 'sa-blk-accept-next',
            authority: 'operator',
            envelope: envelope('accept-blk-accept-next'),
        });
        const row = getApp('blk-accept');
        expect(row.accepted_generation_id).toBe('blk-accept-next');
        expect(row.review_block_reason).toBeNull();
        expect(row.review_required).toBe(0);
    });

    it('clears on dismissal', () => {
        blocked('blk-dismiss', 'blk-dismiss-web');
        GitOpsTransitions.getInstance().dismissed('blk-dismiss', envelope('dismiss-blk'));
        const row = getApp('blk-dismiss');
        expect(row.candidate_generation_id).toBeNull();
        expect(row.review_block_reason).toBeNull();
    });

    it('clears when a newer candidate is staged', () => {
        blocked('blk-newer', 'blk-newer-web');
        insertAndStageGeneration(getApp('blk-newer'), 'blk-newer-web', 'blk-newer-third');
        const row = getApp('blk-newer');
        expect(row.candidate_generation_id).toBe('blk-newer-third');
        expect(row.review_block_reason).toBeNull();
        expect(row.review_required).toBe(0);
    });

    it.each(['review', 'manual'] as const)('clears when the policy moves to %s', (policy) => {
        const id = `blk-policy-${policy}`;
        blocked(id, `${id}-web`);
        GitOpsTransitions.getInstance().sourcePolicyChanged(id, policy, envelope(`policy-${id}`));
        const row = getApp(id);
        expect(row.review_block_reason).toBeNull();
        // The candidate still needs a decision; only the automatic refusal
        // label goes away, leaving the generic review state.
        expect(row.review_required).toBe(1);
        expect(attentionReasons(projectApplication(id, false))).not.toContain('stateful_withdrawal_blocked');
    });

    it('resumes automatic acceptance once a newer candidate clears the block', async () => {
        blocked('blk-resume', 'blk-resume-web');
        insertAndStageGeneration(getApp('blk-resume'), 'blk-resume-web', 'blk-resume-third');
        mockDue([armDuePoll('blk-resume')]);
        evaluateCandidatePolicy.mockResolvedValue({ status: 'allowed' });
        spyOnReconcile().mockResolvedValue(fetchedResult);
        const dispatch = spyOnDispatch();

        controller.start();
        await advanceOneTick();

        expect(getApp('blk-resume').accepted_generation_id).toBe('blk-resume-third');
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('keeps the block when the policy is re-saved as automatic', () => {
        blocked('blk-auto', 'blk-auto-web');
        GitOpsTransitions.getInstance().sourcePolicyChanged('blk-auto', 'automatic', envelope('policy-blk-auto'));
        expect(getApp('blk-auto').review_block_reason).toBe('stateful_withdrawal');
    });

    it('refuses to record a block while an apply is in flight', () => {
        stageCandidate('blk-inflight', 'blk-inflight-web', 'blk-inflight-gen', 'automatic');
        GitOpsTransitions.getInstance().applyStarted('blk-inflight', 'blk-inflight-gen', envelope('apply-blk-inflight'));
        expect(() => GitOpsTransitions.getInstance().sourceReviewBlocked({
            applicationId: 'blk-inflight',
            generationId: 'blk-inflight-gen',
            reason: 'stateful_withdrawal',
            envelope: envelope('block-blk-inflight'),
        })).toThrow('cannot hold acceptance while an apply is in flight');
        expect(getApp('blk-inflight').review_block_reason).toBeNull();
    });

    it('projects an unknown stored reason as the plain review state', () => {
        blocked('blk-unknown', 'blk-unknown-web');
        // A value written by a newer build this one does not know.
        DatabaseService.getInstance().getDb().prepare(
            'UPDATE gitops_applications SET review_block_reason = ? WHERE id = ?',
        ).run('future_reason', 'blk-unknown');
        const projection = projectApplication('blk-unknown', false);
        const reasons = attentionReasons(projection);
        expect(reasons).toContain('source_review_pending');
        expect(reasons).not.toContain('stateful_withdrawal_blocked');
    });
});
