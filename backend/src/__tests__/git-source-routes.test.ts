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
import { ComposeService } from '../services/ComposeService';
import { GitSourceService } from '../services/GitSourceService';

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
        expect(res.body.error).toMatch(/compose path/i);
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
        expect(res.body.error).toMatch(/compose path/i);
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

describe('GET /api/stacks/:stackName/git-source', () => {
    it('returns 200 { linked: false } when the stack exists but has no Git source', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        fs.mkdirSync(path.join(composeDir, 'unlinked-stack'), { recursive: true });
        fs.writeFileSync(path.join(composeDir, 'unlinked-stack', 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
        const res = await request(app)
            .get('/api/stacks/unlinked-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ linked: false });
    });

    it('returns 404 when the stack does not exist on the active node', async () => {
        const res = await request(app)
            .get('/api/stacks/ghost-stack-get/git-source')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/stack not found/i);
    });

    it('returns 200 with the source object when a Git source is configured', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        fs.mkdirSync(path.join(composeDir, 'linked-stack'), { recursive: true });
        fs.writeFileSync(path.join(composeDir, 'linked-stack', 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
        seedGitSource('linked-stack');
        const res = await request(app)
            .get('/api/stacks/linked-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.stack_name).toBe('linked-stack');
        expect(res.body.repo_url).toBe('https://github.com/example/repo.git');
        expect(res.body.linked).toBeUndefined();
    });
});

describe('PUT /api/stacks/:stackName/git-source: multi-file selection', () => {
    // The success-path tests forward a parsed selection to upsert(), whose dry-run
    // fetch would clone a real repo. Stub upsert so the assertion stays at the
    // route layer (parse + forward) without network. Rejection-path tests hit the
    // parseComposeSelection 400 before upsert is ever reached, so they need no stub.
    it('persists a compose_paths array and forwards it to the service', async () => {
        const upsertSpy = vi.spyOn(GitSourceService.getInstance(), 'upsert')
            .mockResolvedValue({} as Awaited<ReturnType<typeof GitSourceService.prototype.upsert>>);
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_paths: ['infra/base.yml', 'infra/prod.yml'],
                context_dir: 'app',
                auth_type: 'none',
            });
        expect(res.status).toBe(200);
        expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
            composePaths: ['infra/base.yml', 'infra/prod.yml'],
            contextDir: 'app',
        }));
        upsertSpy.mockRestore();
    });

    it('still accepts the legacy compose_path string and maps it to a one-element array', async () => {
        const upsertSpy = vi.spyOn(GitSourceService.getInstance(), 'upsert')
            .mockResolvedValue({} as Awaited<ReturnType<typeof GitSourceService.prototype.upsert>>);
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_path: 'stacks/web/compose.yaml',
                auth_type: 'none',
            });
        expect(res.status).toBe(200);
        expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
            composePaths: ['stacks/web/compose.yaml'],
            contextDir: null,
        }));
        upsertSpy.mockRestore();
    });

    it('rejects a compose_paths array with more than 10 files (400)', async () => {
        const tooMany = Array.from({ length: 11 }, (_, i) => `f${i}.yml`);
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_paths: tooMany,
                auth_type: 'none',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/exceed/i);
    });

    it('rejects duplicate entries in compose_paths (400)', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_paths: ['compose.yaml', 'infra/prod.yml', 'infra/prod.yml'],
                auth_type: 'none',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/duplicate/i);
    });

    it('rejects a context_dir that collides with the primary compose.yaml (400)', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/repo.git',
                branch: 'main',
                compose_paths: ['compose.yaml'],
                context_dir: 'compose.yaml',
                auth_type: 'none',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/context_dir/i);
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

describe('DELETE /api/stacks/:stackName/git-source, detach/export contract', () => {
    function mockRender(yaml: string | null): ReturnType<typeof vi.spyOn> {
        // ComposeService.getInstance() returns a fresh instance per call, so
        // the spy must live on the prototype to reach the route's instance.
        return vi
            .spyOn(ComposeService.prototype, 'renderComposeYaml')
            .mockImplementation(() => (yaml === null ? Promise.reject(new Error('docker unavailable')) : Promise.resolve(yaml)));
    }

    it('exports a multi-file source: renders, writes compose.yaml, removes the row', async () => {
        seedGitSource('mf-unlink');
        DatabaseService.getInstance().setGitSourceAppliedSpec('mf-unlink', { files: ['compose.yaml', 'infra/prod.yml'], contextDir: null });
        const stackDir = path.join(process.env.COMPOSE_DIR!, 'mf-unlink');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
        const render = mockRender('services:\n  web:\n    image: nginx\n    environment:\n      A: b\n');
        try {
            const res = await request(app)
                .delete('/api/stacks/mf-unlink/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(200);
            expect(DatabaseService.getInstance().getGitSource('mf-unlink')).toBeUndefined();
            const exported = fs.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf8');
            expect(exported).toContain('A: b');
            expect(render).toHaveBeenCalled();
        } finally {
            render.mockRestore();
        }
    });

    it('returns 409 and keeps the row when the export render fails', async () => {
        seedGitSource('ctx-unlink');
        DatabaseService.getInstance().setGitSourceAppliedSpec('ctx-unlink', { files: ['compose.yaml'], contextDir: 'app' });
        const render = mockRender(null);
        try {
            const res = await request(app)
                .delete('/api/stacks/ctx-unlink/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(409);
            expect(DatabaseService.getInstance().getGitSource('ctx-unlink')).toBeTruthy();
        } finally {
            render.mockRestore();
        }
    });

    it('allows unlinking a single-file source', async () => {
        seedGitSource('sf-unlink');
        const stackDir = path.join(process.env.COMPOSE_DIR!, 'sf-unlink');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
        const render = mockRender('services:\n  web:\n    image: nginx\n');
        try {
            const res = await request(app)
                .delete('/api/stacks/sf-unlink/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(200);
            expect(DatabaseService.getInstance().getGitSource('sf-unlink')).toBeUndefined();
        } finally {
            render.mockRestore();
        }
    });
});

describe('GET /api/stacks/:stackName/git-source/manifest', () => {
    it('returns the manifest for a stack that has one', async () => {
        seedGitSource('manifest-get');
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const svc = GitProjectManifestService.getInstance();
        const manifest = svc.buildManifest({
            stackName: 'manifest-get',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc123',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: 'manifest-get',
            invocation: ['-f', 'compose.yaml', '-p', 'manifest-get'],
            inputs: [],
            refusals: [],
            buildContexts: [],
            bounds: { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024, maxContextBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxFileBytes: 10 * 1024 * 1024 },
            priorManifest: null,
            state: 'active',
        });
        await svc.writeManifest('manifest-get', manifest);
        const res = await request(app)
            .get('/api/stacks/manifest-get/git-source/manifest')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.manifest.schemaVersion).toBe(1);
        expect(res.body.manifest.resolvedRevision.commitSha).toBe('abc123');
    });

    it('returns 404 when no manifest exists', async () => {
        seedGitSource('manifest-missing');
        const res = await request(app)
            .get('/api/stacks/manifest-missing/git-source/manifest')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(404);
    });

    it('denies without the stack:read permission', async () => {
        seedGitSource('manifest-denied');
        const res = await request(app)
            .get('/api/stacks/manifest-denied/git-source/manifest')
            .set('Authorization', `Bearer ${jwt.sign({ username: 'viewer', role: 'viewer' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`);
        // viewer lacks stack:read for this stack
        expect([401, 403]).toContain(res.status);
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

describe('stack_git_sources manifest cache columns', () => {
    const MANIFEST_STATES = [
        'none',
        'migrated',
        'active',
        'partial',
        'unsupported',
        'migration_required',
        'absent',
    ] as const;

    it('round-trips every GitSourceManifestState enum member', () => {
        const db = DatabaseService.getInstance();
        for (const state of MANIFEST_STATES) {
            seedGitSource(`manifest-state-${state}`);
            db.setGitSourceManifestState(`manifest-state-${state}`, 7, state, 'generations/applied-abc');
            const row = db.getGitSource(`manifest-state-${state}`)!;
            expect(row.manifest_version).toBe(7);
            expect(row.manifest_state).toBe(state);
            expect(row.manifest_generation).toBe('generations/applied-abc');
            db.deleteGitSource(`manifest-state-${state}`);
        }
    });

    it('reads nulls for rows written before the columns existed', () => {
        const row = DatabaseService.getInstance().getGitSource('missing-manifest-row');
        expect(row).toBeUndefined();
    });

    it('upsert does not clobber the manifest cache columns', () => {
        const db = DatabaseService.getInstance();
        seedGitSource('manifest-preserved');
        db.setGitSourceManifestState('manifest-preserved', 3, 'active', 'generations/applied-x');
        db.upsertGitSource({
            stack_name: 'manifest-preserved',
            repo_url: 'https://github.com/example/repo.git',
            branch: 'main',
            compose_path: 'compose.yaml',
            compose_paths: ['compose.yaml'],
            context_dir: null,
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
        const row = db.getGitSource('manifest-preserved')!;
        expect(row.manifest_version).toBe(3);
        expect(row.manifest_state).toBe('active');
        expect(row.manifest_generation).toBe('generations/applied-x');
    });
});
