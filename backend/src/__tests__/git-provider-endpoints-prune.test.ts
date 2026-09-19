/**
 * Provider-webhook endpoint pruning: detaching a Git source or deleting its
 * stack must remove that stack's git_provider_endpoints rows (which hold
 * encrypted secrets) and their git_provider_deliveries history. FK cascades
 * are declarative-only in this codebase, so the deletes are explicit; these
 * tests pin the prune on both removal paths plus the single-endpoint DELETE.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { ComposeService } from '../services/ComposeService';
import { FileSystemService } from '../services/FileSystemService';
import { MeshService } from '../services/MeshService';
import { DeployedStackDeletionService } from '../services/DeployedStackDeletionService';
import { ProviderWebhookService } from '../services/gitops/providerWebhooks/ProviderWebhookService';
import { GitProviderWebhookStore } from '../services/gitops/providerWebhooks/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { directApplicationFixture } from './helpers/gitopsFixtures';

let tmpDir: string;
let app: import('express').Express;

function adminToken(): string {
    return jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function seedGitSource(stackName: string): void {
    DatabaseService.getInstance().upsertGitSource({
        stack_name: stackName,
        repo_url: 'https://github.com/example/repo.git',
        branch: 'main',
        compose_path: 'compose.yaml',
        compose_paths: ['compose.yaml'],
        context_dir: null,
        sync_env: false,
        env_path: null,
        auth_type: 'none',
        encrypted_token: null,
        encrypted_deploy_key: null,
        ssh_known_hosts_entry: null,
        ssh_host_key_fingerprint: null,
        encrypted_ca_bundle: null,
        auto_apply_on_webhook: false,
        auto_deploy_on_apply: false,
        last_applied_commit_sha: null,
        last_applied_content_hash: null,
        pending_commit_sha: null,
        pending_compose_content: null,
        pending_env_content: null,
        pending_fetched_at: null,
        last_debounce_at: null,
    });
}

function seedEndpoint(stackName: string, provider: 'github' | 'gitlab' = 'github'): string {
    return ProviderWebhookService.getInstance().createEndpoint({ stackName, provider }).id;
}

function seedDeliveries(endpointId: string, count: number): void {
    for (let i = 0; i < count; i++) {
        GitProviderWebhookStore.getInstance().upsertDelivery({
            endpointId,
            deliveryId: `delivery-${endpointId}-${i}`,
            state: 'received',
        });
    }
}

function endpointCount(stackName: string): number {
    const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT COUNT(*) AS c FROM git_provider_endpoints WHERE stack_name = ?')
        .get(stackName) as { c: number };
    return row.c;
}

function deliveryCount(endpointId: string): number {
    const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT COUNT(*) AS c FROM git_provider_deliveries WHERE endpoint_id = ?')
        .get(endpointId) as { c: number };
    return row.c;
}

function seedStackDir(stackName: string): void {
    const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('Git source detach prunes provider webhook endpoints', () => {
    it('removes the detached stack\'s endpoints and deliveries, leaves other stacks alone', async () => {
        seedGitSource('prune-detach');
        DatabaseService.getInstance().setGitSourceAppliedSpec('prune-detach', { files: ['compose.yaml'], contextDir: null });
        seedStackDir('prune-detach');
        const doomedEndpoint = seedEndpoint('prune-detach');
        seedDeliveries(doomedEndpoint, 3);

        seedGitSource('prune-detach-keep');
        const keptEndpoint = seedEndpoint('prune-detach-keep');
        seedDeliveries(keptEndpoint, 2);

        const render = vi.spyOn(ComposeService.prototype, 'renderComposeYaml')
            .mockResolvedValue('services:\n  web:\n    image: nginx\n');
        try {
            const res = await request(app)
                .delete('/api/stacks/prune-detach/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);

            expect(res.status).toBe(200);
            expect(DatabaseService.getInstance().getGitSource('prune-detach')).toBeUndefined();
            expect(endpointCount('prune-detach')).toBe(0);
            expect(deliveryCount(doomedEndpoint)).toBe(0);
            expect(endpointCount('prune-detach-keep')).toBe(1);
            expect(deliveryCount(keptEndpoint)).toBe(2);
        } finally {
            render.mockRestore();
        }
    });

    it('rolls the prune back when the detach transaction aborts', async () => {
        seedGitSource('prune-detach-rollback');
        DatabaseService.getInstance().setGitSourceAppliedSpec('prune-detach-rollback', { files: ['compose.yaml'], contextDir: null });
        seedStackDir('prune-detach-rollback');
        const endpointId = seedEndpoint('prune-detach-rollback');
        seedDeliveries(endpointId, 2);
        GitOpsTransitions.getInstance().activateDirect({
            application: directApplicationFixture('app-prune-detach-rollback', 'prune-detach-rollback'),
            nodeId: 1,
            envelope: { operationId: 'op-prune-detach-rollback', actor: 'tester', trigger: 'manual', at: Date.now() },
        });

        const render = vi.spyOn(ComposeService.prototype, 'renderComposeYaml')
            .mockResolvedValue('services:\n  web:\n    image: nginx\n');
        // Fail the commit after the prune statement: the surrounding
        // transaction must roll the endpoint delete back with everything else.
        const tombstone = vi.spyOn(GitOpsTransitions.prototype, 'applicationTombstoned')
            .mockImplementationOnce(() => { throw new Error('simulated tombstone failure'); });
        try {
            const res = await request(app)
                .delete('/api/stacks/prune-detach-rollback/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);

            expect(res.status).toBe(400);
            expect(DatabaseService.getInstance().getGitSource('prune-detach-rollback')).toBeDefined();
            expect(endpointCount('prune-detach-rollback')).toBe(1);
            expect(deliveryCount(endpointId)).toBe(2);
        } finally {
            render.mockRestore();
            tombstone.mockRestore();
        }
    });
});

describe('Stack deletion purges provider webhook endpoints', () => {
    it('removes endpoints and deliveries for the deleted stack only', async () => {
        vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
        vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);
        vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);

        const doomedEndpoint = seedEndpoint('prune-stack-del');
        seedDeliveries(doomedEndpoint, 3);
        const keptEndpoint = seedEndpoint('prune-stack-keep');
        seedDeliveries(keptEndpoint, 2);

        const db = DatabaseService.getInstance();
        const nodeId = db.getNodes()[0].id;
        const result = await DeployedStackDeletionService.getInstance().deleteDeployedStack({
            nodeId,
            stackName: 'prune-stack-del',
            pruneVolumes: false,
            actor: 'test',
        });

        expect(result.ok).toBe(true);
        expect(endpointCount('prune-stack-del')).toBe(0);
        expect(deliveryCount(doomedEndpoint)).toBe(0);
        expect(endpointCount('prune-stack-keep')).toBe(1);
        expect(deliveryCount(keptEndpoint)).toBe(2);
    });

    it('reports db_failed and keeps the endpoint rows when the prune throws', async () => {
        vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
        vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);
        vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);

        const endpointId = seedEndpoint('prune-stack-fail');
        seedDeliveries(endpointId, 2);

        // The purge block is sequential, not one transaction: a prune failure
        // surfaces as db_failed and the endpoint rows survive for retry.
        const prune = vi.spyOn(DatabaseService.prototype, 'deleteGitProviderEndpointsForStack')
            .mockImplementationOnce(() => { throw new Error('simulated prune failure'); });

        const db = DatabaseService.getInstance();
        const nodeId = db.getNodes()[0].id;
        const result = await DeployedStackDeletionService.getInstance().deleteDeployedStack({
            nodeId,
            stackName: 'prune-stack-fail',
            pruneVolumes: false,
            actor: 'test',
        });

        expect(prune).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ ok: false, code: 'db_failed' });
        expect(endpointCount('prune-stack-fail')).toBe(1);
        expect(deliveryCount(endpointId)).toBe(2);
    });

    it('prunes disabled endpoints too', async () => {
        vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
        vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);
        vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);

        const endpointId = seedEndpoint('prune-stack-disabled');
        GitProviderWebhookStore.getInstance().updateEndpoint(endpointId, { enabled: 0 });
        seedDeliveries(endpointId, 1);

        const db = DatabaseService.getInstance();
        const nodeId = db.getNodes()[0].id;
        const result = await DeployedStackDeletionService.getInstance().deleteDeployedStack({
            nodeId,
            stackName: 'prune-stack-disabled',
            pruneVolumes: false,
            actor: 'test',
        });

        expect(result.ok).toBe(true);
        expect(endpointCount('prune-stack-disabled')).toBe(0);
        expect(deliveryCount(endpointId)).toBe(0);
    });
});

describe('DELETE /api/stacks/:stackName/git-source/provider-hooks/:id', () => {
    it('removes the endpoint\'s deliveries and leaves sibling endpoints intact', async () => {
        seedGitSource('prune-single');
        const doomedEndpoint = seedEndpoint('prune-single', 'github');
        seedDeliveries(doomedEndpoint, 2);
        const keptEndpoint = seedEndpoint('prune-single', 'gitlab');
        seedDeliveries(keptEndpoint, 2);

        const res = await request(app)
            .delete(`/api/stacks/prune-single/git-source/provider-hooks/${doomedEndpoint}`)
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expect(endpointCount('prune-single')).toBe(1);
        expect(deliveryCount(doomedEndpoint)).toBe(0);
        expect(deliveryCount(keptEndpoint)).toBe(2);
    });

    it('refuses to delete an endpoint owned by another stack', async () => {
        seedGitSource('prune-cross-owner');
        const foreignEndpoint = seedEndpoint('prune-cross-owner');
        seedDeliveries(foreignEndpoint, 2);
        seedGitSource('prune-cross-caller');

        const res = await request(app)
            .delete(`/api/stacks/prune-cross-caller/git-source/provider-hooks/${foreignEndpoint}`)
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(404);
        expect(endpointCount('prune-cross-owner')).toBe(1);
        expect(deliveryCount(foreignEndpoint)).toBe(2);
    });
});
