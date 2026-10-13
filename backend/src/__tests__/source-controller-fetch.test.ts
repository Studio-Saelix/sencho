/**
 * Operator pull of a Git-managed Blueprint. The fetch is the same reconcile
 * a poll uses. Manual sources stay off the cadence and are not accepted.
 * Review sources keep their poll cursor. A second caller during a fetch is
 * refused before reconcile runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { GitOpsBindingService } from '../services/gitops/binding';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import { GitSourceService } from '../services/GitSourceService';
import { SourceController } from '../services/gitops/SourceController';
import { DatabaseService } from '../services/DatabaseService';
import { candidateContentFingerprint } from '../services/gitops/fingerprint';
import type { GitOpsApplicationRow } from '../services/gitops/types';
import type { ReconcileResult } from '../services/gitops/outcomes';

const okResult: ReconcileResult = { outcome: 'pending_review', reason: 'A newer commit is waiting.', nextAction: 'review' };
const failedResult: ReconcileResult = { outcome: 'failed_previous_intact', reason: 'previous fetch failed', nextAction: 'retry' };

let tmpDir: string;
let controller: SourceController;
let seq = 0;

function getApp(id: string): GitOpsApplicationRow {
    const app = GitOpsStore.getInstance().getApplication(id);
    if (!app) throw new Error(`application ${id} not found`);
    return app;
}

function spyOnReconcile() {
    return vi.spyOn(GitSourceService.getInstance(), 'reconcile');
}

/** A live Git-managed Blueprint retaining the named source stack. */
function seedBlueprint(policy: 'manual' | 'review' | 'automatic'): { applicationId: string; stackName: string } {
    seq += 1;
    const stackName = `fetch-web-${seq}`;
    const applicationId = `app-fetch-${seq}`;
    const application = {
        ...directApplicationFixture(applicationId, stackName),
        configured_repo_url: `https://github.com/example/${stackName}.git`,
        source_policy: policy,
    };
    GitOpsTransitions.getInstance().activateDirect({
        application,
        nodeId: 1,
        envelope: { operationId: `seed-${applicationId}`, actor: 'tester', trigger: 'manual', at: Date.now() },
    });
    const blueprint = commitBlueprintCreate({
        name: `bp-fetch-${seq}`,
        description: null,
        compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
        selector: { type: 'nodes', ids: [1] },
        drift_mode: 'suggest',
        classification: 'stateless',
        classification_reasons: [],
        enabled: true,
        created_by: 'tester',
    }, () => [1]);
    GitOpsBindingService.getInstance().convertInlineToGit({
        blueprintId: blueprint.id,
        applicationId,
        actor: 'tester',
    });
    return { applicationId, stackName };
}

/** What a real fetch records when it stages the commit it just read. */
function stageCandidate(app: GitOpsApplicationRow, generationId: string): void {
    const compose = 'services:\n  web:\n    image: nginx:1.27\n';
    const contentSha = candidateContentFingerprint([{ path: 'compose.yaml', content: compose }]);
    GitOpsStore.getInstance().insertGeneration({
        id: generationId,
        application_id: app.id,
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
        plan_blocked: 0,
        change_plan_fingerprint: 'f'.repeat(64),
        operation_id: `gen-${generationId}`,
        trigger: 'manual',
        actor: 'ada',
        previous_generation_id: null,
        redacted_limitations_json: '[]',
        portable_manifest_json: null,
        compose_inputs_json: JSON.stringify({ candidateContentSha256: contentSha }),
        source_policy_evidence_json: JSON.stringify({ sourcePolicy: app.source_policy }),
        security_policy_evidence_json: null,
        support_requirements_json: null,
        compatibility_requirements_json: null,
        secret_capability_json: null,
        created_at: Date.now(),
    });
    const env = { operationId: `fetch-${app.id}`, actor: 'ada', trigger: 'manual' as const, at: Date.now() };
    GitOpsTransitions.getInstance().fetchStarted(app.id, env);
    GitOpsTransitions.getInstance().fetched(app.id, 'c'.repeat(40), env);
    GitOpsTransitions.getInstance().candidateReady(app.id, generationId, app.source_policy !== 'automatic', env);
}

function recordFetchFailure(id: string): void {
    const env = { operationId: `fail-${id}`, actor: 'ada', trigger: 'manual' as const, at: Date.now() };
    GitOpsTransitions.getInstance().fetchStarted(id, env);
    GitOpsTransitions.getInstance().fetchFailed(id, env, 'NETWORK_TIMEOUT');
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
    DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '5');
});

afterEach(() => {
    controller.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('SourceController.requestFetch', () => {
    it('stages a candidate for a manual source and does not poll or accept it', async () => {
        const seeded = seedBlueprint('manual');
        spyOnReconcile().mockImplementation(async () => {
            stageCandidate(getApp(seeded.applicationId), `gen-${seeded.applicationId}`);
            return okResult;
        });

        const fetched = await controller.requestFetch(seeded.applicationId, 'ada');

        expect(fetched).toMatchObject({
            status: 'settled',
            candidateGenerationId: `gen-${seeded.applicationId}`,
        });
        const row = getApp(seeded.applicationId);
        expect(row.candidate_generation_id).toBe(`gen-${seeded.applicationId}`);
        expect(row.accepted_generation_id).toBeNull();
        expect(row.next_poll_at).toBeNull();
        expect(row.retry_at).toBeNull();
    });

    it('does not arm a retry cursor when a manual pull fails', async () => {
        const seeded = seedBlueprint('manual');
        spyOnReconcile().mockImplementation(async () => {
            recordFetchFailure(seeded.applicationId);
            return failedResult;
        });

        const fetched = await controller.requestFetch(seeded.applicationId, 'ada');

        expect(fetched.status).toBe('settled');
        expect(getApp(seeded.applicationId).retry_at).toBeNull();
        expect(getApp(seeded.applicationId).next_poll_at).toBeNull();
    });

    it('re-arms the poll cursor after a review pull succeeds', async () => {
        const seeded = seedBlueprint('review');
        spyOnReconcile().mockResolvedValue({ outcome: 'no_source_change', reason: 'ok', nextAction: 'none' });

        await controller.requestFetch(seeded.applicationId, 'ada');

        expect(getApp(seeded.applicationId).next_poll_at).toBe(Date.now() + 5 * 60 * 1000);
        expect(getApp(seeded.applicationId).accepted_generation_id).toBeNull();
    });

    it('refuses a suspended source before fetching', async () => {
        const seeded = seedBlueprint('manual');
        GitOpsTransitions.getInstance().sourceSuspended(
            seeded.applicationId,
            'paused',
            { operationId: 'suspend', actor: 'ada', trigger: 'manual', at: Date.now() },
        );
        const reconcile = spyOnReconcile();

        const fetched = await controller.requestFetch(seeded.applicationId, 'ada');

        expect(fetched).toMatchObject({ status: 'refused', code: 'suspended' });
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('refuses a pull while a candidate is being applied', async () => {
        const seeded = seedBlueprint('manual');
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE gitops_applications SET active_operation_stage = 'apply_started' WHERE id = ?`,
        ).run(seeded.applicationId);
        const reconcile = spyOnReconcile();

        const fetched = await controller.requestFetch(seeded.applicationId, 'ada');

        expect(fetched).toMatchObject({ status: 'refused', code: 'applying' });
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('refuses a pull while the source is recovering', async () => {
        const seeded = seedBlueprint('manual');
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE gitops_applications SET recovery_phase = 'restoring' WHERE id = ?`,
        ).run(seeded.applicationId);
        const reconcile = spyOnReconcile();

        const fetched = await controller.requestFetch(seeded.applicationId, 'ada');

        expect(fetched).toMatchObject({ status: 'refused', code: 'recovery' });
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('refuses a second pull while the first fetch is still running', async () => {
        const seeded = seedBlueprint('manual');
        let release!: (result: ReconcileResult) => void;
        const pending = new Promise<ReconcileResult>((resolve) => { release = resolve; });
        const reconcile = spyOnReconcile().mockReturnValue(pending);

        const first = controller.requestFetch(seeded.applicationId, 'ada');
        const second = await controller.requestFetch(seeded.applicationId, 'ada');

        expect(second).toMatchObject({ status: 'refused', code: 'fetch_in_flight' });
        expect(reconcile).toHaveBeenCalledTimes(1);
        release(okResult);
        await first;
    });
});
