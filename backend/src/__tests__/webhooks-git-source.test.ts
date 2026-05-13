import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let WebhookService: typeof import('../services/WebhookService').WebhookService;

function adminToken(): string {
    return jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ WebhookService } = await import('../services/WebhookService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
});

describe('node-aware Git source webhooks', () => {
    it('persists node_id when creating a webhook', async () => {
        const db = DatabaseService.getInstance();
        const nodeId = db.getDefaultNode()!.id;
        db.upsertGitSource({
            stack_name: 'webhook-local-git',
            repo_url: 'https://github.com/example/repo.git',
            branch: 'main',
            compose_path: 'compose.yaml',
            sync_env: false,
            env_path: null,
            auth_type: 'none',
            encrypted_token: null,
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

        const res = await request(app)
            .post('/api/webhooks')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                node_id: nodeId,
                name: 'local git webhook',
                stack_name: 'webhook-local-git',
                action: 'git-pull',
            });

        expect(res.status).toBe(201);
        const row = db.getWebhook(res.body.id);
        expect(row?.node_id).toBe(nodeId);
    });

    it('checks remote git-source existence through the target node', async () => {
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'remote-git-webhook',
            type: 'remote',
            compose_dir: '/tmp',
            is_default: false,
            api_url: 'http://remote.example',
            api_token: 'remote-token',
        });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

        const res = await request(app)
            .post('/api/webhooks')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                node_id: remoteNodeId,
                name: 'remote git webhook',
                stack_name: 'remote-stack',
                action: 'git-pull',
            });

        expect(res.status).toBe(201);
        expect(fetchSpy).toHaveBeenCalledWith(
            new URL('http://remote.example/api/stacks/remote-stack/git-source'),
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('rejects malformed webhook node_id values', async () => {
        const res = await request(app)
            .post('/api/webhooks')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                node_id: 'remote',
                name: 'bad node id webhook',
                stack_name: 'remote-stack',
                action: 'deploy',
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/node_id/i);
    });

    it('rejects retargeting an existing git-pull webhook without a Git source', async () => {
        const db = DatabaseService.getInstance();
        const nodeId = db.getDefaultNode()!.id;
        db.upsertGitSource({
            stack_name: 'retarget-source-stack',
            repo_url: 'https://github.com/example/repo.git',
            branch: 'main',
            compose_path: 'compose.yaml',
            sync_env: false,
            env_path: null,
            auth_type: 'none',
            encrypted_token: null,
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
        const webhookId = db.addWebhook({
            node_id: nodeId,
            name: 'retarget git webhook',
            stack_name: 'retarget-source-stack',
            action: 'git-pull',
            secret: WebhookService.getInstance().generateSecret(),
            enabled: true,
        });

        const res = await request(app)
            .put(`/api/webhooks/${webhookId}`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ stack_name: 'retarget-no-source-stack' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Git source/i);
    });

    it('records failure when remote node disconnects before execution', async () => {
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'remote-disconnected-webhook',
            type: 'remote',
            compose_dir: '/tmp',
            is_default: false,
            api_url: '',
            api_token: '',
        });
        const webhookId = db.addWebhook({
            node_id: remoteNodeId,
            name: 'disconnected remote git',
            stack_name: 'remote-stack',
            action: 'git-pull',
            secret: WebhookService.getInstance().generateSecret(),
            enabled: true,
        });

        const result = await WebhookService.getInstance().execute(webhookId, 'git-pull', 'test');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/unreachable|configured/i);
        const history = db.getWebhookExecutions(webhookId);
        expect(history[0].status).toBe('failure');
        expect(history[0].error).toMatch(/unreachable|configured/i);
    });

    it('records failure when remote node request times out', async () => {
        vi.useFakeTimers();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'remote-timeout-webhook',
            type: 'remote',
            compose_dir: '/tmp',
            is_default: false,
            api_url: 'http://remote-timeout.example',
            api_token: 'remote-token',
        });
        const webhookId = db.addWebhook({
            node_id: remoteNodeId,
            name: 'timeout remote git',
            stack_name: 'remote-stack',
            action: 'git-pull',
            secret: WebhookService.getInstance().generateSecret(),
            enabled: true,
        });
        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }));

        const pending = WebhookService.getInstance().execute(webhookId, 'git-pull', 'test');
        await vi.advanceTimersByTimeAsync(30_000);
        const result = await pending;

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/timed out/i);
        const history = db.getWebhookExecutions(webhookId);
        expect(history[0].status).toBe('failure');
        expect(history[0].error).toMatch(/timed out/i);
        vi.useRealTimers();
    });
});
