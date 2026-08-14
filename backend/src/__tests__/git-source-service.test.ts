/**
 * Unit tests for GitSourceService.
 *
 * Covers:
 * - hashContent determinism and env separation
 * - validateCompose YAML pre-check (empty / non-object / syntax error)
 * - Token round-trip via upsert: encryption, has_token projection, undefined/null/empty/non-empty semantics
 * - Apply-matrix rejection (auto_deploy requires auto_apply)
 * - Error code mapping from isomorphic-git failures (REPO_NOT_FOUND, AUTH_FAILED, BRANCH_NOT_FOUND, NETWORK_TIMEOUT)
 * - Credential scrubbing in surfaced error messages
 * - Pending state lifecycle (setPending -> apply clears -> dismissPending clears)
 * - Webhook debounce enforcement
 * - Per-stack mutex serialization ordering
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockGitClone, mockGitLog } = vi.hoisted(() => ({
    mockGitClone: vi.fn(),
    mockGitLog: vi.fn(),
}));

vi.mock('isomorphic-git', () => {
    const api = { clone: mockGitClone, log: mockGitLog };
    return { default: api, clone: mockGitClone, log: mockGitLog };
});

vi.mock('isomorphic-git/http/node', () => ({ default: {} }));


const {
  mockCaptureCandidate,
  mockRecoveryAbandon,
  mockRecoveryMarkAcquired,
  mockRecoveryHandoff,
  mockRecoveryMarkReconciling,
  mockRecoveryMarkImmediateVerified,
  mockRecoveryGet,
  mockRecoveryLinkGateOrRetain,
} = vi.hoisted(() => ({
  mockCaptureCandidate: vi.fn(async () => ({ id: 'rec-test-1' })),
  mockRecoveryAbandon: vi.fn(async () => true),
  mockRecoveryMarkAcquired: vi.fn(() => true),
  mockRecoveryHandoff: vi.fn(() => true),
  mockRecoveryMarkReconciling: vi.fn(() => true),
  mockRecoveryMarkImmediateVerified: vi.fn(() => true),
  mockRecoveryGet: vi.fn(() => ({ id: 'rec-test-1', is_current: 1 })),
  mockRecoveryLinkGateOrRetain: vi.fn(),
}));

vi.mock('../services/StackUpdateRecoveryService', () => ({
  StackUpdateRecoveryService: {
    getInstance: () => ({
      captureCandidate: mockCaptureCandidate,
      abandon: mockRecoveryAbandon,
      markAcquired: mockRecoveryMarkAcquired,
      handoff: mockRecoveryHandoff,
      markReconciling: mockRecoveryMarkReconciling,
      markImmediateVerified: mockRecoveryMarkImmediateVerified,
      get: mockRecoveryGet,
      linkGateOrRetain: mockRecoveryLinkGateOrRetain,
      compensateWithCandidate: vi.fn(async () => true),
    }),
  },
}));


let tmpDir: string;
let GitSourceService: typeof import('../services/GitSourceService').GitSourceService;
let GitSourceError: typeof import('../services/GitSourceService').GitSourceError;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ GitSourceService, GitSourceError } = await import('../services/GitSourceService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    mockGitClone.mockReset();
    mockGitLog.mockReset();
    mockCaptureCandidate.mockReset();
    mockCaptureCandidate.mockImplementation(async () => ({ id: 'rec-test-1' }));
    mockRecoveryAbandon.mockReset();
    mockRecoveryAbandon.mockResolvedValue(true);
    mockRecoveryMarkAcquired.mockReset();
    mockRecoveryMarkAcquired.mockReturnValue(true);
    mockRecoveryHandoff.mockReset();
    mockRecoveryHandoff.mockReturnValue(true);
    mockRecoveryMarkReconciling.mockReset();
    mockRecoveryMarkReconciling.mockReturnValue(true);
    mockRecoveryMarkImmediateVerified.mockReset();
    mockRecoveryMarkImmediateVerified.mockReturnValue(true);
    mockRecoveryGet.mockReset();
    mockRecoveryLinkGateOrRetain.mockReset();
    mockRecoveryGet.mockReturnValue({ id: 'rec-test-1', is_current: 1 });

    // Wipe persisted git sources between tests
    const db = DatabaseService.getInstance();
    for (const s of db.getGitSources()) db.deleteGitSource(s.stack_name);
    for (const p of db.getScanPolicies()) db.deleteScanPolicy(p.id);
});

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Stub out isomorphic-git so that `clone` writes a minimal compose file into
 * the caller's temp dir and `log` returns a deterministic commit sha. Returns
 * the sha so tests can compare.
 */
function mockSuccessfulClone(options: {
    compose?: string;
    env?: string | null;
    composePath?: string;
    envPath?: string | null;
    sha?: string;
    /**
     * Additional repo-relative files to write into the clone temp dir on top of
     * the primary compose file. Lets multi-file tests stage base+override layouts.
     */
    extraFiles?: Record<string, string>;
} = {}) {
    const {
        compose = 'services:\n  web:\n    image: nginx\n',
        env = null,
        composePath = 'compose.yaml',
        envPath = null,
        sha = 'abc1234567890abc1234567890abc1234567890a',
        extraFiles = {},
    } = options;

    mockGitClone.mockImplementation(async (args: { dir: string }) => {
        const { promises: fsp } = await import('fs');
        const path = await import('path');
        const composeAbs = path.join(args.dir, composePath);
        await fsp.mkdir(path.dirname(composeAbs), { recursive: true });
        await fsp.writeFile(composeAbs, compose, 'utf-8');
        for (const [rel, content] of Object.entries(extraFiles)) {
            const abs = path.join(args.dir, rel);
            await fsp.mkdir(path.dirname(abs), { recursive: true });
            await fsp.writeFile(abs, content, 'utf-8');
        }
        if (env !== null && envPath) {
            const envAbs = path.join(args.dir, envPath);
            await fsp.mkdir(path.dirname(envAbs), { recursive: true });
            await fsp.writeFile(envAbs, env, 'utf-8');
        }
    });
    mockGitLog.mockResolvedValue([{ oid: sha }]);
    return sha;
}

/** Wrap a single compose string in the ComposeFile[] shape the new APIs take. */
function asFiles(content: string): import('../services/GitSourceService').ComposeFile[] {
    return [{ path: 'compose.yaml', content }];
}

/** Best-effort teardown for tests that materialize a stack on disk. */
async function cleanupStackDir(name: string) {
    const { FileSystemService } = await import('../services/FileSystemService');
    try {
        await FileSystemService.getInstance().deleteStack(name);
    } catch {
        // directory may not exist; ignore
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

const SKIP_PLAN_FINGERPRINT = { requirePlanFingerprint: false as const };

describe('GitSourceService.hashContent', () => {
    it('produces stable hashes for identical inputs', () => {
        const svc = GitSourceService.getInstance();
        const a = svc.hashContent(asFiles('services:\n  web: nginx\n'), 'FOO=bar');
        const b = svc.hashContent(asFiles('services:\n  web: nginx\n'), 'FOO=bar');
        expect(a).toBe(b);
        expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it('distinguishes env=null from env=""', () => {
        const svc = GitSourceService.getInstance();
        const nullHash = svc.hashContent(asFiles('x: 1'), null);
        const emptyHash = svc.hashContent(asFiles('x: 1'), '');
        // Both hash-empty-string after null-coalesce, so they should match by design.
        expect(nullHash).toBe(emptyHash);
    });

    it('changes when compose content changes', () => {
        const svc = GitSourceService.getInstance();
        const a = svc.hashContent(asFiles('x: 1'), null);
        const b = svc.hashContent(asFiles('x: 2'), null);
        expect(a).not.toBe(b);
    });

    it('changes when env content changes', () => {
        const svc = GitSourceService.getInstance();
        const a = svc.hashContent(asFiles('x: 1'), 'A=1');
        const b = svc.hashContent(asFiles('x: 1'), 'A=2');
        expect(a).not.toBe(b);
    });

    it('does not confuse compose|env boundary (uses NUL separator)', () => {
        const svc = GitSourceService.getInstance();
        // If the separator were absent, "ab" + "cd" would equal "abc" + "d".
        const a = svc.hashContent(asFiles('ab'), 'cd');
        const b = svc.hashContent(asFiles('abc'), 'd');
        expect(a).not.toBe(b);
    });

    it('keeps the single-file hash stable vs the legacy content+env formula', () => {
        const svc = GitSourceService.getInstance();
        // Legacy single-string hash was sha256(content + '\x00' + (env ?? '')).
        const legacy = crypto
            .createHash('sha256')
            .update('x: 1')
            .update('\x00')
            .update('FOO=bar')
            .digest('hex');
        expect(svc.hashContent(asFiles('x: 1'), 'FOO=bar')).toBe(legacy);
    });

    it('folds ordered contents (not paths) for a multi-file set', () => {
        const svc = GitSourceService.getInstance();
        const base = { path: 'compose.yaml', content: 'a' };
        const override = { path: 'infra/prod.yml', content: 'b' };
        const ab = svc.hashContent([base, override], null);
        const ba = svc.hashContent([override, base], null);
        // Order-sensitive: swapping the two files changes the hash (content order).
        expect(ab).not.toBe(ba);
        // Path-INsensitive by design: the same contents in the same order hash equal
        // regardless of path, so create (repo paths) and pull (materialized paths,
        // primary -> compose.yaml) agree and a clean stack is not flagged as edited.
        const repoPaths = svc.hashContent([{ path: 'infra/base.yml', content: 'a' }, { path: 'infra/prod.yml', content: 'b' }], null);
        const localPaths = svc.hashContent([{ path: 'compose.yaml', content: 'a' }, { path: 'infra/prod.yml', content: 'b' }], null);
        expect(repoPaths).toBe(localPaths);
        // Content-sensitive: changing a file's content changes the hash.
        expect(ab).not.toBe(svc.hashContent([base, { path: 'infra/prod.yml', content: 'B' }], null));
    });
});

describe('GitSourceService.validateCompose (YAML pre-check)', () => {
    const svc = () => GitSourceService.getInstance();

    it('rejects empty content', async () => {
        const r = await svc().validateCompose(asFiles(''), null, null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/empty/i);
    });

    it('rejects a YAML array at the root', async () => {
        const r = await svc().validateCompose(asFiles('- one\n- two\n'), null, null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/mapping/i);
    });

    it('rejects a YAML scalar at the root', async () => {
        const r = await svc().validateCompose(asFiles('42'), null, null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/mapping/i);
    });

    it('rejects malformed YAML syntax', async () => {
        const r = await svc().validateCompose(asFiles('services:\n  web:\n    image: "unterminated\n'), null, null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/YAML parse error/i);
    });

    it('scrubs absolute validation paths from docker compose stderr', async () => {
        const instance = svc();
        const leak =
            'open /app/data/git-managed/1/qa-refusal/generations/candidate-abc/case/config.yml: no such file or directory';
        const runSpy = vi.spyOn(
            instance as unknown as { runDockerCompose: (a: string[], c: string, t: number) => Promise<{ code: number; stdout: string; stderr: string }> },
            'runDockerCompose',
        ).mockResolvedValue({ code: 1, stdout: '', stderr: leak });
        try {
            const r = await instance.validateCompose(asFiles('services:\n  web:\n    image: nginx\n'), null, null);
            expect(r.ok).toBe(false);
            expect(r.error).toBeDefined();
            expect(r.error).not.toContain('/app/data');
            expect(r.error).not.toContain('git-managed/1');
            expect(r.error).not.toContain('candidate-abc');
            expect(r.error).toContain('[managed-path]');
        } finally {
            runSpy.mockRestore();
        }
    });

    it('does not corrupt unrelated paths when scrubbing a DATA_DIR prefix', async () => {
        const instance = svc();
        // Simulate a temp validation dir whose basename is a prefix of another
        // word in the message (data vs database). The scrubber must not turn
        // "database" into "base".
        const runSpy = vi.spyOn(
            instance as unknown as { runDockerCompose: (a: string[], c: string, t: number) => Promise<{ code: number; stdout: string; stderr: string }> },
            'runDockerCompose',
        ).mockImplementation(async (_args, cwd) => ({
            code: 1,
            stdout: '',
            stderr: `open ${cwd}/compose.yaml: failed; see /var/lib/database/notes`,
        }));
        try {
            const r = await instance.validateCompose(asFiles('services:\n  web:\n    image: nginx\n'), null, null);
            expect(r.ok).toBe(false);
            expect(r.error).toContain('/var/lib/database/notes');
            expect(r.error).not.toMatch(/\/var\/lib\/base\/notes/);
        } finally {
            runSpy.mockRestore();
        }
    });
});

describe('GitSourceService.upsert (encryption + reachability)', () => {
    it('stores an encrypted token and exposes has_token without leaking the value', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const created = await svc.upsert({
            stackName: 'enc-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'token',
            token: 'ghp_secret_token_value',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        expect(created.has_token).toBe(true);
        // Public projection should not contain the raw token
        const serialized = JSON.stringify(created);
        expect(serialized).not.toContain('ghp_secret_token_value');

        // DB row holds an encrypted blob distinct from the plaintext
        const row = DatabaseService.getInstance().getGitSource('enc-stack');
        expect(row?.encrypted_token).toBeTruthy();
        expect(row?.encrypted_token).not.toBe('ghp_secret_token_value');
    });

    it('preserves an existing token when update omits token (undefined)', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'keep-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'token',
            token: 'initial-token',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        const originalEnc = DatabaseService.getInstance().getGitSource('keep-stack')?.encrypted_token;

        await svc.upsert({
            stackName: 'keep-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'token',
            // token omitted on purpose
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        const after = DatabaseService.getInstance().getGitSource('keep-stack')?.encrypted_token;
        expect(after).toBe(originalEnc);
    });

    it('clears the token when authType switches to "none"', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'clear-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'token',
            token: 'will-be-cleared',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        await svc.upsert({
            stackName: 'clear-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        const row = DatabaseService.getInstance().getGitSource('clear-stack');
        expect(row?.encrypted_token).toBeNull();
        expect(row?.auth_type).toBe('none');
    });

    it('rejects auto_deploy_on_apply without auto_apply_on_webhook', async () => {
        const svc = GitSourceService.getInstance();
        await expect(svc.upsert({
            stackName: 'bad-matrix',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: true,
        })).rejects.toBeInstanceOf(GitSourceError);

        // Dry-run clone must not have been attempted for the invalid matrix
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('does not persist when dry-run fetch fails', async () => {
        mockGitClone.mockRejectedValueOnce(Object.assign(new Error('404 not found'), { code: 'NotFoundError' }));
        const svc = GitSourceService.getInstance();
        await expect(svc.upsert({
            stackName: 'unreachable',
            repoUrl: 'https://github.com/example/nope.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        })).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });

        expect(DatabaseService.getInstance().getGitSource('unreachable')).toBeUndefined();
    });

    describe('repository identity changes on managed stacks (audit round 8 B-5)', () => {
        async function seedManifest(stackName: string, repoUrl = 'https://github.com/example/repo.git', branch = 'main') {
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const manifest = GitProjectManifestService.getInstance().buildManifest({
                stackName,
                repoUrl,
                branch,
                commitSha: 'abc123',
                projectRoot: null,
                composeFiles: ['compose.yaml'],
                projectName: stackName,
                invocation: ['-f', 'compose.yaml', '-p', stackName],
                inputs: [{
                    sourcePath: 'compose.yaml',
                    materializedPath: 'compose.yaml',
                    role: 'compose-primary',
                    dependencyKind: 'explicit',
                    ownership: 'managed',
                    provenance: 'fetch',
                    sensitivity: 'medium',
                    contentSha256: null,
                    sizeBytes: null,
                    state: 'present',
                    deletionAuthority: 'sencho',
                    note: null,
                }],
                refusals: [],
                buildContexts: [],
                bounds: {
                    maxFiles: 10_000,
                    maxBytes: 512 * 1024 * 1024,
                    maxContextBytes: 256 * 1024 * 1024,
                    maxPathDepth: 64,
                    maxFileBytes: 10 * 1024 * 1024,
                },
                priorManifest: null,
                state: 'active',
            });
            await GitProjectManifestService.getInstance().writeManifest(stackName, manifest);
        }

        const baseInput = {
            stackName: 'id-change',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none' as const,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        };

        async function seedSource(stackName: string) {
            mockSuccessfulClone();
            const svc = GitSourceService.getInstance();
            await svc.upsert({ ...baseInput, stackName });
        }

        it('rejects a repository change when a managed-project manifest exists', async () => {
            await seedSource('id-change-repo');
            await seedManifest('id-change-repo');
            const svc = GitSourceService.getInstance();
            mockGitClone.mockClear();

            await expect(svc.upsert({
                ...baseInput,
                stackName: 'id-change-repo',
                repoUrl: 'https://github.com/example/other.git',
            })).rejects.toMatchObject({
                code: 'GIT_ERROR',
                message: expect.stringMatching(/Detach the Git source first/),
            });

            // Nothing persisted, no dry-run fetch attempted.
            expect(DatabaseService.getInstance().getGitSource('id-change-repo')?.repo_url).toBe('https://github.com/example/repo.git');
            expect(mockGitClone).not.toHaveBeenCalled();
        });

        it('rejects a branch change when a managed-project manifest exists', async () => {
            await seedSource('id-change-branch');
            await seedManifest('id-change-branch');
            const svc = GitSourceService.getInstance();

            await expect(svc.upsert({
                ...baseInput,
                stackName: 'id-change-branch',
                branch: 'develop',
            })).rejects.toMatchObject({ code: 'GIT_ERROR', message: expect.stringMatching(/Detach the Git source first/) });
            expect(DatabaseService.getInstance().getGitSource('id-change-branch')?.branch).toBe('main');
        });

        it('allows a repository change when no manifest exists (legacy stack)', async () => {
            await seedSource('id-change-legacy');
            const svc = GitSourceService.getInstance();

            await svc.upsert({ ...baseInput, stackName: 'id-change-legacy', repoUrl: 'https://github.com/example/other.git' });
            expect(DatabaseService.getInstance().getGitSource('id-change-legacy')?.repo_url).toBe('https://github.com/example/other.git');
        });

        it('allows non-identity config changes on a managed stack', async () => {
            await seedSource('id-change-paths');
            await seedManifest('id-change-paths');
            const svc = GitSourceService.getInstance();
            // The dry-run reachability fetch must find every configured file.
            mockSuccessfulClone({ extraFiles: { 'override.yaml': 'services: {}\n' } });

            await svc.upsert({ ...baseInput, stackName: 'id-change-paths', composePaths: ['compose.yaml', 'override.yaml'] });
            const row = DatabaseService.getInstance().getGitSource('id-change-paths');
            expect(row?.compose_paths).toEqual(['compose.yaml', 'override.yaml']);
        });

        it('refuses a stale-identity manifest with a detach-first instruction', async () => {
            const sha = 'abc1234567890abc1234567890abc1234567890a';
            await seedSource('id-change-apply');
            // Manifest stamped for a different repository than the source row.
            await seedManifest('id-change-apply', 'https://github.com/example/other.git', 'main');
            const svc = GitSourceService.getInstance();

            mockSuccessfulClone({ sha });
            await expect(svc.pull('id-change-apply'))
                .rejects.toMatchObject({ code: 'GIT_ERROR', message: expect.stringMatching(/Detach the Git source/) });
        });
    });
});

describe('GitSourceService error mapping', () => {
    const svc = () => GitSourceService.getInstance();
    const fetchParams = {
        repoUrl: 'https://github.com/example/repo.git',
        branch: 'main',
        composePaths: ['compose.yaml'],
    };

    it('maps 401 with supplied token to AUTH_FAILED', async () => {
        // A 401 only means "your token is wrong" when the caller actually sent one.
        mockGitClone.mockRejectedValueOnce(Object.assign(new Error('HTTP Error: 401 Unauthorized'), {
            code: 'HttpError',
            data: { statusCode: 401 },
        }));
        await expect(svc().fetchFromGit({ ...fetchParams, token: 'ghp_some_token_value' }))
            .rejects.toMatchObject({ code: 'AUTH_FAILED' });
    });

    it('maps 401 without a token to REPO_NOT_FOUND with a private-repo hint', async () => {
        // GitHub returns 404 for genuinely missing public repos but 401/403 can
        // also reach us for private repos that the caller did not authenticate
        // to. Without a supplied token, "check your token" is misleading, so we
        // surface it as "not found or private" and suggest adding a PAT.
        mockGitClone.mockRejectedValueOnce(Object.assign(new Error('HTTP Error: 401 Unauthorized'), {
            code: 'HttpError',
            data: { statusCode: 401 },
        }));
        await expect(svc().fetchFromGit(fetchParams))
            .rejects.toMatchObject({ code: 'REPO_NOT_FOUND', message: expect.stringMatching(/private/i) });
    });

    it('maps 404 HttpError to REPO_NOT_FOUND (not AUTH_FAILED)', async () => {
        // Regression: isomorphic-git throws HttpError for every non-2xx, so a
        // 404 on info/refs was previously misclassified as auth failure.
        mockGitClone.mockRejectedValueOnce(Object.assign(new Error('HTTP Error: 404 Not Found'), {
            code: 'HttpError',
            data: { statusCode: 404 },
        }));
        await expect(svc().fetchFromGit(fetchParams))
            .rejects.toMatchObject({ code: 'REPO_NOT_FOUND', message: expect.stringMatching(/private/i) });
    });

    it('maps 404 with a supplied token to REPO_NOT_FOUND with a token-scope hint', async () => {
        // GitHub returns 404 for both "missing repo" and "token lacks access",
        // so when the caller did supply a token we point them at URL + scopes
        // instead of "add a PAT" (which they already did).
        mockGitClone.mockRejectedValueOnce(Object.assign(new Error('HTTP Error: 404 Not Found'), {
            code: 'HttpError',
            data: { statusCode: 404 },
        }));
        await expect(svc().fetchFromGit({ ...fetchParams, token: 'ghp_some_token_value' }))
            .rejects.toMatchObject({ code: 'REPO_NOT_FOUND', message: expect.stringMatching(/token has read access/i) });
    });

    it('maps 404/not-found errors to REPO_NOT_FOUND', async () => {
        mockGitClone.mockRejectedValueOnce(Object.assign(new Error('Repository not found'), { code: 'NotFoundError' }));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
    });

    it('maps resolve-ref errors to BRANCH_NOT_FOUND', async () => {
        // Message phrased to miss the REPO_NOT_FOUND regex ("could not resolve")
        // so the BRANCH_NOT_FOUND branch is exercised.
        mockGitClone.mockRejectedValueOnce(Object.assign(new Error('unknown ref nonexistent'), { code: 'ResolveRefError' }));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
    });

    it('maps timeout errors to NETWORK_TIMEOUT', async () => {
        mockGitClone.mockRejectedValueOnce(new Error('ETIMEDOUT connecting to host'));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('maps a bare "fetch failed" TypeError with an ENOTFOUND cause to NETWORK_TIMEOUT', async () => {
        // Node's global fetch() reports DNS failure as TypeError('fetch failed')
        // with the real reason on err.cause. Without cause-unwrapping this fell
        // through to a useless GIT_ERROR: "fetch failed".
        mockGitClone.mockRejectedValueOnce(
            new TypeError('fetch failed', {
                cause: Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }),
            }),
        );
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('maps a "fetch failed" TypeError with an ECONNREFUSED cause to NETWORK_TIMEOUT', async () => {
        mockGitClone.mockRejectedValueOnce(
            new TypeError('fetch failed', {
                cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
            }),
        );
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('surfaces the host instead of bare "fetch failed" in transport errors', async () => {
        mockGitClone.mockRejectedValueOnce(
            new TypeError('fetch failed', {
                cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
            }),
        );
        try {
            await svc().fetchFromGit(fetchParams);
            expect.fail('should have thrown');
        } catch (e) {
            const err = e as Error;
            expect(err.message).not.toMatch(/^fetch failed$/i);
            expect(err.message).toContain('github.com');
        }
    });

    it('unwraps a nested fetch cause chain to find the transport code', async () => {
        mockGitClone.mockRejectedValueOnce(
            new TypeError('fetch failed', {
                cause: new TypeError('terminated', {
                    cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
                }),
            }),
        );
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('maps a TLS certificate "fetch failed" cause to a certificate GIT_ERROR', async () => {
        mockGitClone.mockRejectedValueOnce(
            new TypeError('fetch failed', {
                cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
            }),
        );
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({
            code: 'GIT_ERROR',
            message: expect.stringMatching(/certificate/i),
        });
    });

    it('surfaces FILE_NOT_FOUND when the compose path is missing from the clone', async () => {
        mockGitClone.mockImplementation(async () => { /* clone empty repo */ });
        mockGitLog.mockResolvedValue([{ oid: 'deadbeef' }]);
        await expect(svc().fetchFromGit({
            ...fetchParams,
            composePaths: ['missing/compose.yaml'],
        })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('scrubs inline credentials from surfaced error messages', async () => {
        mockGitClone.mockRejectedValueOnce(new Error('Failed: https://user:supersecret@github.com/example/repo.git 500'));
        try {
            await svc().fetchFromGit(fetchParams);
            expect.fail('should have thrown');
        } catch (e) {
            const err = e as Error;
            expect(err.message).not.toContain('supersecret');
            expect(err.message).toContain('***');
        }
    });
});

describe('countingBodyIterator (clone size cap)', () => {
    function chunkStream(...sizes: number[]): AsyncIterableIterator<Uint8Array> {
        async function* gen(): AsyncIterableIterator<Uint8Array> {
            for (const s of sizes) yield new Uint8Array(s);
        }
        return gen();
    }

    it('passes chunks through unchanged while under the cap', async () => {
        const { countingBodyIterator } = await import('../services/GitSourceService');
        const controller = new AbortController();
        const state = { exceeded: false, received: 0 };
        const out: number[] = [];
        for await (const c of countingBodyIterator(chunkStream(10, 20, 30), controller, 1000, state)) {
            out.push(c.byteLength);
        }
        expect(out).toEqual([10, 20, 30]);
        expect(state.exceeded).toBe(false);
        expect(state.received).toBe(60);
        expect(controller.signal.aborted).toBe(false);
    });

    it('aborts the transport and throws once the cumulative size exceeds the cap', async () => {
        const { countingBodyIterator } = await import('../services/GitSourceService');
        const controller = new AbortController();
        const state = { exceeded: false, received: 0 };
        await expect((async () => {
            for await (const _c of countingBodyIterator(chunkStream(60, 60), controller, 100, state)) {
                void _c;
            }
        })()).rejects.toThrow(/maximum allowed size/i);
        expect(state.exceeded).toBe(true);
        expect(controller.signal.aborted).toBe(true);
    });
});

describe('GitSourceService.fetchFromGit (size limits)', () => {
    const svc = () => GitSourceService.getInstance();
    const fetchParams = {
        repoUrl: 'https://github.com/example/repo.git',
        branch: 'main',
        composePaths: ['compose.yaml'],
    };

    it('rejects a compose file larger than the per-file read cap', async () => {
        // The download cap bounds the compressed pack, not a single decompressed
        // file, so readRepoFile guards the in-memory read by file size.
        mockSuccessfulClone();
        const { promises: fsp } = await import('fs');
        const lstatSpy = vi.spyOn(fsp, 'lstat').mockResolvedValue({
            isSymbolicLink: () => false,
            size: 11 * 1024 * 1024,
        } as Awaited<ReturnType<typeof fsp.lstat>>);

        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({
            code: 'GIT_ERROR',
            message: expect.stringMatching(/too large/i),
        });

        lstatSpy.mockRestore();
    });

    it('surfaces a clone-size error when the download exceeds the cap', async () => {
        // Drive the real size-counting transport the service injected into
        // git.clone, with a tiny cap, and confirm fetchFromGit reports it as a
        // clone-size error rather than a generic transport failure.
        process.env.GITSOURCE_MAX_CLONE_BYTES = '8';
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(new Uint8Array(64), { status: 200 }),
        );
        mockGitClone.mockImplementation(async (args: {
            http: { request: (r: { url: string; method: string; headers: Record<string, string> }) => Promise<{ body: AsyncIterableIterator<Uint8Array> }> };
        }) => {
            const resp = await args.http.request({ url: 'https://example.test/info/refs', method: 'GET', headers: {} });
            for await (const chunk of resp.body) { void chunk; }
        });

        try {
            await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({
                code: 'GIT_ERROR',
                message: expect.stringMatching(/exceeds the maximum clone size/i),
            });
        } finally {
            delete process.env.GITSOURCE_MAX_CLONE_BYTES;
            fetchSpy.mockRestore();
        }
    });
});

describe('GitSourceService pending lifecycle', () => {
    it('dismissPending clears pending columns', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'pending-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        const db = DatabaseService.getInstance();
        db.setGitSourcePending('pending-stack', 'sha-xxx', 'services: {}', null);
        expect(db.getGitSource('pending-stack')?.pending_commit_sha).toBe('sha-xxx');

        svc.dismissPending('pending-stack');
        expect(db.getGitSource('pending-stack')?.pending_commit_sha).toBeNull();
    });

    it('clearGitSourceAppliedRevision clears pending plan columns', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'clear-pending-plan',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        const db = DatabaseService.getInstance();
        db.setGitSourcePending('clear-pending-plan', 'sha-pend', 'blob', null, {
            fingerprint: 'fp-clear',
            blocked: true,
            summary: '{"fingerprint":"fp-clear"}',
        });
        const before = db.getGitSource('clear-pending-plan');
        expect(before?.pending_plan_fingerprint).toBe('fp-clear');
        expect(before?.pending_plan_blocked).toBe(true);
        expect(before?.pending_plan_summary).toBeTruthy();
        db.clearGitSourceAppliedRevision('clear-pending-plan');
        const after = db.getGitSource('clear-pending-plan');
        expect(after?.last_applied_commit_sha).toBeNull();
        expect(after?.pending_commit_sha).toBeNull();
        expect(after?.pending_compose_content).toBeNull();
        expect(after?.pending_env_content).toBeNull();
        expect(after?.pending_fetched_at).toBeNull();
        expect(after?.pending_plan_fingerprint).toBeNull();
        expect(after?.pending_plan_blocked).toBeNull();
        expect(after?.pending_plan_summary).toBeNull();
    });
});

describe('GitSourceService.handleWebhookPull debounce', () => {
    it('returns skipped when invoked within the debounce window', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'debounce-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        // Stamp a recent debounce timestamp directly
        DatabaseService.getInstance().touchGitSourceDebounce('debounce-stack');

        const result = await svc.handleWebhookPull('debounce-stack');
        expect(result.status).toBe('skipped');
        expect(result.message).toMatch(/rate limited/i);
    });

    it('returns error when stack has no Git source configured', async () => {
        const svc = GitSourceService.getInstance();
        const result = await svc.handleWebhookPull('does-not-exist');
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/no git source/i);
    });

    it('runs a single clone for a concurrent webhook fan-out', async () => {
        // The original failure: N webhooks for one push each ran a full clone
        // because the debounce gate was read before the per-stack lock. The
        // gate now lives inside the lock, so the first request stamps the
        // window and the rest skip.
        const sha = 'eeee555eeee555eeee555eeee555eeee555eeee5';
        mockSuccessfulClone({ sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        await svc.upsert({
            stackName: 'fanout-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        // upsert performs a dry-run fetch; clear that call so we count only
        // the clones triggered by the webhook fan-out below.
        mockGitClone.mockClear();

        const results = await Promise.all(
            Array.from({ length: 5 }, () => svc.handleWebhookPull('fanout-stack')),
        );

        expect(mockGitClone.mock.calls.length).toBe(1);
        expect(results.filter(r => r.status === 'success')).toHaveLength(1);
        expect(results.filter(r => r.status === 'skipped')).toHaveLength(4);
        validateSpy.mockRestore();
    });

    it('returns error when the pulled compose fails validation', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'webhook-validate-fail',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        // Complete-project pulls validate the staged candidate via the docker
        // runner; stub it to fail so the webhook pull reports the error.
        const runSpy = vi
            .spyOn(svc as unknown as { runDockerCompose: (a: string[], c: string, t: number) => Promise<{ code: number; stdout: string; stderr: string }> }, 'runDockerCompose')
            .mockResolvedValue({ code: 1, stdout: '', stderr: 'bad compose' });

        const result = await svc.handleWebhookPull('webhook-validate-fail');
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/validation failed/i);
        runSpy.mockRestore();
    });

    it('routes webhook auto-apply through the shared stack-operation lock', async () => {
        const sha = 'ffff666ffff666ffff666ffff666ffff666ffff6';
        mockSuccessfulClone({ sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        await svc.upsert({
            stackName: 'webhook-shared-lock',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: true,
            autoDeployOnApply: false,
        });
        mockGitClone.mockClear();

        const { StackOpLockService } = await import('../services/StackOpLockService');
        const runExclusive = vi.spyOn(StackOpLockService.getInstance(), 'runExclusive')
            .mockResolvedValue({
                ran: false,
                existing: { action: 'update', actor: 'user:admin', startedAt: Date.now() },
            } as never);

        const result = await svc.handleWebhookPull('webhook-shared-lock');
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/already in progress/i);
        expect(runExclusive).toHaveBeenCalledWith(
            expect.any(Number),
            'webhook-shared-lock',
            'git_apply',
            'system:webhook',
            expect.any(Function),
        );

        runExclusive.mockRestore();
        validateSpy.mockRestore();
    });
});

describe('GitSourceService per-stack mutex', () => {
    it('serializes concurrent apply calls on the same stack', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance() as unknown as {
            withStackLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
        };

        const order: string[] = [];
        const makeJob = (label: string, delayMs: number) => async () => {
            order.push(`start:${label}`);
            await new Promise(r => setTimeout(r, delayMs));
            order.push(`end:${label}`);
            return label;
        };

        const [a, b, c] = await Promise.all([
            svc.withStackLock('serialized', makeJob('A', 30)),
            svc.withStackLock('serialized', makeJob('B', 10)),
            svc.withStackLock('serialized', makeJob('C', 5)),
        ]);

        expect([a, b, c]).toEqual(['A', 'B', 'C']);
        // Each job must fully complete before the next one starts.
        expect(order).toEqual([
            'start:A', 'end:A',
            'start:B', 'end:B',
            'start:C', 'end:C',
        ]);
    });

    it('does not block work on a different stack', async () => {
        const svc = GitSourceService.getInstance() as unknown as {
            withStackLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
        };

        const order: string[] = [];
        const slow = svc.withStackLock('alpha', async () => {
            order.push('alpha:start');
            await new Promise(r => setTimeout(r, 40));
            order.push('alpha:end');
        });
        const fast = svc.withStackLock('beta', async () => {
            order.push('beta:start');
            order.push('beta:end');
        });

        await Promise.all([slow, fast]);
        // beta should have started and finished before alpha finished
        expect(order.indexOf('beta:end')).toBeLessThan(order.indexOf('alpha:end'));
    });
});

describe('GitSourceService.fetchFromGit (.git metadata guard)', () => {
    const svc = () => GitSourceService.getInstance();

    it('rejects compose paths that target the .git directory', async () => {
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['.git/config'],
        })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('rejects nested .git paths', async () => {
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['subdir/.git/HEAD'],
        })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('rejects env paths that target the .git directory', async () => {
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            envPath: '.git/config',
        })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('allows paths that merely contain the substring "git"', async () => {
        mockSuccessfulClone({ composePath: 'gitops.yaml' });
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['gitops.yaml'],
        })).resolves.toBeDefined();
    });

    it('rejects compose paths that are symbolic links', async () => {
        mockSuccessfulClone();
        const { promises: fsp } = await import('fs');
        const lstatSpy = vi.spyOn(fsp, 'lstat').mockResolvedValue({
            isSymbolicLink: () => true,
        } as Awaited<ReturnType<typeof fsp.lstat>>);

        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
        })).rejects.toMatchObject({
            code: 'FILE_NOT_FOUND',
            message: expect.stringMatching(/symbolic link/i),
        });

        lstatSpy.mockRestore();
    });
});

describe('GitSourceService.fetchFromGit (LFS + submodule detection)', () => {
    const svc = () => GitSourceService.getInstance();
    // Real pointer files start with this exact header (git-lfs spec v1).
    const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc123\nsize 1024\n';

    it('rejects an LFS-pointer compose file with a GIT_ERROR mentioning LFS', async () => {
        mockSuccessfulClone({ compose: LFS_POINTER });
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
        })).rejects.toMatchObject({
            code: 'GIT_ERROR',
            message: expect.stringMatching(/LFS/i),
        });
    });

    it('rejects an LFS-pointer env file with a GIT_ERROR mentioning LFS', async () => {
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            env: LFS_POINTER,
            envPath: '.env',
        });
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            envPath: '.env',
        })).rejects.toMatchObject({
            code: 'GIT_ERROR',
            message: expect.stringMatching(/LFS/i),
        });
    });

    it('returns a submodule warning when .gitmodules is present', async () => {
        mockGitClone.mockImplementation(async (args: { dir: string }) => {
            const { promises: fsp } = await import('fs');
            const p = await import('path');
            await fsp.writeFile(p.join(args.dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf-8');
            await fsp.writeFile(
                p.join(args.dir, '.gitmodules'),
                '[submodule "vendor"]\n\tpath = vendor\n\turl = https://github.com/example/vendor.git\n',
                'utf-8',
            );
        });
        mockGitLog.mockResolvedValue([{ oid: 'abc1234567890abc1234567890abc1234567890a' }]);

        const result = await svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
        });
        expect(result.warnings).toEqual(
            expect.arrayContaining([expect.stringMatching(/submodules/i)]),
        );
    });

    it('returns no warnings when .gitmodules is absent', async () => {
        mockSuccessfulClone();
        const result = await svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
        });
        expect(result.warnings).toEqual([]);
    });
});

describe('GitSourceService.pull', () => {
    it('rejects when no Git source is configured for the stack', async () => {
        const svc = GitSourceService.getInstance();
        await expect(svc.pull('does-not-exist')).rejects.toMatchObject({ code: 'GIT_ERROR' });
    });
});

describe('GitSourceService.createStackFromGit', () => {
    it('creates a stack on disk, writes compose, and seeds last_applied columns', async () => {
        const sha = 'fedcba9876543210fedcba9876543210fedcba98';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            sha,
        });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

        try {
        const result = await svc.createStackFromGit({
            stackName: 'create-happy',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        expect(result.commitSha).toBe(sha);
        expect(result.envWritten).toBe(false);
        expect(result.source.last_applied_commit_sha).toBe(sha);
        expect(result.source.pending_commit_sha).toBeNull();
        expect(result.source.last_plan_outcome).toBe('applied');
        expect(result.source.last_plan_fingerprint).toBeTruthy();

        // The manifest cache is persisted after the row insert (audit S-2):
        // the immediate response and the DB row report the real state, not
        // the default 'absent'.
        expect(result.source.manifest_state).toBe('active');
        const row = DatabaseService.getInstance().getGitSource('create-happy');
        expect(row?.manifest_state).toBe('active');
        expect(row?.manifest_version).toBe(1);
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const manifest = await GitProjectManifestService.getInstance().readManifest('create-happy', 'https://github.com/example/repo.git', 'main');
        if (manifest === null || 'corrupt' in manifest) throw new Error('expected a manifest');
        expect(manifest.resolvedRevision.commitSha).toBe(sha);

        const { FileSystemService } = await import('../services/FileSystemService');
        const onDisk = await FileSystemService.getInstance().getStackContent('create-happy');
        expect(onDisk).toContain('image: nginx');

        await cleanupStackDir('create-happy');
        } finally {
            validateSpy.mockRestore();
        }
    });

    it('builds the change plan before creating the active stack directory', async () => {
        const sha = 'planbefore11112222333344445555666677778888';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            sha,
        });
        const svc = GitSourceService.getInstance();
        const { GitChangePlanService } = await import('../services/GitChangePlanService');
        const { FileSystemService } = await import('../services/FileSystemService');
        let stackExistedDuringPlan = true;
        const origBuild = GitChangePlanService.prototype.build;
        const buildSpy = vi.spyOn(GitChangePlanService.prototype, 'build').mockImplementation(async function (this: InstanceType<typeof GitChangePlanService>, input) {
            stackExistedDuringPlan = fs.existsSync(path.join(process.env.COMPOSE_DIR!, input.stackName));
            return origBuild.call(this, input);
        });
        const origCreate = FileSystemService.prototype.createStack;
        const createSpy = vi.spyOn(FileSystemService.prototype, 'createStack').mockImplementation(async function (this: InstanceType<typeof FileSystemService>, name: string) {
            expect(buildSpy).toHaveBeenCalled();
            return origCreate.call(this, name);
        });
        try {
            await svc.createStackFromGit({
                stackName: 'create-plan-first',
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: false,
                envPath: null,
                authType: 'none',
                token: null,
                autoApplyOnWebhook: false,
                autoDeployOnApply: false,
            });
            expect(stackExistedDuringPlan).toBe(false);
            expect(buildSpy.mock.invocationCallOrder[0]).toBeLessThan(createSpy.mock.invocationCallOrder[0]);
            await cleanupStackDir('create-plan-first');
        } finally {
            buildSpy.mockRestore();
            createSpy.mockRestore();
        }
    });

    it('multi-file create then pull reports no local changes (hash is path-independent)', async () => {
        const sha = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
        mockSuccessfulClone({
            composePath: 'infra/base.yml',
            compose: 'services:\n  web:\n    image: nginx\n',
            extraFiles: { 'infra/prod.yml': 'services:\n  web:\n    restart: always\n' },
            sha,
        });
        const svc = GitSourceService.getInstance();
        await svc.createStackFromGit({
            stackName: 'mf-clean-pull',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['infra/base.yml', 'infra/prod.yml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        // The primary is materialized as compose.yaml, the override at its repo path.
        const row = DatabaseService.getInstance().getGitSource('mf-clean-pull');
        expect(row?.applied_deploy_spec?.files).toEqual(['compose.yaml', 'infra/prod.yml']);

        // Pulling the identical commit must NOT flag local edits, even though the
        // stored hash was computed from repo paths while the disk read uses the
        // materialized paths (primary -> compose.yaml). This was the regression.
        const pull = await svc.pull('mf-clean-pull');
        expect(pull.plan).toBeTruthy();
        expect(pull.plan?.blocked).toBe(false);
        expect(pull.plan?.counts.localModified).toBe(0);
        expect(pull).not.toHaveProperty('hasLocalChanges');
        expect(pull).not.toHaveProperty('incomingCompose');

        await cleanupStackDir('mf-clean-pull');
    });

    it('resolves a nested compose_path and nested env_path into the stack dir', async () => {
        const sha = 'deadbeef1234567890deadbeef1234567890abcd';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            env: 'FOO=nested\n',
            composePath: 'apps/web/compose.yaml',
            envPath: 'apps/web/.env',
            sha,
        });
        const svc = GitSourceService.getInstance();

        const result = await svc.createStackFromGit({
            stackName: 'create-nested',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['apps/web/compose.yaml'],
            contextDir: null,
            syncEnv: true,
            envPath: 'apps/web/.env',
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        expect(result.envWritten).toBe(true);
        expect(result.source.compose_path).toBe('apps/web/compose.yaml');
        expect(result.source.env_path).toBe('apps/web/.env');

        const { FileSystemService } = await import('../services/FileSystemService');
        const env = await FileSystemService.getInstance().getEnvContent('create-nested');
        expect(env).toBe('FOO=nested\n');

        const row = DatabaseService.getInstance().getGitSource('create-nested');
        expect(row?.env_path).toBe('apps/web/.env');

        await cleanupStackDir('create-nested');
    });

    it('writes the env file when sync_env is enabled', async () => {
        const sha = '0101010101010101010101010101010101010101';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            env: 'FOO=bar\n',
            envPath: '.env',
            sha,
        });
        const svc = GitSourceService.getInstance();

        const result = await svc.createStackFromGit({
            stackName: 'create-env',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: true,
            envPath: '.env',
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        expect(result.envWritten).toBe(true);

        const { FileSystemService } = await import('../services/FileSystemService');
        const env = await FileSystemService.getInstance().getEnvContent('create-env');
        expect(env).toBe('FOO=bar\n');

        await cleanupStackDir('create-env');
    });

    it('rejects an invalid apply-matrix without fetching or writing disk', async () => {
        const svc = GitSourceService.getInstance();
        await expect(svc.createStackFromGit({
            stackName: 'create-bad-matrix',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: true,
        })).rejects.toBeInstanceOf(GitSourceError);

        expect(mockGitClone).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().getGitSource('create-bad-matrix')).toBeUndefined();
    });

    it('rejects when compose validation fails and leaves no stack/row behind', async () => {
        mockSuccessfulClone({
            // Non-mapping root is rejected by validateCompose() pre-check
            compose: '- not-a-mapping\n',
        });
        const svc = GitSourceService.getInstance();

        await expect(svc.createStackFromGit({
            stackName: 'create-bad-yaml',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        })).rejects.toMatchObject({ code: 'GIT_ERROR' });

        expect(DatabaseService.getInstance().getGitSource('create-bad-yaml')).toBeUndefined();
        const { FileSystemService } = await import('../services/FileSystemService');
        const stacks = await FileSystemService.getInstance().getStacks();
        expect(stacks).not.toContain('create-bad-yaml');
    });

    it('rolls back the stack dir when a post-create step fails', async () => {
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
        });
        const { FileSystemService } = await import('../services/FileSystemService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent')
            .mockRejectedValueOnce(new Error('simulated disk failure'));

        const svc = GitSourceService.getInstance();
        await expect(svc.createStackFromGit({
            stackName: 'create-rollback',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        })).rejects.toThrow(/simulated disk failure/);

        expect(DatabaseService.getInstance().getGitSource('create-rollback')).toBeUndefined();
        const stacks = await FileSystemService.getInstance().getStacks();
        expect(stacks).not.toContain('create-rollback');

        saveSpy.mockRestore();
    });
});

describe('GitSourceService.apply', () => {
    const skipFingerprint = SKIP_PLAN_FINGERPRINT;

    async function seedPending(stackName: string, composeContent: string, commitSha: string) {
        mockSuccessfulClone({ compose: composeContent, sha: commitSha });
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName,
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        await svc.pull(stackName);
        return svc;
    }

    it('throws when pending has been cleared between pull and apply', async () => {
        const svc = await seedPending('apply-cleared', 'services:\n  x:\n    image: alpine\n', 'aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1');
        DatabaseService.getInstance().clearGitSourcePending('apply-cleared');
        await expect(svc.apply('apply-cleared', 'aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1'))
            .rejects.toMatchObject({ code: 'GIT_ERROR', message: expect.stringMatching(/no pending pull/i) });
    });

    it('throws when the commit sha does not match the pending sha', async () => {
        const svc = await seedPending('apply-mismatch', 'services:\n  x:\n    image: alpine\n', 'bbbb222bbbb222bbbb222bbbb222bbbb222bbbb2');
        await expect(svc.apply('apply-mismatch', 'deadbeef1234567890deadbeef1234567890dead'))
            .rejects.toMatchObject({ code: 'GIT_ERROR', message: expect.stringMatching(/pending commit has changed/i) });
    });

    it('begins a deploy health gate after a successful apply-and-deploy', async () => {
        const sha = 'eeee555eeee555eeee555eeee555eeee555eeee5';
        const svc = await seedPending('apply-deploy-gate', 'services:\n  x:\n    image: alpine\n', sha);
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        const { HealthGateService } = await import('../services/HealthGateService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
        const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack').mockReturnValue('gate-git');
        const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;

        try {
            const result = await svc.apply('apply-deploy-gate', sha, { deploy: true, ...skipFingerprint });
            expect(result.deployed).toBe(true);
            expect(deploySpy).toHaveBeenCalledWith('apply-deploy-gate', undefined, undefined, {
                source: 'git_apply',
                actor: 'system:git-source',
            });
            expect(beginSpy).toHaveBeenCalledWith(nodeId, 'apply-deploy-gate', 'deploy', 'system:git-source');
            expect(mockRecoveryLinkGateOrRetain).toHaveBeenCalledWith('rec-test-1', 'gate-git');
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
            deploySpy.mockRestore();
            beginSpy.mockRestore();
        }
    });

    it('returns deployError when the deploy step fails after writing to disk', async () => {
        const sha = 'cccc333cccc333cccc333cccc333cccc333cccc3';
        const svc = await seedPending('apply-deploy-fail', 'services:\n  x:\n    image: alpine\n', sha);

        // Stub validation (docker compose config is expensive and not needed here)
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        // Stub file write (FileSystemService expects a real stack dir)
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        // Force deploy failure so the return shape is deterministic (no Docker / mock leakage).
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockRejectedValue(
            new Error('compose up failed: docker unavailable'),
        );

        try {
            // Assert the return SHAPE: apply must not throw, deployError must
            // carry the failure detail so the UI can surface "applied but not deployed".
            const result = await svc.apply('apply-deploy-fail', sha, { deploy: true, ...skipFingerprint });
            expect(result.applied).toBe(true);
            expect(result.deployed).toBe(false);
            expect(result.deployError).toBeTruthy();

            // Disk write happened; DB was marked applied even though deploy failed.
            expect(saveSpy).toHaveBeenCalled();
            const row = DatabaseService.getInstance().getGitSource('apply-deploy-fail');
            expect(row?.last_applied_commit_sha).toBe(sha);
            expect(row?.pending_commit_sha).toBeNull();
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
            deploySpy.mockRestore();
        }
    });

    it('refuses the first complete-project apply when an unowned local file collides (audit round 9 B-1)', async () => {
        const sha = '9999aaaa9999aaaa9999aaaa9999aaaa9999aaaa';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n    configs: [app]\nconfigs:\n  app:\n    file: configs/app.json\n',
            extraFiles: { 'configs/app.json': '{"repo": true}\n' },
            sha,
        });
        const svc = GitSourceService.getInstance();
        const stackName = 'pre-manifest-collision';
        await svc.upsert({
            stackName,
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        // Legacy state: only compose.yaml was ever applied (no manifest).
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, { files: ['compose.yaml'], contextDir: null });
        const { FileSystemService } = await import('../services/FileSystemService');
        const fsSvc = FileSystemService.getInstance();
        await fsSvc.createStack(stackName);
        await fsSvc.saveStackContent(stackName, 'services:\n  web:\n    image: nginx:old\n');
        // A local file Sencho never owned, colliding with the incoming revision.
        await fsSvc.writeStackFile(stackName, 'configs/app.json', 'local user data\n');

        await svc.pull(stackName);
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        try {
            await expect(svc.apply(stackName, sha, skipFingerprint)).rejects.toMatchObject({
                code: 'PLAN_BLOCKED',
            });
            // The local file is preserved byte-for-byte.
            const onDisk = await fsSvc.readStackFile(stackName, 'configs/app.json');
            expect(onDisk.content).toBe('local user data\n');
            expect(DatabaseService.getInstance().getGitSource(stackName)?.pending_commit_sha).toBe(sha);
        } finally {
            validateSpy.mockRestore();
        }
        await cleanupStackDir(stackName);
    });

    it('returns deployError and skips compose deploy when policy blocks apply deploy', async () => {
        const sha = 'dddd444dddd444dddd444dddd444dddd444dddd4';
        const svc = await seedPending('apply-policy-block', 'services:\n  x:\n    image: nginx:bad\n', sha);
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        const TrivyService = (await import('../services/TrivyService')).default;
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        const listImagesSpy = vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:bad']);
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
        const trivy = TrivyService.getInstance();
        const trivyAvailableSpy = vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(true);
        const scanSpy = vi.spyOn(trivy, 'scanImagePreflight').mockResolvedValue({
            id: 77,
            node_id: 1,
            image_ref: 'nginx:bad',
            image_digest: null,
            scanned_at: Date.now(),
            total_vulnerabilities: 1,
            critical_count: 1,
            high_count: 0,
            medium_count: 0,
            low_count: 0,
            unknown_count: 0,
            fixable_count: 0,
            secret_count: 0,
            misconfig_count: 0,
            scanners_used: 'vuln',
            highest_severity: 'CRITICAL',
            os_info: null,
            trivy_version: '0.50.0',
            scan_duration_ms: null,
            triggered_by: 'deploy-preflight',
            status: 'completed',
            error: null,
            stack_context: 'apply-policy-block',
            policy_evaluation: null,
        });

        DatabaseService.getInstance().createScanPolicy({
            name: 'block-high',
            node_id: null,
            node_identity: '',
            stack_pattern: 'apply-policy-block',
            max_severity: 'HIGH',
            block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });

        try {
            const result = await svc.apply('apply-policy-block', sha, { deploy: true, ...skipFingerprint });

            expect(result.applied).toBe(true);
            expect(result.deployed).toBe(false);
            expect(result.deployError).toContain('Policy "block-high" blocked deploy');
            expect(scanSpy).toHaveBeenCalled();
            expect(deploySpy).not.toHaveBeenCalled();
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
            listImagesSpy.mockRestore();
            deploySpy.mockRestore();
            trivyAvailableSpy.mockRestore();
            scanSpy.mockRestore();
        }
    });
});

describe('GitSourceService DB normalization (compose_paths back-compat)', () => {
    it('reads back [compose_path] when a row stores compose_paths as null (legacy)', async () => {
        mockSuccessfulClone({ composePath: 'stacks/web/compose.yaml' });
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'legacy-null',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['stacks/web/compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        // Simulate a row written before the multi-file column existed.
        const db = DatabaseService.getInstance();
        db.getDb().prepare('UPDATE stack_git_sources SET compose_paths = NULL WHERE stack_name = ?').run('legacy-null');

        const row = db.getGitSource('legacy-null');
        expect(row?.compose_paths).toEqual(['stacks/web/compose.yaml']);
        expect(row?.compose_path).toBe('stacks/web/compose.yaml');
    });

    it('reads back [compose_path] when compose_paths holds an empty JSON array', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'legacy-empty',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        const db = DatabaseService.getInstance();
        db.getDb().prepare(`UPDATE stack_git_sources SET compose_paths = '[]' WHERE stack_name = ?`).run('legacy-empty');

        expect(db.getGitSource('legacy-empty')?.compose_paths).toEqual(['compose.yaml']);
    });

    it('backfills compose_paths to json_array(compose_path) for a NULL-column row', async () => {
        // The migration runs json_array(compose_path) for any row whose
        // compose_paths is NULL. Insert a NULL-column row, run the backfill SQL,
        // and confirm the stored JSON is a one-element array of the legacy path.
        mockSuccessfulClone({ composePath: 'deploy/compose.yaml' });
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'backfill-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['deploy/compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        const db = DatabaseService.getInstance();
        db.getDb().prepare('UPDATE stack_git_sources SET compose_paths = NULL WHERE stack_name = ?').run('backfill-stack');

        db.getDb().prepare(
            `UPDATE stack_git_sources SET compose_paths = json_array(compose_path) WHERE compose_paths IS NULL`,
        ).run();

        const stored = db.getDb()
            .prepare('SELECT compose_paths FROM stack_git_sources WHERE stack_name = ?')
            .get('backfill-stack') as { compose_paths: string };
        expect(JSON.parse(stored.compose_paths)).toEqual(['deploy/compose.yaml']);
    });
});

describe('GitSourceService multi-file create + apply flow', () => {
    it('materializes both files and persists a non-null applied_deploy_spec for a two-file create', async () => {
        const sha = '1111aaa1111aaa1111aaa1111aaa1111aaa1111a';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            composePath: 'infra/base.yml',
            extraFiles: { 'infra/prod.yml': 'services:\n  web:\n    environment:\n      - X=1\n' },
            sha,
        });
        const svc = GitSourceService.getInstance();
        // Isolate materialize behavior from docker availability.
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

        const result = await svc.createStackFromGit({
            stackName: 'multi-create',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['infra/base.yml', 'infra/prod.yml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        expect(result.commitSha).toBe(sha);
        const row = DatabaseService.getInstance().getGitSource('multi-create');
        expect(row?.compose_paths).toEqual(['infra/base.yml', 'infra/prod.yml']);
        expect(row?.applied_deploy_spec).not.toBeNull();
        expect(row?.applied_deploy_spec?.files).toEqual(['compose.yaml', 'infra/prod.yml']);

        const { FileSystemService } = await import('../services/FileSystemService');
        const fsSvc = FileSystemService.getInstance();
        // Primary lands at the root compose.yaml; the additional file at its repo path.
        expect(await fsSvc.getStackContent('multi-create')).toContain('image: nginx');
        const prod = await fsSvc.readStackFile('multi-create', 'infra/prod.yml');
        expect(prod.content).toContain('X=1');

        validateSpy.mockRestore();
        await cleanupStackDir('multi-create');
    });

    it('leaves applied_deploy_spec null for a plain single-file create', async () => {
        const sha = '2222bbb2222bbb2222bbb2222bbb2222bbb2222b';
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx\n', sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

        await svc.createStackFromGit({
            stackName: 'single-create',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        const row = DatabaseService.getInstance().getGitSource('single-create');
        expect(row?.compose_paths).toEqual(['compose.yaml']);
        expect(row?.applied_deploy_spec).toBeNull();

        validateSpy.mockRestore();
        await cleanupStackDir('single-create');
    });

    it('sets applied_deploy_spec for a single-file create that has a context_dir', async () => {
        const sha = '3333ccc3333ccc3333ccc3333ccc3333ccc3333c';
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx\n', sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

        await svc.createStackFromGit({
            stackName: 'ctx-create',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: 'app',
            syncEnv: false,
            envPath: null,
            authType: 'none',
            token: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        const row = DatabaseService.getInstance().getGitSource('ctx-create');
        expect(row?.applied_deploy_spec).not.toBeNull();
        expect(row?.applied_deploy_spec?.files).toEqual(['compose.yaml']);
        expect(row?.applied_deploy_spec?.contextDir).toBe('app');

        validateSpy.mockRestore();
        await cleanupStackDir('ctx-create');
    });

    it('pulls a multi-file v2 pending blob and applies both files to disk', async () => {
        const sha = '4444ddd4444ddd4444ddd4444ddd4444ddd4444d';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            composePath: 'infra/base.yml',
            extraFiles: { 'infra/prod.yml': 'services:\n  web:\n    environment:\n      - Y=2\n' },
            sha,
        });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const fsSvc = FileSystemService.getInstance();
        await fsSvc.createStack('multi-pull');

        await svc.upsert({
            stackName: 'multi-pull',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['infra/base.yml', 'infra/prod.yml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        const pull = await svc.pull('multi-pull');
        // Pending compose blob is encrypted; assert it round-trips by applying it.
        const row = DatabaseService.getInstance().getGitSource('multi-pull');
        expect(row?.pending_commit_sha).toBe(sha);

        const applied = await svc.apply('multi-pull', pull.commitSha, SKIP_PLAN_FINGERPRINT);
        expect(applied.applied).toBe(true);

        const after = DatabaseService.getInstance().getGitSource('multi-pull');
        expect(after?.applied_deploy_spec?.files).toEqual(['compose.yaml', 'infra/prod.yml']);
        expect(await fsSvc.getStackContent('multi-pull')).toContain('image: nginx');
        expect((await fsSvc.readStackFile('multi-pull', 'infra/prod.yml')).content).toContain('Y=2');

        validateSpy.mockRestore();
        await cleanupStackDir('multi-pull');
    });

    it('keeps pending across an upsert with the SAME config and clears it when compose_paths change', async () => {
        const sha = '5555eee5555eee5555eee5555eee5555eee5555e';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            composePath: 'infra/base.yml',
            extraFiles: {
                'infra/prod.yml': 'services:\n  web:\n    environment:\n      - Z=3\n',
                // The changed-config upsert re-fetches this path; the dry-run reads
                // every configured file, so it must exist in the clone.
                'infra/staging.yml': 'services:\n  web:\n    environment:\n      - Z=4\n',
            },
            sha,
        });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        await FileSystemService.getInstance().createStack('pending-config');

        const baseInput = {
            stackName: 'pending-config',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['infra/base.yml', 'infra/prod.yml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none' as const,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        };
        await svc.upsert(baseInput);
        await svc.pull('pending-config');
        const db = DatabaseService.getInstance();
        expect(db.getGitSource('pending-config')?.pending_commit_sha).toBe(sha);

        // Same config -> pending must survive.
        await svc.upsert(baseInput);
        expect(db.getGitSource('pending-config')?.pending_commit_sha).toBe(sha);

        // Changed compose_paths -> the captured pending blob no longer matches, clear it.
        await svc.upsert({ ...baseInput, composePaths: ['infra/base.yml', 'infra/staging.yml'] });
        expect(db.getGitSource('pending-config')?.pending_commit_sha).toBeNull();

        validateSpy.mockRestore();
        await cleanupStackDir('pending-config');
    });
});

describe('GitSourceService pending blob decode branches', () => {
    function svc(): unknown { return GitSourceService.getInstance(); }
    type DecodeApi = {
        crypto: { encrypt(s: string): string; decrypt(s: string): string };
        encodePendingCompose(files: { path: string; content: string }[], ctx: string | null, cand: string | null, inv: unknown): string;
        decodePendingCompose(s: string): { files: { path: string; content: string }[]; contextDir: string | null; candidateRelPath: string | null; inventory: unknown };
    };

    it('round-trips the v3 blob with candidate path and inventory', () => {
        const s = svc() as unknown as DecodeApi;
        const encoded = s.crypto.encrypt(JSON.stringify({
            v: 3,
            files: [{ path: 'compose.yaml', content: 'x' }],
            contextDir: null,
            candidateRelPath: 'generations/candidate-abc',
            inventory: { inputs: [], refusals: [], buildContexts: [] },
        }));
        const decoded = s.decodePendingCompose(encoded);
        expect(decoded.candidateRelPath).toBe('generations/candidate-abc');
        expect(decoded.files[0].content).toBe('x');
        expect(decoded.inventory).toEqual({ inputs: [], refusals: [], buildContexts: [] });
    });

    it('decodes a v2 blob without a candidate', () => {
        const s = svc() as unknown as DecodeApi;
        const encoded = s.crypto.encrypt(JSON.stringify({ v: 2, files: [{ path: 'compose.yaml', content: 'y' }], contextDir: null }));
        const decoded = s.decodePendingCompose(encoded);
        expect(decoded.candidateRelPath).toBeNull();
        expect(decoded.files[0].content).toBe('y');
    });

    it('falls back to legacy plaintext for unknown shapes', () => {
        const s = svc() as unknown as DecodeApi;
        const decoded = s.decodePendingCompose(s.crypto.encrypt('legacy content'));
        expect(decoded.files).toEqual([{ path: 'compose.yaml', content: 'legacy content' }]);
        expect(decoded.candidateRelPath).toBeNull();
    });

    it('rejects a corrupt v3 blob as corrupt state instead of falling back to legacy', () => {
        const s = svc() as unknown as DecodeApi;
        const encoded = s.crypto.encrypt('{"v":3 not json');
        expect(() => s.decodePendingCompose(encoded)).toThrow(/cannot be reviewed/);
    });
});

describe('GitSourceService managed-area lifecycle', () => {
    it('removes the managed area when createStackFromGit fails after staging', async () => {
        const sha = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
        mockSuccessfulClone({ sha });
        const svc = GitSourceService.getInstance();
        const runSpy = vi
            .spyOn(svc as unknown as { runDockerCompose: (a: string[], c: string, t: number) => Promise<{ code: number; stdout: string; stderr: string }> }, 'runDockerCompose')
            .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
        const { FileSystemService } = await import('../services/FileSystemService');
        const createSpy = vi
            .spyOn(FileSystemService.prototype, 'createStack')
            .mockRejectedValue(new Error('simulated create failure'));
        try {
            await expect(
                svc.createStackFromGit({
                    stackName: 'rollback-area',
                    repoUrl: 'https://github.com/example/repo.git',
                    branch: 'main',
                    composePaths: ['compose.yaml'],
                    contextDir: null,
                    syncEnv: false,
                    envPath: null,
                    authType: 'none',
                    token: null,
                    autoApplyOnWebhook: false,
                    autoDeployOnApply: false,
                }),
            ).rejects.toThrow(/simulated create failure/);
        } finally {
            runSpy.mockRestore();
            createSpy.mockRestore();
        }
        // The staged candidate lived in the managed area; the rollback must reap it.
        const stagedCandidate = path.join(process.env.DATA_DIR!, 'git-managed', '1', 'rollback-area', 'generations', 'candidate-f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1');
        expect(fs.existsSync(stagedCandidate)).toBe(false);
        expect(DatabaseService.getInstance().getGitSource('rollback-area')).toBeUndefined();
    });

    it('sweeps managed areas whose stack no longer exists', async () => {
        mockSuccessfulClone();
        DatabaseService.getInstance().upsertGitSource({
            stack_name: 'ghost-stack',
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
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const manifestSvc = GitProjectManifestService.getInstance();
        const manifest = manifestSvc.buildManifest({
            stackName: 'ghost-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: 'ghost-stack',
            invocation: ['-f', 'compose.yaml', '-p', 'ghost-stack'],
            inputs: [],
            refusals: [],
            buildContexts: [],
            bounds: { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024, maxContextBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxFileBytes: 10 * 1024 * 1024 },
            priorManifest: null,
            state: 'active',
        });
        await manifestSvc.writeManifest('ghost-stack', manifest);
        await manifestSvc.prepareDetachRecovery(
            'ghost-stack',
            'https://github.com/example/repo.git',
            'main',
            [{ path: 'compose.yaml', existed: false, content: null }],
        );
        expect(await manifestSvc.stageManagedAreaForDetach('ghost-stack')).toBe(true);
        await GitSourceService.getInstance().sweepOrphans();
        expect(await manifestSvc.readManifest('ghost-stack', 'https://github.com/example/repo.git', 'main')).toBeNull();
        expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'git-managed', '1', '.detach-ghost-stack'))).toBe(false);
    });

    const SWEEP_BOUNDS = { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024, maxContextBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxFileBytes: 10 * 1024 * 1024 };

    function insertGitSourceRow(stackName: string): void {
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

    /** Live managed-stack fixture: on-disk stack, row, and written manifest. */
    async function seedManagedStack(stackName: string): Promise<void> {
        const { FileSystemService } = await import('../services/FileSystemService');
        await FileSystemService.getInstance().createStack(stackName);
        await FileSystemService.getInstance().saveStackContent(stackName, 'services: {}\n');
        insertGitSourceRow(stackName);
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const manifestSvc = GitProjectManifestService.getInstance();
        await manifestSvc.writeManifest(stackName, manifestSvc.buildManifest({
            stackName,
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: stackName,
            invocation: ['-f', 'compose.yaml', '-p', stackName],
            inputs: [],
            refusals: [],
            buildContexts: [],
            bounds: SWEEP_BOUNDS,
            priorManifest: null,
            state: 'active',
        }));
    }

    it('does not delete managed areas when the stack listing fails', async () => {
        const { FileSystemService } = await import('../services/FileSystemService');
        const svc = GitSourceService.getInstance();
        const stackName = 'live-sweep-listing-fail';
        await seedManagedStack(stackName);
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const manifestSvc = GitProjectManifestService.getInstance();
        // A retained recovery generation, as the sweep would otherwise reap.
        const genDir = path.join(process.env.DATA_DIR!, 'git-managed', '1', stackName, 'generations', 'applied-abc-1');
        fs.mkdirSync(genDir, { recursive: true });

        const strictSpy = vi.spyOn(FileSystemService.prototype, 'getStacksStrict').mockRejectedValue(new Error('EIO: readdir failed'));
        // Also mock the SOFT listing: the pre-fix sweep called getStacks(),
        // which swallows the failure into an empty list and deletes the area.
        // Post-fix the sweep uses the strict variant and is unaffected, so the
        // test goes red on the pre-fix call path and green here.
        const softSpy = vi.spyOn(FileSystemService.prototype, 'getStacks').mockRejectedValue(new Error('EIO: readdir failed'));
        try {
            await svc.sweepOrphans();
        } finally {
            strictSpy.mockRestore();
            softSpy.mockRestore();
        }
        // The manifest and every retained generation survive the failed listing.
        expect(await manifestSvc.readManifest(stackName, 'https://github.com/example/repo.git', 'main')).not.toBeNull();
        expect(fs.existsSync(genDir)).toBe(true);
        await cleanupStackDir(stackName);
    });

    it('skips a live stack\'s managed area when the listing omits it', async () => {
        const { FileSystemService } = await import('../services/FileSystemService');
        const svc = GitSourceService.getInstance();
        const stackName = 'live-sweep-empty-listing';
        await seedManagedStack(stackName);
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const manifestSvc = GitProjectManifestService.getInstance();

        const strictSpy = vi.spyOn(FileSystemService.prototype, 'getStacksStrict').mockResolvedValue([]);
        const softSpy = vi.spyOn(FileSystemService.prototype, 'getStacks').mockResolvedValue([]);
        try {
            await svc.sweepOrphans();
        } finally {
            strictSpy.mockRestore();
            softSpy.mockRestore();
        }
        expect(await manifestSvc.readManifest(stackName, 'https://github.com/example/repo.git', 'main')).not.toBeNull();
        await cleanupStackDir(stackName);
    });

    it('reaps a vanished stack\'s managed area while live stacks survive in the same sweep', async () => {
        const svc = GitSourceService.getInstance();
        const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
        const manifestSvc = GitProjectManifestService.getInstance();
        const liveA = 'live-sweep-a';
        const liveB = 'live-sweep-b';
        const ghost = 'vanished-sweep';
        for (const name of [liveA, liveB]) {
            await seedManagedStack(name);
        }
        // A row whose stack directory is genuinely gone: row + manifest only.
        insertGitSourceRow(ghost);
        await manifestSvc.writeManifest(ghost, manifestSvc.buildManifest({
            stackName: ghost,
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: ghost,
            invocation: ['-f', 'compose.yaml', '-p', ghost],
            inputs: [],
            refusals: [],
            buildContexts: [],
            bounds: SWEEP_BOUNDS,
            priorManifest: null,
            state: 'active',
        }));

        await svc.sweepOrphans();

        // Both live areas and manifests survive; the vanished stack's area is reaped.
        expect(await manifestSvc.readManifest(liveA, 'https://github.com/example/repo.git', 'main')).not.toBeNull();
        expect(await manifestSvc.readManifest(liveB, 'https://github.com/example/repo.git', 'main')).not.toBeNull();
        expect(await manifestSvc.readManifest(ghost, 'https://github.com/example/repo.git', 'main')).toBeNull();
        for (const name of [liveA, liveB]) {
            await cleanupStackDir(name);
        }
    });

    it('reports migration_required when the manifest file is gone but the cache claims an applied state', async () => {
        const svc = GitSourceService.getInstance();
        DatabaseService.getInstance().upsertGitSource({
            stack_name: 'stale-cache-summary',
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
        DatabaseService.getInstance().setGitSourceManifestState('stale-cache-summary', 3, 'active', 'generations/applied-abc-3');
        const summary = await svc.getManifestSummary('stale-cache-summary');
        expect(summary?.state).toBe('migration_required');
        expect(summary?.manifestVersion).toBe(0);
        expect(summary?.managedCount).toBe(0);
        // Heal-on-read keeps the flat cache aligned with the summary.
        expect(DatabaseService.getInstance().getGitSource('stale-cache-summary')?.manifest_state).toBe('migration_required');
        expect(DatabaseService.getInstance().getGitSource('stale-cache-summary')?.manifest_version).toBeNull();

        // A row that never had a manifest still reports absent.
        DatabaseService.getInstance().upsertGitSource({
            stack_name: 'never-manifested',
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
        expect((await svc.getManifestSummary('never-manifested'))?.state).toBe('absent');
    });
});

describe('GitSourceService legacy pending apply (migration path)', () => {
    it('refuses a v2 pending blob and returns LEGACY_PENDING', async () => {
        const sha = '9999aaa9999aaa9999aaa9999aaa9999aaa9999a';
        const svc = GitSourceService.getInstance();
        const db = DatabaseService.getInstance();
        const { FileSystemService } = await import('../services/FileSystemService');
        const fsSvc = FileSystemService.getInstance();
        await fsSvc.createStack('legacy-apply');
        db.upsertGitSource({
            stack_name: 'legacy-apply',
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
            pending_commit_sha: sha,
            pending_compose_content: null,
            pending_env_content: null,
            pending_fetched_at: null,
            last_debounce_at: null,
        });
        // Seed the v2 blob directly, as a pre-upgrade row would carry it.
        const svcPriv = svc as unknown as { crypto: { encrypt(s: string): string } };
        db.setGitSourcePending('legacy-apply', sha, svcPriv.crypto.encrypt(JSON.stringify({ v: 2, files: [{ path: 'compose.yaml', content: 'services:\n  web:\n    image: nginx\n' }], contextDir: null })), null);
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

        try {
            await expect(svc.apply('legacy-apply', sha, { deploy: false })).rejects.toMatchObject({
                code: 'LEGACY_PENDING',
            });
            const disk = await fsSvc.getStackContent('legacy-apply').catch(() => '');
            expect(disk).toContain('nginx:latest');
            expect(disk).not.toContain('services:\n  web:');
        } finally {
            validateSpy.mockRestore();
            await cleanupStackDir('legacy-apply');
        }
    });

    it('rejects materialize when deleting a stale override fails', async () => {
        const svc = GitSourceService.getInstance();
        const { FileSystemService } = await import('../services/FileSystemService');
        const fsSvc = FileSystemService.getInstance();
        const stackName = 'legacy-stale-del';
        await fsSvc.createStack(stackName);
        await fsSvc.saveStackContent(stackName, 'services:\n  web:\n    image: nginx\n');
        await fsSvc.writeStackFile(stackName, 'compose.override.yaml', 'services:\n  web:\n    environment: [X=1]\n');

        const deleteSpy = vi.spyOn(FileSystemService.prototype, 'deleteStackPath')
            .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

        const materialize = (svc as unknown as {
            materialize: (
                stackName: string,
                files: Array<{ path: string; content: string }>,
                contextDir: string | null,
                syncEnv: boolean,
                envContent: string | null,
                prevSpec: { files: string[]; contextDir: string | null } | null,
            ) => Promise<unknown>;
        }).materialize.bind(svc);

        try {
            await expect(
                materialize(
                    stackName,
                    [{ path: 'compose.yaml', content: 'services:\n  web:\n    image: alpine\n' }],
                    null,
                    false,
                    null,
                    { files: ['compose.yaml', 'compose.override.yaml'], contextDir: null },
                ),
            ).rejects.toThrow(/permission denied/);
            expect(deleteSpy).toHaveBeenCalledWith(stackName, 'compose.override.yaml');
            // Stale override must still be present; apply must not report success over a hybrid.
            const override = await fsSvc.readStackFile(stackName, 'compose.override.yaml');
            expect(override.content).toContain('X=1');
        } finally {
            deleteSpy.mockRestore();
            await cleanupStackDir(stackName);
        }
    });
});

describe('GitSourceService sync-env stacks with a repo .env (audit C-2)', () => {
    it('applies twice without a divergence refusal when the repo carries a root .env', async () => {
        const sha = 'abcd1111abcd1111abcd1111abcd1111abcd1111';
        const svc = GitSourceService.getInstance();
        const db = DatabaseService.getInstance();
        const runSpy = vi
            .spyOn(svc as unknown as { runDockerCompose: (a: string[], c: string, t: number) => Promise<{ code: number; stdout: string; stderr: string }> }, 'runDockerCompose')
            .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
        const { FileSystemService } = await import('../services/FileSystemService');
        const fsSvc = FileSystemService.getInstance();
        await fsSvc.createStack('sync-env-double');
        // Repo carries a root .env; sync_env is on and the sync env path is the same file.
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            env: 'SYNCED=1\n',
            envPath: '.env',
            extraFiles: { '.env': 'REPO=1\n' },
            sha,
        });
        try {
            await svc.upsert({
                stackName: 'sync-env-double',
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: true,
                envPath: '.env',
                authType: 'none',
                autoApplyOnWebhook: false,
                autoDeployOnApply: false,
            });
            const pull1 = await svc.pull('sync-env-double');
            const apply1 = await svc.apply('sync-env-double', pull1.commitSha, { deploy: false, ...SKIP_PLAN_FINGERPRINT });
            expect(apply1.applied).toBe(true);
            // The manifest has exactly one .env entry.
            const manifest = await svc.getManifest('sync-env-double');
            const envEntries = manifest?.inputs.filter((i) => i.materializedPath === '.env') ?? [];
            expect(envEntries).toHaveLength(1);
            expect(envEntries[0].dependencyKind).toBe('sync-env');

            // Second cycle must not raise the divergence refusal.
            const pull2 = await svc.pull('sync-env-double');
            const apply2 = await svc.apply('sync-env-double', pull2.commitSha, { deploy: false, ...SKIP_PLAN_FINGERPRINT });
            expect(apply2.applied).toBe(true);
            void db;
        } finally {
            runSpy.mockRestore();
            await cleanupStackDir('sync-env-double');
        }
    });
});

describe('GitSourceService classified plan fingerprint', () => {
    it('refuses public apply without a fingerprint and binds the pulled fingerprint', async () => {
        const sha = 'ffff0000ffff0000ffff0000ffff0000ffff0000';
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx\n', sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        await FileSystemService.getInstance().createStack('fp-bind');
        await svc.upsert({
            stackName: 'fp-bind',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        try {
            const pull = await svc.pull('fp-bind', { actor: 'alice' });
            expect(pull.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
            expect(pull.plan?.blocked).toBe(false);

            const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;
            const acts = DatabaseService.getInstance().getStackActivity(nodeId, 'fp-bind', { limit: 20 });
            expect(acts.some((a: { category?: string; actor_username?: string | null }) =>
                a.category === 'git_pull_ready' && a.actor_username === 'alice',
            )).toBe(true);

            await expect(svc.apply('fp-bind', sha)).rejects.toMatchObject({ code: 'PLAN_FINGERPRINT_REQUIRED' });
            await expect(svc.apply('fp-bind', sha, { planFingerprint: 'deadbeef' })).rejects.toMatchObject({
                code: 'STALE_PLAN',
            });

            const applied = await svc.apply('fp-bind', sha, { planFingerprint: pull.planFingerprint! });
            expect(applied.applied).toBe(true);
        } finally {
            validateSpy.mockRestore();
            await cleanupStackDir('fp-bind');
        }
    });

    it('keeps operationId across a live-file recompute and flips GET pending to blocked', async () => {
        const sha = 'eeee1111eeee1111eeee1111eeee1111eeee1111';
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx\n', sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const fsSvc = FileSystemService.getInstance();
        await fsSvc.createStack('fp-stale-live');
        await svc.upsert({
            stackName: 'fp-stale-live',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        try {
            const pull = await svc.pull('fp-stale-live');
            const row = DatabaseService.getInstance().getGitSource('fp-stale-live');
            const decoded = (svc as unknown as {
                decodePendingCompose: (raw: string) => { operationId: string | null };
            }).decodePendingCompose(row!.pending_compose_content!);
            expect(decoded.operationId).toBeTruthy();

            await fsSvc.saveStackContent('fp-stale-live', 'services:\n  web:\n    image: nginx:local\n');

            await expect(svc.apply('fp-stale-live', sha, { planFingerprint: pull.planFingerprint! }))
                .rejects.toMatchObject({ code: 'STALE_PLAN' });

            const after = DatabaseService.getInstance().getGitSource('fp-stale-live');
            const decodedAfter = (svc as unknown as {
                decodePendingCompose: (raw: string) => { operationId: string | null };
            }).decodePendingCompose(after!.pending_compose_content!);
            expect(decodedAfter.operationId).toBe(decoded.operationId);

            const publicSrc = svc.get('fp-stale-live');
            expect(publicSrc?.pending_plan?.blocked).toBe(true);
            expect(publicSrc?.pending_plan?.fingerprint).not.toBe(pull.planFingerprint);
        } finally {
            validateSpy.mockRestore();
            await cleanupStackDir('fp-stale-live');
        }
    });

    it('refuses an incomplete v4 pending blob as PLAN_UNAVAILABLE', async () => {
        const sha = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
        const svc = GitSourceService.getInstance();
        const db = DatabaseService.getInstance();
        const { FileSystemService } = await import('../services/FileSystemService');
        await FileSystemService.getInstance().createStack('plan-unavail');
        db.upsertGitSource({
            stack_name: 'plan-unavail',
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
            pending_commit_sha: sha,
            pending_compose_content: null,
            pending_env_content: null,
            pending_fetched_at: null,
            last_debounce_at: null,
        });
        const svcPriv = svc as unknown as { crypto: { encrypt(s: string): string } };
        db.setGitSourcePending(
            'plan-unavail',
            sha,
            svcPriv.crypto.encrypt(JSON.stringify({
                v: 4,
                files: [{ path: 'compose.yaml', content: 'services:\n  web:\n    image: nginx\n' }],
                contextDir: null,
                candidateRelPath: 'generations/cand',
                inventory: { inputs: [], refusals: [], buildContexts: [] },
            })),
            null,
        );
        try {
            await expect(svc.apply('plan-unavail', sha, SKIP_PLAN_FINGERPRINT)).rejects.toMatchObject({
                code: 'PLAN_UNAVAILABLE',
            });
        } finally {
            await cleanupStackDir('plan-unavail');
        }
    });
});
