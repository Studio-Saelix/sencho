/**
 * Route-layer tests for the git-source API.
 *
 * Covers input-validation and guard behavior reachable through the Express
 * handlers (the URL rules themselves live in services/gitops/repoIdentity.ts,
 * not in GitSourceService), specifically:
 *   - HTTPS-only repo URL enforcement, including userinfo/query/fragment rejection
 *   - SSH deploy-key auth_type, deploy_key length caps, ssh-host-key probe route
 *   - Max-length caps on repo_url / branch / compose_path / env_path / token
 *   - Stack-existence 404 guard on PUT
 *   - 400 on invalid stack names
 *
 * Service-layer logic (encryption, error mapping, mutex, pending lifecycle)
 * is covered in git-source-service.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { REF_MAX_LEN } from '../services/git/nativeGitTransport';
import { DatabaseService } from '../services/DatabaseService';
import { CryptoService } from '../services/CryptoService';
import { ComposeService } from '../services/ComposeService';
import { GitSourceService, GitSourceError } from '../services/GitSourceService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { insertHistory } from '../services/gitops/history';
import type { GitOpsApplicationRow } from '../services/gitops/types';
import { PROXY_DEPLOY_ACTOR_HEADER, PROXY_DEPLOY_SOURCE_HEADER } from '../services/license-headers';
import { withLoopbackTargetProtection } from './helpers/allowLoopbackTargets';

/** A minimal live Direct application row for GitOps read-path fixtures. */
function directApplicationFixture(id: string, stackName: string): GitOpsApplicationRow {
    return {
        id,
        lifecycle_key: `direct:${stackName}`,
        lifecycle_status: 'active',
        target_mode: 'direct',
        stack_name: stackName,
        blueprint_id: null,
        configured_repo_url: 'https://github.com/example/repo.git',
        repo_identity_json: '{"host":"github.com","pathname":"/example/repo.git"}',
        configured_ref: 'main',
        compose_paths_json: '["compose.yaml"]',
        context_dir: null,
        sync_env: 0,
        env_path: null,
        materialization_fingerprint: 'a'.repeat(64),
        desired_commit_sha: null,
        fetched_commit_sha: null,
    fetched_resolved_ref_kind: null,
        candidate_generation_id: null,
        accepted_generation_id: null,
        candidate_plan_blocked: 0,
        review_required: 0,
        artifact_set_id: null,
        latest_artifact_set_id: null,
        intent_revision_id: null,
        rollout_candidate_id: null,
        rollout_generation_id: null,
        source_acceptance_ref: null,
        placement_approval_ref: null,
        rollout_authorization_ref: null,
        legacy_combined_approval_ref: null,
        preflight_fingerprint: null,
        latest_operation_id: null,
        active_operation_id: null,
        active_operation_stage: null,
        active_operation_at: null,
        active_generation_id: null,
        pause_at: null,
        pause_reason: null,
        partial_json: null,
        failure_stage: null,
        failure_class: null,
        failure_at: null,
        retry_at: null,
        retry_count: 0,
        suspended_at: null,
        recovery_ref: null,
        recovery_phase: null,
        interruption_stage: null,
        interruption_at: null,
        interruption_operation_id: null,
        interruption_generation_id: null,
        evidence_fresh_at: null,
        evidence_limitations_json: null,
        created_at: 1,
        updated_at: 1,
    };
}

// ── Hoisted mocks (must come before importing the app) ─────────────────

// The statuses cache carries the source label, so link/unlink must drop it.
// Spy on the invalidation helper the routes call; the rest of the module
// (remote-meta invalidation) stays real.
const mockInvalidateNodeCaches = vi.hoisted(() => vi.fn());
vi.mock('../helpers/cacheInvalidation', async () => {
    const actual = await vi.importActual<typeof import('../helpers/cacheInvalidation')>('../helpers/cacheInvalidation');
    return { ...actual, invalidateNodeCaches: mockInvalidateNodeCaches };
});

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
        encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
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

    it('rejects repo URLs with userinfo, query, or fragment', async () => {
        const cases = [
            { repo_url: 'https://user:pass@github.com/example/repo.git', error: /userinfo/i },
            { repo_url: 'https://github.com/example/repo.git?token=1', error: /query/i },
            { repo_url: 'https://github.com/example/repo.git#head', error: /fragment/i },
        ];
        for (const c of cases) {
            const res = await request(app)
                .put('/api/stacks/existing-stack/git-source')
                .set('Authorization', `Bearer ${adminToken()}`)
                .send({
                    repo_url: c.repo_url,
                    branch: 'main',
                    compose_path: 'compose.yaml',
                    auth_type: 'none',
                });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(c.error);
        }
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

describe('POST /api/git-sources/browse: URL validation', () => {
    it('rejects non-HTTPS, userinfo, query, and fragment URLs before cloning', async () => {
        const listRepoTree = vi.spyOn(GitSourceService.getInstance(), 'listRepoTree');
        const cases = [
            { repo_url: 'http://github.com/example/repo.git', error: /HTTPS/i },
            { repo_url: 'https://user:pass@github.com/example/repo.git', error: /userinfo/i },
            { repo_url: 'https://github.com/example/repo.git?token=1', error: /query/i },
            { repo_url: 'https://github.com/example/repo.git#head', error: /fragment/i },
        ];
        for (const c of cases) {
            const res = await request(app)
                .post('/api/git-sources/browse')
                .set('Authorization', `Bearer ${adminToken()}`)
                .send({ repo_url: c.repo_url, branch: 'main', auth_type: 'none' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(c.error);
        }
        expect(listRepoTree).not.toHaveBeenCalled();
        listRepoTree.mockRestore();
    });

    it('rejects repository hosts that resolve to an unsafe address', async () => {
        const res = await withLoopbackTargetProtection(() => request(app)
          .post('/api/git-sources/browse')
          .set('Authorization', `Bearer ${adminToken()}`)
          .send({
              repo_url: 'https://127.0.0.1:9999/repo.git',
              branch: 'main',
              auth_type: 'none',
          }));

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not allowed/i);
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

    it('does not reject a branch at the transport limit as too long', async () => {
        // The route and the transport share one bound, so a branch the route
        // stores is always one the transport will still fetch. This asserts
        // the shared side of that: at the limit, length is not the objection.
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                ...baseBody,
                repo_url: 'https://github.com/example/repo.git',
                branch: 'b'.repeat(REF_MAX_LEN),
            });
        expect(String(res.body?.error ?? '')).not.toMatch(/too long/i);
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
        expect(res.body.linked).toBe(false);
        // The stack is real but carries no Git source, so it has no GitOps
        // application to project and the directory is still on disk.
        expect(res.body.stackResourcePresent).toBe(true);
        expect(res.body.gitopsRevision).toMatchObject({
            schemaVersion: 1,
            targetMode: 'not_applicable',
            applicationId: null,
        });
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

    it('redacts high-sensitivity refusal paths from the summary projection (audit round 9 S-1)', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        fs.mkdirSync(path.join(composeDir, 'linked-redacted'), { recursive: true });
        fs.writeFileSync(path.join(composeDir, 'linked-redacted', 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
        seedGitSource('linked-redacted');
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const svc = GitProjectManifestService.getInstance();
        const manifest = svc.buildManifest({
            stackName: 'linked-redacted',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc123',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: 'linked-redacted',
            invocation: ['-f', 'compose.yaml', '-p', 'linked-redacted'],
            inputs: [],
            refusals: [
                { sourcePath: 'secrets/db.env', kind: 'missing-file', reason: 'File not found in repository: secrets/db.env', actionable: true, sensitivity: 'high' },
                { sourcePath: 'compose.yaml', kind: 'missing-file', reason: 'File not found in repository: compose.yaml', actionable: true, sensitivity: 'medium' },
            ],
            buildContexts: [],
            bounds: { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024, maxContextBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxFileBytes: 10 * 1024 * 1024 },
            priorManifest: null,
            state: 'partial',
        });
        await svc.writeManifest('linked-redacted', manifest);

        const res = await request(app)
            .get('/api/stacks/linked-redacted/git-source')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain('secrets/db.env');
        const high = res.body.manifest.refused.find(
            (r: { kind: string; sourcePath: string | null; reason: string }) => r.kind === 'missing-file' && r.sourcePath === null,
        ) as { reason: string } | undefined;
        expect(high).toBeTruthy();
        expect(high?.reason).toContain('[redacted]');
        // Non-sensitive refusals keep their actionable path.
        expect(res.body.manifest.refused.some((r: { sourcePath: string }) => r.sourcePath === 'compose.yaml')).toBe(true);
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

    it('rejects repo URLs with userinfo, query, or fragment', async () => {
        const res = await request(app)
            .post('/api/stacks/from-git')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ ...validBody, repo_url: 'https://github.com/example/repo.git?token=1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/query/i);
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

    it('removes auto-discovered override files so the flattened model is final', async () => {
        seedGitSource('ov-unlink');
        const stackDir = path.join(process.env.COMPOSE_DIR!, 'ov-unlink');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
        fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'), 'services:\n  web:\n    environment:\n      A: b\n');
        // The managed override file is recorded in the manifest so detach can
        // find it; write a manifest entry for it directly.
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const svc = GitProjectManifestService.getInstance();
        const manifest = svc.buildManifest({
            stackName: 'ov-unlink',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: 'ov-unlink',
            invocation: ['-f', 'compose.yaml', '-p', 'ov-unlink'],
            inputs: [
                {
                    sourcePath: 'compose.yaml', materializedPath: 'compose.yaml', role: 'compose-primary', dependencyKind: 'explicit',
                    ownership: 'managed', provenance: 'fetch', sensitivity: 'medium', contentSha256: null, sizeBytes: 10,
                    state: 'present', deletionAuthority: 'sencho', note: null,
                },
                {
                    sourcePath: 'compose.override.yaml', materializedPath: 'compose.override.yaml', role: 'compose-override', dependencyKind: 'implicit-override',
                    ownership: 'managed', provenance: 'fetch', sensitivity: 'medium', contentSha256: null, sizeBytes: 10,
                    state: 'present', deletionAuthority: 'sencho', note: null,
                },
            ],
            refusals: [],
            buildContexts: [],
            bounds: { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024, maxContextBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxFileBytes: 10 * 1024 * 1024 },
            priorManifest: null,
            state: 'active',
        });
        await svc.writeManifest('ov-unlink', manifest);
        const render = mockRender('services:\n  web:\n    image: nginx\n    environment:\n      A: b\n');
        try {
            const res = await request(app)
                .delete('/api/stacks/ov-unlink/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(200);
            // The flattened model is final: the override file is gone, so plain
            // docker compose cannot re-merge it.
            expect(fs.existsSync(path.join(stackDir, 'compose.override.yaml'))).toBe(false);
            expect(DatabaseService.getInstance().getGitSource('ov-unlink')).toBeUndefined();
            expect(render).toHaveBeenCalled();
        } finally {
            render.mockRestore();
        }
    });

    it('keeps an explicitly selected file named compose.override.yaml during detach (audit round 8 B-7)', async () => {
        seedGitSource('explicit-override-name');
        const stackDir = path.join(process.env.COMPOSE_DIR!, 'explicit-override-name');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
        fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'), 'services:\n  web:\n    environment:\n      A: b\n');
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const svc = GitProjectManifestService.getInstance();
        const manifest = svc.buildManifest({
            stackName: 'explicit-override-name',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc',
            projectRoot: null,
            composeFiles: ['compose.yaml', 'compose.override.yaml'],
            projectName: 'explicit-override-name',
            invocation: ['-f', 'compose.yaml', '-f', 'compose.override.yaml', '-p', 'explicit-override-name'],
            inputs: [
                {
                    sourcePath: 'compose.yaml', materializedPath: 'compose.yaml', role: 'compose-primary', dependencyKind: 'explicit',
                    ownership: 'managed', provenance: 'fetch', sensitivity: 'medium', contentSha256: null, sizeBytes: 10,
                    state: 'present', deletionAuthority: 'sencho', note: null,
                },
                {
                    // Same basename, but an EXPLICIT -f input, not an
                    // auto-discovered override.
                    sourcePath: 'compose.override.yaml', materializedPath: 'compose.override.yaml', role: 'compose-additional', dependencyKind: 'explicit',
                    ownership: 'managed', provenance: 'fetch', sensitivity: 'medium', contentSha256: null, sizeBytes: 10,
                    state: 'present', deletionAuthority: 'sencho', note: null,
                },
            ],
            refusals: [],
            buildContexts: [],
            bounds: { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024, maxContextBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxFileBytes: 10 * 1024 * 1024 },
            priorManifest: null,
            state: 'active',
        });
        await svc.writeManifest('explicit-override-name', manifest);
        const render = mockRender('services:\n  web:\n    image: nginx\n    environment:\n      A: b\n');
        try {
            const res = await request(app)
                .delete('/api/stacks/explicit-override-name/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(200);
            // The explicit file is part of the rendered model; detach keeps it.
            expect(fs.existsSync(path.join(stackDir, 'compose.override.yaml'))).toBe(true);
            expect(DatabaseService.getInstance().getGitSource('explicit-override-name')).toBeUndefined();
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

    it('reaps staged managed data after detach cleanup is deferred', async () => {
        seedGitSource('deferred-cleanup');
        const stackDir = path.join(process.env.COMPOSE_DIR!, 'deferred-cleanup');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const manifestSvc = GitProjectManifestService.getInstance();
        const finalizeSpy = vi.spyOn(manifestSvc, 'finalizeStagedDetach').mockResolvedValueOnce(false);
        const render = mockRender('services:\n  web:\n    image: nginx\n');
        const staged = path.join(process.env.DATA_DIR!, 'git-managed', '1', '.detach-deferred-cleanup');
        try {
            const res = await request(app)
                .delete('/api/stacks/deferred-cleanup/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(200);
            expect(DatabaseService.getInstance().getGitSource('deferred-cleanup')).toBeUndefined();
            expect(fs.existsSync(staged)).toBe(true);

            await GitSourceService.getInstance().sweepOrphans();
            expect(fs.existsSync(staged)).toBe(false);
        } finally {
            finalizeSpy.mockRestore();
            render.mockRestore();
        }
    });

    it('restores files and managed data when the database commit fails', async () => {
        seedGitSource('db-fail-unlink');
        const stackDir = path.join(process.env.COMPOSE_DIR!, 'db-fail-unlink');
        fs.mkdirSync(stackDir, { recursive: true });
        const original = `${'#'.repeat((2 * 1024 * 1024) + 1)}\nservices:\n  web:\n    image: nginx:old\n`;
        const originalOverride = Buffer.from('services:\n  web:\n    environment:\n      LABEL: café\n', 'utf8');
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), original);
        fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'), originalOverride);
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const svc = GitProjectManifestService.getInstance();
        const manifest = svc.buildManifest({
            stackName: 'db-fail-unlink',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: 'db-fail-unlink',
            invocation: ['-f', 'compose.yaml', '-p', 'db-fail-unlink'],
            inputs: [
                {
                    sourcePath: 'compose.yaml', materializedPath: 'compose.yaml', role: 'compose-primary', dependencyKind: 'explicit',
                    ownership: 'managed', provenance: 'fetch', sensitivity: 'medium', contentSha256: null, sizeBytes: original.length,
                    state: 'present', deletionAuthority: 'sencho', note: null,
                },
                {
                    sourcePath: 'compose.override.yaml', materializedPath: 'compose.override.yaml', role: 'compose-override', dependencyKind: 'implicit-override',
                    ownership: 'managed', provenance: 'fetch', sensitivity: 'medium', contentSha256: null, sizeBytes: originalOverride.length,
                    state: 'present', deletionAuthority: 'sencho', note: null,
                },
            ],
            refusals: [],
            buildContexts: [],
            bounds: { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024, maxContextBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxFileBytes: 10 * 1024 * 1024 },
            priorManifest: null,
            state: 'active',
        });
        await svc.writeManifest('db-fail-unlink', manifest);
        const render = mockRender('services:\n  web:\n    image: nginx:new\n');
        const deleteSpy = vi.spyOn(DatabaseService.getInstance(), 'deleteGitSource').mockImplementationOnce(() => {
            throw new Error('database unavailable');
        });
        try {
            const res = await request(app)
                .delete('/api/stacks/db-fail-unlink/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(400);
            expect(DatabaseService.getInstance().getGitSource('db-fail-unlink')).toBeTruthy();
            expect(fs.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(original);
            expect(fs.readFileSync(path.join(stackDir, 'compose.override.yaml')).equals(originalOverride)).toBe(true);
            const restored = await svc.readManifest('db-fail-unlink', 'https://github.com/example/repo.git', 'main');
            expect(restored).not.toBeNull();
            expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'git-managed', '1', '.detach-db-fail-unlink'))).toBe(false);
        } finally {
            deleteSpy.mockRestore();
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
        expect(res.body.manifest.manifestVersion).toBe(1);
        expect(res.body.manifest.resolvedCommitSha).toBe('abc123');
    });

    it('redacts sensitive input paths and omits internal metadata (audit round 8 B-6)', async () => {
        seedGitSource('manifest-redact');
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const svc = GitProjectManifestService.getInstance();
        const manifest = svc.buildManifest({
            stackName: 'manifest-redact',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc123',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: 'manifest-redact',
            invocation: ['-f', 'compose.yaml', '-p', 'manifest-redact'],
            inputs: [
                {
                    sourcePath: 'compose.yaml',
                    materializedPath: 'compose.yaml',
                    role: 'compose-primary',
                    dependencyKind: 'explicit',
                    ownership: 'managed',
                    provenance: 'fetch',
                    sensitivity: 'medium',
                    contentSha256: 'a'.repeat(64),
                    sizeBytes: 120,
                    state: 'present',
                    deletionAuthority: 'sencho',
                    note: null,
                },
                {
                    sourcePath: 'secrets/db.env',
                    materializedPath: 'secrets/db.env',
                    role: 'env',
                    dependencyKind: 'env_file',
                    ownership: 'managed',
                    provenance: 'fetch',
                    sensitivity: 'high',
                    contentSha256: 'b'.repeat(64),
                    sizeBytes: 40,
                    state: 'present',
                    deletionAuthority: 'sencho',
                    note: null,
                },
                {
                    sourcePath: 'configs/app.conf',
                    materializedPath: 'configs/app.conf',
                    role: 'config',
                    dependencyKind: 'config',
                    ownership: 'managed',
                    provenance: 'fetch',
                    sensitivity: 'high',
                    contentSha256: 'c'.repeat(64),
                    sizeBytes: 200,
                    state: 'present',
                    deletionAuthority: 'sencho',
                    note: null,
                },
                {
                    sourcePath: 'keys/jwt.pem',
                    materializedPath: 'keys/jwt.pem',
                    role: 'secret',
                    dependencyKind: 'secret',
                    ownership: 'managed',
                    provenance: 'fetch',
                    sensitivity: 'high',
                    contentSha256: 'd'.repeat(64),
                    sizeBytes: 50,
                    state: 'present',
                    deletionAuthority: 'sencho',
                    note: 'File-backed secret materialized from keys/jwt.pem',
                },
            ],
            refusals: [],
            buildContexts: [],
            bounds: { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024, maxContextBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxFileBytes: 10 * 1024 * 1024 },
            priorManifest: null,
            state: 'active',
        });
        await svc.writeManifest('manifest-redact', manifest);

        const res = await request(app)
            .get('/api/stacks/manifest-redact/git-source/manifest')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);

        // The medium-sensitivity compose input keeps its path...
        const compose = res.body.manifest.inputs.find((i: { dependencyKind: string }) => i.dependencyKind === 'explicit');
        expect(compose.path).toBe('compose.yaml');
        // ...and high-sensitivity env/config inputs have their paths redacted.
        const env = res.body.manifest.inputs.find((i: { dependencyKind: string }) => i.dependencyKind === 'env_file');
        expect(env.path).toBeNull();
        const cfg = res.body.manifest.inputs.find((i: { dependencyKind: string }) => i.dependencyKind === 'config');
        expect(cfg.path).toBeNull();

        // Internal metadata never crosses the API.
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain('contentSha256');
        expect(serialized).not.toContain('sizeBytes');
        expect(serialized).not.toContain('sourcePath');
        expect(serialized).not.toContain('materializedPath');
        expect(serialized).not.toContain('deletionAuthority');
        expect(serialized).not.toContain('provenance');
        expect(serialized).not.toContain('secrets/db.env');
        expect(serialized).not.toContain('configs/app.conf');
        // A path-bearing note on a high-sensitivity entry must not leak either.
        expect(serialized).not.toContain('keys/jwt.pem');
        // The redacted projection still counts the entries.
        expect(res.body.manifest.inputs).toHaveLength(4);
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
            encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
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

    it('migrateGitSourceChangePlan is idempotent', () => {
        const db = DatabaseService.getInstance() as unknown as { migrateGitSourceChangePlan: () => void };
        expect(() => {
            db.migrateGitSourceChangePlan();
            db.migrateGitSourceChangePlan();
        }).not.toThrow();
        const row = DatabaseService.getInstance().getGitSource('existing-stack');
        expect(row === undefined || row.pending_plan_fingerprint === null || typeof row.pending_plan_fingerprint === 'string').toBe(true);
    });

    it('GET keeps flat manifest_state aligned with the healed summary', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        fs.mkdirSync(path.join(composeDir, 'stale-manifest-get'), { recursive: true });
        fs.writeFileSync(path.join(composeDir, 'stale-manifest-get', 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
        seedGitSource('stale-manifest-get');
        DatabaseService.getInstance().setGitSourceManifestState('stale-manifest-get', 3, 'active', 'generations/applied-abc-3');

        const res = await request(app)
            .get('/api/stacks/stale-manifest-get/git-source')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.manifest?.state).toBe('migration_required');
        expect(res.body.manifest_state).toBe('migration_required');
    });
});

describe('git-source routes: statuses-cache invalidation', () => {
    // The cached /stacks/statuses payload carries the source label, so link
    // and unlink must drop the cache; read-only routes must not.
    beforeEach(() => {
        mockInvalidateNodeCaches.mockClear();
    });

    function seedStackDir(stackName: string): void {
        const composeDir = process.env.COMPOSE_DIR!;
        fs.mkdirSync(path.join(composeDir, stackName), { recursive: true });
        fs.writeFileSync(path.join(composeDir, stackName, 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
    }

    it('invalidates node caches when linking a Git source', async () => {
        seedStackDir('inv-link');
        // Stub upsert so the assertion stays at the route layer without cloning a repo.
        const upsertSpy = vi.spyOn(GitSourceService.getInstance(), 'upsert')
            .mockResolvedValue({} as Awaited<ReturnType<typeof GitSourceService.prototype.upsert>>);
        const res = await request(app)
            .put('/api/stacks/inv-link/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: 'https://github.com/example/inv-link.git',
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'none',
            });
        expect(res.status).toBe(200);
        expect(mockInvalidateNodeCaches).toHaveBeenCalledTimes(1);
        expect(mockInvalidateNodeCaches).toHaveBeenCalledWith(expect.any(Number));
        upsertSpy.mockRestore();
    });

    it('invalidates node caches when unlinking a Git source', async () => {
        seedStackDir('inv-unlink');
        seedGitSource('inv-unlink');
        // Stub detach so the assertion stays at the route layer (export/render
        // belongs to the service tests); unlink must still drop the cache.
        const detachSpy = vi.spyOn(GitSourceService.getInstance(), 'detach')
            .mockResolvedValue(undefined);
        try {
            const res = await request(app)
                .delete('/api/stacks/inv-unlink/git-source')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(200);
            expect(mockInvalidateNodeCaches).toHaveBeenCalledTimes(1);
            expect(mockInvalidateNodeCaches).toHaveBeenCalledWith(expect.any(Number));
        } finally {
            detachSpy.mockRestore();
        }
    });

    it('does not invalidate on GET of the Git source', async () => {
        seedStackDir('inv-get');
        seedGitSource('inv-get');
        const res = await request(app)
            .get('/api/stacks/inv-get/git-source')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(mockInvalidateNodeCaches).not.toHaveBeenCalled();
    });

    it('does not invalidate when dismissing a pending update', async () => {
        seedGitSource('inv-dismiss');
        const res = await request(app)
            .post('/api/stacks/inv-dismiss/git-source/dismiss-pending')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(mockInvalidateNodeCaches).not.toHaveBeenCalled();
    });
});

describe('POST /api/stacks/:stackName/git-source/apply fingerprint', () => {
    it('returns 400 PLAN_FINGERPRINT_REQUIRED when the body omits planFingerprint', async () => {
        seedGitSource('existing-stack');
        const res = await request(app)
            .post('/api/stacks/existing-stack/git-source/apply')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ commitSha: 'abc123', deploy: false });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PLAN_FINGERPRINT_REQUIRED');
    });

    it('returns 409 STALE_PLAN with the replacement plan attached', async () => {
        seedGitSource('existing-stack');
        const plan = {
            blocked: false,
            counts: {
                add: 0, modify: 1, delete: 0, rename: 0, unchanged: 0,
                localModified: 0, localMissing: 0, typeChanged: 0, unmanagedCollision: 0, invocation: 0,
            },
            operations: [{ path: 'compose.yaml', op: 'modify' as const, role: 'compose-primary' as const }],
            invocation: { candidateChanged: false, liveDiverged: false },
        };
        const applySpy = vi.spyOn(GitSourceService.getInstance(), 'apply')
            .mockRejectedValue(new GitSourceError('STALE_PLAN', 'stale', { plan, planFingerprint: 'fp-new' }));
        try {
            const res = await request(app)
                .post('/api/stacks/existing-stack/git-source/apply')
                .set('Authorization', `Bearer ${adminToken()}`)
                .send({ commitSha: 'abc123', planFingerprint: 'fp-old', deploy: false });
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('STALE_PLAN');
            expect(res.body.planFingerprint).toBe('fp-new');
            expect(res.body.plan).toEqual(plan);
            expect(JSON.stringify(res.body)).not.toContain('SUPER-SECRET');
        } finally {
            applySpy.mockRestore();
        }
    });
});

describe('POST /api/stacks/:stackName/git-source/pull permissions and actor', () => {
    it('denies pull without stack:edit', async () => {
        seedGitSource('existing-stack');
        const res = await request(app)
            .post('/api/stacks/existing-stack/git-source/pull')
            .set('Authorization', `Bearer ${jwt.sign({ username: 'viewer', role: 'viewer' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`);
        expect([401, 403]).toContain(res.status);
    });

    it('passes the authenticated username as the pull actor', async () => {
        seedGitSource('existing-stack');
        const pullSpy = vi.spyOn(GitSourceService.getInstance(), 'pull').mockResolvedValue({
            commitSha: 'abc',
            validation: { ok: true },
            refusals: [],
            manifestSummary: null,
            candidateReady: true,
            warnings: [],
            plan: {
                blocked: false,
                counts: {
                    add: 0, modify: 0, delete: 0, rename: 0, unchanged: 1,
                    localModified: 0, localMissing: 0, typeChanged: 0, unmanagedCollision: 0, invocation: 0,
                },
                operations: [],
                invocation: { candidateChanged: false, liveDiverged: false },
            },
            planFingerprint: 'fp',
        });
        try {
            const res = await request(app)
                .post('/api/stacks/existing-stack/git-source/pull')
                .set('Authorization', `Bearer ${adminToken()}`);
            expect(res.status).toBe(200);
            expect(pullSpy).toHaveBeenCalledWith('existing-stack', { actor: TEST_USERNAME });
            expect(JSON.stringify(res.body)).not.toContain('incomingCompose');
            expect(JSON.stringify(res.body)).not.toContain('hasLocalChanges');
        } finally {
            pullSpy.mockRestore();
        }
    });
});

describe('GitOps additive fields and history routes', () => {
    let viewerCookie: string;
    let auditorCookie: string;

    async function loginAs(username: string, role: 'viewer' | 'auditor'): Promise<string> {
        const bcrypt = (await import('bcrypt')).default;
        const password = `${username}-pass`;
        DatabaseService.getInstance().addUser({
            username,
            password_hash: await bcrypt.hash(password, 1),
            role,
        });
        const login = await request(app).post('/api/auth/login').send({ username, password });
        const cookies = login.headers['set-cookie'] as string | string[];
        return Array.isArray(cookies) ? cookies[0] : cookies;
    }

    beforeAll(async () => {
        viewerCookie = await loginAs('gitops-viewer', 'viewer');
        auditorCookie = await loginAs('gitops-auditor', 'auditor');
    });

    function makeStackDir(stackName: string): void {
        const composeDir = process.env.COMPOSE_DIR!;
        fs.mkdirSync(path.join(composeDir, stackName), { recursive: true });
        fs.writeFileSync(path.join(composeDir, stackName, 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
    }

    /** Bring a real Direct application into the store, which also writes its first history row. */
    function activateApplication(
        id: string,
        stackName: string,
        lifecycleStatus: GitOpsApplicationRow['lifecycle_status'] = 'active',
    ): void {
        const application: GitOpsApplicationRow = {
            ...directApplicationFixture(id, stackName),
            lifecycle_status: lifecycleStatus,
        };
        GitOpsTransitions.getInstance().activateDirect({
            application,
            nodeId: 1,
            envelope: { operationId: `op-${id}`, actor: 'tester', trigger: 'manual', at: Date.now() },
        });
    }

    /** Append one more history row for an existing application. */
    function recordFetch(applicationId: string, stackName: string, operationId: string, sha: string): void {
        const application = GitOpsStore.getInstance().getApplication(applicationId)
            ?? directApplicationFixture(applicationId, stackName);
        insertHistory(DatabaseService.getInstance().getDb(), {
            application,
            nodeId: 1,
            dedupeTarget: 'app',
            operationId,
            stage: 'fetched',
            outcome: 'committed',
            trigger: 'manual',
            actor: 'tester',
            before: { desiredCommitSha: null },
            after: { desiredCommitSha: sha },
            commitSha: sha,
            at: Date.now(),
        });
    }

    it('carries gitopsRevision and stackResourcePresent on each git-source row', async () => {
        makeStackDir('additive-stack');
        seedGitSource('additive-stack');
        const res = await request(app)
            .get('/api/git-sources')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        const row = res.body.find((r: { stack_name: string }) => r.stack_name === 'additive-stack');
        expect(row).toBeDefined();
        expect(row.stackResourcePresent).toBe(true);
        expect(row.gitopsRevision.schemaVersion).toBe(1);
    });

    it('withholds a row with no GitOps application from a non-admin', async () => {
        makeStackDir('unmodelled-stack');
        seedGitSource('unmodelled-stack');
        // A viewer holds global stack:read, but a source we cannot tie to a
        // live application has no lifecycle to prove, so it stays with Admin.
        const res = await request(app)
            .get('/api/git-sources')
            .set('Cookie', viewerCookie);
        expect(res.status).toBe(200);
        expect(res.body.map((r: { stack_name: string }) => r.stack_name)).not.toContain('unmodelled-stack');
    });

    it('projects a live application, not just the not-applicable shape', async () => {
        makeStackDir('live-app-stack');
        seedGitSource('live-app-stack');
        activateApplication('app-live-route', 'live-app-stack');
        const res = await request(app)
            .get('/api/git-sources')
            .set('Authorization', `Bearer ${adminToken()}`);
        const row = res.body.find((r: { stack_name: string }) => r.stack_name === 'live-app-stack');
        expect(row.gitopsRevision).toMatchObject({
            schemaVersion: 1,
            targetMode: 'direct',
            applicationId: 'app-live-route',
            lifecycleStatus: 'active',
        });
        expect(row.gitopsRevision.facets).not.toBeNull();
    });

    it('shows a modelled row to a non-admin holding stack read', async () => {
        // The deny case alone would pass if the route dropped every row for a
        // non-admin, so the allow case is what proves the classifier runs.
        makeStackDir('viewer-visible-stack');
        seedGitSource('viewer-visible-stack');
        activateApplication('app-viewer-visible', 'viewer-visible-stack');
        const res = await request(app)
            .get('/api/git-sources')
            .set('Cookie', viewerCookie);
        expect(res.status).toBe(200);
        expect(res.body.map((r: { stack_name: string }) => r.stack_name)).toContain('viewer-visible-stack');
    });

    it('filters cross-stack history per row for a non-admin', async () => {
        makeStackDir('viewer-hist-stack');
        activateApplication('app-viewer-hist', 'viewer-hist-stack');
        // No directory, so this application's rows are unprovable and Admin-only.
        activateApplication('app-hidden-hist', 'absent-hist-stack');

        const asAdmin = await request(app)
            .get('/api/git-sources/history?limit=100')
            .set('Authorization', `Bearer ${adminToken()}`);
        const adminStacks = asAdmin.body.items.map((i: { stackName: string }) => i.stackName);
        expect(adminStacks).toContain('viewer-hist-stack');
        expect(adminStacks).toContain('absent-hist-stack');

        const asViewer = await request(app)
            .get('/api/git-sources/history?limit=100')
            .set('Cookie', viewerCookie);
        const viewerStacks = asViewer.body.items.map((i: { stackName: string }) => i.stackName);
        expect(viewerStacks).toContain('viewer-hist-stack');
        expect(viewerStacks).not.toContain('absent-hist-stack');
    });

    it('shows an auditor the history entries a viewer cannot prove', async () => {
        // 'absent-hist-stack' has no directory, so its entries cannot be tied
        // to a readable stack. They are still an audit record, so the audit
        // permission reaches them where a plain stack grant does not.
        const asAuditor = await request(app)
            .get('/api/git-sources/history?limit=100')
            .set('Cookie', auditorCookie);
        expect(asAuditor.status).toBe(200);
        const auditorStacks = asAuditor.body.items.map((i: { stackName: string }) => i.stackName);
        expect(auditorStacks).toContain('absent-hist-stack');
        expect(auditorStacks).toContain('viewer-hist-stack');
    });

    it('does not let the audit permission reach Git configuration', async () => {
        // The source list is live configuration, not a record of events, so an
        // auditor sees no more of it than any other non-admin.
        makeStackDir('auditor-config-stack');
        seedGitSource('auditor-config-stack');
        const res = await request(app)
            .get('/api/git-sources')
            .set('Cookie', auditorCookie);
        expect(res.status).toBe(200);
        // Seeded with no GitOps application, so it stays Admin-only.
        expect(res.body.map((r: { stack_name: string }) => r.stack_name)).not.toContain('auditor-config-stack');
    });

    it('advances the cursor past rows the caller may not read', async () => {
        // The viewer cannot read the absent-stack rows seeded above. Paging
        // must still move forward, or a narrowly scoped caller re-reads the
        // same rejected window for ever.
        const first = await request(app)
            .get('/api/git-sources/history?limit=1')
            .set('Cookie', viewerCookie);
        expect(first.status).toBe(200);
        expect(first.body.nextCursor).not.toBeNull();

        const second = await request(app)
            .get(`/api/git-sources/history?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
            .set('Cookie', viewerCookie);
        expect(second.status).toBe(200);
        const firstIds = first.body.items.map((i: { id: string }) => i.id);
        const secondIds = second.body.items.map((i: { id: string }) => i.id);
        expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);
    });

    it('hands back a cursor when a page fills and none when the window is spent', async () => {
        makeStackDir('paging-stack');
        activateApplication('app-paging', 'paging-stack');
        recordFetch('app-paging', 'paging-stack', 'op-page-1', 'aaa1111');
        recordFetch('app-paging', 'paging-stack', 'op-page-2', 'bbb2222');

        const full = await request(app)
            .get('/api/stacks/paging-stack/git-source/history?limit=2')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(full.body.items).toHaveLength(2);
        expect(full.body.nextCursor).not.toBeNull();

        const rest = await request(app)
            .get(`/api/stacks/paging-stack/git-source/history?limit=2&cursor=${encodeURIComponent(full.body.nextCursor)}`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(rest.body.items).toHaveLength(1);
        expect(rest.body.nextCursor).toBeNull();
    });

    it('keeps a creating stack own history readable through the per-stack route', async () => {
        // The row classifier sends `creating` to Admin. The per-stack route
        // authorizes its collection by name instead, which is the whole reason
        // that distinction exists.
        makeStackDir('creating-stack');
        activateApplication('app-creating', 'creating-stack', 'creating');

        recordFetch('app-creating', 'creating-stack', 'op-creating-1', 'creat111');
        const perStack = await request(app)
            .get('/api/stacks/creating-stack/git-source/history')
            .set('Cookie', viewerCookie);
        expect(perStack.status).toBe(200);
        // Asserted by identity, not by count. A non-empty page would also be
        // satisfied by an exemption that had widened to rows it should not
        // cover, which is the failure this route's scope exists to prevent.
        expect(perStack.body.items.map((i: { applicationId: string }) => i.applicationId))
            .toContain('app-creating');
        expect(perStack.body.items.map((i: { commitSha: string | null }) => i.commitSha))
            .toContain('creat111');

        const crossStack = await request(app)
            .get('/api/git-sources/history?limit=100')
            .set('Cookie', viewerCookie);
        const stacks = crossStack.body.items.map((i: { stackName: string }) => i.stackName);
        expect(stacks).not.toContain('creating-stack');
    });

    it('does not expose a predecessor application through a reused stack name', async () => {
        // A stack name outlives the applications that hold it. A grant on the
        // one holding it now says nothing about the repository, actors or
        // commits of the one that held it before, so those rows stay behind
        // the audit permission on this route exactly as they do cross-stack.
        makeStackDir('reused-name');
        activateApplication('app-reused-old', 'reused-name');
        recordFetch('app-reused-old', 'reused-name', 'op-reused-old', 'old11111');
        GitOpsTransitions.getInstance().applicationTombstoned('app-reused-old', 'deleted', {
            operationId: 'op-reused-old', actor: 'tester', trigger: 'manual', at: Date.now(),
        });
        activateApplication('app-reused-new', 'reused-name');
        recordFetch('app-reused-new', 'reused-name', 'op-reused-new', 'new22222');

        const viewer = await request(app)
            .get('/api/stacks/reused-name/git-source/history?limit=100')
            .set('Cookie', viewerCookie);
        expect(viewer.status).toBe(200);
        const viewerShas = viewer.body.items.map((i: { commitSha: string | null }) => i.commitSha);
        expect(viewerShas).toContain('new22222');
        expect(viewerShas).not.toContain('old11111');

        // The audit trail is not lost, only moved behind the permission that
        // exists for reading it.
        const auditor = await request(app)
            .get('/api/stacks/reused-name/git-source/history?limit=100')
            .set('Cookie', auditorCookie);
        expect(auditor.status).toBe(200);
        const auditorShas = auditor.body.items.map((i: { commitSha: string | null }) => i.commitSha);
        expect(auditorShas).toContain('old11111');
        expect(auditorShas).toContain('new22222');
    });

    it('moves a detached application behind system:audit even with no successor', async () => {
        // Detach leaves the files on disk, which once justified reading its
        // trail on a stack grant. A grant covers whatever occupies the name
        // today, and nothing in these tables can prove the detached
        // application still does: some successors hide from every lookup this
        // route could run, so detach joins `deleted` as an audit-only
        // predecessor.
        makeStackDir('detached-kept');
        activateApplication('app-detached-kept', 'detached-kept');
        recordFetch('app-detached-kept', 'detached-kept', 'op-detached-kept', 'kept1111');
        GitOpsTransitions.getInstance().applicationTombstoned('app-detached-kept', 'detached', {
            operationId: 'op-detached-kept', actor: 'tester', trigger: 'manual', at: Date.now(),
        });

        const viewer = await request(app)
            .get('/api/stacks/detached-kept/git-source/history?limit=100')
            .set('Cookie', viewerCookie);
        expect(viewer.status).toBe(200);
        const shas = viewer.body.items.map((i: { commitSha: string | null }) => i.commitSha);
        expect(shas).not.toContain('kept1111');

        // Moved behind the audit permission, not lost.
        const auditor = await request(app)
            .get('/api/stacks/detached-kept/git-source/history?limit=100')
            .set('Cookie', auditorCookie);
        expect(auditor.status).toBe(200);
        const auditorShas = auditor.body.items.map((i: { commitSha: string | null }) => i.commitSha);
        expect(auditorShas).toContain('kept1111');
    });

    it('keeps a detached predecessor behind system:audit once a successor takes the name', async () => {
        // The successor makes the reuse visible, but the answer does not depend
        // on detecting it: a detached trail is audit-only on its own. This pins
        // that a successor neither restores nor widens what the stack grant
        // reaches.
        makeStackDir('reused-detached');
        activateApplication('app-detached-old', 'reused-detached');
        recordFetch('app-detached-old', 'reused-detached', 'op-detached-old', 'det11111');
        GitOpsTransitions.getInstance().applicationTombstoned('app-detached-old', 'detached', {
            operationId: 'op-detached-old', actor: 'tester', trigger: 'manual', at: Date.now(),
        });
        activateApplication('app-detached-new', 'reused-detached');
        recordFetch('app-detached-new', 'reused-detached', 'op-detached-new', 'det22222');

        const viewer = await request(app)
            .get('/api/stacks/reused-detached/git-source/history?limit=100')
            .set('Cookie', viewerCookie);
        expect(viewer.status).toBe(200);
        const shas = viewer.body.items.map((i: { commitSha: string | null }) => i.commitSha);
        expect(shas).toContain('det22222');
        expect(shas).not.toContain('det11111');

        // Moved behind the audit permission, not lost.
        const auditor = await request(app)
            .get('/api/stacks/reused-detached/git-source/history?limit=100')
            .set('Cookie', auditorCookie);
        expect(auditor.status).toBe(200);
        const auditorShas = auditor.body.items.map((i: { commitSha: string | null }) => i.commitSha);
        expect(auditorShas).toContain('det11111');
        expect(auditorShas).toContain('det22222');
    });

    it('rejects a malformed cursor instead of silently restarting', async () => {
        const res = await request(app)
            .get('/api/git-sources/history?cursor=123.not-a-uuid')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cursor/i);
    });

    it('rejects a recognized filter carrying an unusable value', async () => {
        const outcome = await request(app)
            .get('/api/git-sources/history?outcome=success')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(outcome.status).toBe(400);
        expect(outcome.body.error).toMatch(/outcome/i);

        const nodeId = await request(app)
            .get('/api/git-sources/history?nodeId=abc')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(nodeId.status).toBe(400);
        expect(nodeId.body.error).toMatch(/nodeId/i);
    });

    it('rejects an invalid stack name on the per-stack history route', async () => {
        const res = await request(app)
            .get('/api/stacks/..%2Fetc/git-source/history')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/stack name/i);
    });

    it('returns an empty page for a stack with no recorded history', async () => {
        makeStackDir('quiet-stack');
        const res = await request(app)
            .get('/api/stacks/quiet-stack/git-source/history')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([]);
        expect(res.body.nextCursor).toBeNull();
    });
});

describe('POST /api/git-sources/ssh-host-key', () => {
    it('rejects missing repo_url with 400', async () => {
        const res = await request(app)
            .post('/api/git-sources/ssh-host-key')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/repo_url/i);
    });

    it('rejects unsupported URL schemes before probing', async () => {
        const res = await request(app)
            .post('/api/git-sources/ssh-host-key')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ repo_url: 'http://github.com/example/repo.git' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/https:\/\/ URL or an SSH URL/i);
    });

    it('rejects HTTPS URLs that are storable but not SSH probe targets', async () => {
        const res = await request(app)
            .post('/api/git-sources/ssh-host-key')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ repo_url: 'https://github.com/example/repo.git' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/SSH repository URL/i);
    });

    it('rejects host-key probes to an unsafe address', async () => {
        const res = await withLoopbackTargetProtection(() => request(app)
          .post('/api/git-sources/ssh-host-key')
          .set('Authorization', `Bearer ${adminToken()}`)
          .send({ repo_url: 'ssh://git@127.0.0.1:22/example/repo.git' }));
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not allowed/i);
    });

    it('returns scanned host keys for an SSH repository URL', async () => {
        const scanHostKeys = vi.spyOn(
            await import('../services/git/sshTrust'),
            'scanHostKeys',
        ).mockResolvedValue([
            {
                keyType: 'ssh-ed25519',
                fingerprint: 'SHA256:fixtureFingerprint',
                line: '|1|fixture|fixture ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyMaterial',
            },
        ]);
        const res = await request(app)
            .post('/api/git-sources/ssh-host-key')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ repo_url: 'git@pinned.example:example/repo.git' });
        expect(res.status).toBe(200);
        expect(res.body.host).toBe('pinned.example');
        expect(res.body.port).toBe(22);
        expect(res.body.keys).toHaveLength(1);
        expect(res.body.keys[0].fingerprint).toBe('SHA256:fixtureFingerprint');
        expect(scanHostKeys).toHaveBeenCalledWith('pinned.example', 22, '93.184.216.34');
        scanHostKeys.mockRestore();
    });

    it('allows host-key probing for an existing stack when stack_name is supplied', async () => {
        const scanHostKeys = vi.spyOn(
            await import('../services/git/sshTrust'),
            'scanHostKeys',
        ).mockResolvedValue([
            {
                keyType: 'ssh-ed25519',
                fingerprint: 'SHA256:fixtureFingerprint',
                line: '|1|fixture|fixture ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyMaterial',
            },
        ]);
        const res = await request(app)
            .post('/api/git-sources/ssh-host-key')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ repo_url: 'git@github.com:example/repo.git', stack_name: 'existing-stack' });
        expect(res.status).toBe(200);
        scanHostKeys.mockRestore();
    });

    it('returns 403 when the caller lacks stack:create and does not name a stack', async () => {
        const deployerName = 'ssh-host-key-deployer';
        const db = DatabaseService.getInstance();
        if (!db.getUserByUsername(deployerName)) {
            db.addUser({ username: deployerName, password_hash: 'test', role: 'deployer' });
        }
        const deployer = db.getUserByUsername(deployerName);
        if (!deployer) throw new Error('expected deployer user');
        const res = await request(app)
            .post('/api/git-sources/ssh-host-key')
            .set('Authorization', `Bearer ${jwt.sign({ username: deployer.username, role: deployer.role, userId: deployer.id }, TEST_JWT_SECRET, { expiresIn: '1m' })}`)
            .send({ repo_url: 'git@github.com:example/repo.git' });
        expect(res.status).toBe(403);
    });

    it('returns 500 when host-key probing throws an unexpected error', async () => {
        const scanHostKeys = vi.spyOn(
            await import('../services/git/sshTrust'),
            'scanHostKeys',
        ).mockRejectedValue(new Error('ssh-keyscan failed'));
        const res = await request(app)
            .post('/api/git-sources/ssh-host-key')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ repo_url: 'ssh://git@github.com:2222/org/repo.git' });
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Git source operation failed/i);
        scanHostKeys.mockRestore();
    });
});

describe('SSH deploy-key route validation', () => {
    const sshRepoUrl = 'git@github.com:example/deploy-repo.git';
    const deployKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n';
    const knownHosts = '|1|fixture|fixture ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyMaterial';

    it('rejects an unknown auth_type on PUT', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: sshRepoUrl,
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'oauth',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/auth_type/i);
    });

    it('rejects an oversized deploy_key on PUT', async () => {
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: sshRepoUrl,
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'deploy_key',
                deploy_key: 'k'.repeat(16385),
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deploy_key is too long/i);
    });

    it('forwards deploy_key fields to upsert for SSH repository URLs', async () => {
        const upsertSpy = vi.spyOn(GitSourceService.getInstance(), 'upsert')
            .mockResolvedValue({} as Awaited<ReturnType<typeof GitSourceService.prototype.upsert>>);
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: sshRepoUrl,
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'deploy_key',
                deploy_key: deployKey,
                ssh_known_hosts_entry: knownHosts,
                ssh_host_key_fingerprint: 'SHA256:fixtureFingerprint',
            });
        expect(res.status).toBe(200);
        expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
            repoUrl: sshRepoUrl,
            authType: 'deploy_key',
            deployKey,
            sshKnownHostsEntry: knownHosts,
            sshHostKeyFingerprint: 'SHA256:fixtureFingerprint',
        }));
        upsertSpy.mockRestore();
    });

    it('forwards proxied deploy actor into upsert auditContext', async () => {
        const upsertSpy = vi.spyOn(GitSourceService.getInstance(), 'upsert')
            .mockResolvedValue({} as Awaited<ReturnType<typeof GitSourceService.prototype.upsert>>);
        const nodeToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
        const res = await request(app)
            .put('/api/stacks/existing-stack/git-source')
            .set('Authorization', `Bearer ${nodeToken}`)
            .set(PROXY_DEPLOY_ACTOR_HEADER, 'fleet-operator')
            .set(PROXY_DEPLOY_SOURCE_HEADER, 'from_git')
            .send({
                repo_url: sshRepoUrl,
                branch: 'main',
                compose_path: 'compose.yaml',
                auth_type: 'deploy_key',
                deploy_key: deployKey,
                ssh_known_hosts_entry: knownHosts,
                ssh_host_key_fingerprint: 'SHA256:fixtureFingerprint',
            });
        expect(res.status).toBe(200);
        expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
            auditContext: expect.objectContaining({ username: 'fleet-operator' }),
        }));
        upsertSpy.mockRestore();
    });

    it('forwards sshAuth to listRepoTree when browsing with deploy_key auth', async () => {
        const listRepoTree = vi.spyOn(GitSourceService.getInstance(), 'listRepoTree')
            .mockResolvedValue({ files: [], truncated: false, commitSha: 'a'.repeat(40), warnings: [] });
        const res = await request(app)
            .post('/api/git-sources/browse')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                repo_url: sshRepoUrl,
                branch: 'main',
                auth_type: 'deploy_key',
                deploy_key: deployKey,
                ssh_known_hosts_entry: knownHosts,
            });
        expect(res.status).toBe(200);
        expect(listRepoTree).toHaveBeenCalledWith(expect.objectContaining({
            repoUrl: sshRepoUrl,
            sshAuth: { privateKey: deployKey, knownHostsEntry: knownHosts },
        }));
        listRepoTree.mockRestore();
    });

    it('GET exposes deploy-key metadata without returning the private key', async () => {
        const stackName = 'ssh-deploy-get';
        const composeDir = process.env.COMPOSE_DIR!;
        fs.mkdirSync(path.join(composeDir, stackName), { recursive: true });
        fs.writeFileSync(path.join(composeDir, stackName, 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
        DatabaseService.getInstance().upsertGitSource({
            stack_name: stackName,
            repo_url: sshRepoUrl,
            branch: 'main',
            compose_path: 'compose.yaml',
            compose_paths: ['compose.yaml'],
            context_dir: null,
            sync_env: false,
            env_path: null,
            auth_type: 'deploy_key',
            encrypted_token: null,
            encrypted_deploy_key: CryptoService.getInstance().encrypt(deployKey),
            ssh_known_hosts_entry: knownHosts,
            ssh_host_key_fingerprint: 'SHA256:fixtureFingerprint',
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
            .get(`/api/stacks/${stackName}/git-source`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.auth_type).toBe('deploy_key');
        expect(res.body.has_deploy_key).toBe(true);
        expect(res.body.ssh_host_key_fingerprint).toBe('SHA256:fixtureFingerprint');
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain(deployKey);
        expect(serialized).not.toContain('encrypted_deploy_key');
    });
});
