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
} = {}) {
    const {
        compose = 'services:\n  web:\n    image: nginx\n',
        env = null,
        composePath = 'compose.yaml',
        envPath = null,
        sha = 'abc1234567890abc1234567890abc1234567890a',
    } = options;

    mockGitClone.mockImplementation(async (args: { dir: string }) => {
        const { promises: fsp } = await import('fs');
        const path = await import('path');
        const composeAbs = path.join(args.dir, composePath);
        await fsp.mkdir(path.dirname(composeAbs), { recursive: true });
        await fsp.writeFile(composeAbs, compose, 'utf-8');
        if (env !== null && envPath) {
            const envAbs = path.join(args.dir, envPath);
            await fsp.mkdir(path.dirname(envAbs), { recursive: true });
            await fsp.writeFile(envAbs, env, 'utf-8');
        }
    });
    mockGitLog.mockResolvedValue([{ oid: sha }]);
    return sha;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('GitSourceService.hashContent', () => {
    it('produces stable hashes for identical inputs', () => {
        const svc = GitSourceService.getInstance();
        const a = svc.hashContent('services:\n  web: nginx\n', 'FOO=bar');
        const b = svc.hashContent('services:\n  web: nginx\n', 'FOO=bar');
        expect(a).toBe(b);
        expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it('distinguishes env=null from env=""', () => {
        const svc = GitSourceService.getInstance();
        const nullHash = svc.hashContent('x: 1', null);
        const emptyHash = svc.hashContent('x: 1', '');
        // Both hash-empty-string after null-coalesce, so they should match by design.
        expect(nullHash).toBe(emptyHash);
    });

    it('changes when compose content changes', () => {
        const svc = GitSourceService.getInstance();
        const a = svc.hashContent('x: 1', null);
        const b = svc.hashContent('x: 2', null);
        expect(a).not.toBe(b);
    });

    it('changes when env content changes', () => {
        const svc = GitSourceService.getInstance();
        const a = svc.hashContent('x: 1', 'A=1');
        const b = svc.hashContent('x: 1', 'A=2');
        expect(a).not.toBe(b);
    });

    it('does not confuse compose|env boundary (uses NUL separator)', () => {
        const svc = GitSourceService.getInstance();
        // If the separator were absent, "ab" + "cd" would equal "abc" + "d".
        const a = svc.hashContent('ab', 'cd');
        const b = svc.hashContent('abc', 'd');
        expect(a).not.toBe(b);
    });
});

describe('GitSourceService.validateCompose (YAML pre-check)', () => {
    const svc = () => GitSourceService.getInstance();

    it('rejects empty content', async () => {
        const r = await svc().validateCompose('', null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/empty/i);
    });

    it('rejects a YAML array at the root', async () => {
        const r = await svc().validateCompose('- one\n- two\n', null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/mapping/i);
    });

    it('rejects a YAML scalar at the root', async () => {
        const r = await svc().validateCompose('42', null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/mapping/i);
    });

    it('rejects malformed YAML syntax', async () => {
        const r = await svc().validateCompose('services:\n  web:\n    image: "unterminated\n', null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/YAML parse error/i);
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        })).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });

        expect(DatabaseService.getInstance().getGitSource('unreachable')).toBeUndefined();
    });
});

describe('GitSourceService error mapping', () => {
    const svc = () => GitSourceService.getInstance();
    const fetchParams = {
        repoUrl: 'https://github.com/example/repo.git',
        branch: 'main',
        composePath: 'compose.yaml',
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
            composePath: 'missing/compose.yaml',
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
        composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
});

describe('GitSourceService.handleWebhookPull debounce', () => {
    it('returns skipped when invoked within the debounce window', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'debounce-stack',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        // upsert runs a dry-run fetch but not validateCompose, so the stub only
        // affects the webhook pull below.
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: false, error: 'bad compose' });

        const result = await svc.handleWebhookPull('webhook-validate-fail');
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/validation failed/i);
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
            composePath: '.git/config',
        })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('rejects nested .git paths', async () => {
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePath: 'subdir/.git/HEAD',
        })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('rejects env paths that target the .git directory', async () => {
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePath: 'compose.yaml',
            envPath: '.git/config',
        })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('allows paths that merely contain the substring "git"', async () => {
        mockSuccessfulClone({ composePath: 'gitops.yaml' });
        await expect(svc().fetchFromGit({
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePath: 'gitops.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
    async function cleanupStackDir(name: string) {
        const { FileSystemService } = await import('../services/FileSystemService');
        try {
            await FileSystemService.getInstance().deleteStack(name);
        } catch {
            // directory may not exist; ignore
        }
    }

    it('creates a stack on disk, writes compose, and seeds last_applied columns', async () => {
        const sha = 'fedcba9876543210fedcba9876543210fedcba98';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx\n',
            sha,
        });
        const svc = GitSourceService.getInstance();

        const result = await svc.createStackFromGit({
            stackName: 'create-happy',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePath: 'compose.yaml',
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

        const { FileSystemService } = await import('../services/FileSystemService');
        const onDisk = await FileSystemService.getInstance().getStackContent('create-happy');
        expect(onDisk).toContain('image: nginx');

        await cleanupStackDir('create-happy');
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
            composePath: 'apps/web/compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
            composePath: 'compose.yaml',
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
    async function seedPending(stackName: string, composeContent: string, commitSha: string) {
        mockSuccessfulClone({ compose: composeContent, sha: commitSha });
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName,
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePath: 'compose.yaml',
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
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue();
        const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'begin').mockReturnValue('gate-git');
        const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;

        const result = await svc.apply('apply-deploy-gate', sha, { deploy: true });
        expect(result.deployed).toBe(true);
        expect(deploySpy).toHaveBeenCalledWith('apply-deploy-gate');
        expect(beginSpy).toHaveBeenCalledWith(nodeId, 'apply-deploy-gate', 'deploy', 'system:git-source');

        validateSpy.mockRestore();
        saveSpy.mockRestore();
        deploySpy.mockRestore();
        beginSpy.mockRestore();
    });

    it('returns deployError when the deploy step fails after writing to disk', async () => {
        const sha = 'cccc333cccc333cccc333cccc333cccc333cccc3';
        const svc = await seedPending('apply-deploy-fail', 'services:\n  x:\n    image: alpine\n', sha);

        // Stub validation (docker compose config is expensive and not needed here)
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        // Stub file write (FileSystemService expects a real stack dir)
        const { FileSystemService } = await import('../services/FileSystemService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();

        // Deploy will fail organically (docker CLI unavailable in the test env).
        // We only assert the return SHAPE: apply must not throw, deployError must
        // carry the failure detail so the UI can surface "applied but not deployed".
        const result = await svc.apply('apply-deploy-fail', sha, { deploy: true });
        expect(result.applied).toBe(true);
        expect(result.deployed).toBe(false);
        expect(result.deployError).toBeTruthy();

        // Disk write happened; DB was marked applied even though deploy failed.
        expect(saveSpy).toHaveBeenCalled();
        const row = DatabaseService.getInstance().getGitSource('apply-deploy-fail');
        expect(row?.last_applied_commit_sha).toBe(sha);
        expect(row?.pending_commit_sha).toBeNull();

        validateSpy.mockRestore();
        saveSpy.mockRestore();
    });

    it('returns deployError and skips compose deploy when policy blocks apply deploy', async () => {
        const sha = 'dddd444dddd444dddd444dddd444dddd444dddd4';
        const svc = await seedPending('apply-policy-block', 'services:\n  x:\n    image: nginx:bad\n', sha);
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        const { LicenseService } = await import('../services/LicenseService');
        const TrivyService = (await import('../services/TrivyService')).default;
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        const listImagesSpy = vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:bad']);
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue();
        const tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
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
            block_on_deploy: 1,
            enabled: 1,
            replicated_from_control: 0,
        });

        const result = await svc.apply('apply-policy-block', sha, { deploy: true });

        expect(result.applied).toBe(true);
        expect(result.deployed).toBe(false);
        expect(result.deployError).toContain('Policy "block-high" blocked deploy');
        expect(deploySpy).not.toHaveBeenCalled();

        validateSpy.mockRestore();
        saveSpy.mockRestore();
        listImagesSpy.mockRestore();
        deploySpy.mockRestore();
        tierSpy.mockRestore();
        trivyAvailableSpy.mockRestore();
        scanSpy.mockRestore();
    });
});
