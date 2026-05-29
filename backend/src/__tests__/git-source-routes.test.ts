/**
 * Route-layer tests for the git-source API.
 *
 * Covers input-validation and guard behavior that lives in the Express
 * handlers (not in GitSourceService), specifically:
 *   - HTTPS-only repo URL enforcement
 *   - Max-length caps on repo_url / branch / compose_path / env_path / token
 *   - Stack-existence 404 guard on PUT
 *   - 400 on invalid stack names
 *
 * Service-layer logic (encryption, error mapping, mutex, pending lifecycle)
 * is covered in git-source-service.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitSourceService } from '../services/GitSourceService';

function seedGitSource(stackName: string): void {
    DatabaseService.getInstance().upsertGitSource({
        stack_name: stackName,
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
}

let tmpDir: string;
let app: import('express').Express;

function adminToken(): string {
    return jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));

    // Seed a real stack directory so the PUT handler's existence guard is satisfied
    // for tests that need to exercise validation past that point.
    const composeDir = process.env.COMPOSE_DIR!;
    fs.mkdirSync(path.join(composeDir, 'existing-stack'), { recursive: true });
    fs.writeFileSync(path.join(composeDir, 'existing-stack', 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('PUT /api/stacks/:stackName/git-source — URL validation', () => {
    it('rejects http:// URLs with 400', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'http://github.com/example/repo.git',
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'none',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/HTTPS/i);
    });

    it('rejects missing repo_url with 400', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'none',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/repo_url/i);
    });
});

describe('PUT /api/stacks/:stackName/git-source — max-length caps', () => {
    const baseBody = {
        branch: 'main',
        compose_path: 'compose.yaml',
        auth_type: 'none' as const,
    };

    it('rejects oversized repo_url', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ ...baseBody, repo_url: 'https://example.com/' + 'a'.repeat(2048) });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/repo_url/i);
    });

    it('rejects oversized branch', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                ...baseBody,
                repo_url: 'https://github.com/example/repo.git',
                branch: 'b'.repeat(300),
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/branch/i);
    });

    it('rejects oversized compose_path', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                ...baseBody,
                repo_url: 'https://github.com/example/repo.git',
                compose_path: 'c'.repeat(1100),
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/compose_path/i);
    });

    it('rejects oversized env_path', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                ...baseBody,
                repo_url: 'https://github.com/example/repo.git',
                env_path: 'e'.repeat(1100),
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/env_path/i);
    });

    it('rejects oversized token', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                ...baseBody,
                repo_url: 'https://github.com/example/repo.git',
                auth_type: 'token',
                token: 't'.repeat(9000),
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/token/i);
    });
});

describe('PUT /api/stacks/:stackName/git-source — stack existence guard', () => {
    it('returns 404 when the stack does not exist on the active node', async () => {
        const res = await request(app)
            .put('/api/stacks/ghost-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'none',
            });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/stack not found/i);
    });
});

describe('git-source routes — repository path validation', () => {
    it('rejects compose_path traversal before service execution', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_path: '../compose.yaml',
                auth_type: 'none',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/compose_path/i);
    });

    it('rejects absolute env_path on create-from-git', async () => {
        const res = await request(app)
            .post('/api/stacks/from-git')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                stack_name: 'route-from-git-env-abs',
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_path: 'compose.yaml',
                sync_env: true,
                env_path: '/etc/passwd',
                auth_type: 'none',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/env_path/i);
    });

    it('rejects string auto_deploy_on_apply on update', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'none',
                auto_deploy_on_apply: 'true',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/auto_deploy_on_apply/i);
    });

    it('rejects string auto_deploy_on_apply on create-from-git', async () => {
        const res = await request(app)
            .post('/api/stacks/from-git')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                stack_name: 'route-from-git-auto-deploy-string',
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'none',
                auto_deploy_on_apply: 'true',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/auto_deploy_on_apply/i);
    });
});

describe('git-source routes — invalid stack names', () => {
    it('returns 400 for traversal attempts on GET per-stack', async () => {
        const res = await request(app)
            .get('/api/stacks/..%2fescape/git-source')
            .set('Authorization', `Bearer ${adminToken()}`);
        // URL-decoded name `../escape` fails isValidStackName.
        expect([400, 404]).toContain(res.status);
    });
});

describe('POST /api/stacks/from-git', () => {
    const validBody = {
        stack_name: 'route-from-git',
        repo_url: 'https://github.com/example/repo.git',
        branch: 'main',
        compose_path: 'compose.yaml',
        auth_type: 'none' as const,
    };

    it('returns 401 without auth', async () => {
        const res = await request(app).post('/api/stacks/from-git').send(validBody);
        expect(res.status).toBe(401);
    });

    it('rejects missing stack_name with 400', async () => {
        const { stack_name: _unused, ...body } = validBody;
        void _unused;
        const res = await request(app)
            .post('/api/stacks/from-git')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/stack_name/i);
    });

    it('rejects invalid stack name with 400', async () => {
        const res = await request(app)
            .post('/api/stacks/from-git')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ ...validBody, stack_name: '../escape' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/stack name/i);
    });

    it('rejects http:// URLs with 400', async () => {
        const res = await request(app)
            .post('/api/stacks/from-git')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ ...validBody, repo_url: 'http://github.com/example/repo.git' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/HTTPS/i);
    });

    it('rejects oversized repo_url with 400', async () => {
        const res = await request(app)
            .post('/api/stacks/from-git')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ ...validBody, repo_url: 'https://example.com/' + 'a'.repeat(2048) });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/repo_url/i);
    });

    it('returns 409 when a stack with that name already exists on disk', async () => {
        const res = await request(app)
            .post('/api/stacks/from-git')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ ...validBody, stack_name: 'existing-stack' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already exists/i);
    });
});

describe('POST /api/stacks/:stackName/git-source/webhook-pull status codes', () => {
    it('returns 404 (not 200) when the stack has no Git source configured', async () => {
        const res = await request(app)
            .post('/api/stacks/existing-stack/git-source/webhook-pull')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no git source/i);
    });

    it('returns 401 without auth', async () => {
        const res = await request(app).post('/api/stacks/existing-stack/git-source/webhook-pull');
        expect(res.status).toBe(401);
    });

    it('maps a failed pull to 422 (not 200) so a Git provider sees the failure', async () => {
        seedGitSource('webhook-status-422');
        const pullSpy = vi.spyOn(GitSourceService.getInstance(), 'handleWebhookPull')
            .mockResolvedValue({ status: 'error', message: 'Validation failed: bad compose' });
        const res = await request(app)
            .post('/api/stacks/webhook-status-422/git-source/webhook-pull')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(422);
        expect(res.body.status).toBe('error');
        pullSpy.mockRestore();
    });

    it('maps a debounced pull to 202', async () => {
        seedGitSource('webhook-status-202');
        const pullSpy = vi.spyOn(GitSourceService.getInstance(), 'handleWebhookPull')
            .mockResolvedValue({ status: 'skipped', message: 'Rate limited (debounced).' });
        const res = await request(app)
            .post('/api/stacks/webhook-status-202/git-source/webhook-pull')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(202);
        pullSpy.mockRestore();
    });

    it('maps a successful pull to 200', async () => {
        seedGitSource('webhook-status-200');
        const pullSpy = vi.spyOn(GitSourceService.getInstance(), 'handleWebhookPull')
            .mockResolvedValue({ status: 'success', message: 'Pending update ready at abc1234.' });
        const res = await request(app)
            .post('/api/stacks/webhook-status-200/git-source/webhook-pull')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        pullSpy.mockRestore();
    });
});

describe('GET /api/git-sources', () => {
    it('returns 200 and a JSON array for an authenticated admin', async () => {
        const res = await request(app)
            .get('/api/git-sources')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 401 without a valid token', async () => {
        const res = await request(app).get('/api/git-sources');
        expect(res.status).toBe(401);
    });
});
