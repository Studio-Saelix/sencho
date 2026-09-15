/**
 * Unit tests for GitSourceService.
 *
 * Covers:
 * - hashContent determinism and env separation
 * - validateCompose YAML pre-check (empty / non-object / syntax error)
 * - Token round-trip via upsert: encryption, has_token projection, undefined/null/empty/non-empty semantics
 * - Apply-matrix rejection (auto_deploy requires auto_apply)
 * - Error code mapping from native-git transport failures (REPO_NOT_FOUND, AUTH_FAILED, REF_NOT_FOUND, REF_DELETED, UNSUPPORTED_REF, NETWORK_TIMEOUT)
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
import type { TransportFailure } from '../services/git/errors';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { StackOpLockService } from '../services/StackOpLockService';
import { coalesceKey, deliveryKey, type ReconcileRequest, type ReconcileTrigger } from '../services/gitops/triggers';
import {
    buildDirectApplicationRow,
    buildGenerationRow,
    directSourceIdentity,
    newGitOpsId,
    stackManagedRoot,
    type DirectSourceConfig,
} from '../services/gitops/directApplication';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockResolveRef, mockFetchAtCommit, mockVerifyFastForward, mockGitClone, mockGitLog } = vi.hoisted(() => ({
    mockResolveRef: vi.fn(),
    mockFetchAtCommit: vi.fn(),
    mockVerifyFastForward: vi.fn(),
    mockGitClone: vi.fn(),
    mockGitLog: vi.fn(),
}));

// The transport boundary is what gets mocked. mockGitClone/mockGitLog remain
// as the fixture layer so every per-test override keeps its meaning: clone
// writes files into the checkout dir, log yields the deterministic sha.
vi.mock('../services/git/nativeGitTransport', () => ({
    nativeGitTransport: {
        resolveRef: mockResolveRef,
        fetchAtCommit: mockFetchAtCommit,
    },
    verifyFastForward: mockVerifyFastForward,
}));


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

const { mockInvalidateNodeCaches, mockTriggerPostDeployScan } = vi.hoisted(() => ({
  mockInvalidateNodeCaches: vi.fn(),
  mockTriggerPostDeployScan: vi.fn(async () => undefined),
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

vi.mock('../helpers/cacheInvalidation', async () => {
  const actual = await vi.importActual<typeof import('../helpers/cacheInvalidation')>(
    '../helpers/cacheInvalidation',
  );
  return { ...actual, invalidateNodeCaches: mockInvalidateNodeCaches };
});

vi.mock('../helpers/policyGate', async () => {
  const actual = await vi.importActual<typeof import('../helpers/policyGate')>(
    '../helpers/policyGate',
  );
  return { ...actual, triggerPostDeployScan: mockTriggerPostDeployScan };
});


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
    mockResolveRef.mockReset();
    mockFetchAtCommit.mockReset();
    mockVerifyFastForward.mockReset();
    mockGitClone.mockReset();
    mockGitLog.mockReset();
    wireTransportDefaults();
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

    StackOpLockService.resetForTests();

    // Wipe persisted git sources between tests
    const db = DatabaseService.getInstance();
    for (const s of db.getGitSources()) db.deleteGitSource(s.stack_name);
    for (const p of db.getScanPolicies()) db.deleteScanPolicy(p.id);
});

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Default transport wiring: resolveRef defers to the log stub so per-test
 * overrides of mockGitLog keep controlling the final SHA, and fetchAtCommit
 * delegates to the clone/log fixture fns, handing clone a `dir` that points
 * at the workspace checkout.
 */
function wireTransportDefaults(): void {
    mockVerifyFastForward.mockResolvedValue(true);
    mockResolveRef.mockImplementation(async () => {
        const log = await mockGitLog({});
        const oid = Array.isArray(log) ? log[0]?.oid : undefined;
        return { commitSha: oid ?? '', kind: 'branch' as const, ref: 'main' };
    });
    mockFetchAtCommit.mockImplementation(async (req: { workspaceRoot: string; commitSha: string }) => {
        const path = await import('path');
        const { promises: fsp } = await import('fs');
        const dir = path.join(req.workspaceRoot, 'repo');
        // The real clone creates the checkout dir; fixture impls may not.
        await fsp.mkdir(dir, { recursive: true });
        await mockGitClone({ ...req, dir });
        const log = await mockGitLog({ dir });
        if (!Array.isArray(log) || !log.length) {
            // An empty branch produces no remote ref; mirror the structured
            // failure the real transport raises for that case.
            throw { transportFailure: true as const, reason: 'ref-not-found', host: 'unknown', hasToken: false };
        }
        return { commitSha: log[0].oid, dir };
    });
}

/**
 * Structured transport failure carrying a real-world git stderr sample, for
 * exercising the service's classification of native-git failures.
 */
function gitFailure(stderr: string, hasToken: boolean): TransportFailure {
    return { transportFailure: true as const, reason: 'exit', stderr, exitCode: 128, host: 'github.com', hasToken };
}

/**
 * Stub out the clone/log fixtures so that `clone` writes a minimal compose
 * file into the checkout dir and `log` returns a deterministic commit sha.
 * Returns the sha so tests can compare.
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

/**
 * Configure a plain single-file Git source for a stack, without creating the
 * stack itself. The caller stages the clone mock first: upsert runs a
 * reachability fetch.
 */
async function configureGitSource(stackName: string): Promise<void> {
    await GitSourceService.getInstance().upsert({
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
}

/** Operation ids of every gitops_history row an application recorded at one stage. */
function historyOperationIds(applicationId: string, stage: string): string[] {
    const rows = DatabaseService.getInstance().getDb()
        .prepare('SELECT operation_id FROM gitops_history WHERE application_id = ? AND stage = ?')
        .all(applicationId, stage) as { operation_id: string }[];
    return rows.map((r) => r.operation_id);
}

/** Settled attempt rows for one application, used to compare follower results. */
function settledAttemptsForApplication(applicationId: string): { operation_id: string; after_json: string }[] {
    return DatabaseService.getInstance().getDb()
        .prepare("SELECT operation_id, after_json FROM gitops_history WHERE application_id = ? AND stage = 'source_reconcile_settled'")
        .all(applicationId) as { operation_id: string; after_json: string }[];
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

describe('GitSourceService.shortOperationId', () => {
    function shortOperationId(operationId: string): string {
        return (GitSourceService as unknown as { shortOperationId: (id: string) => string }).shortOperationId(operationId);
    }

    it('discriminates between reserved attempts on the same application, unlike a fixed-width prefix', () => {
        const appId = '4457ddc3-3eb0-444e-902c-7e65d355b36b';
        expect(shortOperationId(`${appId}:attempt:1`)).toBe('1');
        expect(shortOperationId(`${appId}:attempt:2`)).toBe('2');
    });

    it('uses the delivery-key suffix for a webhook-triggered reservation', () => {
        expect(shortOperationId('webhook:fetch:delivery-abc')).toBe('delivery-abc');
    });

    it('falls back to a prefix for a plain UUID with no colon', () => {
        const uuid = '29ec01cd-4129-4c4c-a5f2-4e2368f44490';
        expect(shortOperationId(uuid)).toBe(uuid.slice(0, 8));
    });
});

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

    it('stores an encrypted CA bundle and exposes has_ca_bundle without leaking PEM', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const pem = '-----BEGIN CERTIFICATE-----\nTEST-CA-PEM\n-----END CERTIFICATE-----\n';
        const created = await svc.upsert({
            stackName: 'ca-stack',
            repoUrl: 'https://git.example.com/org/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            caBundle: pem,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        expect(created.has_ca_bundle).toBe(true);
        expect(JSON.stringify(created)).not.toContain('TEST-CA-PEM');
        const row = DatabaseService.getInstance().getGitSource('ca-stack');
        expect(row?.encrypted_ca_bundle).toBeTruthy();
        expect(row?.encrypted_ca_bundle).not.toBe(pem);
    });

    it('explicitly removes a stored CA bundle when removeCaBundle is true, even when caBundle is omitted', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const pem = '-----BEGIN CERTIFICATE-----\nTEST-CA-PEM\n-----END CERTIFICATE-----\n';
        // Step 1: store a CA bundle.
        await svc.upsert({
            stackName: 'ca-revoke-stack',
            repoUrl: 'https://git.example.com/org/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            caBundle: pem,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        let row = DatabaseService.getInstance().getGitSource('ca-revoke-stack');
        expect(row?.encrypted_ca_bundle).toBeTruthy();
        // Step 2: simulate the operator clicking "Remove stored CA": the
        // textarea is left empty and the UI sends removeCaBundle: true with
        // caBundle omitted. The stored CA must be cleared.
        const updated = await svc.upsert({
            stackName: 'ca-revoke-stack',
            repoUrl: 'https://git.example.com/org/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            removeCaBundle: true,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        expect(updated.has_ca_bundle).toBe(false);
        expect(JSON.stringify(updated)).not.toContain('TEST-CA-PEM');
        row = DatabaseService.getInstance().getGitSource('ca-revoke-stack');
        expect(row?.encrypted_ca_bundle).toBeNull();
    });

    it('saves an explicit CA removal even when the repository is unreachable without that CA', async () => {
        // The dry-run reachability check normally runs on every save. A
        // repository that genuinely needs its CA to be reached would fail
        // that check the instant the CA is removed, refusing the very
        // request meant to retire it. removeCaBundle must bypass the
        // check so the operator's explicit intent to remove always saves.
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const pem = '-----BEGIN CERTIFICATE-----\nTEST-CA-PEM\n-----END CERTIFICATE-----\n';
        mockResolveRef.mockImplementation(async (req: { caBundlePem?: string | null }) => {
            if (!req.caBundlePem) {
                throw gitFailure('unable to get local issuer certificate', false);
            }
            return { commitSha: 'a'.repeat(40), kind: 'branch' as const };
        });
        await svc.upsert({
            stackName: 'ca-required-stack',
            repoUrl: 'https://git.example.com/org/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            caBundle: pem,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });

        // Sanity check: without removeCaBundle, an upsert that can no longer
        // reach the repository is refused, proving the dry-run check itself
        // still runs for ordinary saves.
        await expect(svc.upsert({
            stackName: 'ca-required-stack',
            repoUrl: 'https://git.example.com/org/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            caBundle: null,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        })).rejects.toBeTruthy();

        // The removal itself must still save.
        const removed = await svc.upsert({
            stackName: 'ca-required-stack',
            repoUrl: 'https://git.example.com/org/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            removeCaBundle: true,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        expect(removed.has_ca_bundle).toBe(false);
        const row = DatabaseService.getInstance().getGitSource('ca-required-stack');
        expect(row?.encrypted_ca_bundle).toBeNull();
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

    it('derives SSH host key fingerprint server-side on deploy_key upsert', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const keyBase64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIGb3JzL3Rlc3Q=';
        const knownHosts = `127.0.0.1 ssh-ed25519 ${keyBase64}`;
        const derived = `SHA256:${crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64').replace(/=+$/, '')}`;
        await svc.upsert({
            stackName: 'ssh-trust-stack',
            repoUrl: 'git@github.com:example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'deploy_key',
            deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n',
            sshKnownHostsEntry: knownHosts,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        });
        const row = DatabaseService.getInstance().getGitSource('ssh-trust-stack');
        expect(row?.ssh_host_key_fingerprint).toBe(derived);
    });

    it('rejects a client fingerprint that does not match the trusted host key entry', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const keyBase64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIGb3JzL3Rlc3Q=';
        const knownHosts = `127.0.0.1 ssh-ed25519 ${keyBase64}`;
        await expect(svc.upsert({
            stackName: 'ssh-trust-mismatch',
            repoUrl: 'git@github.com:example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'deploy_key',
            deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n',
            sshKnownHostsEntry: knownHosts,
            sshHostKeyFingerprint: 'SHA256:wrongFingerprintValue',
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
        })).rejects.toMatchObject({ code: 'GIT_ERROR' });
    });

    it('records SSH trust audit with the supplied actor and no key material', async () => {
        mockSuccessfulClone();
        const insertSpy = vi.spyOn(DatabaseService.getInstance(), 'insertAuditLog');
        const svc = GitSourceService.getInstance();
        const deployKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-audit\n-----END OPENSSH PRIVATE KEY-----\n';
        const keyBase64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIGb3JzL3Rlc3Q=';
        const knownHosts = `127.0.0.1 ssh-ed25519 ${keyBase64}`;
        const derived = `SHA256:${crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64').replace(/=+$/, '')}`;
        await svc.upsert({
            stackName: 'ssh-trust-audit',
            repoUrl: 'git@github.com:example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'deploy_key',
            deployKey,
            sshKnownHostsEntry: knownHosts,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
            auditContext: {
                username: 'fleet-operator',
                method: 'PUT',
                path: '/api/stacks/ssh-trust-audit/git-source',
                ipAddress: '127.0.0.1',
            },
        });
        expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
            username: 'fleet-operator',
            summary: expect.stringContaining('git_source.ssh_trust_created'),
        }));
        const entry = insertSpy.mock.calls[0]?.[0];
        expect(entry?.summary).toContain(derived);
        expect(entry?.summary).not.toContain(deployKey);
        expect(entry?.summary).not.toContain(knownHosts);
        insertSpy.mockRestore();
    });

    it('records SSH trust rotation when replacing known_hosts without resending the deploy key', async () => {
        mockSuccessfulClone();
        const { CryptoService } = await import('../services/CryptoService');
        const insertSpy = vi.spyOn(DatabaseService.getInstance(), 'insertAuditLog');
        const svc = GitSourceService.getInstance();
        const deployKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nrotation-fixture\n-----END OPENSSH PRIVATE KEY-----\n';
        const keyBase64A = 'AAAAC3NzaC1lZDI1NTE5AAAAIGb3JzL3Rlc3Q=';
        const keyBase64B = 'AAAAC3NzaC1lZDI1NTE5AAAAIHRvdGF0ZWtleWZpeHR1cmVtYXRlcmlhbA==';
        const knownHostsA = `127.0.0.1 ssh-ed25519 ${keyBase64A}`;
        const knownHostsB = `github.com ssh-ed25519 ${keyBase64B}`;
        const derivedB = `SHA256:${crypto.createHash('sha256').update(Buffer.from(keyBase64B, 'base64')).digest('base64').replace(/=+$/, '')}`;
        const auditContext = {
            username: 'trust-rotator',
            method: 'PUT',
            path: '/api/stacks/ssh-trust-rotate/git-source',
            ipAddress: '127.0.0.1',
        };
        const baseUpsert = {
            repoUrl: 'git@github.com:example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'deploy_key' as const,
            autoApplyOnWebhook: false,
            autoDeployOnApply: false,
            auditContext,
        };

        await svc.upsert({
            ...baseUpsert,
            stackName: 'ssh-trust-rotate',
            deployKey,
            sshKnownHostsEntry: knownHostsA,
        });

        insertSpy.mockClear();

        await svc.upsert({
            ...baseUpsert,
            stackName: 'ssh-trust-rotate',
            sshKnownHostsEntry: knownHostsB,
        });

        const row = DatabaseService.getInstance().getGitSource('ssh-trust-rotate');
        expect(row?.ssh_host_key_fingerprint).toBe(derivedB);
        expect(row?.ssh_known_hosts_entry).toBe(knownHostsB);
        expect(CryptoService.getInstance().decrypt(row!.encrypted_deploy_key!)).toBe(deployKey);

        expect(insertSpy).toHaveBeenCalledTimes(1);
        expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
            username: 'trust-rotator',
            summary: expect.stringContaining('git_source.ssh_trust_rotated'),
        }));
        const rotatedEntry = insertSpy.mock.calls[0]?.[0];
        expect(rotatedEntry?.summary).toContain(derivedB);
        expect(rotatedEntry?.summary).not.toContain(deployKey);
        expect(rotatedEntry?.summary).not.toContain(knownHostsB);
        expect(JSON.stringify(insertSpy.mock.calls)).not.toContain('git_source.ssh_trust_created');

        insertSpy.mockClear();

        await svc.upsert({
            ...baseUpsert,
            stackName: 'ssh-trust-rotate',
            sshKnownHostsEntry: knownHostsB,
        });

        expect(insertSpy).not.toHaveBeenCalled();
        insertSpy.mockRestore();
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

    it('rejects auto-deploy when the effective policy is not automatic', async () => {
        // An existing application already carries an explicit 'manual' policy;
        // a legacy boolean-only write must not let auto-deploy ride along.
        GitOpsStore.getInstance().insertApplication(
            buildDirectApplicationRow({
                id: newGitOpsId(),
                stackName: 'manual-deploy-matrix',
                config: {
                    repoUrl: 'https://github.com/example/repo.git',
                    branch: 'main',
                    composePaths: ['compose.yaml'],
                    contextDir: null,
                    syncEnv: false,
                    envPath: null,
                },
                identity: directSourceIdentity({
                    repoUrl: 'https://github.com/example/repo.git',
                    branch: 'main',
                    composePaths: ['compose.yaml'],
                    contextDir: null,
                    syncEnv: false,
                    envPath: null,
                }),
                lifecycleStatus: 'active',
                at: Date.now(),
            }, 'manual'),
        );
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await expect(svc.upsert({
            stackName: 'manual-deploy-matrix',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: true,
        })).rejects.toMatchObject({ code: 'GIT_ERROR' });
    });

    it('allows auto-deploy when the effective policy is automatic via sourcePolicy', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'auto-deploy-matrix',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: false,
            autoDeployOnApply: true,
            sourcePolicy: 'automatic',
        });
        const source = svc.get('auto-deploy-matrix')!;
        expect(source.auto_apply_on_webhook).toBe(true);
        expect(source.auto_deploy_on_apply).toBe(true);
        const app = GitOpsStore.getInstance().getLiveDirectApplication('auto-deploy-matrix');
        expect(app?.source_policy).toBe('automatic');
    });

    it('an explicit sourcePolicy wins over the legacy boolean', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'policy-wins',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: true,
            autoDeployOnApply: false,
            sourcePolicy: 'manual',
        });
        expect(GitOpsStore.getInstance().getLiveDirectApplication('policy-wins')?.source_policy).toBe('manual');
        // Reads project the boolean from source_policy (automatic only), so a
        // manual policy reports false. A legacy client that read-modify-writes
        // a manual source therefore sends false and never re-enables automatic.
        expect(svc.get('policy-wins')!.auto_apply_on_webhook).toBe(false);
    });

    it('a legacy false edit keeps an existing manual policy (no silent conversion)', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'manual-keeps',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            composePaths: ['compose.yaml'],
            contextDir: null,
            syncEnv: false,
            envPath: null,
            authType: 'none',
            autoApplyOnWebhook: true,
            autoDeployOnApply: false,
            sourcePolicy: 'manual',
        });
        expect(GitOpsStore.getInstance().getLiveDirectApplication('manual-keeps')?.source_policy).toBe('manual');
        // Unrelated legacy edit: boolean false, no sourcePolicy. The manual
        // policy must survive rather than being converted to review.
        await svc.upsert({
            stackName: 'manual-keeps',
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
        expect(GitOpsStore.getInstance().getLiveDirectApplication('manual-keeps')?.source_policy).toBe('manual');
    });

    it('create without sourcePolicy derives review from a false boolean', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'derive-review',
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
        expect(GitOpsStore.getInstance().getLiveDirectApplication('derive-review')?.source_policy).toBe('review');
    });

    it('does not persist when dry-run fetch fails', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: repository 'https://github.com/example/nope.git/' not found",
            false,
        ));
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

    it('maps an authentication refusal with supplied token to AUTH_FAILED', async () => {
        // Auth failure only means "your token is wrong" when the caller actually sent one.
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: Authentication failed for 'https://github.com/example/repo.git/'",
            true,
        ));
        await expect(svc().fetchFromGit({ ...fetchParams, token: 'ghp_some_token_value' }))
            .rejects.toMatchObject({ code: 'AUTH_FAILED' });
    });

    it('maps a credential prompt without a token to REPO_NOT_FOUND with a private-repo hint', async () => {
        // Private repos demand credentials; without a supplied token,
        // "check your token" is misleading, so we surface it as "not found or
        // private" and suggest adding a PAT (GitHub masks private repos too).
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: could not read Username for 'https://github.com/example/repo.git': terminal prompts disabled",
            false,
        ));
        await expect(svc().fetchFromGit(fetchParams))
            .rejects.toMatchObject({ code: 'REPO_NOT_FOUND', message: expect.stringMatching(/private/i) });
    });

    it('maps repository-not-found to REPO_NOT_FOUND (not AUTH_FAILED)', async () => {
        // Regression guard: a missing repo must never read as an auth problem.
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: repository 'https://github.com/example/repo.git/' not found",
            false,
        ));
        await expect(svc().fetchFromGit(fetchParams))
            .rejects.toMatchObject({ code: 'REPO_NOT_FOUND', message: expect.stringMatching(/private/i) });
    });

    it('maps repository-not-found with a supplied token to REPO_NOT_FOUND with a token-scope hint', async () => {
        // GitHub returns not-found for both "missing repo" and "token lacks
        // access", so when the caller did supply a token we point them at URL
        // + scopes instead of "add a PAT" (which they already did).
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: repository 'https://github.com/example/repo.git/' not found",
            true,
        ));
        await expect(svc().fetchFromGit({ ...fetchParams, token: 'ghp_some_token_value' }))
            .rejects.toMatchObject({ code: 'REPO_NOT_FOUND', message: expect.stringMatching(/token has read access/i) });
    });

    it('classifies resolve-phase failures too (ls-remote runs before clone)', async () => {
        // The first real-world failure point is resolution; if the service
        // ever stops translating its failures this goes generic GIT_ERROR.
        mockResolveRef.mockRejectedValueOnce(gitFailure(
            "fatal: Authentication failed for 'https://github.com/example/repo.git/'",
            true,
        ));
        await expect(svc().fetchFromGit({ ...fetchParams, token: 'ghp_some_token_value' }))
            .rejects.toMatchObject({ code: 'AUTH_FAILED' });
    });

    it('threads the resolved commit, ref, and token into the pinned fetch', async () => {
        const sha = mockSuccessfulClone();
        await svc().fetchFromGit({ ...fetchParams, token: 'tok-abc' });
        expect(mockFetchAtCommit.mock.calls[0][0]).toMatchObject({
            commitSha: sha,
            ref: 'main',
            refKind: 'branch',
            repoUrl: 'https://github.com/example/repo.git',
            token: 'tok-abc',
            workspaceRoot: expect.any(String),
        });
    });

    it('removes the transport workspace after success and after failure', async () => {
        const fsMod = await import('fs');
        mockSuccessfulClone();
        await svc().fetchFromGit(fetchParams);
        const successRoot = mockFetchAtCommit.mock.calls[0][0].workspaceRoot;
        expect(fsMod.existsSync(successRoot)).toBe(false);

        mockFetchAtCommit.mockRejectedValueOnce(gitFailure('fatal: repository not found', false));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
        const failureRoot = mockFetchAtCommit.mock.calls[1][0].workspaceRoot;
        expect(fsMod.existsSync(failureRoot)).toBe(false);
    });

    it('reports REF_NOT_FOUND for a branch with no commits', async () => {
        // Resolve-first turns an empty branch into a missing remote ref.
        mockGitLog.mockResolvedValue([]);
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({
            code: 'REF_NOT_FOUND',
            message: expect.stringMatching(/was not found/),
        });
    });

    it('maps short not-found phrasing to REPO_NOT_FOUND', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure('fatal: repository not found', false));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
    });

    it('maps remote-branch-not-found to REF_NOT_FOUND', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            'fatal: Remote branch nonexistent not found in upstream origin',
            false,
        ));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'REF_NOT_FOUND' });
    });

    it('upgrades REF_NOT_FOUND to REF_DELETED when the source has prior history', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            'fatal: Remote branch nonexistent not found in upstream origin',
            false,
        ));
        await expect(svc().fetchFromGit({ ...fetchParams, hasPriorHistory: true }))
            .rejects.toMatchObject({ code: 'REF_DELETED' });
    });

    it('returns REF_DELETED when a resolved ref changes namespace', async () => {
        mockResolveRef.mockResolvedValueOnce({ commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', kind: 'tag' });
        await expect(svc().fetchFromGit({
            ...fetchParams,
            priorIdentity: { commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'branch' },
        })).rejects.toMatchObject({ code: 'REF_DELETED' });
        expect(mockFetchAtCommit).not.toHaveBeenCalled();
    });

    it('returns REF_DELETED when a branch tip moves by force-push', async () => {
        mockResolveRef.mockResolvedValueOnce({ commitSha: 'cccccccccccccccccccccccccccccccccccccccc', kind: 'branch' });
        mockVerifyFastForward.mockResolvedValueOnce(false);
        await expect(svc().fetchFromGit({
            ...fetchParams,
            priorIdentity: { commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'branch' },
        })).rejects.toMatchObject({ code: 'REF_DELETED' });
        expect(mockFetchAtCommit).not.toHaveBeenCalled();
    });

    it('propagates verifyFastForward transport failures without upgrading to REF_DELETED', async () => {
        mockResolveRef.mockResolvedValueOnce({ commitSha: 'cccccccccccccccccccccccccccccccccccccccc', kind: 'branch' });
        mockVerifyFastForward.mockRejectedValueOnce({
            transportFailure: true as const,
            reason: 'timeout',
            host: 'github.com',
            hasToken: true,
        });
        await expect(svc().fetchFromGit({
            ...fetchParams,
            priorIdentity: { commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'branch' },
        })).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
        expect(mockFetchAtCommit).not.toHaveBeenCalled();
    });

    it('maps a host refusal to serve a pinned SHA to UNSUPPORTED_REF', async () => {
        // A SHA fetch requires the host to serve unadvertised objects; a
        // refusal (allowAnySHA1InWant off) is a server-capability failure,
        // not a missing commit. GitLab/Gitea word it differently from GitHub,
        // so the classifier matches the stable "unadvertised object" phrase.
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            'fatal: upload-pack: unable to find 0123456789abcdef0123456789abcdef01234567, does not allow request for unadvertised object',
            false,
        ));
        await expect(svc().fetchFromGit({ ...fetchParams, branch: '0123456789abcdef0123456789abcdef01234567' }))
            .rejects.toMatchObject({ code: 'UNSUPPORTED_REF' });
    });

    it('keeps NETWORK_TIMEOUT on a timed-out fetch even with prior history', async () => {
        // The REF_DELETED upgrade fires only on a classified REF_NOT_FOUND.
        // A network timeout on a source that previously resolved must stay a
        // timeout, not read as "the ref vanished".
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: unable to access 'https://github.com/example/repo.git/': Failed to connect to github.com port 443: Connection timed out",
            false,
        ));
        await expect(svc().fetchFromGit({ ...fetchParams, hasPriorHistory: true }))
            .rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('maps GitHub not-our-ref SHA refusal to UNSUPPORTED_REF', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            'fatal: remote error: upload-pack: not our ref 0123456789abcdef0123456789abcdef01234567',
            false,
        ));
        await expect(svc().fetchFromGit({ ...fetchParams, branch: '0123456789abcdef0123456789abcdef01234567' }))
            .rejects.toMatchObject({ code: 'UNSUPPORTED_REF' });
    });

    it('leaves a missing pinned SHA as GIT_ERROR, not UNSUPPORTED_REF', async () => {
        // A SHA the host simply has never seen surfaces as "couldn't find
        // remote ref". That is a missing object, not a server-capability
        // refusal, and it is deliberately not collapsed into the delete/force
        // upgrade: there is no evidence the ref ever existed.
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            'fatal: couldn\'t find remote ref 0123456789abcdef0123456789abcdef01234567',
            false,
        ));
        await expect(svc().fetchFromGit({ ...fetchParams, branch: '0123456789abcdef0123456789abcdef01234567' }))
            .rejects.toMatchObject({ code: 'GIT_ERROR' });
    });

    it('maps connection timeouts to NETWORK_TIMEOUT', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: unable to access 'https://github.com/example/repo.git/': Failed to connect to github.com port 443 after 21005 ms: Connection timed out",
            false,
        ));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('maps DNS failure stderr to NETWORK_TIMEOUT', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: unable to access 'https://github.com/example/repo.git/': Could not resolve host: github.com",
            false,
        ));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('maps connection-refused stderr to NETWORK_TIMEOUT', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: unable to access 'https://github.com/example/repo.git/': Failed to connect to github.com port 443: Connection refused",
            false,
        ));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('surfaces the host in DNS transport errors', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: unable to access 'https://github.com/example/repo.git/': Could not resolve host: github.com",
            false,
        ));
        try {
            await svc().fetchFromGit(fetchParams);
            expect.fail('should have thrown');
        } catch (e) {
            const err = e as Error;
            expect(err.message).toContain('github.com');
        }
    });

    it('maps a reset connection to NETWORK_TIMEOUT', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            'fatal: the remote end hung up unexpectedly',
            false,
        ));
        await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    });

    it('propagates the raw transport reason onto GitSourceError.extras for retry classification', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            'fatal: the remote end hung up unexpectedly',
            false,
        ));
        try {
            await svc().fetchFromGit(fetchParams);
            expect.fail('should have thrown');
        } catch (e) {
            expect((e as InstanceType<typeof GitSourceError>).extras?.transportReason).toBe('exit');
        }
    });

    it('propagates a non-exit transport reason (e.g. timeout) without hardcoding to exit', async () => {
        mockFetchAtCommit.mockRejectedValueOnce({
            transportFailure: true as const,
            reason: 'timeout',
            host: 'github.com',
            hasToken: false,
        } satisfies TransportFailure);
        try {
            await svc().fetchFromGit(fetchParams);
            expect.fail('should have thrown');
        } catch (e) {
            expect((e as InstanceType<typeof GitSourceError>).extras?.transportReason).toBe('timeout');
        }
    });

    it('maps a TLS certificate failure to a certificate GIT_ERROR', async () => {
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: unable to access 'https://github.com/example/repo.git/': SSL certificate problem: self-signed certificate",
            false,
        ));
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
        mockFetchAtCommit.mockRejectedValueOnce(gitFailure(
            "fatal: unable to access 'https://user:supersecret@github.com/example/repo.git/': The requested URL returned error: 500",
            false,
        ));
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

describe('GitSourceService.fetchFromGit (size limits)', () => {
    const svc = () => GitSourceService.getInstance();
    const fetchParams = {
        repoUrl: 'https://github.com/example/repo.git',
        branch: 'main',
        composePaths: ['compose.yaml'],
    };

    it('rejects a compose file larger than the per-file read cap', async () => {
        // The workspace cap bounds the on-disk clone, not a single file, so
        // readRepoFile guards the in-memory read by file size.
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

    it('surfaces a clone-size error and forwards the configured cap to the transport', async () => {
        // The transport enforces the cap with its size watchdog (covered in the
        // transport unit tests); here we pin the plumbing: the env knob reaches
        // the transport as maxBytes, and a structured size failure translates
        // into the clone-size message rather than a generic transport error.
        process.env.GITSOURCE_MAX_CLONE_BYTES = '8';
        mockFetchAtCommit.mockImplementationOnce(async () => {
            throw { transportFailure: true as const, reason: 'size', maxBytes: 8, host: 'github.com', hasToken: false };
        });

        try {
            await expect(svc().fetchFromGit(fetchParams)).rejects.toMatchObject({
                code: 'GIT_ERROR',
                message: expect.stringMatching(/exceeds the maximum clone size/i),
            });
            expect(mockFetchAtCommit.mock.calls[0][0]).toMatchObject({ maxBytes: 8 });
        } finally {
            delete process.env.GITSOURCE_MAX_CLONE_BYTES;
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

    it('dismissPending clears the canonical candidate and records a dismissed history row', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const db = DatabaseService.getInstance();
        const stackName = 'dismiss-canonical';
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
        db.setGitSourcePending(stackName, 'sha-xxx', 'services: {}', null);
        const { appId, generationId } = seedDirectCandidate(stackName);
        expect(GitOpsStore.getInstance().getApplication(appId)?.candidate_generation_id).toBe(generationId);

        svc.dismissPending(stackName, 'operator-1');

        const app = GitOpsStore.getInstance().getApplication(appId)!;
        expect(app.candidate_generation_id).toBeNull();
        expect(app.candidate_plan_blocked).toBe(0);
        expect(app.review_required).toBe(0);
        expect(db.getGitSource(stackName)?.pending_commit_sha).toBeNull();
        const stages = (db.getDb().prepare(
            'SELECT stage, outcome FROM gitops_history WHERE application_id = ? ORDER BY id',
        ).all(appId) as Array<{ stage: string; outcome: string }>).map((r) => `${r.stage}:${r.outcome}`);
        expect(stages).toContain('dismissed:skipped');
    });

    it('dismissPending refuses while an operation is in flight and mutates nothing', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const db = DatabaseService.getInstance();
        const stackName = 'dismiss-in-flight';
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
        db.setGitSourcePending(stackName, 'sha-yyy', 'services: {}', null);
        const { appId, generationId } = seedDirectCandidate(stackName);
        GitOpsTransitions.getInstance().fetchStarted(appId, testEnvelope());

        let caught: unknown;
        try {
            svc.dismissPending(stackName, 'operator-1');
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(GitSourceError);
        if (!(caught instanceof GitSourceError)) throw new Error('expected GitSourceError');
        expect(caught.code).toBe('OPERATION_IN_FLIGHT');
        // The refusal is the outcome: neither the model nor the legacy columns move.
        expect(GitOpsStore.getInstance().getApplication(appId)?.candidate_generation_id).toBe(generationId);
        expect(db.getGitSource(stackName)?.pending_commit_sha).toBe('sha-yyy');
    });

    it('dismissPending stays a legacy-only no-op without a canonical application', async () => {
        mockSuccessfulClone();
        const svc = GitSourceService.getInstance();
        const db = DatabaseService.getInstance();
        const stackName = 'dismiss-legacy-only';
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
        db.setGitSourcePending(stackName, 'sha-zzz', 'services: {}', null);

        expect(() => svc.dismissPending(stackName, 'operator-1')).not.toThrow();
        expect(db.getGitSource(stackName)?.pending_commit_sha).toBeNull();
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

        const result = await svc.handleWebhookPull('debounce-stack', true);
        expect(result.status).toBe('skipped');
        expect(result.message).toMatch(/rate limited/i);
    });

    it('returns error when stack has no Git source configured', async () => {
        const svc = GitSourceService.getInstance();
        const result = await svc.handleWebhookPull('does-not-exist', true);
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/no git source/i);
    });

    it('fails closed and does not clone when reservation itself fails', async () => {
        mockSuccessfulClone({ sha: '2'.repeat(40) });
        const svc = GitSourceService.getInstance();
        await configureGitSource('webhook-reservation-fails-closed');
        mockGitClone.mockClear();
        const reserveSpy = vi.spyOn(GitOpsTransitions.prototype, 'allocateReconcileAttempt')
            .mockImplementationOnce(() => { throw new Error('simulated reservation failure'); });

        try {
            const result = await svc.handleWebhookPull('webhook-reservation-fails-closed', true);
            expect(result.status).toBe('error');
            expect(mockGitClone).not.toHaveBeenCalled();
        } finally {
            reserveSpy.mockRestore();
        }
    });

    it('fails closed and does not clone when the application was detached but the source config survives', async () => {
        mockSuccessfulClone({ sha: '3'.repeat(40) });
        const svc = GitSourceService.getInstance();
        await configureGitSource('webhook-tombstoned-app');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('webhook-tombstoned-app')!.id;
        GitOpsTransitions.getInstance().applicationTombstoned(applicationId, 'detached', {
            operationId: 'op-detach-3', actor: 'tester', trigger: 'test', at: Date.now(),
        });
        mockGitClone.mockClear();

        const result = await svc.handleWebhookPull('webhook-tombstoned-app', true);

        // Skipped, not error: this is a permanent state, and reporting it
        // as a delivery failure on every future push risks the Git host
        // disabling the webhook for a condition retrying can never fix.
        expect(result.status).toBe('skipped');
        expect(result.message).toMatch(/GitOps tracking was removed/);
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('fails closed and does not clone when the application was deleted but the source config survives', async () => {
        mockSuccessfulClone({ sha: '4'.repeat(40) });
        const svc = GitSourceService.getInstance();
        await configureGitSource('webhook-deleted-app');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('webhook-deleted-app')!.id;
        GitOpsTransitions.getInstance().applicationTombstoned(applicationId, 'deleted', {
            operationId: 'op-delete-webhook', actor: 'tester', trigger: 'test', at: Date.now(),
        });
        mockGitClone.mockClear();

        const result = await svc.handleWebhookPull('webhook-deleted-app', true);

        expect(result.status).toBe('skipped');
        expect(result.message).toMatch(/GitOps tracking is unavailable/);
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('does not execute a persisted deploy intent when the caller lacks deploy authorization', async () => {
        const stackName = 'webhook-persisted-deploy-auth';
        const deliveryId = 'webhook:control:7:deploy-auth';
        mockSuccessfulClone({ sha: '5'.repeat(40) });
        const svc = GitSourceService.getInstance();
        await configureGitSource(stackName);
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication(stackName)!.id;
        GitOpsTransitions.getInstance().reserveReconcileAttempt(
            applicationId,
            {
                operationId: deliveryKey('webhook', 'fetch', deliveryId),
                actor: 'system:webhook',
                trigger: 'webhook',
                at: Date.now(),
            },
            undefined,
            { autoApply: true, deploy: true },
        );
        mockGitClone.mockClear();

        const result = await svc.handleWebhookPull(stackName, false, deliveryId);

        expect(result.status).toBe('error');
        expect(result.message).toMatch(/deploy permission/i);
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('does not require deploy authorization when auto-apply is disabled', async () => {
        const stackName = 'webhook-fetch-only-deploy-setting';
        const deliveryId = 'delivery-fetch-only-deploy-setting';
        mockSuccessfulClone({ sha: '7'.repeat(40) });
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
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
            .run(stackName);
        mockGitClone.mockClear();

        expect(svc.webhookDeliveryRequiresDeploy(stackName, deliveryId)).toBe(false);
        const first = await svc.handleWebhookPull(stackName, false, deliveryId);
        expect(first.status).toBe('success');
        expect(svc.webhookDeliveryRequiresDeploy(stackName, deliveryId)).toBe(false);

        DatabaseService.getInstance().getDb()
            .prepare('UPDATE stack_git_sources SET last_debounce_at = ? WHERE stack_name = ?')
            .run(Date.now() - 999_999, stackName);
        mockGitClone.mockClear();
        const redelivery = await svc.handleWebhookPull(stackName, false, deliveryId);

        expect(redelivery.status).toBe('success');
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('fails closed on the auto-apply step alone: the fetch settles, the apply reservation fails, and no apply proceeds', async () => {
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: '6'.repeat(40) });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        try {
            await svc.upsert({
                stackName: 'webhook-apply-reservation-fails-closed',
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
        } finally {
            validateSpy.mockRestore();
        }
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('webhook-apply-reservation-fails-closed')!.id;

        // First call (the fetch) reserves normally; the second (the
        // auto-apply) fails, isolating the apply-stage reservation path.
        const originalReserve = GitOpsTransitions.prototype.reserveReconcileAttempt;
        const reserveSpy = vi.spyOn(GitOpsTransitions.prototype, 'reserveReconcileAttempt')
            .mockImplementationOnce(function (this: GitOpsTransitions, ...args: Parameters<typeof originalReserve>) {
                return originalReserve.apply(this, args);
            })
            .mockImplementationOnce(() => { throw new Error('simulated apply reservation failure'); });

        try {
            const result = await svc.handleWebhookPull(
                'webhook-apply-reservation-fails-closed',
                true,
                'delivery-apply-reservation-failure',
            );
            expect(result.status).toBe('error');
            expect(saveSpy).not.toHaveBeenCalled();
            // The fetch attempt settled normally; only the apply attempt
            // never got as far as being reserved at all.
            const unsettled = GitOpsStore.getInstance().listUnsettledReconcileAttempts()
                .filter((r) => r.application_id === applicationId);
            expect(unsettled).toHaveLength(0);
        } finally {
            reserveSpy.mockRestore();
        }

        DatabaseService.getInstance().getDb()
            .prepare('UPDATE stack_git_sources SET auto_apply_on_webhook = 0, last_debounce_at = ? WHERE stack_name = ?')
            .run(Date.now() - 999_999, 'webhook-apply-reservation-fails-closed');
        try {
            const redelivery = await svc.handleWebhookPull(
                'webhook-apply-reservation-fails-closed',
                true,
                'delivery-apply-reservation-failure',
            );
            expect(redelivery.status).toBe('success');
            expect(saveSpy).toHaveBeenCalledTimes(1);
        } finally {
            saveSpy.mockRestore();
        }
    });

    it('reserves and durably settles an attempt for a successful webhook fetch', async () => {
        mockSuccessfulClone({ sha: '8'.repeat(40) });
        const svc = GitSourceService.getInstance();
        await configureGitSource('webhook-reserves');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('webhook-reserves')!.id;
        mockGitClone.mockClear();
        mockSuccessfulClone({ sha: '9'.repeat(40) });

        const result = await svc.handleWebhookPull('webhook-reserves', true);

        expect(result.status).toBe('success');
        expect(historyOperationIds(applicationId, 'source_reconcile_settled').length).toBeGreaterThanOrEqual(1);
        expect(GitOpsStore.getInstance().listUnsettledReconcileAttempts().some((r) => r.application_id === applicationId)).toBe(false);
    });

    it('deduplicates a webhook redelivery by its stable delivery id after the debounce window expires', async () => {
        const sha = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
        mockSuccessfulClone({ sha });
        const svc = GitSourceService.getInstance();
        await configureGitSource('webhook-delivery-recorded');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('webhook-delivery-recorded')!.id;

        const first = await svc.handleWebhookPull('webhook-delivery-recorded', true, 'delivery-xyz');
        expect(first.status).toBe('success');

        DatabaseService.getInstance().getDb()
            .prepare('UPDATE stack_git_sources SET last_debounce_at = ? WHERE stack_name = ?')
            .run(Date.now() - 999_999, 'webhook-delivery-recorded');
        mockGitClone.mockClear();

        const redelivery = await svc.handleWebhookPull('webhook-delivery-recorded', true, 'delivery-xyz');

        expect(mockGitClone).not.toHaveBeenCalled();
        expect(redelivery.status).toBe('success');
        expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(1);
        expect(historyOperationIds(applicationId, 'source_reconcile_settled')).toHaveLength(1);
    });

    it('joins a concurrent redelivery to the whole webhook fetch-and-apply execution', async () => {
        const sha = 'a4'.repeat(20);
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        let releaseSave!: () => void;
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockImplementation(async () => { await saveGate; });

        try {
            await svc.upsert({
                stackName: 'webhook-whole-delivery-coalesce',
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
            const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('webhook-whole-delivery-coalesce')!.id;
            mockGitClone.mockClear();

            const first = svc.handleWebhookPull('webhook-whole-delivery-coalesce', true, 'delivery-whole-execution');
            await vi.waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
            const redelivery = svc.handleWebhookPull('webhook-whole-delivery-coalesce', true, 'delivery-whole-execution');
            releaseSave();
            const [firstResult, redeliveryResult] = await Promise.all([first, redelivery]);

            expect(redeliveryResult).toEqual(firstResult);
            expect(mockGitClone).toHaveBeenCalledTimes(1);
            expect(saveSpy).toHaveBeenCalledTimes(1);
            expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(2);
            expect(historyOperationIds(applicationId, 'source_reconcile_settled')).toHaveLength(2);
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
        }
    });

    it('does not add an apply step to a fetch-only delivery when settings change before redelivery', async () => {
        const sha = 'a2'.repeat(20);
        mockSuccessfulClone({ sha });
        const svc = GitSourceService.getInstance();
        await configureGitSource('webhook-redelivery-settings-change');

        const first = await svc.handleWebhookPull('webhook-redelivery-settings-change', true, 'delivery-settings-change');
        expect(first.status).toBe('success');

        const db = DatabaseService.getInstance().getDb();
        db.prepare('UPDATE stack_git_sources SET auto_apply_on_webhook = 1, last_debounce_at = ? WHERE stack_name = ?')
            .run(Date.now() - 999_999, 'webhook-redelivery-settings-change');
        const { FileSystemService } = await import('../services/FileSystemService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        mockGitClone.mockClear();

        try {
            const redelivery = await svc.handleWebhookPull('webhook-redelivery-settings-change', true, 'delivery-settings-change');
            expect(redelivery.status).toBe('success');
            expect(mockGitClone).not.toHaveBeenCalled();
            expect(saveSpy).not.toHaveBeenCalled();
        } finally {
            saveSpy.mockRestore();
        }
    });

    it('returns the stored apply failure when auto-apply is disabled before redelivery', async () => {
        const sha = 'a3'.repeat(20);
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockRejectedValue(new Error('simulated webhook deploy failure'));

        try {
            await svc.upsert({
                stackName: 'webhook-redelivery-apply-failure',
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: false,
                envPath: null,
                authType: 'none',
                autoApplyOnWebhook: true,
                autoDeployOnApply: true,
            });

            const first = await svc.handleWebhookPull('webhook-redelivery-apply-failure', true, 'delivery-apply-failure');
            expect(first.status).toBe('error');
            expect(first.message).toContain('simulated webhook deploy failure');

            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_apply_on_webhook = 0, auto_deploy_on_apply = 0, last_debounce_at = ? WHERE stack_name = ?')
                .run(Date.now() - 999_999, 'webhook-redelivery-apply-failure');
            mockGitClone.mockClear();
            saveSpy.mockClear();
            deploySpy.mockClear();

            const redelivery = await svc.handleWebhookPull('webhook-redelivery-apply-failure', true, 'delivery-apply-failure');

            expect(redelivery.status).toBe('error');
            expect(redelivery.message).toContain('simulated webhook deploy failure');
            expect(mockGitClone).not.toHaveBeenCalled();
            expect(saveSpy).not.toHaveBeenCalled();
            expect(deploySpy).not.toHaveBeenCalled();
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
            deploySpy.mockRestore();
        }
    });

    it('applies a webhook delivery without deploying when auto-deploy is off', async () => {
        // Truth-table counterpart to the deploy-fail case: with
        // auto_deploy_on_apply off, a successful webhook apply writes the
        // files and settles the attempt, and the deploy engine is never
        // touched.
        const sha = 'b0'.repeat(20);
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack');

        try {
            await svc.upsert({
                stackName: 'webhook-apply-only',
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
            const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('webhook-apply-only')!.id;
            const settledBefore = historyOperationIds(applicationId, 'source_reconcile_settled').length;

            const result = await svc.handleWebhookPull('webhook-apply-only', true, 'delivery-apply-only');

            expect(result.status).toBe('success');
            expect(saveSpy).toHaveBeenCalledTimes(1);
            expect(deploySpy).not.toHaveBeenCalled();
            // An auto-apply delivery tracks two reconciles (fetch + apply),
            // so assert convergence instead of an exact count: settled rows
            // grew, and none were left open.
            expect(historyOperationIds(applicationId, 'source_reconcile_settled').length).toBeGreaterThan(settledBefore);
            expect(GitOpsStore.getInstance().listUnsettledReconcileAttempts().some((r) => r.application_id === applicationId)).toBe(false);
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
            deploySpy.mockRestore();
        }
    });

    it('logs the recognized delivery id as a traceability breadcrumb when a webhook pull fails', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ sha: '6'.repeat(40) });
        await configureGitSource('webhook-delivery-breadcrumb');
        mockGitClone.mockClear();
        mockGitClone.mockRejectedValueOnce(new Error('simulated network failure'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const result = await svc.handleWebhookPull('webhook-delivery-breadcrumb', true, 'delivery-log-1');
            expect(result.status).toBe('error');
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('(delivery delivery-log-1)'));
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('runs a single clone for a concurrent webhook fan-out', async () => {
        // Concurrent deliveries all reserve and join one shared fetch. Every
        // caller receives the leader's normalized result, while only the
        // leader performs the clone.
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
            Array.from({ length: 5 }, () => svc.handleWebhookPull('fanout-stack', true)),
        );

        expect(mockGitClone.mock.calls.length).toBe(1);
        expect(results.filter(r => r.status === 'success')).toHaveLength(5);
        expect(results.filter(r => r.status === 'skipped')).toHaveLength(0);
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('fanout-stack')!.id;
        const settled = settledAttemptsForApplication(applicationId);
        expect(settled).toHaveLength(5);
        expect(new Set(settled.map((row) => row.after_json)).size).toBe(1);
        validateSpy.mockRestore();
    });

    it('coalesces a webhook fetch with a concurrent manual pull', async () => {
        const sha = 'ef'.repeat(20);
        mockSuccessfulClone({ sha });
        const svc = GitSourceService.getInstance();
        await configureGitSource('webhook-manual-fetch-coalesce');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('webhook-manual-fetch-coalesce')!.id;

        let releaseClone!: () => void;
        const cloneGate = new Promise<void>((resolve) => { releaseClone = resolve; });
        mockGitClone.mockClear();
        mockGitClone.mockImplementation(async (args: { dir: string }) => {
            await cloneGate;
            const { promises: fsp } = await import('fs');
            const path = await import('path');
            await fsp.writeFile(path.join(args.dir, 'compose.yaml'), 'services:\n  x:\n    image: alpine\n', 'utf-8');
        });
        mockGitLog.mockResolvedValue([{ oid: sha }]);

        const webhook = svc.handleWebhookPull('webhook-manual-fetch-coalesce', true, 'delivery-cross-producer');
        await vi.waitFor(() => expect(mockGitClone).toHaveBeenCalledTimes(1));
        const manual = svc.pull('webhook-manual-fetch-coalesce');
        releaseClone();
        const [webhookResult, manualResult] = await Promise.all([webhook, manual]);

        expect(webhookResult.status).toBe('success');
        expect(manualResult.commitSha).toBe(sha);
        expect(mockGitClone).toHaveBeenCalledTimes(1);
        const settled = DatabaseService.getInstance().getDb()
            .prepare("SELECT after_json FROM gitops_history WHERE application_id = ? AND stage = 'source_reconcile_settled'")
            .all(applicationId) as { after_json: string }[];
        expect(settled).toHaveLength(2);
        expect(new Set(settled.map((row) => row.after_json)).size).toBe(1);
    });

    it('coalesces a manual pull with a concurrent webhook fetch', async () => {
        const sha = 'f0'.repeat(20);
        mockSuccessfulClone({ sha });
        const svc = GitSourceService.getInstance();
        await configureGitSource('manual-webhook-fetch-coalesce');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('manual-webhook-fetch-coalesce')!.id;

        let releaseClone!: () => void;
        const cloneGate = new Promise<void>((resolve) => { releaseClone = resolve; });
        mockGitClone.mockClear();
        mockGitClone.mockImplementation(async (args: { dir: string }) => {
            await cloneGate;
            const { promises: fsp } = await import('fs');
            const path = await import('path');
            await fsp.writeFile(path.join(args.dir, 'compose.yaml'), 'services:\n  x:\n    image: alpine\n', 'utf-8');
        });
        mockGitLog.mockResolvedValue([{ oid: sha }]);

        const manual = svc.pull('manual-webhook-fetch-coalesce');
        await vi.waitFor(() => expect(mockGitClone).toHaveBeenCalledTimes(1));
        const webhook = svc.handleWebhookPull('manual-webhook-fetch-coalesce', true, 'delivery-manual-leader');
        releaseClone();
        const [manualResult, webhookResult] = await Promise.all([manual, webhook]);

        expect(manualResult.commitSha).toBe(sha);
        expect(webhookResult.status).toBe('success');
        expect(mockGitClone).toHaveBeenCalledTimes(1);
        const settled = settledAttemptsForApplication(applicationId);
        expect(settled).toHaveLength(2);
        expect(new Set(settled.map((row) => row.after_json)).size).toBe(1);
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

        const result = await svc.handleWebhookPull('webhook-validate-fail', true);
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

        const result = await svc.handleWebhookPull('webhook-shared-lock', true);
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/already in progress/i);
        expect(runExclusive).toHaveBeenCalledWith(
            expect.any(Number),
            'webhook-shared-lock',
            'git_apply',
            'system:webhook',
            expect.any(Function),
            undefined,
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

    it('reserves and durably settles an attempt for a successful pull', async () => {
        await createFromGit('pull-reserves', '2'.repeat(40));
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx:2\n', sha: '3'.repeat(40) });
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('pull-reserves')!.id;

        await svc.pull('pull-reserves');

        expect(historyOperationIds(applicationId, 'source_reconcile_settled').length).toBeGreaterThanOrEqual(1);
    });

    it('stamps the pending fetch record with the same operation id the reserved attempt used, not an independent one', async () => {
        await createFromGit('pull-pending-lineage', '2'.repeat(40));
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx:2\n', sha: '3'.repeat(40) });
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('pull-pending-lineage')!.id;

        await svc.pull('pull-pending-lineage');

        const [reservedOperationId] = historyOperationIds(applicationId, 'source_reconcile_started');
        expect(reservedOperationId).toBeTruthy();
        const row = DatabaseService.getInstance().getGitSource('pull-pending-lineage');
        const decoded = (svc as unknown as {
            decodePendingCompose: (raw: string) => { operationId: string | null };
        }).decodePendingCompose(row!.pending_compose_content!);
        expect(decoded.operationId).toBe(reservedOperationId);
    });

    it('coalesces two concurrent pulls for the same stack into one clone', async () => {
        const svc = GitSourceService.getInstance();
        await createFromGit('pull-coalesce', '4'.repeat(40));

        let releaseClone!: () => void;
        const gate = new Promise<void>((resolve) => { releaseClone = resolve; });
        mockGitClone.mockClear();
        mockGitClone.mockImplementation(async (args: { dir: string }) => {
            await gate;
            const { promises: fsp } = await import('fs');
            const path = await import('path');
            const composeAbs = path.join(args.dir, 'compose.yaml');
            await fsp.mkdir(path.dirname(composeAbs), { recursive: true });
            await fsp.writeFile(composeAbs, 'services:\n  web:\n    image: nginx:3\n', 'utf-8');
        });
        mockGitLog.mockResolvedValue([{ oid: '5'.repeat(40) }]);

        const first = svc.pull('pull-coalesce');
        const second = svc.pull('pull-coalesce');
        releaseClone();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(mockGitClone).toHaveBeenCalledTimes(1);
        expect(secondResult).toEqual(firstResult);
    });

    it('fails closed and does not clone when reservation itself fails', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ sha: '1'.repeat(40) });
        await configureGitSource('pull-reservation-fails-closed');
        mockGitClone.mockClear();
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('pull-reservation-fails-closed')!.id;
        const reserveSpy = vi.spyOn(GitOpsTransitions.prototype, 'allocateReconcileAttempt')
            .mockImplementationOnce(() => { throw new Error('simulated reservation failure'); });

        try {
            await expect(svc.pull('pull-reservation-fails-closed')).rejects.toMatchObject({ code: 'GIT_ERROR' });
            expect(mockGitClone).not.toHaveBeenCalled();
            expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(0);
        } finally {
            reserveSpy.mockRestore();
        }
    });

    it('fails closed and does not clone when the application was detached but the source config survives', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ sha: '1'.repeat(40) });
        await configureGitSource('pull-tombstoned-app');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('pull-tombstoned-app')!.id;
        GitOpsTransitions.getInstance().applicationTombstoned(applicationId, 'detached', {
            operationId: 'op-detach-1', actor: 'tester', trigger: 'test', at: Date.now(),
        });
        expect(DatabaseService.getInstance().getGitSource('pull-tombstoned-app')).toBeDefined();
        mockGitClone.mockClear();
        const activitySpy = vi.spyOn(DatabaseService.getInstance(), 'addNotificationHistory');

        try {
            await expect(svc.pull('pull-tombstoned-app')).rejects.toMatchObject({
                code: 'GIT_ERROR',
                message: expect.stringContaining('GitOps tracking was removed'),
            });
            expect(mockGitClone).not.toHaveBeenCalled();
            expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(0);
            expect(activitySpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                category: 'git_pull_failed',
                stack_name: 'pull-tombstoned-app',
            }));
        } finally {
            activitySpy.mockRestore();
        }
    });

    it('fails closed when the application was deleted, then restores tracked pulls after reconfiguration', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ sha: '4'.repeat(40) });
        await configureGitSource('pull-deleted-app-refused');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('pull-deleted-app-refused')!.id;
        GitOpsTransitions.getInstance().applicationTombstoned(applicationId, 'deleted', {
            operationId: 'op-delete-1', actor: 'tester', trigger: 'test', at: Date.now(),
        });
        mockGitClone.mockClear();

        await expect(svc.pull('pull-deleted-app-refused')).rejects.toMatchObject({
            code: 'GIT_ERROR',
            message: expect.stringContaining('GitOps tracking is unavailable'),
        });
        expect(mockGitClone).not.toHaveBeenCalled();

        await configureGitSource('pull-deleted-app-refused');
        expect(GitOpsStore.getInstance().getLiveDirectApplication('pull-deleted-app-refused')?.id).not.toBe(applicationId);
        mockGitClone.mockClear();
        await svc.pull('pull-deleted-app-refused');
        expect(mockGitClone).toHaveBeenCalledTimes(1);
    });

    it('falls through to the ordinary no-source error for a completed detach, not the detach-in-progress message', async () => {
        // detach() commits applicationTombstoned('detached') and
        // deleteGitSource in one transaction, so a routine, fully
        // successful detach leaves exactly this state: a detached
        // tombstone with NO surviving source row. The detach-in-progress
        // refusal must not fire here, or every previously-detached stack
        // name would get a false, unactionable message instead of the
        // real, correct "no source configured" error.
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ sha: '5'.repeat(40) });
        await configureGitSource('pull-completed-detach');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('pull-completed-detach')!.id;
        GitOpsTransitions.getInstance().applicationTombstoned(applicationId, 'detached', {
            operationId: 'op-detach-4', actor: 'tester', trigger: 'test', at: Date.now(),
        });
        DatabaseService.getInstance().deleteGitSource('pull-completed-detach');
        mockGitClone.mockClear();

        await expect(svc.pull('pull-completed-detach')).rejects.toMatchObject({
            code: 'GIT_ERROR',
            message: 'No Git source configured for this stack.',
        });
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('does not mask the real pull failure when deriving the settlement result afterward also throws', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ sha: '1'.repeat(40) });
        await configureGitSource('pull-mask-error');
        // A real gitops application exists (so this call reserves an
        // attempt), but the source config row is now gone, so pullLocked
        // itself throws a specific, truthful error.
        DatabaseService.getInstance().deleteGitSource('pull-mask-error');
        const deriveSpy = vi.spyOn(svc as unknown as { deriveReconcileResult: (s: string) => unknown }, 'deriveReconcileResult')
            .mockImplementationOnce(() => { throw new Error('derivation boom'); });

        try {
            await expect(svc.pull('pull-mask-error')).rejects.toMatchObject({
                code: 'GIT_ERROR',
                message: expect.stringContaining('No Git source configured'),
            });
        } finally {
            deriveSpy.mockRestore();
        }
    });

    it('fails closed when a reservation collision is forced with no in-process leader', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ sha: '1'.repeat(40) });
        await configureGitSource('pull-forced-collision');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('pull-forced-collision')!.id;
        const nextSeq = GitOpsStore.getInstance().getApplication(applicationId)!.attempt_seq + 1;
        const predictedOperationId = `${applicationId}:attempt:${nextSeq}`;
        // Force the exact operation id pull() is about to allocate to
        // already be reserved, simulating a collision with no in-process
        // leader for it. The call must not run untracked work under an
        // operation id already owned by another submission.
        GitOpsTransitions.getInstance().reserveReconcileAttempt(applicationId, {
            operationId: predictedOperationId, actor: 'someone-else', trigger: 'poll', at: Date.now(),
        });
        mockSuccessfulClone({ sha: '2'.repeat(40) });
        mockGitClone.mockClear();
        await expect(svc.pull('pull-forced-collision')).rejects.toMatchObject({
            code: 'GIT_ERROR',
            message: expect.stringContaining('already recorded'),
        });
        expect(mockGitClone).not.toHaveBeenCalled();
    });

    it('settles a coalesced follower\'s own attempt even when the leader\'s fetch rejects', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ sha: '1'.repeat(40) });
        await configureGitSource('pull-follower-settles-on-reject');
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('pull-follower-settles-on-reject')!.id;

        let releaseClone!: () => void;
        const gate = new Promise<void>((resolve) => { releaseClone = resolve; });
        mockGitClone.mockClear();
        mockGitClone.mockImplementation(async () => {
            await gate;
            throw new Error('simulated clone failure');
        });

        const first = svc.pull('pull-follower-settles-on-reject');
        const second = svc.pull('pull-follower-settles-on-reject');
        releaseClone();
        await expect(first).rejects.toThrow('simulated clone failure');
        await expect(second).rejects.toThrow('simulated clone failure');

        // Both the leader's and the follower's own reservations must be
        // durably settled; neither may be left open waiting for a crash
        // that never happened.
        expect(GitOpsStore.getInstance().listUnsettledReconcileAttempts().some((r) => r.application_id === applicationId)).toBe(false);
    });

    function generationCount(stackName: string): number {
        const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName)!;
        return (DatabaseService.getInstance().getDb()
            .prepare('SELECT COUNT(*) AS n FROM gitops_generations WHERE application_id = ?')
            .get(app.id) as { n: number }).n;
    }

    async function createFromGit(stackName: string, sha: string, autoApplyOnWebhook = false): Promise<void> {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx\n', sha });
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        try {
            await svc.createStackFromGit({
                stackName,
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: false,
                envPath: null,
                authType: 'none',
                token: null,
                autoApplyOnWebhook,
                autoDeployOnApply: false,
            });
        } finally {
            validateSpy.mockRestore();
        }
    }

    it('an up-to-date pull against an accepted commit opens a fresh staging generation', async () => {
        // Deliberate counterpart to the dedupe below: once the candidate was
        // accepted, nothing is staged, and staging again is a new dispatch
        // cycle that apply needs as its acceptance target.
        const svc = GitSourceService.getInstance();
        await createFromGit('pull-after-apply', '1111111111111111111111111111111111111111');
        const base = generationCount('pull-after-apply');

        await svc.pull('pull-after-apply');
        expect(generationCount('pull-after-apply')).toBe(base + 1);
        const app = GitOpsStore.getInstance().getLiveDirectApplication('pull-after-apply')!;
        expect(app.candidate_generation_id).toBeTruthy();
        expect(DatabaseService.getInstance().getGitSource('pull-after-apply')?.pending_commit_sha).toBeTruthy();
        await cleanupStackDir('pull-after-apply');
    });

    it('repeat pulls of an unapplied update keep one candidate', async () => {
        const svc = GitSourceService.getInstance();
        await createFromGit('pull-repeat', '2222222222222222222222222222222222222222');
        const base = generationCount('pull-repeat');

        const updatedSha = '3333333333333333333333333333333333333333';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx:1.29\n',
            sha: updatedSha,
        });
        await svc.pull('pull-repeat');
        const stagedId = GitOpsStore.getInstance().getLiveDirectApplication('pull-repeat')!.candidate_generation_id;
        expect(stagedId).toBeTruthy();
        expect(generationCount('pull-repeat')).toBe(base + 1);

        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx:1.29\n',
            sha: updatedSha,
        });
        await svc.pull('pull-repeat');
        expect(generationCount('pull-repeat')).toBe(base + 1);
        expect(GitOpsStore.getInstance().getLiveDirectApplication('pull-repeat')!.candidate_generation_id).toBe(stagedId);
        expect(DatabaseService.getInstance().getGitSource('pull-repeat')?.pending_commit_sha).toBe(updatedSha);
        await cleanupStackDir('pull-repeat');
    });

    it('a pull whose source fingerprint drifted from the staged candidate mints anew', async () => {
        const svc = GitSourceService.getInstance();
        await createFromGit('pull-fp-drift', '4444444444444444444444444444444444444444');
        const base = generationCount('pull-fp-drift');
        const updatedSha = '5555555555555555555555555555555555555555';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx:1.29\n',
            sha: updatedSha,
        });
        await svc.pull('pull-fp-drift');
        const stagedId = GitOpsStore.getInstance().getLiveDirectApplication('pull-fp-drift')!.candidate_generation_id;
        expect(stagedId).toBeTruthy();

        // Simulates a standing candidate produced under different source
        // wiring than the configuration in effect now. Commit and plan
        // verdict are unchanged, but the fingerprint term alone must defeat
        // equivalence so the candidate never misrepresents what a pull stages.
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE gitops_generations SET materialization_fingerprint = ? WHERE id = ?')
            .run('drifted-fingerprint', stagedId);

        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx:1.29\n',
            sha: updatedSha,
        });
        await svc.pull('pull-fp-drift');
        expect(generationCount('pull-fp-drift')).toBe(base + 2);
        expect(GitOpsStore.getInstance().getLiveDirectApplication('pull-fp-drift')!.candidate_generation_id).not.toBe(stagedId);
        await cleanupStackDir('pull-fp-drift');
    });

    it('a pull whose plan verdict differs from the staged candidate mints anew', async () => {
        const svc = GitSourceService.getInstance();
        await createFromGit('pull-verdict-flip', '6666666666666666666666666666666666666666');
        const base = generationCount('pull-verdict-flip');
        const updatedSha = '7777777777777777777777777777777777777777';
        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx:1.29\n',
            sha: updatedSha,
        });
        await svc.pull('pull-verdict-flip');
        const stagedId = GitOpsStore.getInstance().getLiveDirectApplication('pull-verdict-flip')!.candidate_generation_id;
        expect(stagedId).toBeTruthy();
        const seeded = DatabaseService.getInstance().getDb()
            .prepare('SELECT plan_blocked FROM gitops_generations WHERE id = ?')
            .get(stagedId) as { plan_blocked: number };
        expect(seeded.plan_blocked).toBe(0);

        // The plan is re-evaluated on every pull and can flip without a new
        // commit, for example when stack policy changes between pulls.
        // Simulating a candidate staged under the other verdict proves the
        // verdict term defeats equivalence on its own.
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE gitops_generations SET plan_blocked = 1 WHERE id = ?')
            .run(stagedId);

        mockSuccessfulClone({
            compose: 'services:\n  web:\n    image: nginx:1.29\n',
            sha: updatedSha,
        });
        await svc.pull('pull-verdict-flip');
        expect(generationCount('pull-verdict-flip')).toBe(base + 2);
        expect(GitOpsStore.getInstance().getLiveDirectApplication('pull-verdict-flip')!.candidate_generation_id).not.toBe(stagedId);
        await cleanupStackDir('pull-verdict-flip');
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

    it('a newly created eligible source receives an initial poll cursor', async () => {
        const sha = 'curs00000000000000000000000000000000001';
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx\n', sha });
        DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '5');
        const svc = GitSourceService.getInstance();
        try {
            await svc.createStackFromGit({
                stackName: 'create-cursor',
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

            // Create defaults to review, which is unattended-eligible, so the
            // application row leaves the create with a durable wake already
            // armed: no global settings PATCH is needed to start polling.
            const application = GitOpsStore.getInstance().getLiveDirectApplication('create-cursor');
            expect(application?.source_policy).toBe('review');
            expect(application?.next_poll_at).not.toBeNull();
            expect(application!.next_poll_at!).toBeGreaterThan(Date.now());
            expect(application!.next_poll_at!).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
            const history = DatabaseService.getInstance().getDb()
                .prepare("SELECT COUNT(*) AS n FROM gitops_history WHERE stack_name = ? AND stage = 'source_poll_scheduled'")
                .get('create-cursor') as { n: number };
            expect(history.n).toBe(1);
        } finally {
            DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '0');
            DatabaseService.getInstance().getDb()
                .prepare('DELETE FROM gitops_applications WHERE stack_name = ?')
                .run('create-cursor');
            await cleanupStackDir('create-cursor');
        }
    });

    it('a newly created manual source stays out of the cadence', async () => {
        const sha = 'curs00000000000000000000000000000000002';
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx\n', sha });
        DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '5');
        const svc = GitSourceService.getInstance();
        try {
            await svc.createStackFromGit({
                stackName: 'create-cursor-manual',
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: false,
                envPath: null,
                authType: 'none',
                token: null,
                autoApplyOnWebhook: true,
                autoDeployOnApply: false,
                sourcePolicy: 'manual',
            });
            const application = GitOpsStore.getInstance().getLiveDirectApplication('create-cursor-manual');
            expect(application?.source_policy).toBe('manual');
            expect(application?.next_poll_at).toBeNull();
        } finally {
            DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '0');
            DatabaseService.getInstance().getDb()
                .prepare('DELETE FROM gitops_applications WHERE stack_name = ?')
                .run('create-cursor-manual');
            await cleanupStackDir('create-cursor-manual');
        }
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

    function liveApp(stackName: string) {
        return GitOpsStore.getInstance().getLiveDirectApplication(stackName);
    }

    it('fails closed and does not write or deploy when reservation itself fails, even for a deploying apply', async () => {
        const sha = 'df'.repeat(20);
        const svc = await seedPending('apply-reservation-fails-closed', 'services:\n  x:\n    image: alpine\n', sha);
        const applicationId = liveApp('apply-reservation-fails-closed')!.id;
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack');
        const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
        const reserveSpy = vi.spyOn(GitOpsTransitions.prototype, 'allocateReconcileAttempt')
            .mockImplementationOnce(() => { throw new Error('simulated reservation failure'); });

        try {
            await expect(svc.apply('apply-reservation-fails-closed', sha, { ...SKIP_PLAN_FINGERPRINT, deploy: true }))
                .rejects.toMatchObject({ code: 'GIT_ERROR' });
            expect(saveSpy).not.toHaveBeenCalled();
            expect(deploySpy).not.toHaveBeenCalled();
            // No new attempt at all, settled or unsettled: reservation
            // itself never landed, so there is nothing new to track.
            expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore);
        } finally {
            saveSpy.mockRestore();
            deploySpy.mockRestore();
            reserveSpy.mockRestore();
        }
    });

    it('fails closed and does not write when the application was detached but the pending commit survives', async () => {
        const sha = 'db'.repeat(20);
        const svc = await seedPending('apply-tombstoned-app', 'services:\n  x:\n    image: alpine\n', sha);
        const applicationId = liveApp('apply-tombstoned-app')!.id;
        GitOpsTransitions.getInstance().applicationTombstoned(applicationId, 'detached', {
            operationId: 'op-detach-2', actor: 'tester', trigger: 'test', at: Date.now(),
        });
        expect(DatabaseService.getInstance().getGitSource('apply-tombstoned-app')?.pending_commit_sha).toBe(sha);
        const { FileSystemService } = await import('../services/FileSystemService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        const activitySpy = vi.spyOn(DatabaseService.getInstance(), 'addNotificationHistory');

        try {
            await expect(svc.apply('apply-tombstoned-app', sha, SKIP_PLAN_FINGERPRINT)).rejects.toMatchObject({
                code: 'GIT_ERROR',
                message: expect.stringContaining('GitOps tracking was removed'),
            });
            expect(saveSpy).not.toHaveBeenCalled();
            expect(activitySpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                category: 'git_apply_failed',
                stack_name: 'apply-tombstoned-app',
            }));
        } finally {
            saveSpy.mockRestore();
            activitySpy.mockRestore();
        }
    });

    it('fails closed and does not write or deploy when the application was deleted but the pending commit survives', async () => {
        const sha = 'dc'.repeat(20);
        const svc = await seedPending('apply-deleted-app', 'services:\n  x:\n    image: alpine\n', sha);
        const applicationId = liveApp('apply-deleted-app')!.id;
        GitOpsTransitions.getInstance().applicationTombstoned(applicationId, 'deleted', {
            operationId: 'op-delete-apply', actor: 'tester', trigger: 'test', at: Date.now(),
        });
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack');

        try {
            await expect(svc.apply('apply-deleted-app', sha, { ...SKIP_PLAN_FINGERPRINT, deploy: true }))
                .rejects.toMatchObject({
                    code: 'GIT_ERROR',
                    message: expect.stringContaining('GitOps tracking is unavailable'),
                });
            expect(saveSpy).not.toHaveBeenCalled();
            expect(deploySpy).not.toHaveBeenCalled();
        } finally {
            saveSpy.mockRestore();
            deploySpy.mockRestore();
        }
    });

    it('reserves and durably settles an attempt for a successful apply', async () => {
        const sha = '6'.repeat(40);
        const svc = await seedPending('apply-reserves', 'services:\n  x:\n    image: alpine\n', sha);
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();

        try {
            const applicationId = liveApp('apply-reserves')!.id;
            await svc.apply('apply-reserves', sha, SKIP_PLAN_FINGERPRINT);

            const settled = historyOperationIds(applicationId, 'source_reconcile_settled');
            const applied = historyOperationIds(applicationId, 'applied');
            expect(settled.length).toBeGreaterThanOrEqual(1);
            expect(applied).toHaveLength(1);
            expect(settled).toContain(applied[0]);
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
        }
    });

    it('coalesces two concurrent applies for the same commit into one execution', async () => {
        const sha = '7'.repeat(40);
        const svc = await seedPending('apply-coalesce', 'services:\n  x:\n    image: alpine\n', sha);
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        let releaseSave!: () => void;
        const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockImplementation(async () => { await gate; });

        try {
            const first = svc.apply('apply-coalesce', sha, SKIP_PLAN_FINGERPRINT);
            const second = svc.apply('apply-coalesce', sha, SKIP_PLAN_FINGERPRINT);
            releaseSave();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            expect(saveSpy).toHaveBeenCalledTimes(1);
            expect(secondResult).toEqual(firstResult);
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
        }
    });

    it('does not coalesce two concurrent applies that resolve to different deploy behavior', async () => {
        const sha = 'ba'.repeat(20);
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
        const seedValidateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        try {
            await svc.upsert({
                stackName: 'apply-deploy-mismatch',
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: false,
                envPath: null,
                authType: 'none',
                autoApplyOnWebhook: true,
                autoDeployOnApply: true,
            });
            await svc.pull('apply-deploy-mismatch');
        } finally {
            seedValidateSpy.mockRestore();
        }
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        let releaseSave!: () => void;
        const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockImplementation(async () => { await gate; });
        const { ComposeService } = await import('../services/ComposeService');
        const { HealthGateService } = await import('../services/HealthGateService');
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
        const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack').mockReturnValue('gate-git');

        try {
            // The stack has auto_deploy_on_apply: true. The first call
            // leaves deploy unresolved (so it resolves to true); the
            // second explicitly asks not to deploy. These must never
            // share a coalesce key: if they wrongly joined, the second
            // call would resolve successfully with the first's deployed
            // result instead of running (or failing) on its own terms.
            // Since they do not join, and applying clears the pending
            // commit, the second genuinely has nothing left to apply
            // once the first (which the per-stack lock serializes first)
            // completes -- a real, honest failure, not a borrowed result.
            const first = svc.apply('apply-deploy-mismatch', sha, SKIP_PLAN_FINGERPRINT);
            const second = svc.apply('apply-deploy-mismatch', sha, { ...SKIP_PLAN_FINGERPRINT, deploy: false });
            releaseSave();
            const firstResult = await first;
            expect(firstResult.deployed).toBe(true);
            await expect(second).rejects.toMatchObject({ code: 'GIT_ERROR' });
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
            deploySpy.mockRestore();
            beginSpy.mockRestore();
        }
    });

    describe('reconcile', () => {
        // A legacy boolean of false derives the review policy, so a staged
        // candidate requires review: facet source_review_pending projects the
        // pending_review outcome instead of the old always-ready staging.
        it('reports pending_review after a fetch-intent reconcile stages a new candidate', async () => {
            const sha = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
            const svc = GitSourceService.getInstance();
            await svc.upsert({
                stackName: 'reconcile-fetch',
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
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            try {
                const applicationId = liveApp('reconcile-fetch')!.id;
                const result = await svc.reconcile({
                    intent: 'fetch',
                    applicationId,
                    stackName: 'reconcile-fetch',
                    trigger: 'manual',
                    actor: 'tester',
                });
                expect(result.outcome).toBe('pending_review');
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('reports no_source_change after an apply-intent reconcile accepts the candidate', async () => {
            const sha = 'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2';
            const svc = await seedPending('reconcile-apply', 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();

            try {
                const applicationId = liveApp('reconcile-apply')!.id;
                const result = await svc.reconcile({
                    intent: 'apply',
                    applicationId,
                    stackName: 'reconcile-apply',
                    trigger: 'manual',
                    actor: 'tester',
                    commitSha: sha,
                    planFingerprint: '',
                    deploy: false,
                });
                expect(result.outcome).toBe('no_source_change');
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
            }
        });

        it('does not report success when the source applied but the deploy failed', async () => {
            const sha = 'e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7';
            const svc = await seedPending('reconcile-apply-deploy-fail', 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            const { ComposeService } = await import('../services/ComposeService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockRejectedValue(
                new Error('compose up failed: docker unavailable'),
            );

            try {
                const applicationId = liveApp('reconcile-apply-deploy-fail')!.id;
                const result = await svc.reconcile({
                    intent: 'apply',
                    applicationId,
                    stackName: 'reconcile-apply-deploy-fail',
                    trigger: 'manual',
                    actor: 'tester',
                    commitSha: sha,
                    planFingerprint: '',
                    deploy: true,
                });
                // The promotion itself succeeded (files landed, generation
                // accepted), so the source facet alone reads as converged.
                // reconcile must not let that mask the deploy failure, and must
                // not claim the previous generation is unchanged either: it isn't.
                expect(result.outcome).toBe('recovery_required');
                expect(result.nextAction).toBe('view_target_results');
                expect(result.reason).toMatch(/deploy/i);
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('reports a truthful failure, not the stale staged-candidate outcome, when fetch throws before touching the application row', async () => {
            const sha = 'e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3';
            const svc = await seedPending('reconcile-fetch-fail', 'services:\n  x:\n    image: alpine\n', sha);
            const applicationId = liveApp('reconcile-fetch-fail')!.id;
            // Deleting the config row makes pullLocked throw its `!src` guard,
            // which fires before fetchStarted opens any transition: the
            // application row is untouched by this failure.
            DatabaseService.getInstance().deleteGitSource('reconcile-fetch-fail');

            const result = await svc.reconcile({
                intent: 'fetch',
                applicationId,
                stackName: 'reconcile-fetch-fail',
                trigger: 'manual',
                actor: 'tester',
            });

            expect(result.outcome).not.toBe('candidate_already_fetched');
            expect(result.nextAction).not.toBe('none');
        });

        it('reports a truthful failure, not the stale staged-candidate outcome, when apply throws on a stale commitSha', async () => {
            const sha = 'e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4';
            const svc = await seedPending('reconcile-apply-stale-sha', 'services:\n  x:\n    image: alpine\n', sha);
            const applicationId = liveApp('reconcile-apply-stale-sha')!.id;

            const result = await svc.reconcile({
                intent: 'apply',
                applicationId,
                stackName: 'reconcile-apply-stale-sha',
                trigger: 'manual',
                actor: 'tester',
                commitSha: 'ffffffffffffffffffffffffffffffffffffffff',
                planFingerprint: '',
                deploy: false,
            });

            expect(result.outcome).not.toBe('candidate_already_fetched');
            expect(result.nextAction).not.toBe('none');
        });

        it('fails closed instead of silently reconciling the wrong application when the requested applicationId is stale', async () => {
            const sha = 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5';
            const svc = await seedPending('reconcile-stale-app-id', 'services:\n  x:\n    image: alpine\n', sha);

            const result = await svc.reconcile({
                intent: 'fetch',
                applicationId: 'no-longer-the-live-application',
                stackName: 'reconcile-stale-app-id',
                trigger: 'manual',
                actor: 'tester',
            });

            expect(result.outcome).toBe('unknown');
            expect(result.nextAction).toBe('none');
            // Fails closed before doing anything: the candidate this stack had
            // staged before the call is still exactly as it was.
            const stillStaged = liveApp('reconcile-stale-app-id');
            expect(stillStaged?.candidate_generation_id).toBeTruthy();
        });

        it('fails closed on a stale applicationId even when the live application is stuck in creating, not active', async () => {
            const sha = 'e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6';
            const svc = await seedPending('reconcile-creating-app', 'services:\n  x:\n    image: alpine\n', sha);
            const applicationId = liveApp('reconcile-creating-app')!.id;
            // gitopsApplicationFor() (used elsewhere to gate transitions) only
            // recognizes 'active' rows, but getLiveDirectApplication() (used
            // by deriveReconcileResult) recognizes 'active' and 'creating'
            // alike. reconcile's identity guard must use the same broad
            // definition, or a 'creating' row slips past it entirely.
            DatabaseService.getInstance().getDb()
                .prepare("UPDATE gitops_applications SET lifecycle_status = 'creating' WHERE id = ?")
                .run(applicationId);

            const result = await svc.reconcile({
                intent: 'apply',
                applicationId: 'deliberately-mismatched-id',
                stackName: 'reconcile-creating-app',
                trigger: 'manual',
                actor: 'tester',
                commitSha: 'ffffffffffffffffffffffffffffffffffffffff',
                planFingerprint: '',
                deploy: false,
            });

            expect(result.outcome).toBe('unknown');
            expect(result.nextAction).toBe('none');
            // Fails closed before doing anything: the candidate this stack
            // had staged before the call is still exactly as it was.
            const stillStaged = liveApp('reconcile-creating-app');
            expect(stillStaged?.candidate_generation_id).toBeTruthy();
        });

        it('fails closed instead of silently applying under the current live application when the requested applicationId still exists but was superseded', async () => {
            const sha = 'e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7';
            const svc = await seedPending('reconcile-apply-superseded-id', 'services:\n  x:\n    image: alpine\n', sha);
            const staleApplicationId = liveApp('reconcile-apply-superseded-id')!.id;
            // A real row that used to be live for this stack, not a
            // fabricated id: this is the exact gap the existing stale-id
            // tests (using ids that never existed as any row) do not cover,
            // since GitOpsStore.getApplication finds this row just fine.
            GitOpsTransitions.getInstance().applicationTombstoned(staleApplicationId, 'detached', {
                operationId: 'op-supersede-1', actor: 'tester', trigger: 'test', at: Date.now(),
            });
            const config: DirectSourceConfig = {
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: false,
                envPath: null,
            };
            GitOpsStore.getInstance().insertApplication(buildDirectApplicationRow({
                id: newGitOpsId(),
                stackName: 'reconcile-apply-superseded-id',
                config,
                identity: directSourceIdentity(config),
                lifecycleStatus: 'active',
                at: Date.now(),
            }, 'automatic'));
            const newLiveId = liveApp('reconcile-apply-superseded-id')!.id;
            expect(newLiveId).not.toBe(staleApplicationId);

            const applySpy = vi.spyOn(
                svc as unknown as { applyWithSharedLock: (...args: unknown[]) => Promise<unknown> },
                'applyWithSharedLock',
            );

            try {
                const result = await svc.reconcile({
                    intent: 'apply',
                    applicationId: staleApplicationId,
                    stackName: 'reconcile-apply-superseded-id',
                    trigger: 'manual',
                    actor: 'tester',
                    commitSha: 'ffffffffffffffffffffffffffffffffffffffff',
                    planFingerprint: '',
                    deploy: false,
                });

                expect(result.outcome).toBe('unknown');
                expect(result.nextAction).toBe('none');
                expect(applySpy).not.toHaveBeenCalled();
            } finally {
                applySpy.mockRestore();
            }
        });

        it('revalidates the application identity after acquiring the fetch lock', async () => {
            const svc = GitSourceService.getInstance();
            mockSuccessfulClone({ sha: 'fa'.repeat(20) });
            await configureGitSource('reconcile-fetch-replaced-while-queued');
            const staleApplicationId = liveApp('reconcile-fetch-replaced-while-queued')!.id;
            mockGitClone.mockClear();

            let releaseLock!: () => void;
            const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
            const lockHolder = (svc as unknown as {
                withStackLock: <T>(stackName: string, fn: () => Promise<T>) => Promise<T>;
            }).withStackLock('reconcile-fetch-replaced-while-queued', () => lockGate);

            const reconcile = svc.reconcile({
                intent: 'fetch',
                applicationId: staleApplicationId,
                stackName: 'reconcile-fetch-replaced-while-queued',
                trigger: 'poll',
                actor: 'system:source-controller',
            });
            await vi.waitFor(() => {
                expect(historyOperationIds(staleApplicationId, 'source_reconcile_started')).toHaveLength(1);
            });

            GitOpsTransitions.getInstance().applicationTombstoned(staleApplicationId, 'detached', {
                operationId: 'op-replace-queued-fetch', actor: 'tester', trigger: 'test', at: Date.now(),
            });
            const config: DirectSourceConfig = {
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: false,
                envPath: null,
            };
            GitOpsStore.getInstance().insertApplication(buildDirectApplicationRow({
                id: newGitOpsId(),
                stackName: 'reconcile-fetch-replaced-while-queued',
                config,
                identity: directSourceIdentity(config),
                lifecycleStatus: 'active',
                at: Date.now(),
            }, 'automatic'));

            releaseLock();
            await lockHolder;
            const result = await reconcile;

            expect(result.outcome).toBe('unknown');
            expect(result.nextAction).toBe('none');
            expect(mockGitClone).not.toHaveBeenCalled();
            expect(settledAttempts(staleApplicationId)).toHaveLength(1);
            expect(historyOperationIds(liveApp('reconcile-fetch-replaced-while-queued')!.id, 'fetch_started')).toHaveLength(0);
        });

        it('captures the fetch result before a queued source mutation can change row state', async () => {
            const stackName = 'reconcile-settlement-before-queued-suspend';
            const sha = 'f1'.repeat(20);
            mockSuccessfulClone({ sha });
            const svc = GitSourceService.getInstance();
            await configureGitSource(stackName);
            const applicationId = liveApp(stackName)!.id;
            const releaseClone = gatedClone();
            mockGitLog.mockResolvedValue([{ oid: sha }]);

            const fetch = svc.reconcile({
                intent: 'fetch',
                applicationId,
                stackName,
                trigger: 'poll',
                actor: 'system:source-controller',
            });
            await vi.waitFor(() => expect(mockGitClone).toHaveBeenCalledTimes(1));
            const suspend = svc.suspend(stackName, { actor: 'tester', reason: 'queue behind fetch' });
            releaseClone();

            const [fetchResult, suspendResult] = await Promise.all([fetch, suspend]);

            expect(fetchResult.outcome).toBe('pending_review');
            expect(suspendResult.outcome).toBe('suspended');
            const settled = settledAttempts(applicationId);
            expect(settled).toHaveLength(1);
            expect(JSON.parse(settled[0].after_json).outcome).toBe('pending_review');
        });

        it('reports unknown for a stack with no GitOps application', async () => {
            const svc = GitSourceService.getInstance();
            const result = await svc.reconcile({
                intent: 'fetch',
                applicationId: 'unused',
                stackName: 'reconcile-no-app',
                trigger: 'manual',
                actor: 'tester',
            });
            expect(result.outcome).toBe('unknown');
        });

        function settledAttempts(applicationId: string): { operation_id: string; after_json: string }[] {
            return DatabaseService.getInstance().getDb()
                .prepare("SELECT operation_id, after_json FROM gitops_history WHERE application_id = ? AND stage = 'source_reconcile_settled'")
                .all(applicationId) as { operation_id: string; after_json: string }[];
        }

        function unsettledAttempts(applicationId: string): { operation_id: string }[] {
            return DatabaseService.getInstance().getDb()
                .prepare("SELECT operation_id FROM gitops_history started WHERE started.application_id = ? AND started.stage = 'source_reconcile_started' AND NOT EXISTS (SELECT 1 FROM gitops_history settled WHERE settled.application_id = started.application_id AND settled.operation_id = started.operation_id AND settled.stage = 'source_reconcile_settled')")
                .all(applicationId) as { operation_id: string }[];
        }

        /**
         * Hold the clone open so a second reconcile submission is guaranteed
         * to arrive while the first is still executing. Returns the release
         * function; calling it lets the clone finish and write its compose
         * file.
         */
        function gatedClone(): () => void {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            mockGitClone.mockClear();
            mockGitClone.mockImplementation(async (args: { dir: string }) => {
                await gate;
                const { promises: fsp } = await import('fs');
                const path = await import('path');
                const composeAbs = path.join(args.dir, 'compose.yaml');
                await fsp.mkdir(path.dirname(composeAbs), { recursive: true });
                await fsp.writeFile(composeAbs, 'services:\n  x:\n    image: alpine\n', 'utf-8');
            });
            return release;
        }

        it('durably settles a reconcile attempt for a successful fetch, leaving nothing unsettled', async () => {
            const sha = 'e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8';
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
            const svc = GitSourceService.getInstance();
            await svc.upsert({
                stackName: 'reconcile-durable',
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
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            try {
                const applicationId = liveApp('reconcile-durable')!.id;
                const result = await svc.reconcile({
                    intent: 'fetch',
                    applicationId,
                    stackName: 'reconcile-durable',
                    trigger: 'manual',
                    actor: 'tester',
                });

                const settled = settledAttempts(applicationId);
                expect(settled).toHaveLength(1);
                expect(JSON.parse(settled[0].after_json)).toMatchObject({ outcome: result.outcome, reason: result.reason });
                expect(unsettledAttempts(applicationId)).toHaveLength(0);
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('reserves and settles an attempt for every normalized trigger kind', async () => {
            const stackName = 'reconcile-trigger-matrix';
            const sha = 'e9'.repeat(20);
            const triggers: ReconcileTrigger[] = [
                'manual',
                'api',
                'webhook',
                'poll',
                'retry',
                'config_change',
                'startup',
                'resume',
                'provider_event',
                'schedule',
                'binding_change',
            ];
            mockSuccessfulClone({ sha });
            const svc = GitSourceService.getInstance();
            await configureGitSource(stackName);
            const applicationId = liveApp(stackName)!.id;

            for (const trigger of triggers) {
                await svc.reconcile({
                    intent: 'fetch',
                    applicationId,
                    stackName,
                    trigger,
                    actor: `system:${trigger}`,
                    ...(trigger === 'webhook' ? { deliveryId: 'trigger-matrix-webhook' } : {}),
                });
            }

            const started = DatabaseService.getInstance().getDb()
                .prepare("SELECT operation_id, trigger FROM gitops_history WHERE application_id = ? AND stage = 'source_reconcile_started' ORDER BY rowid")
                .all(applicationId) as { operation_id: string; trigger: string }[];
            expect(started.map((row) => row.trigger)).toEqual(triggers);
            expect(new Set(started.map((row) => row.operation_id)).size).toBe(triggers.length);
            expect(started.find((row) => row.trigger === 'webhook')?.operation_id)
                .toBe(deliveryKey('webhook', 'fetch', 'trigger-matrix-webhook'));
            expect(unsettledAttempts(applicationId)).toHaveLength(0);
        });

        it('threads the reserved attempt\'s operation id into the generation the fetch produces', async () => {
            const sha = 'ed'.repeat(20);
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
            const svc = GitSourceService.getInstance();
            await svc.upsert({
                stackName: 'reconcile-operation-id-threading',
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
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            try {
                const applicationId = liveApp('reconcile-operation-id-threading')!.id;
                await svc.reconcile({
                    intent: 'fetch',
                    applicationId,
                    stackName: 'reconcile-operation-id-threading',
                    trigger: 'manual',
                    actor: 'tester',
                });

                const settled = settledAttempts(applicationId);
                expect(settled).toHaveLength(1);
                const candidateGenerationId = liveApp('reconcile-operation-id-threading')!.candidate_generation_id;
                expect(candidateGenerationId).toBeTruthy();
                const generation = GitOpsStore.getInstance().getGeneration(candidateGenerationId!);
                expect(generation?.operation_id).toBe(settled[0].operation_id);
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('threads the reserved attempt\'s operation id into the apply-side transition an apply-intent reconcile produces', async () => {
            const sha = 'ee'.repeat(20);
            const svc = await seedPending('reconcile-apply-operation-id-threading', 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();

            try {
                const applicationId = liveApp('reconcile-apply-operation-id-threading')!.id;
                await svc.reconcile({
                    intent: 'apply',
                    applicationId,
                    stackName: 'reconcile-apply-operation-id-threading',
                    trigger: 'manual',
                    actor: 'tester',
                    commitSha: sha,
                    planFingerprint: '',
                    deploy: false,
                });

                // seedPending's own pull() reserves and settles its own fetch
                // attempt now that pull() is wired through reservation too, so
                // more than one settled row is expected here; only the
                // apply-intent one needs to match the applied-stage transition.
                const settled = settledAttempts(applicationId).map((r) => r.operation_id);
                const applied = historyOperationIds(applicationId, 'applied');
                expect(applied).toHaveLength(1);
                expect(settled).toContain(applied[0]);
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
            }
        });

        it('coalesces two concurrent fetch-intent reconciles into one execution, each settling its own durable attempt', async () => {
            const newSha = 'e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9';
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0' });
            const svc = GitSourceService.getInstance();
            await svc.upsert({
                stackName: 'reconcile-coalesce',
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
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            const releaseClone = gatedClone();
            mockGitLog.mockResolvedValue([{ oid: newSha }]);

            try {
                const applicationId = liveApp('reconcile-coalesce')!.id;
                const first = svc.reconcile({
                    intent: 'fetch', applicationId, stackName: 'reconcile-coalesce', trigger: 'manual', actor: 'tester-a',
                });
                const second = svc.reconcile({
                    intent: 'fetch', applicationId, stackName: 'reconcile-coalesce', trigger: 'manual', actor: 'tester-b',
                });
                releaseClone();
                const [firstResult, secondResult] = await Promise.all([first, second]);

                expect(mockGitClone).toHaveBeenCalledTimes(1);
                expect(firstResult).toEqual(secondResult);

                const settled = settledAttempts(applicationId);
                expect(settled).toHaveLength(2);
                expect(new Set(settled.map((r) => r.operation_id)).size).toBe(2);
                expect(unsettledAttempts(applicationId)).toHaveLength(0);
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('coalesces a concurrent manual pull and a controller-triggered reconcile into one clone, each with its own complete settled history and a follower-to-leader link', async () => {
            const newSha = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0' });
            const svc = GitSourceService.getInstance();
            await configureGitSource('pull-reconcile-coalesce');
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            const releaseClone = gatedClone();
            mockGitLog.mockResolvedValue([{ oid: newSha }]);

            try {
                const applicationId = liveApp('pull-reconcile-coalesce')!.id;
                const generationCountBefore = (DatabaseService.getInstance().getDb()
                    .prepare('SELECT COUNT(*) AS count FROM gitops_generations WHERE application_id = ?')
                    .get(applicationId) as { count: number }).count;
                const candidateReadyCountBefore = historyOperationIds(applicationId, 'candidate_ready').length;
                // Two different producers, one a manual pull() and the other
                // a controller poll driving reconcile(), submitting for the
                // exact same live application: coalesceKey() does not vary
                // by trigger or producer, so this must join into one clone
                // rather than each running its own.
                const manualPull = svc.pull('pull-reconcile-coalesce');
                const controllerReconcile = svc.reconcile({
                    intent: 'fetch',
                    applicationId,
                    stackName: 'pull-reconcile-coalesce',
                    trigger: 'poll',
                    actor: 'system:source-controller',
                });
                releaseClone();
                const [pullResult, reconcileResult] = await Promise.all([manualPull, controllerReconcile]);

                expect(mockGitClone).toHaveBeenCalledTimes(1);
                expect(pullResult.commitSha).toBe(newSha);
                expect(pullResult.candidateReady).toBe(true);
                expect(reconcileResult.outcome).toBe('pending_review');
                const generationCountAfter = (DatabaseService.getInstance().getDb()
                    .prepare('SELECT COUNT(*) AS count FROM gitops_generations WHERE application_id = ?')
                    .get(applicationId) as { count: number }).count;
                expect(generationCountAfter).toBe(generationCountBefore + 1);
                expect(historyOperationIds(applicationId, 'candidate_ready')).toHaveLength(candidateReadyCountBefore + 1);

                // Two complete histories: each caller reserved and settled
                // its own durable attempt, neither left dangling.
                const settled = settledAttempts(applicationId);
                expect(settled).toHaveLength(2);
                const settledOperationIds = settled.map((r) => r.operation_id);
                expect(new Set(settledOperationIds).size).toBe(2);
                expect(unsettledAttempts(applicationId)).toHaveLength(0);

                // A follower-to-leader link: exactly one of the two
                // reservations recorded that it was made on behalf of the
                // other.
                const started = DatabaseService.getInstance().getDb()
                    .prepare("SELECT operation_id, after_json FROM gitops_history WHERE application_id = ? AND stage = 'source_reconcile_started'")
                    .all(applicationId) as { operation_id: string; after_json: string }[];
                const followerLinks = started
                    .map((r) => (JSON.parse(r.after_json) as { followerOf?: string }).followerOf)
                    .filter((followerOf): followerOf is string => followerOf !== undefined);
                expect(followerLinks).toHaveLength(1);
                expect(settledOperationIds).toContain(followerLinks[0]);
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('leaves every coalesced attempt unsettled when the leader result is not durable, so recovery gives them one result', async () => {
            const stackName = 'reconcile-shared-settlement-failure';
            const sha = 'c7'.repeat(20);
            mockSuccessfulClone({ sha });
            const svc = GitSourceService.getInstance();
            await configureGitSource(stackName);
            const applicationId = liveApp(stackName)!.id;
            const priorStarted = new Set(historyOperationIds(applicationId, 'source_reconcile_started'));
            const releaseClone = gatedClone();
            mockGitLog.mockResolvedValue([{ oid: sha }]);
            const originalSettle = GitOpsTransitions.prototype.settleReconcileAttempt;
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated leader settlement failure'); })
                .mockImplementation(function (this: GitOpsTransitions, ...args: Parameters<typeof originalSettle>) {
                    return originalSettle.apply(this, args);
                });

            try {
                const manual = svc.pull(stackName);
                const controller = svc.reconcile({
                    intent: 'fetch',
                    applicationId,
                    stackName,
                    trigger: 'poll',
                    actor: 'system:source-controller',
                });
                releaseClone();
                await Promise.all([manual, controller]);

                const operationIds = historyOperationIds(applicationId, 'source_reconcile_started')
                    .filter((operationId) => !priorStarted.has(operationId));
                expect(operationIds).toHaveLength(2);
                expect(unsettledAttempts(applicationId).map((row) => row.operation_id).sort())
                    .toEqual([...operationIds].sort());

                await svc.suspend(stackName, { actor: 'tester', reason: 'settle through recovery' });
                await svc.recoverUnsettledReconcileAttempts();

                const recovered = settledAttempts(applicationId)
                    .filter((row) => operationIds.includes(row.operation_id));
                expect(recovered).toHaveLength(2);
                expect(new Set(recovered.map((row) => row.after_json)).size).toBe(1);
                expect(JSON.parse(recovered[0].after_json).outcome).toBe('suspended');
            } finally {
                settleSpy.mockRestore();
            }
        });

        it.each([
            ['manual pull', true],
            ['controller reconcile', false],
        ] as const)('settles both callers from one failed shared fetch when %s leads', async (_leader, manualLeads) => {
            const stackName = manualLeads
                ? 'pull-reconcile-failure-manual-leads'
                : 'pull-reconcile-failure-controller-leads';
            mockSuccessfulClone({ sha: 'f2'.repeat(20) });
            const svc = GitSourceService.getInstance();
            await configureGitSource(stackName);
            const applicationId = liveApp(stackName)!.id;

            let releaseClone!: () => void;
            const cloneGate = new Promise<void>((resolve) => { releaseClone = resolve; });
            mockGitClone.mockClear();
            mockGitClone.mockImplementation(async () => {
                await cloneGate;
                throw new Error('shared fetch failed');
            });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const request = {
                intent: 'fetch' as const,
                applicationId,
                stackName,
                trigger: 'poll' as const,
                actor: 'system:source-controller',
            };

            try {
                const first = manualLeads ? svc.pull(stackName) : svc.reconcile(request);
                const second = manualLeads ? svc.reconcile(request) : svc.pull(stackName);
                releaseClone();
                const [firstResult, secondResult] = await Promise.allSettled([first, second]);

                const reconcileResult = manualLeads ? secondResult : firstResult;
                expect(reconcileResult.status).toBe('fulfilled');
                if (reconcileResult.status !== 'fulfilled') throw reconcileResult.reason;
                const settled = settledAttempts(applicationId).map((row) => JSON.parse(row.after_json));
                expect(settled).toHaveLength(2);
                expect(settled).toEqual([reconcileResult.value, reconcileResult.value]);
                expect(mockGitClone).toHaveBeenCalledTimes(1);
                expect(unsettledAttempts(applicationId)).toHaveLength(0);
            } finally {
                errorSpy.mockRestore();
            }
        });

        it('settles a fetch-intent reconcile durably with the same classified result it returns, even for a pre-transition failure the row does not yet reflect', async () => {
            const svc = GitSourceService.getInstance();
            mockSuccessfulClone({ sha: '3'.repeat(40) });
            await configureGitSource('reconcile-pretransition-failure');
            const applicationId = liveApp('reconcile-pretransition-failure')!.id;
            // Deletes the config row pullLocked itself checks for, before
            // any transition table write, so the row state alone (a
            // generic row-derivation, with no notion of this failure) would
            // misreport the outcome as an unremarkable "never reconciled"
            // rather than the real, classified failure the caller receives.
            DatabaseService.getInstance().deleteGitSource('reconcile-pretransition-failure');

            const result = await svc.reconcile({
                intent: 'fetch',
                applicationId,
                stackName: 'reconcile-pretransition-failure',
                trigger: 'poll',
                actor: 'system:source-controller',
            });

            expect(result.outcome).not.toBe('unknown');
            const settled = settledAttempts(applicationId);
            expect(settled).toHaveLength(1);
            expect(JSON.parse(settled[0].after_json)).toEqual(result);
        });

        it('does not re-execute a redelivered request whose original attempt was reserved but never settled', async () => {
            const sha = 'dededededededededededededededededededede';
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
            const svc = GitSourceService.getInstance();
            await configureGitSource('reconcile-orphaned-redelivery');
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            try {
                const applicationId = liveApp('reconcile-orphaned-redelivery')!.id;
                const request = {
                    intent: 'fetch' as const,
                    applicationId,
                    stackName: 'reconcile-orphaned-redelivery',
                    trigger: 'webhook' as const,
                    actor: 'tester',
                    deliveryId: 'delivery-orphaned',
                };
                await svc.reconcile(request);
                // Simulate a crash between reservation and settlement: the
                // original attempt's reservation survives, but its
                // settlement row never got written, and no in-process
                // leader remains for it in this fresh call.
                DatabaseService.getInstance().getDb()
                    .prepare("DELETE FROM gitops_history WHERE application_id = ? AND stage = 'source_reconcile_settled'")
                    .run(applicationId);
                mockGitClone.mockClear();

                const redeliveryResult = await svc.reconcile(request);

                expect(mockGitClone).not.toHaveBeenCalled();
                expect(redeliveryResult.outcome).not.toBe('unknown');
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('reports an unknown redelivery result when durable settlement fails', async () => {
            const svc = GitSourceService.getInstance();
            mockSuccessfulClone({ sha: 'd1'.repeat(20) });
            await configureGitSource('reconcile-redelivery-settlement-failure');
            const applicationId = liveApp('reconcile-redelivery-settlement-failure')!.id;
            const request: ReconcileRequest & { intent: 'fetch'; deliveryId: string } = {
                intent: 'fetch',
                applicationId,
                stackName: 'reconcile-redelivery-settlement-failure',
                trigger: 'webhook',
                actor: 'tester',
                deliveryId: 'delivery-settlement-failure',
            };
            GitOpsTransitions.getInstance().reserveReconcileAttempt(applicationId, {
                operationId: deliveryKey('webhook', 'fetch', request.deliveryId),
                actor: request.actor,
                trigger: request.trigger,
                at: Date.now(),
            });
            mockGitClone.mockClear();
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated redelivery settlement failure'); });

            try {
                const result = await svc.reconcile(request);

                expect(mockGitClone).not.toHaveBeenCalled();
                expect(result).toEqual({
                    outcome: 'unknown',
                    reason: 'This attempt could not be durably resolved.',
                    nextAction: 'none',
                });
                expect(unsettledAttempts(applicationId)).toHaveLength(1);
            } finally {
                settleSpy.mockRestore();
            }
        });

        it('resolves a redelivery from its own settled history rather than an unrelated leader that happens to be running under the shared coalesce key', async () => {
            const sha = 'cececececececececececececececececececece';
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
            const svc = GitSourceService.getInstance();
            await configureGitSource('reconcile-redelivery-vs-unrelated-leader');
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            try {
                const applicationId = liveApp('reconcile-redelivery-vs-unrelated-leader')!.id;
                const request = {
                    intent: 'fetch' as const,
                    applicationId,
                    stackName: 'reconcile-redelivery-vs-unrelated-leader',
                    trigger: 'webhook' as const,
                    actor: 'tester',
                    deliveryId: 'delivery-vs-unrelated-leader',
                };
                const first = await svc.reconcile(request);

                // A completely unrelated fetch (a plain manual pull, no
                // deliveryId) becomes the in-process leader registered
                // under this application's shared fetch coalesce key,
                // which does not vary by deliveryId or trigger.
                const releaseClone = gatedClone();
                mockGitLog.mockResolvedValue([{ oid: 'dfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdf' }]);
                const unrelatedPull = svc.pull('reconcile-redelivery-vs-unrelated-leader');

                // A redelivery of the original event arrives while that
                // unrelated pull is still running: it must resolve from its
                // own settled history, not from the unrelated in-flight
                // leader it happens to find under the shared key.
                const redelivery = await svc.reconcile(request);
                releaseClone();
                await unrelatedPull;

                expect(redelivery).toEqual(first);
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('does not re-execute a redelivered request carrying the same deliveryId, and returns the original settled result', async () => {
            const sha = 'eaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaea';
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
            const svc = GitSourceService.getInstance();
            await svc.upsert({
                stackName: 'reconcile-dedupe',
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
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            try {
                const applicationId = liveApp('reconcile-dedupe')!.id;
                const request = {
                    intent: 'fetch' as const,
                    applicationId,
                    stackName: 'reconcile-dedupe',
                    trigger: 'webhook' as const,
                    actor: 'tester',
                    deliveryId: 'delivery-1',
                };
                const first = await svc.reconcile(request);
                mockGitClone.mockClear();
                const second = await svc.reconcile(request);

                expect(mockGitClone).not.toHaveBeenCalled();
                expect(second).toEqual(first);
                expect(settledAttempts(applicationId)).toHaveLength(1);
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('joins a concurrent redelivery of the same deliveryId to the in-flight leader, returning the leader\'s real result rather than a stale snapshot', async () => {
            const svc = GitSourceService.getInstance();
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'e0'.repeat(20) });
            await svc.upsert({
                stackName: 'reconcile-concurrent-redelivery',
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
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            const releaseClone = gatedClone();
            mockGitLog.mockResolvedValue([{ oid: 'e1'.repeat(20) }]);

            try {
                const applicationId = liveApp('reconcile-concurrent-redelivery')!.id;
                const request = {
                    intent: 'fetch' as const,
                    applicationId,
                    stackName: 'reconcile-concurrent-redelivery',
                    trigger: 'webhook' as const,
                    actor: 'tester',
                    deliveryId: 'delivery-race',
                };
                const first = svc.reconcile(request);
                const redelivery = svc.reconcile(request);
                releaseClone();
                const [firstResult, redeliveryResult] = await Promise.all([first, redelivery]);

                expect(mockGitClone).toHaveBeenCalledTimes(1);
                // The redelivery must report the leader's real post-fetch
                // outcome, not a snapshot of the row from before the fetch
                // ran (which would still show no candidate staged).
                expect(redeliveryResult).toEqual(firstResult);
                expect(firstResult.outcome).toBe('pending_review');
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('logs and reports unknown rather than throwing when a settled attempt\'s stored result is corrupted', async () => {
            const svc = GitSourceService.getInstance();
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'ef'.repeat(20) });
            await svc.upsert({
                stackName: 'reconcile-corrupt-settled',
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
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            try {
                const applicationId = liveApp('reconcile-corrupt-settled')!.id;
                const request = {
                    intent: 'fetch' as const,
                    applicationId,
                    stackName: 'reconcile-corrupt-settled',
                    trigger: 'webhook' as const,
                    actor: 'tester',
                    deliveryId: 'delivery-corrupt',
                };
                await svc.reconcile(request);
                DatabaseService.getInstance().getDb()
                    .prepare("UPDATE gitops_history SET after_json = ? WHERE application_id = ? AND stage = 'source_reconcile_settled'")
                    .run('not valid json{{{', applicationId);
                const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

                const result = await svc.reconcile(request);

                expect(result.outcome).toBe('unknown');
                expect(errorSpy).toHaveBeenCalled();
                errorSpy.mockRestore();
            } finally {
                validateSpy.mockRestore();
            }
        });

        it('joins a same-delivery apply under a different coalesce key to the real in-flight leader rather than settling a stale snapshot', async () => {
            const svc = GitSourceService.getInstance();
            const sha = 'a6'.repeat(20);
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
            await svc.upsert({
                stackName: 'reconcile-apply-delivery-race',
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
            await svc.pull('reconcile-apply-delivery-race');
            const applicationId = liveApp('reconcile-apply-delivery-race')!.id;
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            let releaseSave!: () => void;
            const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockImplementation(async () => { await gate; });

            try {
                // Two apply requests sharing a delivery id (so their
                // operation ids collide) but differing in commitSha, which
                // coalesceKey includes for an apply intent -- so they run
                // under different coalesce keys despite the shared
                // operation id.
                const first = svc.reconcile({
                    intent: 'apply',
                    applicationId,
                    stackName: 'reconcile-apply-delivery-race',
                    trigger: 'webhook',
                    actor: 'tester',
                    commitSha: sha,
                    planFingerprint: '',
                    deploy: false,
                    deliveryId: 'shared-delivery',
                });
                const second = svc.reconcile({
                    intent: 'apply',
                    applicationId,
                    stackName: 'reconcile-apply-delivery-race',
                    trigger: 'webhook',
                    actor: 'tester',
                    commitSha: 'ff'.repeat(20),
                    planFingerprint: 'different-fingerprint',
                    deploy: true,
                    deliveryId: 'shared-delivery',
                });
                releaseSave();
                const [firstResult, secondResult] = await Promise.all([first, second]);

                // The second request must never have run its own apply
                // (a different, unstaged commitSha would fail on its own
                // terms); it must instead have joined the first's real
                // execution and returned its actual result.
                expect(secondResult).toEqual(firstResult);
                expect(saveSpy).toHaveBeenCalledTimes(1);
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
            }
        });

        it('coalesces a concurrent manual apply and webhook apply into one promotion and one normalized result', async () => {
            const sha = 'a7'.repeat(20);
            const svc = await seedPending('apply-reconcile-coalesce', 'services:\n  x:\n    image: alpine\n', sha);
            const applicationId = liveApp('apply-reconcile-coalesce')!.id;
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            let releaseSave!: () => void;
            const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockImplementation(async () => { await saveGate; });
            const priorSettlements = new Set(settledAttempts(applicationId).map((row) => row.operation_id));

            try {
                const manualApply = svc.apply('apply-reconcile-coalesce', sha, SKIP_PLAN_FINGERPRINT);
                const controllerApply = svc.reconcile({
                    intent: 'apply',
                    applicationId,
                    stackName: 'apply-reconcile-coalesce',
                    trigger: 'webhook',
                    actor: 'system:webhook',
                    commitSha: sha,
                    planFingerprint: '',
                    deploy: false,
                    deliveryId: 'apply-cross-producer',
                });
                releaseSave();
                const [manualResult, reconcileResult] = await Promise.all([manualApply, controllerApply]);

                expect(manualResult.applied).toBe(true);
                expect(saveSpy).toHaveBeenCalledTimes(1);
                const settled = settledAttempts(applicationId)
                    .filter((row) => !priorSettlements.has(row.operation_id))
                    .map((row) => JSON.parse(row.after_json));
                expect(settled).toHaveLength(2);
                expect(settled).toEqual([reconcileResult, reconcileResult]);
                expect(unsettledAttempts(applicationId)).toHaveLength(0);
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
            }
        });

        it('does not let a fingerprint-enforcing manual apply borrow an internal apply that bypasses the fingerprint check', async () => {
            const sha = 'b7'.repeat(20);
            const svc = await seedPending('apply-fingerprint-mode-isolation', 'services:\n  x:\n    image: alpine\n', sha);
            const applicationId = liveApp('apply-fingerprint-mode-isolation')!.id;
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            let releaseSave!: () => void;
            const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockImplementation(async () => { await saveGate; });

            try {
                const internalApply = svc.reconcile({
                    intent: 'apply',
                    applicationId,
                    stackName: 'apply-fingerprint-mode-isolation',
                    trigger: 'webhook',
                    actor: 'system:webhook',
                    commitSha: sha,
                    planFingerprint: 'stale-fingerprint',
                    deploy: false,
                    deliveryId: 'apply-fingerprint-mode-isolation',
                });
                await vi.waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
                const manualApply = svc.apply('apply-fingerprint-mode-isolation', sha, {
                    planFingerprint: 'stale-fingerprint',
                    deploy: false,
                });
                releaseSave();

                await expect(internalApply).resolves.toMatchObject({ outcome: expect.any(String) });
                await expect(manualApply).rejects.toMatchObject({ code: expect.any(String) });
                expect(saveSpy).toHaveBeenCalledTimes(1);
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
            }
        });

        it('resolves an apply redelivery from its own history while an unrelated matching apply is running', async () => {
            const sha = 'a8'.repeat(20);
            const svc = await seedPending('apply-redelivery-vs-unrelated-leader', 'services:\n  x:\n    image: alpine\n', sha);
            const applicationId = liveApp('apply-redelivery-vs-unrelated-leader')!.id;
            const originalRequest: ReconcileRequest & { intent: 'apply' } = {
                intent: 'apply' as const,
                applicationId,
                stackName: 'apply-redelivery-vs-unrelated-leader',
                trigger: 'webhook' as const,
                actor: 'tester',
                commitSha: sha,
                planFingerprint: '',
                deploy: true,
                deliveryId: 'original-delivery',
            };
            const originalOperationId = deliveryKey('webhook', 'apply', 'original-delivery');
            const originalResult = {
                outcome: 'recovery_required' as const,
                reason: 'The source applied, but the deploy failed: first delivery deploy failed',
                nextAction: 'view_target_results' as const,
            };
            const tx = GitOpsTransitions.getInstance();
            const envelope = { operationId: originalOperationId, actor: 'tester', trigger: 'webhook', at: Date.now() };
            tx.reserveReconcileAttempt(applicationId, envelope);
            tx.settleReconcileAttempt(applicationId, envelope, originalResult);

            type ApplyExecution = {
                status: 'fulfilled';
                value: { applied: boolean; deployed: boolean };
                result: { outcome: 'no_source_change'; reason: string; nextAction: 'none' };
            };
            type ApplyCompletion = { execution: ApplyExecution; settled: boolean };
            let releaseLeader!: (completion: ApplyCompletion) => void;
            const leaderPromise = new Promise<ApplyCompletion>((resolve) => { releaseLeader = resolve; });
            const inFlightApplies = (svc as unknown as {
                inFlightApplies: Map<string, { operationId: string; promise: Promise<ApplyCompletion> }>;
            }).inFlightApplies;
            const executionKey = `${coalesceKey(originalRequest)}:fingerprint-optional`;
            inFlightApplies.set(executionKey, {
                operationId: 'unrelated-operation',
                promise: leaderPromise,
            });

            try {
                const redeliveryResult = await svc.reconcile(originalRequest);
                expect(redeliveryResult).toEqual(originalResult);
            } finally {
                inFlightApplies.delete(executionKey);
                releaseLeader({
                    settled: true,
                    execution: {
                        status: 'fulfilled',
                        value: { applied: true, deployed: true },
                        result: { outcome: 'no_source_change', reason: 'Unrelated leader finished.', nextAction: 'none' },
                    },
                });
            }
        });
    });

    describe('dispatchAcceptedGeneration', () => {
        const directContext = { targetMode: 'direct', nodeId: null, bindingRevision: null } as const;
        const manualDispatch = { trigger: 'manual', actor: 'tester' } as const;

        /**
         * Accept the staged candidate at the source layer (what a controller
         * auto-acceptance or an operator review does) and return the accepted
         * generation id. Acceptance clears the application row's candidate
         * pointer, so the dispatch contract must be captured from here on.
         */
        function acceptCandidate(stackName: string): string {
            const app = liveApp(stackName)!;
            const generationId = app.candidate_generation_id!;
            GitOpsTransitions.getInstance().sourceAccepted({
                applicationId: app.id,
                generationId,
                artifactSetId: newGitOpsId(),
                sourceAcceptanceId: newGitOpsId(),
                authority: 'operator',
                envelope: testEnvelope(),
            });
            return generationId;
        }

        async function acceptedGenerationById(generationId: string) {
            const { buildAcceptedGeneration } = await import('../services/gitops/handoff');
            return buildAcceptedGeneration(GitOpsStore.getInstance().getGeneration(generationId)!);
        }

        async function defaultNodeId(): Promise<number> {
            const { NodeRegistry } = await import('../services/NodeRegistry');
            return NodeRegistry.getInstance().getDefaultNodeId();
        }

        it('promotes the accepted generation through the shared pipeline without re-entering reconcile()', async () => {
            const sha = 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1';
            const svc = await seedPending('dispatch-direct', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-direct');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-direct')!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const settledBefore = settledAttemptsForApplication(applicationId).length;
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const order: string[] = [];
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockImplementation(async () => { order.push('promote'); });
            const originalTargetApplied = GitOpsTransitions.prototype.targetApplied;
            const targetSpy = vi.spyOn(GitOpsTransitions.prototype, 'targetApplied')
                .mockImplementation(function (this: GitOpsTransitions, ...args: Parameters<typeof originalTargetApplied>) {
                    order.push('target');
                    return originalTargetApplied.apply(this, args);
                });

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({ status: 'dispatched' });
                expect(reconcileSpy).not.toHaveBeenCalled();
                const generationRow = GitOpsStore.getInstance().getGeneration(generationId)!;
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                // The pipeline promotes the generation's own staged candidate.
                expect(promoteSpy.mock.calls[0]![1]).toMatchObject({ candidateRelPath: generationRow.candidate_dir, sha });
                // targetApplied binds the target only after promotion commits, exactly once.
                expect(order).toEqual(['promote', 'target']);
                expect(targetSpy).toHaveBeenCalledTimes(1);

                const app = GitOpsStore.getInstance().getApplication(applicationId)!;
                expect(app.accepted_generation_id).toBe(generationId);
                const target = GitOpsStore.getInstance().getTarget(applicationId, await defaultNodeId())!;
                expect(target.applied_generation_id).toBe(generationId);
                expect(target.candidate_generation_id).toBeNull();
                const src = DatabaseService.getInstance().getGitSource('dispatch-direct')!;
                expect(src.last_applied_commit_sha).toBe(sha);
                expect(src.pending_commit_sha).toBeNull();
                // This dispatch reserved exactly one durable attempt and settled it.
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore + 1);
                expect(settledAttemptsForApplication(applicationId)).toHaveLength(settledBefore + 1);
            } finally {
                reconcileSpy.mockRestore();
                promoteSpy.mockRestore();
                targetSpy.mockRestore();
            }
        });

        it('blocks a blueprint-mode generation by delegating to BlueprintTargetAdapter', async () => {
            const sha = 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2';
            const svc = await seedPending('dispatch-blueprint', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-blueprint');
            const generation = await acceptedGenerationById(generationId);

            const result = await svc.dispatchAcceptedGeneration(
                generation,
                { targetMode: 'blueprint', nodeId: 1, bindingRevision: 'rev-1' },
                manualDispatch,
            );

            expect(result).toEqual({
                status: 'blocked',
                reason: 'Blueprint rollout orchestration is not yet implemented.',
            });
            // Routing decided from the context alone; the acceptance stands untouched.
            expect(liveApp('dispatch-blueprint')!.accepted_generation_id).toBe(generationId);
        });

        it('blocks when the dispatch contract disagrees with the stored accepted generation', async () => {
            const sha = 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3';
            const svc = await seedPending('dispatch-contract-drift', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-contract-drift');
            const generation = await acceptedGenerationById(generationId);
            const staleGeneration = { ...generation, commitSha: 'ffffffffffffffffffffffffffffffffffffffff' };
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');

            try {
                const result = await svc.dispatchAcceptedGeneration(staleGeneration, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/disagrees with the accepted generation/i),
                });
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(liveApp('dispatch-contract-drift')!.accepted_generation_id).toBe(generationId);
            } finally {
                promoteSpy.mockRestore();
            }
        });

        it('refuses promotion when the live target changed after acceptance, leaving acceptance intact', async () => {
            const sha = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
            mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
            const svc = GitSourceService.getInstance();
            const { FileSystemService } = await import('../services/FileSystemService');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const fsSvc = FileSystemService.getInstance();
            await fsSvc.createStack('dispatch-changed-live');
            await svc.upsert({
                stackName: 'dispatch-changed-live',
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
            await svc.pull('dispatch-changed-live');
            const generationId = acceptCandidate('dispatch-changed-live');
            const generation = await acceptedGenerationById(generationId);
            // A local edit lands after the acceptance: the target the accepted
            // generation was reviewed against no longer exists.
            await fsSvc.saveStackContent('dispatch-changed-live', 'services:\n  x:\n    image: alpine:local\n');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/no longer matches the accepted generation/i),
                });
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(deploySpy).not.toHaveBeenCalled();
                const app = liveApp('dispatch-changed-live')!;
                expect(app.accepted_generation_id).toBe(generationId);
                expect(GitOpsStore.getInstance().getTarget(app.id, await defaultNodeId())?.applied_generation_id).toBeNull();
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                await cleanupStackDir('dispatch-changed-live');
            }
        });

        it('blocks when the accepted candidate directory was removed, promoting nothing', async () => {
            const sha = 'd5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5';
            const svc = await seedPending('dispatch-candidate-gone', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-candidate-gone');
            const generation = await acceptedGenerationById(generationId);
            const generationRow = GitOpsStore.getInstance().getGeneration(generationId)!;
            fs.rmSync(path.join(stackManagedRoot('dispatch-candidate-gone'), generationRow.candidate_dir), { recursive: true, force: true });
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/no longer staged/i),
                });
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(liveApp('dispatch-candidate-gone')!.accepted_generation_id).toBe(generationId);
            } finally {
                promoteSpy.mockRestore();
            }
        });

        it('blocks with an in-progress reason instead of throwing when the stack lock is held', async () => {
            const sha = 'd6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6';
            const svc = await seedPending('dispatch-contention', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-contention');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-contention')!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const settledBefore = settledAttemptsForApplication(applicationId).length;
            const nodeId = await defaultNodeId();
            expect(StackOpLockService.getInstance().tryAcquire(nodeId, 'dispatch-contention', 'deploy', 'tester').acquired).toBe(true);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: 'Another operation (deploy) is already in progress for dispatch-contention.',
                });
                // The refused dispatch reserved nothing, so it leaves no
                // unsettled attempt for startup recovery to chase.
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore);
                expect(settledAttemptsForApplication(applicationId)).toHaveLength(settledBefore);
            } finally {
                StackOpLockService.getInstance().release(nodeId, 'dispatch-contention');
            }
        });

        it('honors an auto_deploy_on_apply source setting by deploying after promotion', async () => {
            const sha = 'd7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7';
            const svc = await seedPending('dispatch-auto-deploy', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-auto-deploy');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-auto-deploy')!.id;
            const { ComposeService } = await import('../services/ComposeService');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: 'a1b2c3d4-e5f6-7788-99aa-bbacddddeeff' });
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-auto-deploy');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({ status: 'dispatched' });
                expect(deploySpy).toHaveBeenCalledWith(
                    'dispatch-auto-deploy',
                    undefined,
                    undefined,
                    {
                        source: 'git_apply',
                        actor: 'tester',
                        // The dispatch journals its deploy intent and threads
                        // the journaled id into the invocation, so Compose's
                        // own deploy transitions land under the id recovery
                        // will look up. The stub records no Compose
                        // transitions itself, so the mock result still
                        // reports its own fixed id.
                        gitopsDeployOperationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
                    },
                );
                const deployCtx = deploySpy.mock.calls[0]![3]!;
                // The journaled intent names the exact id the deploy received.
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const intent = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched');
                expect(intent).toBeDefined();
                expect(JSON.parse(intent!.after_json!)).toMatchObject({
                    generationId,
                    commitSha: sha,
                    deployOperationId: deployCtx.gitopsDeployOperationId,
                });
                // The deploy's canonical GitOps operation id surfaces in the
                // apply evidence line, so an operator reading the log can match
                // the apply against the deploy's own transitions by the same id.
                expect(logSpy.mock.calls.some((args) => String(args[0]).includes('[GitSource] Applied and deployed dispatch-auto-deploy')
                    && String(args[0]).includes('(deploy op a1b2c3d4)'))).toBe(true);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                logSpy.mockRestore();
            }
        });

        it('refuses to start the deploy when the deploy intent cannot be journaled', async () => {
            const sha = 'c4'.repeat(20);
            const svc = await seedPending('refuse-deploy-no-intent', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('refuse-deploy-no-intent');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('refuse-deploy-no-intent')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // The intent journal write itself fails. The dispatch must then
            // refuse to hand the stack to Compose: a deploy that runs with
            // no journaled intent leaves recovery unable to link whatever
            // Compose did to this attempt, which is exactly the false
            // convergence the intent exists to prevent. The simulated
            // failure also carries a credential-shaped store URL: the
            // capture into the operator-visible reason must scrub it.
            const intentSpy = vi.spyOn(GitOpsTransitions.prototype, 'deployDispatched')
                .mockImplementation(() => {
                    throw new Error('simulated intent journal failure at https://user:sup3rs3cr3t@db.internal:5432/gitops');
                });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('refuse-deploy-no-intent');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(deploySpy).not.toHaveBeenCalled();
                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/deploy intent could not be recorded/i),
                });
                // The promotion and the bind did happen; the attempt settles
                // post-commit (the files are real) without claiming a deploy
                // id, since Compose never ran.
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')).toBeUndefined();
                // The refusal itself is journaled: it is the only evidence
                // that separates "refused to deploy" from "apply-only
                // completion" for recovery of an unsettled attempt.
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(true);
                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/deploy intent could not be recorded/i),
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                // The settled reason carries why the intent failed: a
                // cause-less refusal is undebuggable for the operator.
                expect(payload.reason).toMatch(/simulated intent journal failure/);
                // The reason is a durable, operator-visible row, so the
                // credential in the simulated store error must not survive
                // the capture: scrubbing runs before the cause is embedded.
                expect(payload.reason).not.toContain('sup3rs3cr3t');
                expect(payload.reason).toContain('***');
                expect(payload.deployGitopsOperationId).toBeUndefined();
                // Refusing the deploy logs the intent failure at the journal
                // site: it is the operator's real-time trace of why the
                // deploy never started, so a silent drop is a regression
                // this pins. The logged text is scrubbed too.
                expect(errorSpy).toHaveBeenCalled();
                const logged = errorSpy.mock.calls
                    .map((args) => args.map(String).join('\n')).join('\n');
                expect(logged).not.toContain('sup3rs3cr3t');
                // Recovery has nothing to reconstruct and nothing to redeploy:
                // the attempt already settled, so a recovery pass leaves it
                // at one settlement.
                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(deploySpy).not.toHaveBeenCalled();
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                intentSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('refuses to start the deploy when the journaled intent cannot be read back', async () => {
            const sha = 'c5'.repeat(20);
            const svc = await seedPending('refuse-deploy-intent-unreadable', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('refuse-deploy-intent-unreadable');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('refuse-deploy-intent-unreadable')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // The write-failure refusal above pins the recording branch; this
            // one pins the read-back branch of the same tri-state contract,
            // specifically that a corrupt stored row must not escape the
            // hook's null contract as a thrown decode error: an escaping
            // throw lands in the pipeline's deploy-error arm and misreports
            // the refusal as a failed deploy. The row writes fine but its
            // stored payload cannot be decoded, so the intent cannot be
            // trusted. A drift here (returning undefined instead of null)
            // would silently restore the old untracked-deploy behavior,
            // which recovery can then only judge from source state.
            const realRead = GitOpsStore.prototype.getStageRowForAttempt
                .bind(GitOpsStore.getInstance());
            const readSpy = vi.spyOn(GitOpsStore.prototype, 'getStageRowForAttempt')
                .mockImplementation((...args: Parameters<GitOpsStore['getStageRowForAttempt']>) => {
                    const row = realRead(...args);
                    if (args[2] === 'deploy_dispatched' && row) {
                        return { ...row, after_json: 'not json {' };
                    }
                    return row;
                });
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('refuse-deploy-intent-unreadable');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(deploySpy).not.toHaveBeenCalled();
                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/deploy intent could not be recorded/i),
                });
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                // Unlike the write-failure variant, the intent row exists in
                // history: it was the stored payload being undecodable, not
                // the write, that failed. Read past the spy so this is the
                // row as stored.
                const intentCount = DatabaseService.getInstance().getDb()
                    .prepare(`SELECT COUNT(*) AS n FROM gitops_history
                              WHERE application_id = ? AND operation_id = ? AND stage = 'deploy_dispatched'`)
                    .get(applicationId, dispatchOp) as { n: number };
                expect(intentCount.n).toBe(1);
                // The refusal is journaled even though the row exists: the
                // stored intent cannot be trusted, so the recovery arms must
                // see a refusal witness, not the corrupt row.
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(true);
                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/deploy intent could not be recorded/i),
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                // The read-back refusal names its own cause: a corrupt
                // stored row must settle differently from a failed write,
                // and the throw must not escape into the deploy-error arm.
                expect(payload.reason).toMatch(/failed validation/);
                expect(payload.deployGitopsOperationId).toBeUndefined();
                expect(promoteSpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                readSpy.mockRestore();
            }
        });

        it('refuses the deploy when the intent read-back itself throws', async () => {
            const sha = 'c7'.repeat(20);
            const svc = await seedPending('refuse-deploy-readback-throws', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('refuse-deploy-readback-throws');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('refuse-deploy-readback-throws')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // The write lands but the store is still unhealthy and the
            // read-back throws right after it. A throw here must take the
            // refusal path (witness journaled, recovery-required settle)
            // rather than escaping the hook into the deploy-error arm, which
            // would misreport "the deploy failed" for a deploy Compose never
            // started. This pins that third refusal branch.
            const realRead = GitOpsStore.prototype.getStageRowForAttempt
                .bind(GitOpsStore.getInstance());
            const readSpy = vi.spyOn(GitOpsStore.prototype, 'getStageRowForAttempt')
                .mockImplementation((...args: Parameters<GitOpsStore['getStageRowForAttempt']>) => {
                    if (args[2] === 'deploy_dispatched') {
                        throw new Error('simulated read-back store failure');
                    }
                    return realRead(...args);
                });
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('refuse-deploy-readback-throws');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(deploySpy).not.toHaveBeenCalled();
                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/deploy intent could not be recorded and read back[\s\S]*simulated read-back store failure/i),
                });
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                expect(payload.deployGitopsOperationId).toBeUndefined();
                // Refusal-shaped, not deploy-failure-shaped: the reason must
                // not claim the deploy itself failed.
                expect(payload.reason).not.toMatch(/deploy failed/i);
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(true);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                readSpy.mockRestore();
            }
        });

        it('recovery reconstructs the deploy-intent refusal when the settle write fails in the same window', async () => {
            const sha = 'c6'.repeat(20);
            const svc = await seedPending('refuse-deploy-settle-lost', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('refuse-deploy-settle-lost');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('refuse-deploy-settle-lost')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // The compounding failure the refusal witness exists for: the
            // intent journal throws AND the refusal's settle write fails in
            // the same window. Without the witness the attempt would stay
            // open with a bound target and no intent row, and recovery's
            // no-intent arm would read an apply-only completion (the source
            // projection converged), contradicting what the live refusal
            // would have settled. With it, recovery reconstructs the same
            // recovery_required classification from recorded evidence.
            const intentSpy = vi.spyOn(GitOpsTransitions.prototype, 'deployDispatched')
                .mockImplementation(() => { throw new Error('simulated intent journal failure'); });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated settle failure'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('refuse-deploy-settle-lost');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                // The in-process settle was lost: the attempt is open, the
                // way startup recovery expects to find it.
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === dispatchOp)).toBe(false);
                // The refusal witness survived: it is the only durable
                // evidence separating this attempt from an apply-only
                // completion.
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(true);

                await svc.recoverUnsettledReconcileAttempts();
                const settledOnce = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settledOnce).toHaveLength(1);
                const payload = JSON.parse(settledOnce[0]!.after_json!);
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/deploy intent could not be recorded and read back/i),
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                expect(payload.deployGitopsOperationId).toBeUndefined();
                // Recovery judged from the witness: one promotion, no
                // deploy, ever.
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).not.toHaveBeenCalled();

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(deploySpy).not.toHaveBeenCalled();
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                intentSpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('recovers a journaled-but-corrupt intent row as the refusal, not a storage bug', async () => {
            const sha = 'd5'.repeat(20);
            const svc = await seedPending('refuse-deploy-corrupt-row-recovery', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('refuse-deploy-corrupt-row-recovery');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('refuse-deploy-corrupt-row-recovery')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // Pins the refusal-before-intent check order in
            // reconstructBoundDispatchResult. The live dispatch refuses on an
            // undecodable read-back and journals the witness, but its settle
            // is lost in the same window, so recovery must classify the
            // attempt. A corrupt intent row still exists when recovery reads
            // it: if recovery decoded the intent first (to correlate a
            // deploy), the storage-bug throw would leave the attempt
            // unsettled forever. The witness check running first makes the
            // corrupt row moot, exactly as the live decode refusal did.
            const realRead = GitOpsStore.prototype.getStageRowForAttempt
                .bind(GitOpsStore.getInstance());
            const readSpy = vi.spyOn(GitOpsStore.prototype, 'getStageRowForAttempt')
                .mockImplementation((...args: Parameters<GitOpsStore['getStageRowForAttempt']>) => {
                    const row = realRead(...args);
                    if (args[2] === 'deploy_dispatched' && row) {
                        return { ...row, after_json: 'not json {' };
                    }
                    return row;
                });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated settle failure'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('refuse-deploy-corrupt-row-recovery');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');
                expect(deploySpy).not.toHaveBeenCalled();
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === dispatchOp)).toBe(false);
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(true);

                // The read-back spy only corrupts what the live pipeline
                // sees. Make the corruption real in storage before recovery
                // runs, so recovery reads the row every future reader will.
                readSpy.mockRestore();
                DatabaseService.getInstance().getDb()
                    .prepare(`UPDATE gitops_history SET after_json = 'not json {'
                              WHERE application_id = ? AND operation_id = ? AND stage = 'deploy_dispatched'`)
                    .run(applicationId, dispatchOp);

                await svc.recoverUnsettledReconcileAttempts();
                const settledOnce = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settledOnce).toHaveLength(1);
                const payload = JSON.parse(settledOnce[0]!.after_json!);
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/deploy intent could not be recorded and read back/i),
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                expect(payload.deployGitopsOperationId).toBeUndefined();
                // Classified from the witness, not from the corrupt row: the
                // recovery pass must not have touched the intent payload at
                // all (the throw it would have caused is the regression).
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).not.toHaveBeenCalled();

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                readSpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('still refuses and settles when the refusal witness write itself fails', async () => {
            const sha = 'd6'.repeat(20);
            const svc = await seedPending('refuse-deploy-witness-lost', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('refuse-deploy-witness-lost');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('refuse-deploy-witness-lost')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // The intent journal throws AND the refusal witness write fails
            // with it. The witness is best-effort like the promotion witness,
            // so a failed witness write must not turn the refusal into an
            // escape: the dispatch still refuses, the still-healthy settle
            // lands, and the witness outage is logged. That log line is the
            // operator's only notice that recovery of an unsettled version of
            // this attempt would see no witness, so it is pinned here.
            const intentSpy = vi.spyOn(GitOpsTransitions.prototype, 'deployDispatched')
                .mockImplementation(() => { throw new Error('simulated intent journal failure'); });
            const witnessSpy = vi.spyOn(GitOpsTransitions.prototype, 'deployIntentRefused')
                .mockImplementation(() => { throw new Error('simulated witness journal failure'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('refuse-deploy-witness-lost');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(deploySpy).not.toHaveBeenCalled();
                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/deploy intent could not be recorded/i),
                });
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(false);
                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/simulated intent journal failure/i),
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                const logged = errorSpy.mock.calls
                    .map((args) => args.map(String).join('\n')).join('\n');
                expect(logged).toContain('refusal witness unavailable');
                // The attempt settled, so recovery has nothing to add even
                // though no witness exists: the live classification stands.
                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(deploySpy).not.toHaveBeenCalled();
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                intentSpy.mockRestore();
                witnessSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('settles a policy-blocked dispatch as a deploy failure with the intent journaled', async () => {
            const sha = 'dd'.repeat(20);
            const svc = await seedPending('dispatch-policy-block', 'services:\n  x:\n    image: nginx:bad\n', sha);
            const generationId = acceptCandidate('dispatch-policy-block');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-policy-block')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // The deploy branch journals its intent before the fallible
            // policy gate, so a policy block settles as a deploy-arm
            // failure with a durable intent row behind it. The intent's
            // position is the point: with the journal written only at the
            // Compose hand-off, a policy block left bind present and intent
            // absent, and recovery of an unsettled version of this attempt
            // projected the converged source state instead.
            const TrivyService = (await import('../services/TrivyService')).default;
            const trivy = TrivyService.getInstance();
            const trivyAvailableSpy = vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(true);
            const listImagesSpy = vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:bad']);
            const scanSpy = vi.spyOn(trivy, 'scanImagePreflight').mockResolvedValue({
                id: 81,
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
                stack_context: 'dispatch-policy-block',
                policy_evaluation: null,
            });
            DatabaseService.getInstance().createScanPolicy({
                name: 'block-high-dispatch',
                node_id: null,
                node_identity: '',
                stack_pattern: 'dispatch-policy-block',
                max_severity: 'HIGH',
                block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
                enabled: 1,
                replicated_from_control: 0,
            });
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-policy-block');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(deploySpy).not.toHaveBeenCalled();
                // The gate really evaluated the scan: without this, a
                // throw for an unrelated reason matching the same regex
                // would pass silently.
                expect(scanSpy).toHaveBeenCalled();
                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/the deploy failed: Policy "block-high-dispatch" blocked deploy/i),
                });
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                // The intent row exists even though Compose never ran: it
                // is what separates this attempt from an apply-only
                // completion for any later reader.
                expect(GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')).toBeDefined();
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(false);
                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                // The live deploy-failure arm's payload shape: outcome, next
                // action, reason. The commit sha rides on recovery-written
                // rows (reconstructed from the durable bind), not on this
                // live settle, so the asymmetry is pinned as part of the
                // contract.
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                    reason: expect.stringMatching(/the deploy failed: Policy "block-high-dispatch" blocked deploy/i),
                });
                // No deploy id is claimed on the row: Compose never opened
                // its operation, so the minted intent id points at nothing
                // the operator can look up.
                expect(payload.deployGitopsOperationId).toBeUndefined();
                // The attempt settled live: recovery has nothing to add.
                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(deploySpy).not.toHaveBeenCalled();
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                trivyAvailableSpy.mockRestore();
                listImagesSpy.mockRestore();
                scanSpy.mockRestore();
            }
        });

        it('recovery reconstructs a policy-blocked dispatch with a lost settle, never a quiet convergence', async () => {
            const sha = 'f6'.repeat(20);
            const svc = await seedPending('dispatch-policy-lost-settle', 'services:\n  x:\n    image: nginx:bad\n', sha);
            const generationId = acceptCandidate('dispatch-policy-lost-settle');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-policy-lost-settle')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            const TrivyService = (await import('../services/TrivyService')).default;
            const trivy = TrivyService.getInstance();
            const trivyAvailableSpy = vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(true);
            const listImagesSpy = vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:bad']);
            const scanSpy = vi.spyOn(trivy, 'scanImagePreflight').mockResolvedValue({
                id: 82,
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
                stack_context: 'dispatch-policy-lost-settle',
                policy_evaluation: null,
            });
            DatabaseService.getInstance().createScanPolicy({
                name: 'block-high-lost-settle',
                node_id: null,
                node_identity: '',
                stack_pattern: 'dispatch-policy-lost-settle',
                max_severity: 'HIGH',
                block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
                enabled: 1,
                replicated_from_control: 0,
            });
            // The window this pins: the policy gate blocks, the deploy-arm
            // settle is lost with it, and startup recovery later settles
            // the attempt on the durable evidence alone. Before the intent
            // moved ahead of the gate, this state (bind present,
            // intent absent, no refusal witness) reconstructed as the
            // source projection: a false no-source-change convergence for
            // a deploy the operator asked for that never happened.
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated settle failure'); });
            // The activity-feed mirror is the live-path trace when the
            // settle write is lost: recovery reconstructs the outcome
            // eventually, but until then the feed row is the operator's
            // only notice that a settle failed.
            const activitySpy = vi.spyOn(DatabaseService.getInstance(), 'addNotificationHistory');
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-policy-lost-settle');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');
                expect(deploySpy).not.toHaveBeenCalled();
                expect(scanSpy).toHaveBeenCalled();
                expect(activitySpy.mock.calls.map((args) => args[1])).toContainEqual(
                    expect.objectContaining({
                        category: 'git_apply_failed',
                        message: expect.stringContaining('Dispatch settlement failed for dispatch-policy-lost-settle'),
                    }),
                );
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === dispatchOp)).toBe(false);
                expect(GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')).toBeDefined();

                await svc.recoverUnsettledReconcileAttempts();
                const settledOnce = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settledOnce).toHaveLength(1);
                const payload = JSON.parse(settledOnce[0]!.after_json!);
                // The intent row plus the absent deploy_started row decide
                // this arm: a deploy was requested, none was recorded.
                // Recovery never answers this state with the source
                // projection's quiet converged result.
                expect(payload.outcome).toBe('blocked');
                expect(payload).toMatchObject({
                    reason: expect.stringMatching(/no Compose deploy record was found/i),
                    nextAction: 'retry',
                    commitSha: sha,
                });
                expect(payload.deployGitopsOperationId).toBeUndefined();
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).not.toHaveBeenCalled();

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                trivyAvailableSpy.mockRestore();
                listImagesSpy.mockRestore();
                scanSpy.mockRestore();
                settleSpy.mockRestore();
                activitySpy.mockRestore();
            }
        });

        it('settles a recovery-handoff failure with the intent journaled', async () => {
            const sha = 'be'.repeat(20);
            const svc = await seedPending('dispatch-recovery-handoff-fail', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-recovery-handoff-fail');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-recovery-handoff-fail')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // The other fallible step between the intent journal and Compose:
            // the recovery handoff inside the deploy branch throws when the
            // service refuses the CAS. Same contract as the policy gate:
            // the attempt settles as a deploy-arm failure and the intent row
            // is already durable, so the interrupted-window reconstruction
            // sees a requested deploy instead of an apply-only completion.
            mockRecoveryHandoff.mockReturnValue(false);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-recovery-handoff-fail');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(deploySpy).not.toHaveBeenCalled();
                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/the deploy failed: Failed to hand off recovery generation/i),
                });
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')).toBeDefined();
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(false);
                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                    reason: expect.stringMatching(/the deploy failed: Failed to hand off recovery generation/i),
                });
                expect(payload.deployGitopsOperationId).toBeUndefined();
                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(deploySpy).not.toHaveBeenCalled();
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('recovery reconstructs a recovery-handoff failure with a lost settle, never a quiet convergence', async () => {
            const sha = 'ae'.repeat(20);
            const svc = await seedPending('dispatch-recovery-lost-settle', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-recovery-lost-settle');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-recovery-lost-settle')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            mockRecoveryHandoff.mockReturnValue(false);
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated settle failure'); });
            const activitySpy = vi.spyOn(DatabaseService.getInstance(), 'addNotificationHistory');
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-recovery-lost-settle');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');
                expect(deploySpy).not.toHaveBeenCalled();
                expect(activitySpy.mock.calls.map((args) => args[1])).toContainEqual(
                    expect.objectContaining({
                        category: 'git_apply_failed',
                        message: expect.stringContaining('Dispatch settlement failed for dispatch-recovery-lost-settle'),
                    }),
                );
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === dispatchOp)).toBe(false);
                expect(GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')).toBeDefined();

                await svc.recoverUnsettledReconcileAttempts();
                const settledOnce = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settledOnce).toHaveLength(1);
                const payload = JSON.parse(settledOnce[0]!.after_json!);
                expect(payload.outcome).toBe('blocked');
                expect(payload).toMatchObject({
                    reason: expect.stringMatching(/no Compose deploy record was found/i),
                    nextAction: 'retry',
                    commitSha: sha,
                });
                expect(payload.deployGitopsOperationId).toBeUndefined();
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).not.toHaveBeenCalled();

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                settleSpy.mockRestore();
                activitySpy.mockRestore();
            }
        });

        it('recovery reconstructs a compound deploy-branch outage from the reservation fact, never a quiet convergence', async () => {
            const sha = 'cb'.repeat(20);
            const svc = await seedPending('dispatch-request-fact-outage', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-request-fact-outage');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-request-fact-outage')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            // The compound outage the reservation's deploy-request fact
            // exists to survive: the intent journal throws, the refusal
            // witness write throws with it, and the live settle fails in the
            // same window, so none of the three post-bind evidence rows
            // survive. The promotion and bind completed with durable rows,
            // so recovery reaches the bound no-intent state with nothing but
            // the reservation to read. Before the fact existed, that state
            // reconstructed as the source projection: a quiet
            // no-source-change convergence for a deploy the operator asked
            // for that never happened.
            const intentSpy = vi.spyOn(GitOpsTransitions.prototype, 'deployDispatched')
                .mockImplementation(() => { throw new Error('simulated intent journal failure'); });
            const witnessSpy = vi.spyOn(GitOpsTransitions.prototype, 'deployIntentRefused')
                .mockImplementation(() => { throw new Error('simulated witness journal failure'); });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated settle failure'); });
            const deriveSpy = vi.spyOn(svc as unknown as { deriveReconcileResult: (s: string) => unknown }, 'deriveReconcileResult')
                .mockImplementation(() => { throw new Error('the source projection must not decide a deploy-requested attempt'); });
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-request-fact-outage');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(deploySpy).not.toHaveBeenCalled();
                expect(result.status).toBe('blocked');
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                // The outage left no evidence rows: neither the intent nor
                // its refusal witness landed, and the settle write was lost,
                // exactly the state startup recovery must judge.
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === dispatchOp)).toBe(false);
                const store = GitOpsStore.getInstance();
                expect(store.getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')).toBeUndefined();
                expect(store.hasStageRowForAttempt(applicationId, dispatchOp, 'deploy_intent_refused')).toBe(false);
                // The durable proof the fact is the only line that survived:
                // the reservation row itself records the deploy request,
                // written before promotion ran.
                const reservation = store.getStartedAttempt(applicationId, dispatchOp)!;
                expect(JSON.parse(reservation.after_json)).toMatchObject({
                    dispatchGenerationId: generationId,
                    dispatchDeployRequested: true,
                });

                await svc.recoverUnsettledReconcileAttempts();
                const settledOnce = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settledOnce).toHaveLength(1);
                const payload = JSON.parse(settledOnce[0]!.after_json!);
                // The fact decides the arm: the requested deploy left no
                // durable record, so recovery states that and stops the
                // source projection from ever being consulted for this
                // attempt (the derive spy throws if it is).
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/requested a deploy that left no durable deploy record/i),
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                expect(payload.deployGitopsOperationId).toBeUndefined();
                expect(deriveSpy).not.toHaveBeenCalled();
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).not.toHaveBeenCalled();

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                intentSpy.mockRestore();
                witnessSpy.mockRestore();
                settleSpy.mockRestore();
                deriveSpy.mockRestore();
            }
        });

        it('keeps the source projection truthful for an apply-only dispatch whose settle was lost', async () => {
            const sha = 'cd'.repeat(20);
            const svc = await seedPending('dispatch-request-fact-apply-only', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-request-fact-apply-only');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-request-fact-apply-only')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // auto_deploy_on_apply stays off: the point is that the
            // deploy-request arm does NOT fire for an apply-only dispatch,
            // so the reservation must carry no fact at all.
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 0 WHERE stack_name = ?')
                .run('dispatch-request-fact-apply-only');
            // Let the live dispatch settle normally, then delete its
            // settled row to reproduce the state a lost settle write leaves:
            // a bound, apply-only attempt with no deploy evidence anywhere.
            const realDerive = (svc as unknown as { deriveReconcileResult: (s: string) => { outcome: string } }).deriveReconcileResult.bind(svc);
            let deriveCount = 0;
            const deriveSpy = vi.spyOn(svc as unknown as { deriveReconcileResult: (s: string) => { outcome: string } }, 'deriveReconcileResult')
                .mockImplementation((stack: string) => { deriveCount++; return realDerive(stack); });

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result).toEqual({ status: 'dispatched' });
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const reservation = GitOpsStore.getInstance().getStartedAttempt(applicationId, dispatchOp)!;
                expect('dispatchDeployRequested' in JSON.parse(reservation.after_json)).toBe(false);
                DatabaseService.getInstance().getDb()
                    .prepare("DELETE FROM gitops_history WHERE application_id = ? AND operation_id = ? AND stage = 'source_reconcile_settled'")
                    .run(applicationId, dispatchOp);
                const deriveCallsBefore = deriveCount;

                await svc.recoverUnsettledReconcileAttempts();
                const settledOnce = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settledOnce).toHaveLength(1);
                const payload = JSON.parse(settledOnce[0]!.after_json!);
                // An apply-only completion is exactly what the source
                // projection describes truthfully; the new arm must not
                // convert it into a phantom deploy failure.
                expect(payload).toMatchObject({ outcome: 'no_source_change', nextAction: 'none' });
                expect(deriveCount).toBeGreaterThan(deriveCallsBefore);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                deriveSpy.mockRestore();
            }
        });

        it('recovery reads a legacy marked reservation without the deploy-request fact as apply-only, never throwing', async () => {
            const sha = 'ce'.repeat(20);
            const svc = await seedPending('dispatch-request-fact-legacy', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-request-fact-legacy');
            const applicationId = liveApp('dispatch-request-fact-legacy')!.id;
            // Backward compatibility with reservations written before the
            // fact existed: a marked dispatch reservation whose payload
            // carries only the generation marker must decode (not throw) and
            // fall to the conservative apply-only reading when its settle is
            // missing. A dispatch whose persistence all failed under the old
            // build stays misreadable as convergence (the outage predates the
            // fact); what must not happen is recovery rejecting the row and
            // leaving the attempt stuck open forever.
            const { reserved } = GitOpsTransitions.getInstance()
                .allocateReconcileAttempt(applicationId, 'tester', 'manual', Date.now(), undefined, generationId);
            expect(reserved).toBe(true);
            const started = historyOperationIds(applicationId, 'source_reconcile_started');
            const dispatchOp = started[started.length - 1]!;
            const reservation = GitOpsStore.getInstance().getStartedAttempt(applicationId, dispatchOp)!;
            const legacyPayload = JSON.parse(reservation.after_json) as Record<string, unknown>;
            expect('dispatchDeployRequested' in legacyPayload).toBe(false);
            // Bind the generation on the target row directly: this
            // reproduces the durable bind the outage also leaves behind,
            // which is what routes recovery into the bound no-intent state
            // (an unbound row would take the promotion-witness arm instead).
            const nodeId = await defaultNodeId();
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE gitops_target_current SET applied_generation_id = ? WHERE application_id = ? AND node_id = ?')
                .run(generationId, applicationId, nodeId);
            // The source facet after acceptance, promotion, and a bind
            // without a deploy: whatever it projects, the invariant this
            // test pins is that recovery settled from it, not by throwing
            // over the missing fact and not as the deploy-requested failure.
            const liveOutcome = (svc as unknown as { deriveReconcileResult: (s: string) => { outcome: string } }).deriveReconcileResult('dispatch-request-fact-legacy').outcome;
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                await svc.recoverUnsettledReconcileAttempts();
                const settledOnce = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settledOnce).toHaveLength(1);
                const payload = JSON.parse(settledOnce[0]!.after_json!) as { outcome: string; reason?: string };
                expect(payload.outcome).toBe(liveOutcome);
                expect(payload.reason ?? '').not.toMatch(/no durable deploy record/i);
                // The row decoded cleanly: recovery logged nothing for it.
                const logged = errorSpy.mock.calls
                    .map((args) => args.map(String).join('\n')).join('\n');
                expect(logged).not.toContain(dispatchOp);
            } finally {
                errorSpy.mockRestore();
            }
        });

        it('keeps the deploy-op segment out of the evidence line when the deploy was untracked', async () => {
            const sha = 'fb'.repeat(20);
            const svc = await seedPending('dispatch-deploy-untracked', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-deploy-untracked');
            const generation = await acceptedGenerationById(generationId);
            const { ComposeService } = await import('../services/ComposeService');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // A deploy that succeeded but opened no GitOps operation (no
            // identity, or the tracking write itself failed) must not print a
            // dangling "(deploy op ...)" an operator cannot resolve.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-deploy-untracked');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({ status: 'dispatched' });
                const appliedLine = logSpy.mock.calls.map((args) => String(args[0]))
                    .find((text) => text.includes('[GitSource] Applied and deployed dispatch-deploy-untracked'));
                expect(appliedLine).toBeDefined();
                expect(appliedLine).not.toContain('(deploy op');
                // The settled row keeps the same promise the log line makes:
                // no correlation id exists for an untracked deploy, so the
                // field is absent rather than null or empty.
                const settled = settledAttemptsForApplication(liveApp('dispatch-deploy-untracked')!.id);
                const settledResult = JSON.parse(settled[settled.length - 1]!.after_json!) as Record<string, unknown>;
                expect('deployGitopsOperationId' in settledResult).toBe(false);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                logSpy.mockRestore();
            }
        });

        it('binds the Direct target before the deploy branch opens its GitOps operation', async () => {
            const sha = 'ca'.repeat(20);
            const svc = await seedPending('dispatch-bind-before-deploy', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-bind-before-deploy');
            const generation = await acceptedGenerationById(generationId);
            const { ComposeService } = await import('../services/ComposeService');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            // beginGitOpsDeploy reads the target's applied generation when it
            // opens the deploy's own GitOps operation, so the dispatch bind
            // must occupy manual apply's applied() position: after promotion
            // commits, before Compose runs. A bind that ran after the
            // pipeline would record a real deploy against the previous
            // generation, or none at all.
            const order: string[] = [];
            const realBind = GitOpsTransitions.prototype.targetApplied;
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockImplementation(async () => { order.push('promote'); });
            const bindSpy = vi.spyOn(GitOpsTransitions.prototype, 'targetApplied')
                .mockImplementation(function (this: GitOpsTransitions, ...args: Parameters<typeof realBind>) {
                    order.push('bind');
                    return realBind.apply(this, args);
                });
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockImplementation(async () => {
                    order.push('deploy');
                    return { recoveryId: null, deployedGenerationId: null, gitopsOperationId: null };
                });
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-bind-before-deploy');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({ status: 'dispatched' });
                expect(order).toEqual(['promote', 'bind', 'deploy']);
            } finally {
                promoteSpy.mockRestore();
                bindSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('settles a transient revalidation refusal with a retry next action', async () => {
            const sha = 'fc'.repeat(20);
            const svc = await seedPending('dispatch-transient-read', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-transient-read');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-transient-read')!.id;
            const candidateAbs = path.join(
                stackManagedRoot('dispatch-transient-read'),
                GitOpsStore.getInstance().getGeneration(generationId)!.candidate_dir,
            );
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');
            // An EACCES on the candidate barrier is not a conflict anyone has
            // to resolve: the settled row must advise a retry. Injected per
            // path so unrelated fs reads in the same dispatch are untouched.
            const { promises: fsPromises } = await import('fs');
            const realAccess = fsPromises.access.bind(fsPromises);
            const accessSpy = vi.spyOn(fsPromises, 'access')
                .mockImplementation(async (...args: Parameters<typeof realAccess>) => {
                    if (typeof args[0] === 'string' && path.resolve(args[0]) === candidateAbs) {
                        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
                    }
                    return realAccess(...args);
                });

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringContaining('try again'),
                });
                const settled = settledAttemptsForApplication(applicationId);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                    outcome: 'blocked',
                    nextAction: 'retry',
                });
                expect(promoteSpy.mock.calls).toHaveLength(0);
            } finally {
                promoteSpy.mockRestore();
                accessSpy.mockRestore();
            }
        });

        it('blocks with recovery evidence when an auto-deploy applies but the deploy fails', async () => {
            const sha = 'd8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8';
            const svc = await seedPending('dispatch-auto-deploy-fails', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-auto-deploy-fails');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-auto-deploy-fails')!.id;
            const { ComposeService } = await import('../services/ComposeService');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockRejectedValue(
                new Error('compose up failed: docker unavailable'),
            );
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-auto-deploy-fails');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/deploy failed/i),
                });
                // The promotion committed, so the target binding happened even
                // though the deploy did not.
                expect(GitOpsStore.getInstance().getTarget(applicationId, await defaultNodeId())?.applied_generation_id).toBe(generationId);
                const settled = settledAttemptsForApplication(applicationId);
                const last = settled[settled.length - 1]!;
                expect(JSON.parse(last.after_json!)).toMatchObject({ outcome: 'recovery_required', nextAction: 'view_target_results' });
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('names the tracked deploy operation on the settled row when an auto-deploy succeeds', async () => {
            const sha = 'b4'.repeat(20);
            const svc = await seedPending('dispatch-deploy-correlation-ok', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-deploy-correlation-ok');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-deploy-correlation-ok')!.id;
            const { ComposeService } = await import('../services/ComposeService');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // Compose returns the canonical operation id of the deploy it
            // ran; the dispatch settlement must carry the exact same id so
            // an operator reading the attempt's evidence lands on the
            // deploy's own history rows, not a timestamp guess.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue(
                { recoveryId: null, deployedGenerationId: null, gitopsOperationId: 'deploy-op-success-correlation' },
            );
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-deploy-correlation-ok');
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result).toEqual({ status: 'dispatched' });
                const settled = settledAttemptsForApplication(applicationId);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                    deployGitopsOperationId: 'deploy-op-success-correlation',
                });
                // Producer half of the recovery contract: the dispatch's own
                // reservation must carry the marker naming this generation, or
                // startup recovery cannot tell this attempt from a plain
                // reconcile and falls back to the projection that lies about
                // interrupted promotions.
                const dispatchOperationId = settled[settled.length - 1]!.operation_id;
                const startedRow = DatabaseService.getInstance().getDb()
                    .prepare("SELECT after_json FROM gitops_history WHERE application_id = ? AND operation_id = ? AND stage = 'source_reconcile_started'")
                    .get(applicationId, dispatchOperationId) as { after_json: string };
                expect(JSON.parse(startedRow.after_json)).toMatchObject({ dispatchGenerationId: generationId });
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                logSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('names the failed deploy operation on the settled row when Compose tracked the deploy', async () => {
            const sha = 'b5'.repeat(20);
            const svc = await seedPending('dispatch-deploy-correlation-fail', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-deploy-correlation-fail');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-deploy-correlation-fail')!.id;
            const { ComposeService } = await import('../services/ComposeService');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // The failure arm's correlation rides on the error itself:
            // ComposeService stamps a tracked deploy's operation id before
            // rethrowing, and the dispatch caller reads it type-guarded.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockRejectedValue(
                Object.assign(new Error('compose up failed: exited 1'), {
                    gitopsDeployOperationId: 'deploy-op-failure-correlation',
                }),
            );
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-deploy-correlation-fail');
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');
                const settled = settledAttemptsForApplication(applicationId);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                    deployGitopsOperationId: 'deploy-op-failure-correlation',
                });
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                logSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('omits the deploy correlation from the settled row when the failed deploy was untracked', async () => {
            const sha = 'ab'.repeat(20);
            const svc = await seedPending('dispatch-deploy-correlation-untracked', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-deploy-correlation-untracked');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-deploy-correlation-untracked')!.id;
            const { ComposeService } = await import('../services/ComposeService');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // A deploy that opened no GitOps operation (a stack with no live
            // application identity at deploy time, or a failed tracking
            // write) leaves the error unstamped; the settlement must then
            // carry no id at all rather than a fabricated or stale one.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockRejectedValue(new Error('compose up failed: no tracked deploy'));
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-deploy-correlation-untracked');
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');
                const settled = settledAttemptsForApplication(applicationId);
                const settledResult = JSON.parse(settled[settled.length - 1]!.after_json!) as Record<string, unknown>;
                expect(settledResult.outcome).toBe('recovery_required');
                expect('deployGitopsOperationId' in settledResult).toBe(false);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                logSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        /**
         * A guard refusal must settle the reserved attempt as blocked with
         * resolve_conflict (the files are untouched), reserve exactly one
         * started row, promote nothing, and leave the acceptance pointer
         * exactly as the test wrote it (dispatch never restores or moves it).
         */
        async function expectGuardBlocked(
            stackName: string,
            generationId: string,
            reason: RegExp,
            promoteSpy: { mock: { calls: unknown[] } },
            acceptedAfter: string = generationId,
        ): Promise<void> {
            const svc = GitSourceService.getInstance();
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp(stackName)!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const settledBefore = settledAttemptsForApplication(applicationId).length;

            const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

            expect(result).toEqual({ status: 'blocked', reason: expect.stringMatching(reason) });
            const settled = settledAttemptsForApplication(applicationId);
            expect(settled).toHaveLength(settledBefore + 1);
            expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                outcome: 'blocked',
                nextAction: 'resolve_conflict',
            });
            expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore + 1);
            expect(promoteSpy.mock.calls).toHaveLength(0);
            expect(liveApp(stackName)!.accepted_generation_id).toBe(acceptedAfter);
        }

        // The guards that revalidate the application/target rows between
        // acceptance and promotion each refuse with their own settled
        // blocked row. Mutations are applied to the durable rows the same way
        // a concurrent pull, suspend, or detach would move them.
        it.each([
            {
                name: 'suspended',
                stack: 'dispatch-guard-susp',
                sha: 'f4'.repeat(20),
                sql: 'UPDATE gitops_applications SET suspended_at = ? WHERE id = ?',
                bind: 'suspended',
                reason: /Reconciliation is suspended/i,
            },
            {
                name: 'accepted generation moved',
                stack: 'dispatch-guard-moved',
                sha: 'f5'.repeat(20),
                sql: "UPDATE gitops_applications SET accepted_generation_id = 'other-generation' WHERE id = ?",
                bind: 'id',
                acceptedAfter: 'other-generation',
                reason: /accepted generation changed before dispatch/i,
            },
            {
                name: 'acceptance evidence missing',
                stack: 'dispatch-guard-evidence',
                sha: 'f7'.repeat(20),
                sql: 'UPDATE gitops_applications SET artifact_set_id = NULL WHERE id = ?',
                bind: 'id',
                reason: /no recorded acceptance evidence/i,
            },
            {
                name: 'target tombstoned',
                stack: 'dispatch-guard-tomb',
                sha: 'f8'.repeat(20),
                sql: "UPDATE gitops_target_current SET target_status = 'tombstoned' WHERE application_id = ?",
                bind: 'id',
                reason: /target is tombstoned/i,
            },
            {
                name: 'target candidate moved',
                stack: 'dispatch-guard-tcand',
                sha: 'f9'.repeat(20),
                sql: "UPDATE gitops_target_current SET candidate_generation_id = 'other-generation' WHERE application_id = ?",
                bind: 'id',
                reason: /target candidate no longer matches/i,
            },
        ])('settles blocked when the live row says the acceptance is "$name"', async ({ stack, sha, sql, bind, reason, acceptedAfter }) => {
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');
            try {
                const svc = await seedPending(stack, 'services:\n  x:\n    image: alpine\n', sha);
                void svc;
                const generationId = acceptCandidate(stack);
                const appId = liveApp(stack)!.id;
                DatabaseService.getInstance().getDb().prepare(sql).run(
                    ...(bind === 'suspended' ? [Date.now(), appId] : [appId]),
                );
                await expectGuardBlocked(stack, generationId, reason, promoteSpy, acceptedAfter);
            } finally {
                promoteSpy.mockRestore();
            }
        });

        it('scrubs credential-shaped text from a refusal before it reaches the settled row', async () => {
            const sha = 'fd'.repeat(20);
            const svc = await seedPending('dispatch-scrub', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-scrub');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-scrub')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            // Git transport failures routinely embed the remote URL; a PAT
            // that ever leaked into one must not be persisted verbatim into
            // operator-visible durable state, and the settled row is exactly
            // where a leak would outlive the log rotation.
            const readSpy = vi.spyOn(GitProjectManifestService.prototype, 'readManifest')
                .mockRejectedValueOnce(new Error(
                    "fatal: cannot reach 'https://user:sup3rs3cr3t@github.com/example/repo.git/'",
                ));
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: "fatal: cannot reach 'https://***:***@github.com/example/repo.git/'",
                });
                const settled = settledAttemptsForApplication(applicationId);
                const row = JSON.parse(settled[settled.length - 1]!.after_json!);
                expect(row.reason).not.toContain('sup3rs3cr3t');
                expect(row.reason).toContain('***');
                // The generic dispatch catch logs the error before anything
                // downstream sees it, and it logs the stack, not just the
                // message: the head line of this throw's stack repeats the
                // credential-bearing message, so a log site that scrubbed the
                // message alone would still leak through the stack.
                const logged = errorSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
                expect(logged).toContain('[GitSource] Dispatch of dispatch-scrub threw');
                expect(logged).not.toContain('sup3rs3cr3t');
                expect(logged).toContain('***');
            } finally {
                readSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('scrubs credential-shaped text from the reservation-catch log before it reaches the server log', async () => {
            const sha = 'a9'.repeat(20);
            const svc = await seedPending('dispatch-reserve-log-scrub', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-reserve-log-scrub');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-reserve-log-scrub')!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            // Reservation failures are store or transport errors whose text
            // can embed credential-bearing URLs the same way Git transport
            // output does; this catch logs the stack directly, so it is
            // another dispatch-path surface that must scrub before the
            // server log (the generic dispatch catch has its own test
            // above). Provider auth material also rides in header-shaped
            // text: a Bearer PAT, a Basic blob, and a JWT triple must all
            // come out redacted, not just URL userinfo.
            const reserveSpy = vi.spyOn(GitOpsTransitions.prototype, 'allocateReconcileAttempt')
                .mockImplementationOnce(() => {
                    throw new Error(
                        'GitOps store write failed via https://svc:sup3rs3cr3t@example.com/store '
                        + 'with Authorization: Bearer ghp_realtokenvalue1 and Basic c3VwZXI6c2VjcmV0 '
                        + 'and jwt headerpart1x.bodypart2y.sigpart3z',
                    );
                });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringContaining('GitOps tracking is unavailable'),
                });
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore);
                const logged = errorSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
                expect(logged).toContain('Failed to reserve a durable attempt');
                expect(logged).not.toContain('sup3rs3cr3t');
                expect(logged).not.toContain('ghp_realtokenvalue1');
                expect(logged).not.toContain('c3VwZXI6c2VjcmV0');
                expect(logged).not.toContain('bodypart2y');
                expect(logged).toContain('***');
            } finally {
                reserveSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('scrubs credential-shaped text from the promotion-failure log before it reaches the server log', async () => {
            const sha = 'aa'.repeat(20);
            const svc = await seedPending('dispatch-promote-log-scrub', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-promote-log-scrub');
            const generation = await acceptedGenerationById(generationId);
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            // A raw promote failure logs at the pipeline's own catch before
            // the dispatch catch ever sees the rewrapped error, so it is a
            // separate log surface from the generic dispatch catch: both the
            // pipeline-site log and the generic dispatch-catch log must come
            // out clean.
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockRejectedValueOnce(new Error(
                    "fatal: push rejected for 'https://x-access:sup3rs3cr3t@example.com/repo.git'",
                ));
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/push rejected/s),
                });
                const logged = errorSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
                expect(logged).toContain('promotion failed for dispatch-promote-log-scrub');
                expect(logged).toContain('Dispatch of dispatch-promote-log-scrub threw');
                expect(logged).not.toContain('sup3rs3cr3t');
                expect(logged).toContain('***');
            } finally {
                promoteSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('treats a GitSourceError from the promotion catch as untrusted files', async () => {
            const sha = 'fe'.repeat(20);
            const svc = await seedPending('dispatch-giterror-arm', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-giterror-arm');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-giterror-arm')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { GitSourceError } = await import('../services/GitSourceService');
            // promoteGeneration throws no GitSourceError today. One arriving
            // here has unknown provenance relative to the file mutation, so
            // the fail-dangerous guard must flag the files as untrusted
            // before the rethrow: the dispatch settles recovery_required,
            // not the plain refusal the message's shape would suggest.
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockRejectedValueOnce(new GitSourceError('GIT_ERROR', 'simulated unknown-provenance refusal'));
            const targetSpy = vi.spyOn(GitOpsTransitions.prototype, 'targetApplied');
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/did not complete cleanly.*may already be updated/s),
                });
                const settled = settledAttemptsForApplication(applicationId);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                });
                expect(targetSpy).not.toHaveBeenCalled();
            } finally {
                promoteSpy.mockRestore();
                targetSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('blocks without reserving when the attempt reservation itself throws', async () => {
            const sha = 'f3'.repeat(20);
            const svc = await seedPending('dispatch-reserve-throws', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-reserve-throws');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-reserve-throws')!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const settledBefore = settledAttemptsForApplication(applicationId).length;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');
            const reserveSpy = vi.spyOn(GitOpsTransitions.prototype, 'allocateReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated store outage'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringContaining('GitOps tracking is unavailable'),
                });
                expect(promoteSpy).not.toHaveBeenCalled();
                // Nothing was reserved, so nothing may be settled: an
                // unsettled attempt here would strand a phantom reservation
                // for startup recovery to chase forever.
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore);
                expect(settledAttemptsForApplication(applicationId)).toHaveLength(settledBefore);
            } finally {
                promoteSpy.mockRestore();
                reserveSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('settles the reserved attempt as blocked when a store read throws before promotion', async () => {
            const sha = 'e1'.repeat(20);
            const svc = await seedPending('dispatch-throw-pre', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-throw-pre');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-throw-pre')!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const settledBefore = settledAttemptsForApplication(applicationId).length;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            // A throw from revalidation (here the prior-manifest read the plan
            // recompute depends on) must settle the reserved attempt and
            // return blocked, never escape runExclusive with it open.
            const readSpy = vi.spyOn(GitProjectManifestService.prototype, 'readManifest')
                .mockRejectedValueOnce(new Error('transient read failure'));
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/transient read failure/),
                });
                // The dispatch catch is the only handler for this throw: the
                // settled row keeps the scrubbed reason, the stack lives here.
                expect(errorSpy).toHaveBeenCalledWith(
                    expect.stringContaining('Dispatch of dispatch-throw-pre threw'),
                    expect.stringContaining('transient read failure'),
                );
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore + 1);
                const settled = settledAttemptsForApplication(applicationId);
                expect(settled).toHaveLength(settledBefore + 1);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({ outcome: 'blocked' });
            } finally {
                readSpy.mockRestore();
                promoteSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('settles recovery_required when the pipeline throws after the promotion committed', async () => {
            const sha = 'e2'.repeat(20);
            const svc = await seedPending('dispatch-throw-post', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-throw-post');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-throw-post')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // The applied-mark write runs after the promotion committed and
            // after the progress flag flips; a throw there is a completion
            // failure over rewritten files, not a refusal.
            const markSpy = vi.spyOn(DatabaseService.prototype, 'markGitSourceApplied')
                .mockImplementationOnce(() => { throw new Error('simulated bookkeeping failure'); });

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(
                        /did not complete cleanly.*may already be updated/s,
                    ),
                });
                const settled = settledAttemptsForApplication(applicationId);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                });
            } finally {
                promoteSpy.mockRestore();
                markSpy.mockRestore();
            }
        });

        it('settles recovery_required when promotion fails and the automatic restore also fails', async () => {
            const sha = 'e5'.repeat(20);
            const svc = await seedPending('dispatch-restore-failed', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-restore-failed');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-restore-failed')!.id;
            const { GitProjectManifestService, PromoteGenerationError } = await import('../services/GitProjectManifestService');
            // The `recovery_required` phase means the live Compose files were
            // already renamed away from the previous generation and the
            // automatic restore failed on top of that. Past that boundary the
            // dispatch outcome must be recovery_required like a post-promotion
            // throw, not a plain refusal that tells the operator to resolve a
            // conflict over untouched files.
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockRejectedValue(new PromoteGenerationError('recovery_required', new Error('simulated restore failure')));
            const targetSpy = vi.spyOn(GitOpsTransitions.prototype, 'targetApplied');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(
                        /did not complete cleanly.*simulated restore failure.*may already be updated/s,
                    ),
                });
                const settled = settledAttemptsForApplication(applicationId);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                });
                // The promotion never committed, so the target binding that
                // follows a successful pipeline must not have happened.
                expect(targetSpy).not.toHaveBeenCalled();
            } finally {
                promoteSpy.mockRestore();
                targetSpy.mockRestore();
            }
        });

        it('settles plain blocked when promotion fails but the automatic restore succeeded', async () => {
            const sha = 'e6'.repeat(20);
            const svc = await seedPending('dispatch-restore-ok', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-restore-ok');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-restore-ok')!.id;
            const { GitProjectManifestService, PromoteGenerationError } = await import('../services/GitProjectManifestService');
            // The 'restored' phase means the failed promotion was fully rolled
            // back: the live files still hold the previous generation, so the
            // honest dispatch outcome is the plain blocked refusal, not the
            // recovery_required wording reserved for untrusted files.
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockRejectedValue(new PromoteGenerationError('restored', new Error('simulated promote failure')));
            const targetSpy = vi.spyOn(GitOpsTransitions.prototype, 'targetApplied');
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const settledBefore = settledAttemptsForApplication(applicationId).length;

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringContaining('simulated promote failure'),
                });
                const settled = settledAttemptsForApplication(applicationId);
                expect(settled).toHaveLength(settledBefore + 1);
                const settledRow = JSON.parse(settled[settled.length - 1]!.after_json!);
                expect(settledRow).toMatchObject({
                    outcome: 'blocked',
                    nextAction: 'resolve_conflict',
                });
                expect(settledRow.reason).not.toMatch(/may already be updated/);
                // The source row's bookkeeping distinguishes the rollback from
                // a plain failure, same as the manual apply path.
                expect(DatabaseService.getInstance().getGitSource('dispatch-restore-ok')?.last_plan_outcome)
                    .toBe('rolled_back');
                expect(targetSpy).not.toHaveBeenCalled();
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore + 1);
            } finally {
                promoteSpy.mockRestore();
                targetSpy.mockRestore();
            }
        });

        it('settles recovery_required and stops the deploy branch when the promotion committed but the target binding write fails', async () => {
            const sha = 'e8'.repeat(20);
            const svc = await seedPending('dispatch-bind-fails', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-bind-fails');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-bind-fails')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const { HealthGateService } = await import('../services/HealthGateService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // recordGitOps turns a throwing transition into a false return,
            // so a rejected binding never reaches the catch below the
            // pipeline: the !bound branch must apply the same
            // recovery_required classification the throw path uses, since
            // the live files are rewritten either way.
            const targetSpy = vi.spyOn(GitOpsTransitions.prototype, 'targetApplied')
                .mockImplementation(() => { throw new Error('simulated binding rejection'); });
            // Auto-deploy is on: the bind rejection must halt the pipeline at
            // the post-commit boundary, before the policy gate and Compose.
            // A deploy of files the target pointer does not describe is the
            // half-applied state this classification exists to prevent, so
            // the "did not run" evidence matters more than the outcome row.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack');
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-bind-fails');
            mockInvalidateNodeCaches.mockClear();
            mockTriggerPostDeployScan.mockClear();
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/could not be bound/i),
                });
                const settled = settledAttemptsForApplication(applicationId);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                });
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(targetSpy).toHaveBeenCalledTimes(1);
                // Nothing past the bind ran: no deploy, no deploy GitOps
                // history under this attempt, no health gate, no scan.
                expect(deploySpy).not.toHaveBeenCalled();
                expect(beginSpy).not.toHaveBeenCalled();
                expect(mockTriggerPostDeployScan).not.toHaveBeenCalled();
                expect(historyOperationIds(applicationId, 'deploy_started')).toHaveLength(0);
            } finally {
                promoteSpy.mockRestore();
                targetSpy.mockRestore();
                deploySpy.mockRestore();
                beginSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('blocks without settling when the reservation collides with an existing attempt', async () => {
            const sha = 'e3'.repeat(20);
            const svc = await seedPending('dispatch-reserved-false', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-reserved-false');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-reserved-false')!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const settledBefore = settledAttemptsForApplication(applicationId).length;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const reserveSpy = vi.spyOn(GitOpsTransitions.prototype, 'allocateReconcileAttempt')
                .mockImplementationOnce(() => ({ operationId: 'collided:attempt:1', reserved: false }));
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/already recorded/i),
                });
                // Nothing was reserved, so nothing may be settled: the
                // colliding attempt belongs to its own owner (or startup
                // recovery), and a second promote would double-apply.
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore);
                expect(settledAttemptsForApplication(applicationId)).toHaveLength(settledBefore);
            } finally {
                reserveSpy.mockRestore();
                promoteSpy.mockRestore();
            }
        });

        it('refuses promotion when the accepted generation records no plan fingerprint to compare', async () => {
            const sha = 'e4'.repeat(20);
            const svc = await seedPending('dispatch-null-fingerprint', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-null-fingerprint');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-null-fingerprint')!.id;
            // The recorded plan evidence must exist before it is erased, or
            // the test would prove nothing about the null branch.
            expect(GitOpsStore.getInstance().getGeneration(generationId)?.change_plan_fingerprint).not.toBeNull();
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE gitops_generations SET change_plan_fingerprint = NULL WHERE id = ?')
                .run(generationId);
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack');
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('dispatch-null-fingerprint');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);

                // A null stored fingerprint means "no evidence to compare",
                // not "no drift": the fingerprint equality check is the only
                // proof that the accepted change still describes the live
                // target, so its absence fails closed. The source acceptance
                // itself is not in doubt, so the refusal only asks the
                // operator to fetch and accept again.
                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/records no change-plan evidence/i),
                });
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(deploySpy).not.toHaveBeenCalled();
                const settled = settledAttemptsForApplication(applicationId);
                expect(JSON.parse(settled[settled.length - 1]!.after_json!)).toMatchObject({
                    outcome: 'blocked',
                    nextAction: 'resolve_conflict',
                });
                expect(liveApp('dispatch-null-fingerprint')!.accepted_generation_id).toBe(generationId);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('blocks a direct-mode dispatch when the generation names an application that no longer exists', async () => {
            const sha = 'd9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9';
            const svc = await seedPending('dispatch-no-stack', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-no-stack');
            const generation = await acceptedGenerationById(generationId);
            const orphanGeneration = { ...generation, applicationId: 'no-such-application' };

            const result = await svc.dispatchAcceptedGeneration(orphanGeneration, directContext, manualDispatch);

            expect(result).toEqual({
                status: 'blocked',
                reason: expect.stringMatching(/no direct stack is bound/i),
            });
        });

        it('leaves an unsettled dispatch attempt for startup recovery when the in-process settle fails, and recovery settles it once under the original id', async () => {
            const sha = 'e7'.repeat(20);
            const svc = await seedPending('dispatch-settle-crash', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-settle-crash');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-settle-crash')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // A settle write that throws is the in-test stand-in for dying
            // between the promotion and the settled row: settleAttempt
            // swallows the failure, the dispatch still reports dispatched,
            // and the reservation stays open exactly the way startup
            // recovery expects to find it.
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated settle failure'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result).toEqual({ status: 'dispatched' });

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === dispatchOp)).toBe(false);

                // Recovery closes the attempt under the original dispatch
                // operation id, deriving the outcome from current state
                // rather than re-executing the promotion.
                await svc.recoverUnsettledReconcileAttempts();
                const settledOnce = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settledOnce).toHaveLength(1);
                // Recovery derives from the live row state, and the promoted
                // dispatch left the facet at "accepted generation is current
                // and applied": the honest close is the same
                // no_source_change the in-process settle would have written.
                expect(JSON.parse(settledOnce[0]!.after_json!)).toMatchObject({
                    outcome: 'no_source_change',
                    nextAction: 'none',
                });
                expect(promoteSpy).toHaveBeenCalledTimes(1);

                // A second recovery pass adds nothing: the history dedupe
                // index makes the first settled result permanent.
                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('recovery settles a dispatch interrupted before the promotion as unknown with a retry, never re-promoting', async () => {
            const sha = 'b1'.repeat(20);
            const svc = await seedPending('dispatch-recover-pre-promote', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-recover-pre-promote');
            const applicationId = liveApp('dispatch-recover-pre-promote')!.id;
            // The crash point is a state, not a code path: the process died
            // between the marked reservation and the promotion, leaving the
            // marker as the only durable trace of the intended dispatch.
            // Reserving directly reproduces that state without letting any
            // promotion run first.
            const { reserved } = GitOpsTransitions.getInstance()
                .allocateReconcileAttempt(applicationId, 'tester', 'manual', Date.now(), undefined, generationId);
            expect(reserved).toBe(true);
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');

            try {
                await svc.recoverUnsettledReconcileAttempts();

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                // Promotion is unproven and the generation is still the
                // accepted one, so the truthful close is "not proven applied,
                // dispatch it again", not the derive projection's quiet
                // no_source_change.
                expect(JSON.parse(settled[0]!.after_json!)).toMatchObject({
                    outcome: 'unknown',
                    reason: expect.stringMatching(/nothing was proven applied/i),
                    nextAction: 'retry',
                    commitSha: sha,
                });
                // Recovery closes attempts, it never resurrects work.
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(liveApp('dispatch-recover-pre-promote')!.accepted_generation_id).toBe(generationId);
                expect(GitOpsStore.getInstance()
                    .getTarget(applicationId, await defaultNodeId())?.applied_generation_id).not.toBe(generationId);
            } finally {
                promoteSpy.mockRestore();
            }
        });

        it('recovery settles a dispatch interrupted after the promotion but before its bind settlement as recovery_required', async () => {
            const sha = 'b2'.repeat(20);
            const svc = await seedPending('dispatch-recover-post-promote', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-recover-post-promote');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-recover-post-promote')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // The bind rejection stops the pipeline at the post-commit
            // boundary, and the settle its bindRejected arm attempts is the
            // step the simulated crash takes away: the marked attempt stays
            // open with the promotion's bookkeeping fully landed, which is
            // exactly what startup recovery must read as recovery_required.
            const targetSpy = vi.spyOn(GitOpsTransitions.prototype, 'targetApplied')
                .mockImplementation(() => { throw new Error('simulated bind crash'); });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated crash before settle'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            // The failed settle write must leave a trace outside the attempt
            // row even though recovery can now reconstruct this same
            // classification from the witness: the activity mirror is the
            // belt-and-suspenders copy, so the settled row and the
            // reconstructed one are never the operator's only trace.
            const activitySpy = vi.spyOn(DatabaseService.getInstance(), 'addNotificationHistory');

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result).toEqual({
                    status: 'blocked',
                    reason: expect.stringMatching(/could not be bound/i),
                });
                expect(activitySpy.mock.calls.map((args) => args[1])).toContainEqual(
                    expect.objectContaining({
                        category: 'git_apply_failed',
                        message: expect.stringContaining('could not be bound'),
                    }),
                );
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === dispatchOp)).toBe(false);

                await svc.recoverUnsettledReconcileAttempts();

                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                expect(JSON.parse(settled[0]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/could not be bound/i),
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                // One promotion across the whole interrupted-then-recovered
                // lifecycle: recovery settles from evidence, never re-applies.
                expect(promoteSpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                targetSpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
                activitySpy.mockRestore();
            }
        });

        it('recovery proves the promotion from the witness when the crash lands between the commit and the source bookkeeping', async () => {
            const sha = 'b6'.repeat(20);
            const svc = await seedPending('dispatch-recover-bookkeeping-crash', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('dispatch-recover-bookkeeping-crash');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('dispatch-recover-bookkeeping-crash')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            // The crash point is the first durable write after the witness:
            // the promotion has committed and the witness has landed, but the
            // source rows still describe the previous generation, no applied
            // mark exists, and the target bind never ran. Failing the
            // in-process settle once leaves the attempt open exactly the way
            // a process death would.
            const bookkeepingSpy = vi.spyOn(DatabaseService.getInstance(), 'setGitSourceLastPlan')
                .mockImplementationOnce(() => { throw new Error('simulated bookkeeping crash'); });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated crash before settle'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');

                // The trap the old recovery fell into: every source-level
                // piece of promotion evidence is still absent, so the only
                // durable proof that the files changed is the witness row.
                const src = DatabaseService.getInstance().getGitSource('dispatch-recover-bookkeeping-crash')!;
                expect(src.last_applied_commit_sha).toBeNull();
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, dispatchOp, 'promotion_committed')).toBe(true);
                const nodeId = await defaultNodeId();
                expect(GitOpsStore.getInstance().getTarget(applicationId, nodeId)?.applied_generation_id)
                    .not.toBe(generationId);

                await svc.recoverUnsettledReconcileAttempts();

                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                // Witness-proven promotion with no bind settles
                // recovery_required, never the false "nothing was proven
                // applied" the unproven arm words.
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    nextAction: 'view_target_results',
                    commitSha: sha,
                });
                expect(payload.reason).not.toMatch(/nothing was proven applied/i);
                expect(promoteSpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                bookkeepingSpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('recovery settles a dispatch whose journaled deploy never started as an interrupted deploy with a retry', async () => {
            const sha = 'b9'.repeat(20);
            const svc = await seedPending('recover-deploy-intent-only', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('recover-deploy-intent-only');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('recover-deploy-intent-only')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('recover-deploy-intent-only');
            // The deploy intent journaled, Compose never recorded opening the
            // deploy: the mock throws before any Compose transition exists,
            // and the failing in-process settle leaves the attempt open with
            // bind + intent but no deploy rows, the exact post-bind crash
            // state recovery must reconstruct.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockRejectedValue(new Error('simulated crash before Compose began'));
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated crash before settle'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const intentRow = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')!;
                expect(intentRow).toBeTruthy();
                const deployId = JSON.parse(intentRow.after_json!).deployOperationId as string;
                expect(typeof deployId).toBe('string');
                // The journaled id is the exact id handed to Compose: the
                // linkage the intent row promises was really threaded.
                expect(deploySpy.mock.calls[0]![3]!.gitopsDeployOperationId).toBe(deployId);
                expect(historyOperationIds(applicationId, 'deploy_started')).not.toContain(deployId);

                await svc.recoverUnsettledReconcileAttempts();

                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                // The files were promoted and bound, so this is not "nothing
                // was proven applied"; the deploy never began, so this is not
                // recovery_required either. It is a missing deploy record with
                // a truthful retry, and no deploy id is claimed because no
                // deploy record exists to point at.
                expect(payload).toMatchObject({
                    outcome: 'blocked',
                    reason: expect.stringMatching(/no Compose deploy record was found/i),
                    nextAction: 'retry',
                    commitSha: sha,
                });
                expect(payload).not.toHaveProperty('deployGitopsOperationId');
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('recovery reconstructs a successful tracked deploy and settles the attempt with its exact deploy id', async () => {
            const sha = 'c0'.repeat(20);
            const svc = await seedPending('recover-deploy-bound-settle-crash', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('recover-deploy-bound-settle-crash');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('recover-deploy-bound-settle-crash')!.id;
            const nodeId = await defaultNodeId();
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('recover-deploy-bound-settle-crash');
            // A successful tracked deploy: the mock opens and finishes Compose
            // transitions under the exact id dispatch journaled, then the
            // in-process settle dies. The attempt stays open while the
            // deploy's own rows stand, which recovery must read as "the
            // deploy completed, only the settle was lost", linked by id.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockImplementation(async (_stack, _ws, _atomic, ctx) => {
                    const tx = GitOpsTransitions.getInstance();
                    const env = {
                        operationId: ctx!.gitopsDeployOperationId!,
                        actor: 'system:compose',
                        trigger: 'deploy',
                        at: Date.now(),
                    };
                    tx.deployStarted(applicationId, nodeId, generationId, env);
                    tx.deployBound(applicationId, nodeId, generationId, env);
                    return { recoveryId: null, deployedGenerationId: generationId, gitopsOperationId: env.operationId };
                });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated crash before settle'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result).toEqual({ status: 'dispatched' });

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const intentRow = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')!;
                const deployId = JSON.parse(intentRow.after_json!).deployOperationId as string;
                expect(historyOperationIds(applicationId, 'deploy_started')).toContain(deployId);
                expect(historyOperationIds(applicationId, 'deploy_bound')).toContain(deployId);
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === dispatchOp)).toBe(false);

                await svc.recoverUnsettledReconcileAttempts();

                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                // The settled row names the exact deploy that ran under the
                // attempt, and the completed pipeline closes from the source
                // projection itself: the accepted generation is current and
                // applied, so the truthful outcome is the same
                // no_source_change the lost in-process settle would have
                // written, plus the exact deploy id.
                expect(payload).toMatchObject({
                    outcome: 'no_source_change',
                    nextAction: 'none',
                    deployGitopsOperationId: deployId,
                    commitSha: sha,
                });
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('recovery reconstructs a failed tracked deploy as recovery_required naming its exact deploy id', async () => {
            const sha = 'c1'.repeat(20);
            const svc = await seedPending('recover-deploy-failed-settle-crash', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('recover-deploy-failed-settle-crash');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('recover-deploy-failed-settle-crash')!.id;
            const nodeId = await defaultNodeId();
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('recover-deploy-failed-settle-crash');
            // The deploy started, failed, and recorded its failure under the
            // journaled id; then the dispatch's own settle died. Recovery must
            // distinguish this from the completed-deploy case: the deploy
            // failed and the operator needs the target results, with the
            // exact failed deploy's id named on the settled row.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockImplementation(async (_stack, _ws, _atomic, ctx) => {
                    const tx = GitOpsTransitions.getInstance();
                    const env = {
                        operationId: ctx!.gitopsDeployOperationId!,
                        actor: 'system:compose',
                        trigger: 'deploy',
                        at: Date.now(),
                    };
                    tx.deployStarted(applicationId, nodeId, generationId, env);
                    tx.deployFailed(applicationId, nodeId, 'pre_mutation', env);
                    throw new Error('simulated deploy failure');
                });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated crash before settle'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const intentRow = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')!;
                const deployId = JSON.parse(intentRow.after_json!).deployOperationId as string;
                expect(historyOperationIds(applicationId, 'deploy_failed')).toContain(deployId);

                await svc.recoverUnsettledReconcileAttempts();

                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                expect(JSON.parse(settled[0]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/the deploy this dispatch started failed/i),
                    nextAction: 'view_target_results',
                    deployGitopsOperationId: deployId,
                    commitSha: sha,
                });
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('recovery reconstructs a deploy that opened without a terminal record as unproven naming its exact deploy id', async () => {
            const sha = 'c2'.repeat(20);
            const svc = await seedPending('recover-deploy-opened-no-terminal', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('recover-deploy-opened-no-terminal');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('recover-deploy-opened-no-terminal')!.id;
            const nodeId = await defaultNodeId();
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('recover-deploy-opened-no-terminal');
            // The deploy opened under the journaled id and the process died
            // mid-flight: no bind, no failure, no unbound row. Recovery must
            // not claim the deploy completed or failed, and must not retry a
            // deploy whose outcome is unproven; it names the deploy record
            // the operator needs to inspect.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockImplementation(async (_stack, _ws, _atomic, ctx) => {
                    const tx = GitOpsTransitions.getInstance();
                    const env = {
                        operationId: ctx!.gitopsDeployOperationId!,
                        actor: 'system:compose',
                        trigger: 'deploy',
                        at: Date.now(),
                    };
                    tx.deployStarted(applicationId, nodeId, generationId, env);
                    throw new Error('simulated crash mid deploy');
                });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated crash before settle'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const intentRow = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')!;
                const deployId = JSON.parse(intentRow.after_json!).deployOperationId as string;
                expect(historyOperationIds(applicationId, 'deploy_started')).toContain(deployId);

                await svc.recoverUnsettledReconcileAttempts();

                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                expect(JSON.parse(settled[0]!.after_json!)).toMatchObject({
                    outcome: 'unknown',
                    reason: expect.stringMatching(/no recorded outcome/i),
                    nextAction: 'view_target_results',
                    deployGitopsOperationId: deployId,
                    commitSha: sha,
                });
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('recovery reconstructs an unbound tracked deploy as recovery_required naming its exact deploy id', async () => {
            const sha = 'c8'.repeat(20);
            const svc = await seedPending('recover-deploy-unbound-settle-crash', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptCandidate('recover-deploy-unbound-settle-crash');
            const generation = await acceptedGenerationById(generationId);
            const applicationId = liveApp('recover-deploy-unbound-settle-crash')!.id;
            const nodeId = await defaultNodeId();
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run('recover-deploy-unbound-settle-crash');
            // The deploy ran but never bound the generation: Compose records
            // deploy_unbound, the dispatch's own settle dies, and recovery
            // must treat the unbound terminal record like a failed one, since
            // both mean the operator has to inspect the target results.
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockImplementation(async (_stack, _ws, _atomic, ctx) => {
                    const tx = GitOpsTransitions.getInstance();
                    const env = {
                        operationId: ctx!.gitopsDeployOperationId!,
                        actor: 'system:compose',
                        trigger: 'deploy',
                        at: Date.now(),
                    };
                    tx.deployStarted(applicationId, nodeId, generationId, env);
                    tx.deployUnbound(applicationId, nodeId, generationId, env);
                    throw new Error('simulated unbound deploy');
                });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated crash before settle'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.dispatchAcceptedGeneration(generation, directContext, manualDispatch);
                expect(result.status).toBe('blocked');

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const dispatchOp = started[started.length - 1]!;
                const intentRow = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, dispatchOp, 'deploy_dispatched')!;
                const deployId = JSON.parse(intentRow.after_json!).deployOperationId as string;
                expect(historyOperationIds(applicationId, 'deploy_unbound')).toContain(deployId);

                await svc.recoverUnsettledReconcileAttempts();

                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp);
                expect(settled).toHaveLength(1);
                expect(JSON.parse(settled[0]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    reason: expect.stringMatching(/the deploy this dispatch started failed/i),
                    nextAction: 'view_target_results',
                    deployGitopsOperationId: deployId,
                    commitSha: sha,
                });
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === dispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(deploySpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                settleSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });

        it('derives from the plain source projection for an unmarked reservation, applying dispatch-stage logic only to marked attempts', async () => {
            const sha = 'b3'.repeat(20);
            const svc = await seedPending('recover-legacy-unmarked', 'services:\n  x:\n    image: alpine\n', sha);
            acceptCandidate('recover-legacy-unmarked');
            const applicationId = liveApp('recover-legacy-unmarked')!.id;
            // The suspended source makes the derive answer unambiguous: a
            // marked dispatch attempt interrupted on this same state would
            // instead settle unknown/"nothing was proven applied", so which
            // shape the settled row takes proves which path ran. An older
            // build's reservation carries no marker, and recovery must not
            // guess a pipeline stage it cannot evidence.
            await svc.suspend('recover-legacy-unmarked', { actor: 'tester', reason: 'recovery pass' });
            const { reserved } = GitOpsTransitions.getInstance()
                .allocateReconcileAttempt(applicationId, 'tester', 'manual', Date.now());
            expect(reserved).toBe(true);

            await svc.recoverUnsettledReconcileAttempts();

            const started = historyOperationIds(applicationId, 'source_reconcile_started');
            const legacyOp = started[started.length - 1]!;
            const settled = settledAttemptsForApplication(applicationId)
                .filter((row) => row.operation_id === legacyOp);
            expect(settled).toHaveLength(1);
            const result = JSON.parse(settled[0]!.after_json!);
            expect(result).toMatchObject({ outcome: 'suspended' });
            expect(result.reason).not.toMatch(/nothing was proven applied|could not be bound/i);
        });

        it('recovery does not inherit promotion evidence when a new accepted generation shares the applied commit and fingerprint', async () => {
            const sha = 'b8'.repeat(20);
            const svc = await seedPending('dispatch-recover-shared-evidence', 'services:\n  x:\n    image: alpine\n', sha);
            const firstGenerationId = acceptCandidate('dispatch-recover-shared-evidence');
            const firstGeneration = await acceptedGenerationById(firstGenerationId);
            const applicationId = liveApp('dispatch-recover-shared-evidence')!.id;
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration').mockResolvedValue(undefined);

            try {
                // Apply the first generation cleanly so the source rows
                // durably describe this commit and plan fingerprint as
                // applied, and the target binds to the first generation.
                const dispatched = await svc.dispatchAcceptedGeneration(firstGeneration, directContext, manualDispatch);
                expect(dispatched).toEqual({ status: 'dispatched' });
                const firstStarted = historyOperationIds(applicationId, 'source_reconcile_started');
                const firstDispatchOp = firstStarted[firstStarted.length - 1]!;
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === firstDispatchOp)).toHaveLength(1);

                // A second generation with the same commit sha and the same
                // change-plan fingerprint is accepted, and the process dies
                // before its dispatch promotes anything: only the marked
                // reservation exists for it. Nothing about this new
                // generation is applied; the identical source rows belong to
                // the previous generation.
                const genRow = GitOpsStore.getInstance().getGeneration(firstGenerationId)!;
                expect(genRow.change_plan_fingerprint).not.toBeNull();
                const sharedEvidence = DatabaseService.getInstance().getGitSource('dispatch-recover-shared-evidence')!;
                expect(sharedEvidence.last_applied_commit_sha).toBe(sha);
                expect(sharedEvidence.last_plan_fingerprint).toBe(genRow.change_plan_fingerprint);
                const secondGenerationId = newGitOpsId();
                DatabaseService.getInstance().getDb().prepare(`
                    INSERT INTO gitops_generations (
                        id, application_id, commit_sha, repo_url, configured_ref, resolved_ref_kind,
                        repo_identity_json, manifest_version, candidate_dir, applied_dir,
                        expected_invocation_json, materialization_fingerprint, validation_ok, plan_blocked,
                        change_plan_fingerprint, operation_id, trigger, actor, previous_generation_id,
                        redacted_limitations_json, portable_manifest_json, compose_inputs_json,
                        source_policy_evidence_json, security_policy_evidence_json,
                        support_requirements_json, compatibility_requirements_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    secondGenerationId, genRow.application_id, genRow.commit_sha, genRow.repo_url,
                    genRow.configured_ref, genRow.resolved_ref_kind, genRow.repo_identity_json,
                    genRow.manifest_version, genRow.candidate_dir, genRow.applied_dir,
                    genRow.expected_invocation_json, genRow.materialization_fingerprint, genRow.validation_ok,
                    genRow.plan_blocked, genRow.change_plan_fingerprint, genRow.operation_id,
                    genRow.trigger, genRow.actor, genRow.id, genRow.redacted_limitations_json,
                    genRow.portable_manifest_json, genRow.compose_inputs_json,
                    genRow.source_policy_evidence_json, genRow.security_policy_evidence_json,
                    genRow.support_requirements_json, genRow.compatibility_requirements_json, Date.now(),
                );
                DatabaseService.getInstance().getDb()
                    .prepare('UPDATE gitops_applications SET accepted_generation_id = ? WHERE id = ?')
                    .run(secondGenerationId, applicationId);
                const { reserved } = GitOpsTransitions.getInstance()
                    .allocateReconcileAttempt(applicationId, 'tester', 'manual', Date.now(), undefined, secondGenerationId);
                expect(reserved).toBe(true);

                await svc.recoverUnsettledReconcileAttempts();

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const secondDispatchOp = started[started.length - 1]!;
                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === secondDispatchOp);
                expect(settled).toHaveLength(1);
                const payload = JSON.parse(settled[0]!.after_json!);
                // The promotion is proven per operation, never per source
                // state: this attempt carries no witness row, so the shared
                // applied commit and fingerprint cannot claim files changed
                // for the new generation. The truthful close is the unproven
                // retry the pre-promote crash warrants, not recovery_required.
                expect(payload).toMatchObject({
                    outcome: 'unknown',
                    reason: expect.stringMatching(/nothing was proven applied/i),
                    nextAction: 'retry',
                    commitSha: sha,
                });
                // The first dispatch's settlement stands untouched: recovery
                // closed only the new attempt, under its own id.
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === firstDispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === secondDispatchOp)).toHaveLength(1);
                expect(promoteSpy).toHaveBeenCalledTimes(1);
            } finally {
                promoteSpy.mockRestore();
            }
        });
    });

    describe('suspend / resume / retry', () => {
        it('suspends an active source and reflects it in the reconcile result', async () => {
            const svc = await seedPending('suspend-basic', 'services:\n  x:\n    image: alpine\n', 's1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1');

            const result = await svc.suspend('suspend-basic', { actor: 'tester', reason: 'maintenance window' });

            expect(result.outcome).toBe('suspended');
            expect(result.reason).toMatch(/maintenance window/i);
            const app = liveApp('suspend-basic');
            expect(app?.suspended_at).toBeTruthy();
            expect(app?.source_suspended_reason).toBe('maintenance window');
        });

        it('suspends with a default reason when none is given', async () => {
            const svc = await seedPending('suspend-default-reason', 'services:\n  x:\n    image: alpine\n', 's2s2s2s2s2s2s2s2s2s2s2s2s2s2s2s2s2s2s2s2');

            const result = await svc.suspend('suspend-default-reason', { actor: 'tester' });

            expect(result.outcome).toBe('suspended');
            expect(liveApp('suspend-default-reason')?.source_suspended_reason).toBe('Suspended by operator.');
        });

        it('falls back to the default reason when only whitespace is given', async () => {
            const svc = await seedPending('suspend-whitespace-reason', 'services:\n  x:\n    image: alpine\n', 's9s9s9s9s9s9s9s9s9s9s9s9s9s9s9s9s9s9s9s9');

            await svc.suspend('suspend-whitespace-reason', { actor: 'tester', reason: '   ' });

            expect(liveApp('suspend-whitespace-reason')?.source_suspended_reason).toBe('Suspended by operator.');
        });

        it('reports unknown when suspending a stack with no GitOps application', async () => {
            const result = await GitSourceService.getInstance().suspend('suspend-no-app', { actor: 'tester' });

            expect(result.outcome).toBe('unknown');
        });

        it('surfaces a real error, rather than a silent no-op, when suspending an application that is not live', async () => {
            const config: DirectSourceConfig = {
                repoUrl: 'https://github.com/example/repo.git',
                branch: 'main',
                composePaths: ['compose.yaml'],
                contextDir: null,
                syncEnv: false,
                envPath: null,
            };
            GitOpsStore.getInstance().insertApplication(buildDirectApplicationRow({
                id: newGitOpsId(),
                stackName: 'suspend-creating-app',
                config,
                identity: directSourceIdentity(config),
                lifecycleStatus: 'creating',
                at: Date.now(),
            }, 'automatic'));

            await expect(GitSourceService.getInstance().suspend('suspend-creating-app', { actor: 'tester' }))
                .rejects.toMatchObject({ code: 'OPERATION_IN_FLIGHT' });
        });

        it('actually stops a fetch, not just the projected outcome, once suspended', async () => {
            const svc = await seedPending('suspend-blocks-fetch', 'services:\n  x:\n    image: alpine\n', 's6s6s6s6s6s6s6s6s6s6s6s6s6s6s6s6s6s6s6s6');
            await svc.suspend('suspend-blocks-fetch', { actor: 'tester', reason: 'pausing' });
            mockGitClone.mockClear();

            await expect(svc.pull('suspend-blocks-fetch')).rejects.toMatchObject({ code: 'OPERATION_IN_FLIGHT' });

            expect(mockGitClone).not.toHaveBeenCalled();
        });

        it('actually stops an apply once suspended, even for a pending commit fetched before suspension', async () => {
            const sha = 's7s7s7s7s7s7s7s7s7s7s7s7s7s7s7s7s7s7s7s7';
            const svc = await seedPending('suspend-blocks-apply', 'services:\n  x:\n    image: alpine\n', sha);
            await svc.suspend('suspend-blocks-apply', { actor: 'tester', reason: 'pausing' });
            const { FileSystemService } = await import('../services/FileSystemService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();

            try {
                await expect(svc.apply('suspend-blocks-apply', sha, SKIP_PLAN_FINGERPRINT))
                    .rejects.toMatchObject({ code: 'OPERATION_IN_FLIGHT' });
                expect(saveSpy).not.toHaveBeenCalled();
            } finally {
                saveSpy.mockRestore();
            }
        });

        it('a webhook delivery to a suspended source is skipped, not reported as a failed pull', async () => {
            const svc = await seedPending('suspend-webhook', 'services:\n  x:\n    image: alpine\n', 'scscscscscscscscscscscscscscscscscscscsc');
            await svc.suspend('suspend-webhook', { actor: 'tester', reason: 'pausing' });
            mockGitClone.mockClear();
            const activitySpy = vi.spyOn(DatabaseService.getInstance(), 'addNotificationHistory');

            try {
                const result = await svc.handleWebhookPull('suspend-webhook', true);

                expect(result.status).toBe('skipped');
                expect(mockGitClone).not.toHaveBeenCalled();
                expect(activitySpy).not.toHaveBeenCalled();
            } finally {
                activitySpy.mockRestore();
            }
        });

        it('resumes a suspended source', async () => {
            const svc = await seedPending('resume-basic', 'services:\n  x:\n    image: alpine\n', 's3s3s3s3s3s3s3s3s3s3s3s3s3s3s3s3s3s3s3s3');
            await svc.suspend('resume-basic', { actor: 'tester', reason: 'pausing' });

            const result = await svc.resume('resume-basic', { actor: 'tester' });

            expect(result.outcome).not.toBe('suspended');
            const app = liveApp('resume-basic');
            expect(app?.suspended_at).toBeNull();
            expect(app?.source_suspended_reason).toBeNull();
        });

        it('resuming a source re-policed into automatic while suspended arms its poll cursor', async () => {
            const sha = 'curs00000000000000000000000000000000002';
            const svc = await seedPending('resume-cursor', 'services:\n  x:\n    image: alpine\n', sha);
            DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '5');
            try {
                await svc.suspend('resume-cursor', { actor: 'tester', reason: 'pausing' });
                await svc.upsert({
                    stackName: 'resume-cursor',
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
                // The flip while suspended arms nothing: the pre-check skips
                // paused rows.
                expect(liveApp('resume-cursor')?.next_poll_at).toBeNull();

                await svc.resume('resume-cursor', { actor: 'tester' });

                const app = liveApp('resume-cursor');
                expect(app?.suspended_at).toBeNull();
                expect(app?.source_policy).toBe('automatic');
                expect(app?.next_poll_at).not.toBeNull();
                const history = DatabaseService.getInstance().getDb()
                    .prepare("SELECT COUNT(*) AS n FROM gitops_history WHERE stack_name = ? AND stage = 'source_poll_scheduled'")
                    .get('resume-cursor') as { n: number };
                expect(history.n).toBe(1);
            } finally {
                DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '0');
            }
        });

        it('resuming a source that was never eligible for the cadence arms nothing', async () => {
            const sha = 'curs00000000000000000000000000000000003';
            const svc = await seedPending('resume-manual', 'services:\n  x:\n    image: alpine\n', sha);
            try {
                await svc.suspend('resume-manual', { actor: 'tester', reason: 'pausing' });
                await svc.resume('resume-manual', { actor: 'tester' });

                // The policy stays review and the global interval is off, so
                // no wake is due from either guard.
                const app = liveApp('resume-manual');
                expect(app?.source_policy).toBe('review');
                expect(app?.next_poll_at).toBeNull();
            } finally {
                DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '0');
            }
        });

        it('resuming a source that is not suspended is a harmless no-op, not an error', async () => {
            const svc = await seedPending('resume-noop', 'services:\n  x:\n    image: alpine\n', 's8s8s8s8s8s8s8s8s8s8s8s8s8s8s8s8s8s8s8s8');

            const result = await svc.resume('resume-noop', { actor: 'tester' });

            expect(result.outcome).toBe('pending_review');
        });

        it('pulling and applying again succeeds once a suspended source is resumed', async () => {
            const sha = 'sbsbsbsbsbsbsbsbsbsbsbsbsbsbsbsbsbsbsbsb';
            const svc = await seedPending('suspend-resume-roundtrip', 'services:\n  x:\n    image: alpine\n', sha);
            await svc.suspend('suspend-resume-roundtrip', { actor: 'tester', reason: 'pausing' });
            await expect(svc.pull('suspend-resume-roundtrip')).rejects.toMatchObject({ code: 'OPERATION_IN_FLIGHT' });
            await expect(svc.apply('suspend-resume-roundtrip', sha, SKIP_PLAN_FINGERPRINT))
                .rejects.toMatchObject({ code: 'OPERATION_IN_FLIGHT' });

            await svc.resume('suspend-resume-roundtrip', { actor: 'tester' });
            const pullResult = await svc.pull('suspend-resume-roundtrip');
            expect(pullResult.candidateReady).toBe(true);

            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
            try {
                const applyResult = await svc.apply('suspend-resume-roundtrip', sha, SKIP_PLAN_FINGERPRINT);
                expect(applyResult.applied).toBe(true);
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
            }
        });

        it('retries by driving a fresh fetch-intent reconcile', async () => {
            const svc = await seedPending('retry-basic', 'services:\n  x:\n    image: alpine\n', 's5s5s5s5s5s5s5s5s5s5s5s5s5s5s5s5s5s5s5s5');
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const reconcileSpy = vi.spyOn(svc, 'reconcile');

            try {
                const result = await svc.retry('retry-basic', { actor: 'tester' });
                expect(result.outcome).toBe('pending_review');
                expect(reconcileSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'retry', intent: 'fetch' }));
            } finally {
                validateSpy.mockRestore();
                reconcileSpy.mockRestore();
            }
        });

        it('reports unknown when retrying a stack with no GitOps application', async () => {
            const result = await GitSourceService.getInstance().retry('retry-no-app', { actor: 'tester' });

            expect(result.outcome).toBe('unknown');
        });

        it('retrying a suspended source reports suspended, not a generic unknown', async () => {
            const svc = await seedPending('retry-while-suspended', 'services:\n  x:\n    image: alpine\n', 'sasasasasasasasasasasasasasasasasasasasa');
            await svc.suspend('retry-while-suspended', { actor: 'tester', reason: 'pausing' });

            const result = await svc.retry('retry-while-suspended', { actor: 'tester' });

            expect(result.outcome).toBe('suspended');
            expect(result.nextAction).toBe('resume');
        });
    });

    describe('stage-aware retry', () => {
        /**
         * Accept the staged candidate at the source layer (what a controller
         * auto-acceptance or an operator review does). Leaves the
         * application in the accepted-but-undispatched state the dispatch
         * arm of retry() targets: acceptance clears the application
         * candidate pointer and the source failure columns, while the
         * target's candidate pointer still names the accepted generation.
         */
        function acceptPendingCandidate(stackName: string): string {
            const app = liveApp(stackName)!;
            const generationId = app.candidate_generation_id!;
            GitOpsTransitions.getInstance().sourceAccepted({
                applicationId: app.id,
                generationId,
                artifactSetId: newGitOpsId(),
                sourceAcceptanceId: newGitOpsId(),
                authority: 'operator',
                envelope: testEnvelope(),
            });
            return generationId;
        }

        async function asyncDefaultNodeId(): Promise<number> {
            const { NodeRegistry } = await import('../services/NodeRegistry');
            return NodeRegistry.getInstance().getDefaultNodeId();
        }

        /**
         * Park a stack in the state the deploy arm of retry() owns: the
         * promotion committed, the target bound the accepted generation,
         * and the deploy that followed failed. The state is produced by
         * running the promote arm for real (one retry, auto-deploy on,
         * deploy stubbed to record its failure and throw), so the durable
         * evidence the resume reads is transition-written, not SQL-
         * fabricated. The spies stay installed (and their call counts
         * cleared) so the test re-arms the deploy for the resume and
         * counts what the resume does and never does.
         */
        async function appliedWithFailedDeploy(stackName: string, sha: string) {
            const svc = await seedPending(stackName, 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptPendingCandidate(stackName);
            const applicationId = liveApp(stackName)!.id;
            const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE stack_git_sources SET auto_deploy_on_apply = 1 WHERE stack_name = ?')
                .run(stackName);
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const { ComposeService } = await import('../services/ComposeService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockImplementation(async () => {});
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockImplementation(async (_stack, _ws, _atomic, ctx) => {
                    const tx = GitOpsTransitions.getInstance();
                    const env = {
                        operationId: ctx!.gitopsDeployOperationId!,
                        actor: 'system:compose',
                        trigger: 'deploy',
                        at: Date.now(),
                    };
                    tx.deployStarted(applicationId, nodeId, generationId, env);
                    tx.deployFailed(applicationId, nodeId, 'pre_mutation', env);
                    // Stamp the id on the error the way the real tracked
                    // deploy does (ComposeService's wrapped rethrow), so
                    // the settle and the response carry the correlation.
                    const err = new Error('simulated deploy failure') as Error & { gitopsDeployOperationId?: string };
                    err.gitopsDeployOperationId = ctx!.gitopsDeployOperationId;
                    throw err;
                });

            // The promote arm runs to its deploy-failure settle: blocked,
            // naming the failed deploy, with the target applied and its
            // failure_stage on 'deploy'.
            const first = await svc.retry(stackName, { actor: 'tester' });
            expect(first.outcome).toBe('blocked');
            expect(first.reason).toMatch(/^The source applied, but the deploy failed: /);
            const target = GitOpsStore.getInstance().getTarget(applicationId, nodeId)!;
            expect(target.applied_generation_id).toBe(generationId);
            expect(target.failure_stage).toBe('deploy');
            promoteSpy.mockClear();
            deploySpy.mockClear();
            return { svc, applicationId, nodeId, generationId, promoteSpy, deploySpy };
        }

        it('dispatches the accepted generation when nothing was ever promoted, without refetching or re-accepting', async () => {
            const sha = 't1t1t1t1t1t1t1t1t1t1t1t1t1t1t1t1t1t1t1t1';
            const svc = await seedPending('retry-dispatch-arm', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptPendingCandidate('retry-dispatch-arm');
            const applicationId = liveApp('retry-dispatch-arm')!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const acceptedBefore = liveApp('retry-dispatch-arm')!.accepted_generation_id;
            mockGitClone.mockClear();
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockImplementation(async () => {});

            try {
                const result = await svc.retry('retry-dispatch-arm', { actor: 'tester' });

                // The dispatch arm ran through the shared boundary: the
                // generation promoted and the target bound, no fetch ran,
                // and acceptance was not re-run.
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(reconcileSpy).not.toHaveBeenCalled();
                expect(mockGitClone).not.toHaveBeenCalled();
                expect(result.outcome).toBe('no_source_change');
                const app = liveApp('retry-dispatch-arm')!;
                expect(app.accepted_generation_id).toBe(acceptedBefore);
                expect(app.accepted_generation_id).toBe(generationId);
                const target = GitOpsStore.getInstance().getTarget(applicationId, await asyncDefaultNodeId())!;
                expect(target.applied_generation_id).toBe(generationId);
                // The retry's dispatch reserved its own attempt, marked as a
                // dispatch of exactly this generation, and settled it.
                const startedIds = historyOperationIds(applicationId, 'source_reconcile_started');
                expect(startedIds).toHaveLength(startedBefore + 1);
                const retryOperationId = startedIds[startedIds.length - 1]!;
                const reserved = GitOpsStore.getInstance().getStartedAttempt(applicationId, retryOperationId)!;
                expect(reserved.trigger).toBe('retry');
                expect(JSON.parse(reserved.after_json).dispatchGenerationId).toBe(generationId);
                expect(GitOpsStore.getInstance().getSettledAttempt(applicationId, retryOperationId)).toBeDefined();
            } finally {
                reconcileSpy.mockRestore();
                promoteSpy.mockRestore();
            }
        });

        it('refetches when a source-stage failure persists alongside undelivered dispatch evidence', async () => {
            const sha = 't2t2t2t2t2t2t2t2t2t2t2t2t2t2t2t2t2t2t2t2';
            const svc = await seedPending('retry-source-stage-precedence', 'services:\n  x:\n    image: alpine\n', sha);
            acceptPendingCandidate('retry-source-stage-precedence');
            const applicationId = liveApp('retry-source-stage-precedence')!.id;
            // A validation failure recorded after acceptance: the fetch arm
            // owns the newer evidence, so the dispatch pointer does not win.
            DatabaseService.getInstance().getDb().prepare(
                "UPDATE gitops_applications SET failure_stage = 'validation', failure_class = 'validation', failure_at = ? WHERE id = ?",
            ).run(Date.now(), applicationId);
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration');

            try {
                await svc.retry('retry-source-stage-precedence', { actor: 'tester' });

                expect(reconcileSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'retry', intent: 'fetch' }));
                expect(promoteSpy).not.toHaveBeenCalled();
            } finally {
                reconcileSpy.mockRestore();
                promoteSpy.mockRestore();
            }
        });

        it('maps a blocked dispatch to a blocked outcome with the refusal advice, reserving nothing', async () => {
            const sha = 't3t3t3t3t3t3t3t3t3t3t3t3t3t3t3t3t3t3t3t3';
            const svc = await seedPending('retry-dispatch-blocked', 'services:\n  x:\n    image: alpine\n', sha);
            acceptPendingCandidate('retry-dispatch-blocked');
            const applicationId = liveApp('retry-dispatch-blocked')!.id;
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const nodeId = await asyncDefaultNodeId();
            expect(StackOpLockService.getInstance().tryAcquire(nodeId, 'retry-dispatch-blocked', 'deploy', 'tester').acquired).toBe(true);
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            mockGitClone.mockClear();

            try {
                const result = await svc.retry('retry-dispatch-blocked', { actor: 'tester' });

                expect(result).toEqual({
                    outcome: 'blocked',
                    reason: 'Another operation (deploy) is already in progress for retry-dispatch-blocked.',
                    nextAction: 'retry',
                });
                expect(reconcileSpy).not.toHaveBeenCalled();
                expect(mockGitClone).not.toHaveBeenCalled();
                // The lock refusal happened before any reservation, so
                // retry leaves no unsettled attempt behind.
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore);
            } finally {
                reconcileSpy.mockRestore();
                StackOpLockService.getInstance().release(nodeId, 'retry-dispatch-blocked');
            }
        });

        it('defers to the in-flight projection instead of starting a second operation', async () => {
            const sha = 't4t4t4t4t4t4t4t4t4t4t4t4t4t4t4t4t4t4t4t4';
            const svc = await seedPending('retry-mid-operation', 'services:\n  x:\n    image: alpine\n', sha);
            acceptPendingCandidate('retry-mid-operation');
            const applicationId = liveApp('retry-mid-operation')!.id;
            // A crash window: the row still carries the apply-started
            // marker although no work is running. Recovery owns that
            // evidence; retry must not race it with a fetch or a dispatch.
            DatabaseService.getInstance().getDb().prepare(
                "UPDATE gitops_applications SET active_operation_stage = 'apply_started', active_operation_id = 'op-crash', active_operation_at = ? WHERE id = ?",
            ).run(Date.now(), applicationId);
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const dispatchSpy = vi.spyOn(svc, 'dispatchAcceptedGeneration');

            try {
                const result = await svc.retry('retry-mid-operation', { actor: 'tester' });

                expect(result.outcome).toBe('unknown');
                expect(result.reason).toMatch(/in flight/i);
                expect(reconcileSpy).not.toHaveBeenCalled();
                expect(dispatchSpy).not.toHaveBeenCalled();
            } finally {
                reconcileSpy.mockRestore();
                dispatchSpy.mockRestore();
            }
        });

        it('refetches once the accepted generation has been delivered and its deploy settled', async () => {
            const sha = 't5t5t5t5t5t5t5t5t5t5t5t5t5t5t5t5t5t5t5t5';
            const svc = await seedPending('retry-after-delivery', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptPendingCandidate('retry-after-delivery');
            const applicationId = liveApp('retry-after-delivery')!.id;
            // The dispatch evidence is gone: the target applied the
            // generation and its deploy failure columns are clear (they
            // were never written here, which is exactly the still-healthy
            // state deploy-bound leaves), so the only re-evaluation left
            // is a source fetch. The deploy arm must not fire without a
            // recorded target-level deploy failure.
            DatabaseService.getInstance().getDb().prepare(
                'UPDATE gitops_target_current SET applied_generation_id = ?, candidate_generation_id = NULL WHERE application_id = ?',
            ).run(generationId, applicationId);
            mockGitClone.mockClear();
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { ComposeService } = await import('../services/ComposeService');
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack');

            try {
                const result = await svc.retry('retry-after-delivery', { actor: 'tester' });

                expect(reconcileSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'retry', intent: 'fetch' }));
                expect(deploySpy).not.toHaveBeenCalled();
                expect(result.outcome).toBe('pending_review');
            } finally {
                reconcileSpy.mockRestore();
                validateSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('resumes only the deploy when the applied generation\'s deploy failed, without fetching, promoting, or re-binding', async () => {
            const sha = 't8t8t8t8t8t8t8t8t8t8t8t8t8t8t8t8t8t8t8t8';
            const { svc, applicationId, nodeId, generationId, promoteSpy, deploySpy } =
                await appliedWithFailedDeploy('retry-deploy-resume', sha);
            mockGitClone.mockClear();
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const { HealthGateService } = await import('../services/HealthGateService');
            const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack');
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const targetAppliedBefore = historyOperationIds(applicationId, 'target_applied').length;

            try {
                const result = await svc.retry('retry-deploy-resume', { actor: 'tester' });

                // The fetch arm never ran: no reconcile call, no git clone.
                expect(reconcileSpy).not.toHaveBeenCalled();
                expect(mockGitClone).not.toHaveBeenCalled();
                // Promotion and re-binding are refused by the applied
                // pointer, and the resume honors that: the shared promote
                // machinery is untouched.
                expect(promoteSpy).not.toHaveBeenCalled();
                // The same applied generation is deployed again, under a
                // freshly journaled intent of this retry attempt.
                expect(deploySpy).toHaveBeenCalledTimes(1);
                const startedIds = historyOperationIds(applicationId, 'source_reconcile_started');
                expect(startedIds).toHaveLength(startedBefore + 1);
                const retryOperationId = startedIds[startedIds.length - 1]!;
                const reserved = GitOpsStore.getInstance().getStartedAttempt(applicationId, retryOperationId)!;
                expect(reserved.trigger).toBe('retry');
                const markers = JSON.parse(reserved.after_json!);
                expect(markers.dispatchGenerationId).toBe(generationId);
                expect(markers.dispatchDeployRequested).toBe(true);
                const intentRow = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, retryOperationId, 'deploy_dispatched')!;
                const intent = JSON.parse(intentRow.after_json!);
                expect(intent.generationId).toBe(generationId);
                expect(intent.deployOperationId).toBeDefined();
                // The second deploy's own rows land under the journaled id
                // for this generation: started, then failed at pre_mutation.
                expect(historyOperationIds(applicationId, 'deploy_started')).toContain(intent.deployOperationId);
                expect(historyOperationIds(applicationId, 'deploy_failed')).toContain(intent.deployOperationId);
                // Compose was handed exactly the journaled deploy id, under
                // git_apply provenance by the raw retry actor.
                expect(deploySpy).toHaveBeenCalledWith('retry-deploy-resume', undefined, undefined,
                    expect.objectContaining({
                        source: 'git_apply',
                        actor: 'tester',
                        gitopsDeployOperationId: intent.deployOperationId,
                    }));
                // The deploy failed again, so no health gate was opened.
                expect(beginSpy).not.toHaveBeenCalled();
                // The attempt is durably recorded and settled, carrying the
                // same deploy-failure classification the promote arm's
                // failed deploy writes, plus the exact failed deploy id.
                const settled = settledAttemptsForApplication(applicationId)
                    .find((row) => row.operation_id === retryOperationId);
                expect(settled).toBeDefined();
                expect(JSON.parse(settled!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    reason: 'The source applied, but the deploy failed: simulated deploy failure',
                    nextAction: 'view_target_results',
                    deployGitopsOperationId: intent.deployOperationId,
                });
                // The response matches the promote arm's vocabulary for the
                // same settled classification: blocked, view target results.
                expect(result).toEqual({
                    outcome: 'blocked',
                    reason: 'The source applied, but the deploy failed: simulated deploy failure',
                    nextAction: 'view_target_results',
                });
                // Direct re-bind did not happen: no new target_applied
                // history row, and the applied pointer still names the
                // same generation it named before the resume.
                expect(historyOperationIds(applicationId, 'target_applied'))
                    .toHaveLength(targetAppliedBefore);
                expect(GitOpsStore.getInstance().getTarget(applicationId, nodeId)!.applied_generation_id)
                    .toBe(generationId);
            } finally {
                reconcileSpy.mockRestore();
                beginSpy.mockRestore();
                errorSpy.mockRestore();
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('settles the deploy resume as a success when the retried deploy binds, and the source is delivered again', async () => {
            const sha = 't9t9t9t9t9t9t9t9t9t9t9t9t9t9t9t9t9t9t9t9';
            const { svc, applicationId, nodeId, generationId, promoteSpy, deploySpy } =
                await appliedWithFailedDeploy('retry-deploy-resume-wins', sha);
            // Re-arm the stub for the resume: this time the deploy opens
            // under the journaled id and binds the same generation, the way
            // ComposeService's tracked deploy does.
            deploySpy.mockImplementation(async (_stack, _ws, _atomic, ctx) => {
                const tx = GitOpsTransitions.getInstance();
                const env = {
                    operationId: ctx!.gitopsDeployOperationId!,
                    actor: 'system:compose',
                    trigger: 'deploy',
                    at: Date.now(),
                };
                tx.deployStarted(applicationId, nodeId, generationId, env);
                tx.deployBound(applicationId, nodeId, generationId, env);
                return {
                    recoveryId: null,
                    deployedGenerationId: generationId,
                    gitopsOperationId: ctx!.gitopsDeployOperationId!,
                };
            });
            mockGitClone.mockClear();
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const { HealthGateService } = await import('../services/HealthGateService');
            const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack').mockReturnValue('gate-resume');
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });

            try {
                const result = await svc.retry('retry-deploy-resume-wins', { actor: 'tester' });

                expect(reconcileSpy).not.toHaveBeenCalled();
                expect(mockGitClone).not.toHaveBeenCalled();
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(deploySpy).toHaveBeenCalledTimes(1);
                // A successful resume deploy opens the same health gate and
                // post-deploy scan the pipeline's deploy branch does.
                expect(beginSpy).toHaveBeenCalledWith(nodeId, 'retry-deploy-resume-wins', 'deploy', 'system:git-source', { deployedGenerationId: generationId });
                await vi.waitFor(() => expect(mockTriggerPostDeployScan).toHaveBeenCalledWith('retry-deploy-resume-wins', nodeId));
                // The retry's settle carries the exact deploy that ran.
                const startedIds = historyOperationIds(applicationId, 'source_reconcile_started');
                const retryOperationId = startedIds[startedIds.length - 1]!;
                const intentRow = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, retryOperationId, 'deploy_dispatched')!;
                const deployId = JSON.parse(intentRow.after_json!).deployOperationId as string;
                const settled = settledAttemptsForApplication(applicationId)
                    .find((row) => row.operation_id === retryOperationId);
                expect(JSON.parse(settled!.after_json!)).toMatchObject({
                    outcome: 'no_source_change',
                    deployGitopsOperationId: deployId,
                });
                expect(result.outcome).toBe('no_source_change');
                expect(result.deployGitopsOperationId).toBe(deployId);

                // With the deploy evidence cleared by the bind, a further
                // retry is a plain source fetch again: the deploy arm does
                // not fire forever on a delivered generation.
                reconcileSpy.mockClear();
                mockTriggerPostDeployScan.mockClear();
                const again = await svc.retry('retry-deploy-resume-wins', { actor: 'tester' });
                expect(reconcileSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'retry', intent: 'fetch' }));
                expect(again.outcome).toBe('pending_review');
            } finally {
                reconcileSpy.mockRestore();
                beginSpy.mockRestore();
                validateSpy.mockRestore();
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('refuses the deploy resume when the evidence moved before the lock, settling the refusal', async () => {
            const sha = 't10a10a10a10a10a10a10a10a10a10a10a10a10';
            const { svc, applicationId, promoteSpy, deploySpy } =
                await appliedWithFailedDeploy('retry-deploy-resume-race', sha);
            mockGitClone.mockClear();
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            // The entry predicate sees the deploy failure; by the time the
            // in-lock revalidation reads the target, a successful deploy
            // has cleared it. The resume must refuse and touch nothing.
            const realTarget = GitOpsStore.prototype.getTarget;
            const targetSpy = vi.spyOn(GitOpsStore.prototype, 'getTarget');
            let targetCalls = 0;
            targetSpy.mockImplementation((applicationIdArg: string, nodeIdArg: number) => {
                targetCalls++;
                const row = realTarget.call(GitOpsStore.getInstance(), applicationIdArg, nodeIdArg);
                // The entry read (call 1) keeps the failure evidence; the
                // in-lock revalidation (call 2) sees it cleared.
                if (row && targetCalls === 2) return { ...row, failure_stage: null, failure_class: null, failure_at: null };
                return row;
            });

            try {
                const result = await svc.retry('retry-deploy-resume-race', { actor: 'tester' });

                expect(result.outcome).toBe('blocked');
                expect(result.reason).toMatch(/nothing was re-deployed/);
                expect(result.nextAction).toBe('view_target_results');
                expect(deploySpy).not.toHaveBeenCalled();
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(reconcileSpy).not.toHaveBeenCalled();
                expect(mockGitClone).not.toHaveBeenCalled();
                // The refusal happened after the reservation, so it is
                // settled as a blocked attempt, and it is the only new row.
                const startedIds = historyOperationIds(applicationId, 'source_reconcile_started');
                expect(startedIds).toHaveLength(startedBefore + 1);
                const settled = settledAttemptsForApplication(applicationId)
                    .find((row) => row.operation_id === startedIds[startedIds.length - 1]!);
                expect(JSON.parse(settled!.after_json!)).toMatchObject({
                    outcome: 'blocked',
                    nextAction: 'view_target_results',
                });
            } finally {
                reconcileSpy.mockRestore();
                targetSpy.mockRestore();
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('refuses the deploy resume while the stack lock is held, reserving nothing', async () => {
            const sha = 't11b11b11b11b11b11b11b11b11b11b11b11b11b';
            const { applicationId, promoteSpy, deploySpy } =
                await appliedWithFailedDeploy('retry-deploy-resume-blocked', sha);
            const nodeId = await asyncDefaultNodeId();
            expect(StackOpLockService.getInstance().tryAcquire(nodeId, 'retry-deploy-resume-blocked', 'deploy', 'tester').acquired).toBe(true);
            const svc = GitSourceService.getInstance();
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;

            try {
                const result = await svc.retry('retry-deploy-resume-blocked', { actor: 'tester' });

                expect(result).toEqual({
                    outcome: 'blocked',
                    reason: 'Another operation (deploy) is already in progress for retry-deploy-resume-blocked.',
                    nextAction: 'retry',
                });
                expect(deploySpy).not.toHaveBeenCalled();
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(reconcileSpy).not.toHaveBeenCalled();
                // The lock refusal happened before any reservation: a
                // resume that started nothing leaves no attempt to chase.
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore);
            } finally {
                reconcileSpy.mockRestore();
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
                StackOpLockService.getInstance().release(nodeId, 'retry-deploy-resume-blocked');
            }
        });

        it('fetches when a newer source-stage failure outranks the deploy evidence', async () => {
            const sha = 'x12x12x12x12x12x12x12x12x12x12x12x12x12';
            const { svc, applicationId, promoteSpy, deploySpy } =
                await appliedWithFailedDeploy('retry-deploy-arm-fetch-precedence', sha);
            // A fetch failure recorded after the deploy failed: the
            // application-row source evidence is newer than the target-row
            // deploy evidence, and the fetch arm owns the precedence. The
            // class rides along for realism; the arm routing reads the
            // stage only.
            DatabaseService.getInstance().getDb().prepare(
                "UPDATE gitops_applications SET failure_stage = 'fetch', failure_class = 'auth', failure_at = ? WHERE id = ?",
            ).run(Date.now(), applicationId);
            const reconcileSpy = vi.spyOn(svc, 'reconcile');

            try {
                await svc.retry('retry-deploy-arm-fetch-precedence', { actor: 'tester' });

                expect(reconcileSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'retry', intent: 'fetch' }));
                // Neither resume arm ran beside the fetch.
                expect(deploySpy).not.toHaveBeenCalled();
                expect(promoteSpy).not.toHaveBeenCalled();
                // The fetch arm never touches target evidence: the deploy
                // failure stands until a deploy succeeds.
                const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;
                const target = GitOpsStore.getInstance().getTarget(applicationId, nodeId)!;
                expect(target.failure_stage).toBe('deploy');
            } finally {
                reconcileSpy.mockRestore();
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('refuses the deploy resume when its reservation collides, settling nothing', async () => {
            const sha = 'x13x13x13x13x13x13x13x13x13x13x13x13';
            const { svc, applicationId, promoteSpy, deploySpy } =
                await appliedWithFailedDeploy('retry-deploy-resume-collision', sha);
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const settledBefore = settledAttemptsForApplication(applicationId).length;
            const reserveSpy = vi.spyOn(GitOpsTransitions.prototype, 'allocateReconcileAttempt')
                .mockImplementationOnce(() => ({ operationId: 'collided:attempt:1', reserved: false }));

            try {
                const result = await svc.retry('retry-deploy-resume-collision', { actor: 'tester' });

                expect(result).toEqual({
                    outcome: 'blocked',
                    reason: 'A dispatch attempt for this stack is already recorded; check its outcome before dispatching again.',
                    nextAction: 'view_target_results',
                });
                expect(deploySpy).not.toHaveBeenCalled();
                expect(promoteSpy).not.toHaveBeenCalled();
                // Nothing was reserved, so nothing may be settled: the
                // colliding attempt belongs to its own owner, and the
                // deploy-resume must not speak for it.
                expect(historyOperationIds(applicationId, 'source_reconcile_started')).toHaveLength(startedBefore);
                expect(settledAttemptsForApplication(applicationId)).toHaveLength(settledBefore);
            } finally {
                reserveSpy.mockRestore();
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('recovers an interrupted deploy resume from its journaled deploy evidence without re-running anything', async () => {
            const sha = 'x14x14x14x14x14x14x14x14x14x14x14x14';
            const { svc, applicationId, nodeId, generationId, promoteSpy, deploySpy } =
                await appliedWithFailedDeploy('retry-deploy-resume-recovered', sha);
            // A crash window for the resume: the retried deploy records its
            // failure under the journaled id, then the resume's own settle
            // dies. The attempt stays unsettled while its deploy evidence
            // stands, which startup recovery must read as the failed deploy
            // it was, reconstructing the settle from recorded rows only.
            deploySpy.mockImplementation(async (_stack, _ws, _atomic, ctx) => {
                const tx = GitOpsTransitions.getInstance();
                const env = {
                    operationId: ctx!.gitopsDeployOperationId!,
                    actor: 'system:compose',
                    trigger: 'deploy',
                    at: Date.now(),
                };
                tx.deployStarted(applicationId, nodeId, generationId, env);
                tx.deployFailed(applicationId, nodeId, 'pre_mutation', env);
                throw new Error('simulated deploy failure');
            });
            const settleSpy = vi.spyOn(GitOpsTransitions.prototype, 'settleReconcileAttempt')
                .mockImplementationOnce(() => { throw new Error('simulated crash before settle'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                await svc.retry('retry-deploy-resume-recovered', { actor: 'tester' });

                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                const retryOperationId = started[started.length - 1]!;
                const intentRow = GitOpsStore.getInstance()
                    .getStageRowForAttempt(applicationId, retryOperationId, 'deploy_dispatched')!;
                const deployId = JSON.parse(intentRow.after_json!).deployOperationId as string;
                expect(historyOperationIds(applicationId, 'deploy_failed')).toContain(deployId);
                // The live settle died, so the attempt is still open.
                expect(settledAttemptsForApplication(applicationId)
                    .some((row) => row.operation_id === retryOperationId)).toBe(false);

                await svc.recoverUnsettledReconcileAttempts();

                const settled = settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === retryOperationId);
                expect(settled).toHaveLength(1);
                // The reconstruction names the promotion and binding the
                // resume took as its evidence, plus the exact failed deploy.
                expect(JSON.parse(settled[0]!.after_json!)).toMatchObject({
                    outcome: 'recovery_required',
                    reason: 'The promotion and binding completed, but the deploy this dispatch started failed.',
                    nextAction: 'view_target_results',
                    deployGitopsOperationId: deployId,
                    commitSha: sha,
                });
                // Recovery re-ran nothing: the deploy arm never promotes
                // (the helper's counts were cleared after the seeding
                // promote-arm run), and reconstruction is read-only.
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(deploySpy).toHaveBeenCalledTimes(1);

                await svc.recoverUnsettledReconcileAttempts();
                expect(settledAttemptsForApplication(applicationId)
                    .filter((row) => row.operation_id === retryOperationId)).toHaveLength(1);
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(deploySpy).toHaveBeenCalledTimes(1);
            } finally {
                settleSpy.mockRestore();
                errorSpy.mockRestore();
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('refuses the deploy resume when its intent cannot be journaled, settling the refusal without deploying', async () => {
            const sha = 'x15x15x15x15x15x15x15x15x15x15x15x15';
            const { svc, applicationId, promoteSpy, deploySpy } =
                await appliedWithFailedDeploy('retry-deploy-resume-intent-refused', sha);
            const startedBefore = historyOperationIds(applicationId, 'source_reconcile_started').length;
            const intentSpy = vi.spyOn(GitOpsTransitions.prototype, 'deployDispatched')
                .mockImplementationOnce(() => { throw new Error('simulated intent journal failure'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await svc.retry('retry-deploy-resume-intent-refused', { actor: 'tester' });

                // A resume that cannot record and read back its deploy
                // intent refuses to start an untracked deploy: Compose was
                // never handed the stack.
                expect(deploySpy).not.toHaveBeenCalled();
                expect(promoteSpy).not.toHaveBeenCalled();
                expect(result.outcome).toBe('blocked');
                expect(result.nextAction).toBe('view_target_results');
                expect(result.reason).toMatch(/deploy retry could not record and read back its deploy intent/);
                const started = historyOperationIds(applicationId, 'source_reconcile_started');
                expect(started).toHaveLength(startedBefore + 1);
                const retryOperationId = started[started.length - 1]!;
                // The refusal journals its witness (so recovery of an
                // unsettled version of this attempt reads the refusal, not
                // an apply-only completion) and settles recovery_required
                // against the applied files, naming the cause. Compose
                // never ran, so no deploy id is claimed.
                expect(GitOpsStore.getInstance()
                    .hasStageRowForAttempt(applicationId, retryOperationId, 'deploy_intent_refused')).toBe(true);
                const settled = settledAttemptsForApplication(applicationId)
                    .find((row) => row.operation_id === retryOperationId);
                const payload = JSON.parse(settled!.after_json!);
                expect(payload).toMatchObject({
                    outcome: 'recovery_required',
                    reason: 'The deploy retry could not record and read back its deploy intent (simulated intent journal failure), so the deploy was not started.',
                    nextAction: 'view_target_results',
                });
                expect(payload).not.toHaveProperty('deployGitopsOperationId');
            } finally {
                intentSpy.mockRestore();
                errorSpy.mockRestore();
                promoteSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });

        it('defers to the recovery evidence for every unfinished recovery phase', async () => {
            const sha = 't6t6t6t6t6t6t6t6t6t6t6t6t6t6t6t6t6t6t6t6';
            const svc = await seedPending('retry-recovery-restoring', 'services:\n  x:\n    image: alpine\n', sha);
            acceptPendingCandidate('retry-recovery-restoring');
            const applicationId = liveApp('retry-recovery-restoring')!.id;
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const dispatchSpy = vi.spyOn(svc, 'dispatchAcceptedGeneration');

            // The guard defers on any phase except the settled 'complete'
            // receipt. 'capturing' is schema-legal with no production
            // writer yet: pinning it here freezes the fail-safe inversion
            // for the day one lands, and it is projection-transparent
            // today, so the report is the accepted-state projection while
            // the contract is that no work starts. 'failed' runs last
            // because it also sets the recovery failure columns, which the
            // projection reads independently of the phase.
            const cases: Array<{ phase: string; outcome: string; reason?: RegExp }> = [
                { phase: 'restoring', outcome: 'recovery_required' },
                { phase: 'compensating', outcome: 'recovery_required' },
                { phase: 'capturing', outcome: 'no_source_change' },
                { phase: 'failed', outcome: 'recovery_required', reason: /Recovery itself failed \(post_mutation\)/ },
            ];

            try {
                for (const c of cases) {
                    // 'failed' normally arrives with the recovery failure
                    // columns from recoveryFailed/rollbackPartialFailed;
                    // the distinguishing reason proves which projection was
                    // read rather than a generic one.
                    DatabaseService.getInstance().getDb().prepare(
                        c.phase === 'failed'
                            ? "UPDATE gitops_applications SET recovery_phase = 'failed', failure_stage = 'recovery', failure_class = 'post_mutation' WHERE id = ?"
                            : 'UPDATE gitops_applications SET recovery_phase = ? WHERE id = ?',
                    ).run(...(c.phase === 'failed' ? [applicationId] : [c.phase, applicationId]));
                    reconcileSpy.mockClear();
                    dispatchSpy.mockClear();

                    const result = await svc.retry('retry-recovery-restoring', { actor: 'tester' });

                    expect(result.outcome, c.phase).toBe(c.outcome);
                    if (c.reason) expect(result.reason).toMatch(c.reason);
                    expect(reconcileSpy, c.phase).not.toHaveBeenCalled();
                    expect(dispatchSpy, c.phase).not.toHaveBeenCalled();
                }
            } finally {
                reconcileSpy.mockRestore();
                dispatchSpy.mockRestore();
            }
        });

        it('retries normally after a completed rollback (complete phase is a receipt, not outstanding work)', async () => {
            const sha = 't7t7t7t7t7t7t7t7t7t7t7t7t7t7t7t7t7t7t7t7';
            const svc = await seedPending('retry-recovery-complete', 'services:\n  x:\n    image: alpine\n', sha);
            const generationId = acceptPendingCandidate('retry-recovery-complete');
            const applicationId = liveApp('retry-recovery-complete')!.id;
            // recoverySucceeded/rollbackCompleted persist 'complete' and
            // nothing clears it; a settled receipt must not permanently
            // degrade every future retry on this source to a projection
            // read. The undelivered dispatch evidence still routes to the
            // dispatch arm.
            DatabaseService.getInstance().getDb().prepare(
                "UPDATE gitops_applications SET recovery_phase = 'complete' WHERE id = ?",
            ).run(applicationId);
            const reconcileSpy = vi.spyOn(svc, 'reconcile');
            const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockImplementation(async () => {});

            try {
                const result = await svc.retry('retry-recovery-complete', { actor: 'tester' });

                expect(reconcileSpy).not.toHaveBeenCalled();
                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(result.outcome).toBe('no_source_change');
                const target = GitOpsStore.getInstance().getTarget(applicationId, await asyncDefaultNodeId())!;
                expect(target.applied_generation_id).toBe(generationId);
            } finally {
                reconcileSpy.mockRestore();
                promoteSpy.mockRestore();
            }
        });
    });

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
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
        const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack').mockReturnValue('gate-git');
        const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;

        try {
            const result = await svc.apply('apply-deploy-gate', sha, { deploy: true, ...skipFingerprint });
            expect(result.deployed).toBe(true);
            expect(deploySpy).toHaveBeenCalledWith('apply-deploy-gate', undefined, undefined, {
                source: 'git_apply',
                actor: 'system:git-source',
            });
            expect(beginSpy).toHaveBeenCalledWith(nodeId, 'apply-deploy-gate', 'deploy', 'system:git-source', { deployedGenerationId: null });
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
        const applicationId = liveApp('apply-deploy-fail')!.id;
        const priorSettlements = new Set(
            DatabaseService.getInstance().getDb()
                .prepare("SELECT operation_id FROM gitops_history WHERE application_id = ? AND stage = 'source_reconcile_settled'")
                .all(applicationId)
                .map((row) => (row as { operation_id: string }).operation_id),
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

            const settled = DatabaseService.getInstance().getDb()
                .prepare("SELECT operation_id, after_json FROM gitops_history WHERE application_id = ? AND stage = 'source_reconcile_settled'")
                .all(applicationId)
                .filter((item) => !priorSettlements.has((item as { operation_id: string }).operation_id)) as { after_json: string }[];
            expect(settled).toHaveLength(1);
            expect(JSON.parse(settled[0].after_json)).toMatchObject({
                outcome: 'recovery_required',
                nextAction: 'view_target_results',
            });
        } finally {
            validateSpy.mockRestore();
            saveSpy.mockRestore();
            deploySpy.mockRestore();
        }
    });

    describe('cache invalidation and post-deploy scan', () => {
        beforeEach(() => {
            mockInvalidateNodeCaches.mockClear();
            mockTriggerPostDeployScan.mockClear();
        });

        it('invalidates caches once and does not scan for an apply-only commit', async () => {
            const sha = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0';
            const svc = await seedPending('apply-only-cache', 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();

            try {
                const result = await svc.apply('apply-only-cache', sha, { deploy: false, ...skipFingerprint });
                expect(result.applied).toBe(true);
                expect(result.deployed).toBe(false);
                expect(mockInvalidateNodeCaches).toHaveBeenCalledTimes(1);
                expect(mockTriggerPostDeployScan).not.toHaveBeenCalled();
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
            }
        });

        it('invalidates caches once and scans once for a successful apply-and-deploy', async () => {
            const sha = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
            const svc = await seedPending('apply-deploy-scan', 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            const { ComposeService } = await import('../services/ComposeService');
            const { HealthGateService } = await import('../services/HealthGateService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
            const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack').mockReturnValue('gate-scan');

            try {
                const result = await svc.apply('apply-deploy-scan', sha, { deploy: true, ...skipFingerprint });
                expect(result.deployed).toBe(true);
                expect(mockInvalidateNodeCaches).toHaveBeenCalledTimes(1);
                expect(mockTriggerPostDeployScan).toHaveBeenCalledTimes(1);
                expect(mockTriggerPostDeployScan).toHaveBeenCalledWith('apply-deploy-scan', expect.any(Number));
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
                deploySpy.mockRestore();
                beginSpy.mockRestore();
            }
        });

        it('invalidates caches once but does not scan when the deploy fails', async () => {
            const sha = 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2';
            const svc = await seedPending('apply-deploy-fail-scan', 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            const { ComposeService } = await import('../services/ComposeService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockRejectedValue(
                new Error('compose up failed: docker unavailable'),
            );

            try {
                const result = await svc.apply('apply-deploy-fail-scan', sha, { deploy: true, ...skipFingerprint });
                expect(result.deployed).toBe(false);
                expect(mockInvalidateNodeCaches).toHaveBeenCalledTimes(1);
                expect(mockTriggerPostDeployScan).not.toHaveBeenCalled();
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
                deploySpy.mockRestore();
            }
        });
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
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
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

    describe('shared completion pipeline parity', () => {
        beforeEach(() => {
            mockInvalidateNodeCaches.mockClear();
            mockTriggerPostDeployScan.mockClear();
            mockRecoveryAbandon.mockClear();
        });

        it('records a rolled_back last-plan outcome and abandons recovery when promotion restores', async () => {
            const sha = 'a5'.repeat(20);
            const stackName = 'promote-fail-restored';
            const svc = await seedPending(stackName, 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { GitProjectManifestService, PromoteGenerationError } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockRejectedValue(new PromoteGenerationError('restored', new Error('simulated promotion failure')));
            const activitySpy = vi.spyOn(DatabaseService.getInstance(), 'addNotificationHistory');

            try {
                await expect(svc.apply(stackName, sha, SKIP_PLAN_FINGERPRINT)).rejects.toMatchObject({ code: 'GIT_ERROR' });

                expect(promoteSpy).toHaveBeenCalledTimes(1);
                expect(mockRecoveryAbandon).toHaveBeenCalled();
                // Promotion failed: no cache invalidation, no applied mark.
                expect(mockInvalidateNodeCaches).not.toHaveBeenCalled();
                const row = DatabaseService.getInstance().getGitSource(stackName);
                expect(row?.last_plan_outcome).toBe('rolled_back');
                expect(row?.last_applied_commit_sha).toBeNull();
                expect(activitySpy).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({
                    category: 'git_apply_rolled_back',
                    stack_name: stackName,
                }));
            } finally {
                validateSpy.mockRestore();
                promoteSpy.mockRestore();
                activitySpy.mockRestore();
            }
        });

        it('records a failed last-plan outcome when promotion refuses before any mutation', async () => {
            const sha = 'a6'.repeat(20);
            const stackName = 'promote-fail-premutation';
            const svc = await seedPending(stackName, 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { GitProjectManifestService, PromoteGenerationError } = await import('../services/GitProjectManifestService');
            const promoteSpy = vi.spyOn(GitProjectManifestService.prototype, 'promoteGeneration')
                .mockRejectedValue(new PromoteGenerationError('pre_mutation', new Error('simulated promotion refusal')));
            const activitySpy = vi.spyOn(DatabaseService.getInstance(), 'addNotificationHistory');

            try {
                await expect(svc.apply(stackName, sha, SKIP_PLAN_FINGERPRINT)).rejects.toMatchObject({ code: 'GIT_ERROR' });

                expect(mockRecoveryAbandon).toHaveBeenCalled();
                expect(mockInvalidateNodeCaches).not.toHaveBeenCalled();
                const row = DatabaseService.getInstance().getGitSource(stackName);
                expect(row?.last_plan_outcome).toBe('failed');
                expect(row?.last_applied_commit_sha).toBeNull();
                expect(activitySpy).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({
                    category: 'git_apply_failed',
                    stack_name: stackName,
                }));
            } finally {
                validateSpy.mockRestore();
                promoteSpy.mockRestore();
                activitySpy.mockRestore();
            }
        });

        it('binds the health gate to the generation the deploy reports', async () => {
            const sha = 'a7'.repeat(20);
            const stackName = 'apply-health-binding';
            const svc = await seedPending(stackName, 'services:\n  x:\n    image: alpine\n', sha);
            const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
            const { FileSystemService } = await import('../services/FileSystemService');
            const { ComposeService } = await import('../services/ComposeService');
            const { HealthGateService } = await import('../services/HealthGateService');
            const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockResolvedValue();
            const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack')
                .mockResolvedValue({ recoveryId: null, deployedGenerationId: 'gen-deployed-9', gitopsOperationId: 'a1b2c3d4-e5f6-7788-99aa-bbacddddeeff' });
            const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack').mockReturnValue('gate-binding');

            try {
                const result = await svc.apply(stackName, sha, { deploy: true, ...skipFingerprint });
                expect(result.deployed).toBe(true);
                // The deploy's canonical GitOps operation id rides back on the
                // apply result, so the caller's evidence names the same
                // operation the Compose adapter recorded.
                expect(result.gitopsOperationId).toBe('a1b2c3d4-e5f6-7788-99aa-bbacddddeeff');
                expect(beginSpy).toHaveBeenCalledWith(
                    expect.any(Number),
                    stackName,
                    'deploy',
                    'system:git-source',
                    { deployedGenerationId: 'gen-deployed-9' },
                );
            } finally {
                validateSpy.mockRestore();
                saveSpy.mockRestore();
                deploySpy.mockRestore();
                beginSpy.mockRestore();
            }
        });
    });
});

describe('GitSourceService.recoverUnsettledReconcileAttempts', () => {
    it('settles a follower from its leader\'s stored result rather than deriving independently, when only the follower is unsettled', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'a1'.repeat(20) });
        await svc.upsert({
            stackName: 'recover-leader-follower',
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
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('recover-leader-follower')!.id;
        const tx = GitOpsTransitions.getInstance();

        tx.reserveReconcileAttempt(applicationId, { operationId: 'leader-op', actor: 'tester', trigger: 'manual', at: Date.now() });
        tx.reserveReconcileAttempt(
            applicationId,
            { operationId: 'follower-op', actor: 'tester', trigger: 'manual', at: Date.now() + 1 },
            'leader-op',
        );
        // The leader settled with a specific result before the crash that
        // orphaned only the follower. This must not match whatever
        // independent derivation from current row state would produce, or
        // the test cannot tell a real leader-link recovery from a
        // coincidence.
        tx.settleReconcileAttempt(applicationId, { operationId: 'leader-op', actor: 'tester', trigger: 'manual', at: Date.now() }, {
            outcome: 'blocked',
            reason: 'a specific reason only the leader would know',
            nextAction: 'resolve_conflict',
        });

        await svc.recoverUnsettledReconcileAttempts();

        const followerSettled = GitOpsStore.getInstance().getSettledAttempt(applicationId, 'follower-op');
        expect(followerSettled).toBeDefined();
        expect(JSON.parse(followerSettled!.after_json)).toMatchObject({
            outcome: 'blocked',
            reason: 'a specific reason only the leader would know',
            nextAction: 'resolve_conflict',
        });
    });

    it('leaves no unsettled follower after restart when both leader and follower crashed before settling', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'a2'.repeat(20) });
        await svc.upsert({
            stackName: 'recover-both-unsettled',
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
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('recover-both-unsettled')!.id;
        const tx = GitOpsTransitions.getInstance();
        tx.reserveReconcileAttempt(applicationId, { operationId: 'leader-op-2', actor: 'tester', trigger: 'manual', at: Date.now() });
        tx.reserveReconcileAttempt(
            applicationId,
            { operationId: 'follower-op-2', actor: 'tester', trigger: 'manual', at: Date.now() + 1 },
            'leader-op-2',
        );

        await svc.recoverUnsettledReconcileAttempts();

        expect(GitOpsStore.getInstance().getSettledAttempt(applicationId, 'leader-op-2')).toBeDefined();
        expect(GitOpsStore.getInstance().getSettledAttempt(applicationId, 'follower-op-2')).toBeDefined();
        expect(GitOpsStore.getInstance().listUnsettledReconcileAttempts().some((r) => r.application_id === applicationId)).toBe(false);
    });

    it('does not settle a follower independently when its leader also fails to settle in this same recovery pass', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'a5'.repeat(20) });
        await svc.upsert({
            stackName: 'recover-leader-also-fails',
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
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('recover-leader-also-fails')!.id;
        const tx = GitOpsTransitions.getInstance();
        tx.reserveReconcileAttempt(applicationId, { operationId: 'leader-op-3', actor: 'tester', trigger: 'manual', at: Date.now() });
        tx.reserveReconcileAttempt(
            applicationId,
            { operationId: 'follower-op-3', actor: 'tester', trigger: 'manual', at: Date.now() + 1 },
            'leader-op-3',
        );
        // The application vanishes before recovery runs, so the leader's
        // own settlement (pass 1, independent branch) will itself throw
        // and fail, not just "not yet have happened."
        DatabaseService.getInstance().getDb().prepare('DELETE FROM gitops_applications WHERE id = ?').run(applicationId);

        await svc.recoverUnsettledReconcileAttempts();

        // Neither settles: the follower must not be given an independently
        // guessed result while its leader's own fate is still unresolved,
        // even though the leader failed rather than merely being deferred.
        expect(GitOpsStore.getInstance().getSettledAttempt(applicationId, 'leader-op-3')).toBeUndefined();
        expect(GitOpsStore.getInstance().getSettledAttempt(applicationId, 'follower-op-3')).toBeUndefined();
    });

    it.each([
        ['malformed JSON', '{invalid'],
        ['a non-string follower link', JSON.stringify({ followerOf: 123 })],
    ])('leaves a follower unsettled when its reservation contains %s', async (_caseName, corruptAfterJson) => {
        const svc = GitSourceService.getInstance();
        const stackName = `recover-corrupt-follower-${crypto.randomUUID()}`;
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'a6'.repeat(20) });
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
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication(stackName)!.id;
        const tx = GitOpsTransitions.getInstance();
        tx.reserveReconcileAttempt(applicationId, { operationId: 'corrupt-leader', actor: 'tester', trigger: 'manual', at: Date.now() });
        tx.reserveReconcileAttempt(
            applicationId,
            { operationId: 'corrupt-follower', actor: 'tester', trigger: 'manual', at: Date.now() + 1 },
            'corrupt-leader',
        );
        DatabaseService.getInstance().getDb()
            .prepare("UPDATE gitops_history SET after_json = ? WHERE application_id = ? AND operation_id = ? AND stage = 'source_reconcile_started'")
            .run(corruptAfterJson, applicationId, 'corrupt-follower');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await svc.recoverUnsettledReconcileAttempts();

            expect(GitOpsStore.getInstance().getSettledAttempt(applicationId, 'corrupt-leader')).toBeDefined();
            expect(GitOpsStore.getInstance().getSettledAttempt(applicationId, 'corrupt-follower')).toBeUndefined();
            const unsettled = GitOpsStore.getInstance().listUnsettledReconcileAttempts();
            expect(unsettled.some((row) => row.application_id === applicationId && row.operation_id === 'corrupt-follower')).toBe(true);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('drains the full backlog across multiple pages even when an earlier row can never be recovered', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'a3'.repeat(20) });
        await svc.upsert({
            stackName: 'recover-paginated-unrecoverable',
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
        const unrecoverableAppId = GitOpsStore.getInstance().getLiveDirectApplication('recover-paginated-unrecoverable')!.id;
        const tx = GitOpsTransitions.getInstance();
        // The oldest unsettled row's application is gone, so it can never
        // settle. With a page size of 1, a query that keeps returning "the
        // oldest still-unsettled row" would return only this one forever.
        tx.reserveReconcileAttempt(unrecoverableAppId, { operationId: 'op-unrecoverable', actor: 'tester', trigger: 'manual', at: Date.now() });
        DatabaseService.getInstance().getDb().prepare('DELETE FROM gitops_applications WHERE id = ?').run(unrecoverableAppId);

        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'a4'.repeat(20) });
        await svc.upsert({
            stackName: 'recover-paginated-recoverable',
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
        const recoverableAppId = GitOpsStore.getInstance().getLiveDirectApplication('recover-paginated-recoverable')!.id;
        tx.reserveReconcileAttempt(recoverableAppId, { operationId: 'op-recoverable', actor: 'tester', trigger: 'manual', at: Date.now() + 1 });

        await svc.recoverUnsettledReconcileAttempts(1);

        expect(GitOpsStore.getInstance().getSettledAttempt(recoverableAppId, 'op-recoverable')).toBeDefined();
    });

    it('settles an attempt left unsettled by a crash, without re-executing a fetch', async () => {
        const sha = 'eb'.repeat(20);
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha });
        const svc = GitSourceService.getInstance();
        await svc.upsert({
            stackName: 'recover-unsettled',
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
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('recover-unsettled')!.id;
        GitOpsTransitions.getInstance().reserveReconcileAttempt(applicationId, {
            operationId: 'orphaned-op-1', actor: 'tester', trigger: 'poll', at: Date.now(),
        });
        mockGitClone.mockClear();

        await svc.recoverUnsettledReconcileAttempts();

        expect(mockGitClone).not.toHaveBeenCalled();
        const settled = GitOpsStore.getInstance().getSettledAttempt(applicationId, 'orphaned-op-1');
        expect(settled).toBeDefined();
    });

    it('leaves a different application unaffected when only one has an unsettled attempt', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'ec'.repeat(20) });
        await svc.upsert({
            stackName: 'recover-clean',
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
        const applicationId = GitOpsStore.getInstance().getLiveDirectApplication('recover-clean')!.id;

        await expect(svc.recoverUnsettledReconcileAttempts()).resolves.toBeUndefined();

        expect(GitOpsStore.getInstance().listUnsettledReconcileAttempts().some((r) => r.application_id === applicationId)).toBe(false);
    });

    it('does not let one attempt whose application vanished block recovery of another, older, still-real attempt', async () => {
        const svc = GitSourceService.getInstance();
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'ed'.repeat(20) });
        await svc.upsert({
            stackName: 'recover-poisoned',
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
        const poisonedAppId = GitOpsStore.getInstance().getLiveDirectApplication('recover-poisoned')!.id;
        GitOpsTransitions.getInstance().reserveReconcileAttempt(poisonedAppId, {
            operationId: 'poisoned-op-1', actor: 'tester', trigger: 'poll', at: Date.now(),
        });
        // Simulate the application row vanishing between listing and processing.
        DatabaseService.getInstance().getDb().prepare('DELETE FROM gitops_applications WHERE id = ?').run(poisonedAppId);

        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: 'ee'.repeat(20) });
        await svc.upsert({
            stackName: 'recover-healthy',
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
        const healthyAppId = GitOpsStore.getInstance().getLiveDirectApplication('recover-healthy')!.id;
        GitOpsTransitions.getInstance().reserveReconcileAttempt(healthyAppId, {
            operationId: 'healthy-op-1', actor: 'tester', trigger: 'poll', at: Date.now(),
        });

        await expect(svc.recoverUnsettledReconcileAttempts()).resolves.toBeUndefined();

        expect(GitOpsStore.getInstance().getSettledAttempt(healthyAppId, 'healthy-op-1')).toBeDefined();
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
            encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
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
            encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
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
            encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
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
            encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
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
        mockSuccessfulClone({ sha });
        await configureGitSource('legacy-apply');
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

    it('lets a reviewed apply record invocation drift and refuses unattended apply', async () => {
        const sha = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';
        mockSuccessfulClone({ compose: 'services:\n  web:\n    image: nginx\n', sha });
        const svc = GitSourceService.getInstance();
        const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
        const { FileSystemService } = await import('../services/FileSystemService');
        const fsSvc = FileSystemService.getInstance();
        try {
            await svc.createStackFromGit({
                stackName: 'inv-drift',
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
            await fsSvc.writeStackFile('inv-drift', '.env', 'FOO=1\n');

            const pull = await svc.pull('inv-drift');
            expect(pull.plan?.blocked).toBe(false);
            expect(pull.plan?.invocation.liveDiverged).toBe(true);

            await expect(svc.apply('inv-drift', sha, SKIP_PLAN_FINGERPRINT)).rejects.toMatchObject({
                code: 'PLAN_BLOCKED',
                message: expect.stringMatching(/invocation/i),
            });
            expect((await fsSvc.readStackFile('inv-drift', '.env')).content).toBe('FOO=1\n');
            expect(DatabaseService.getInstance().getGitSource('inv-drift')?.pending_commit_sha).toBe(sha);

            const applied = await svc.apply('inv-drift', sha, { planFingerprint: pull.planFingerprint! });
            expect(applied.applied).toBe(true);
            expect((await fsSvc.readStackFile('inv-drift', '.env')).content).toBe('FOO=1\n');
        } finally {
            validateSpy.mockRestore();
            await cleanupStackDir('inv-drift');
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
        mockSuccessfulClone({ sha });
        await configureGitSource('plan-unavail');
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

// ── Canonical dismissal fixtures ───────────────────────────────────────

function testEnvelope(): { operationId: string; actor: string; trigger: string; at: number } {
    return { operationId: newGitOpsId(), actor: 'test', trigger: 'test', at: Date.now() };
}

/**
 * Mint an unblocked candidate for `stackName`, the same shape a pull produces,
 * without driving a real fetch. Reuses the live application the preceding
 * `svc.upsert` created; the identity is re-derived from the same configuration
 * so the generation fingerprint matches the application's.
 */
function seedDirectCandidate(stackName: string): { appId: string; generationId: string } {
    const at = Date.now();
    const config: DirectSourceConfig = {
        repoUrl: 'https://github.com/example/repo.git',
        branch: 'main',
        composePaths: ['compose.yaml'],
        contextDir: null,
        syncEnv: false,
        envPath: null,
    };
    const identity = directSourceIdentity(config);
    const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
    if (!app) throw new Error(`no live direct application for ${stackName}`);
    const appId = app.id;
    const generationId = newGitOpsId();
    GitOpsStore.getInstance().insertGeneration(buildGenerationRow({
        id: generationId,
        applicationId: appId,
        commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        identity,
        configuredRef: 'main',
        resolvedRefKind: 'branch',
        candidateRelPath: 'generations/cand',
        appliedRelPath: 'applied/1',
        manifestVersion: 1,
        expectedInvocation: null,
        changePlanFingerprint: 'fp-seed',
        operationId: newGitOpsId(),
        trigger: 'test',
        actor: 'test',
        at,
    }));
    GitOpsTransitions.getInstance().candidateReady(appId, generationId, false, testEnvelope());
    return { appId, generationId };
}

// ── sweepOrphans claimant fixtures ─────────────────────────────────────

/** A deterministic 40-char hex sha derived from a short seed. */
function shaFromSeed(seed: string): string {
    return seed.repeat(40).slice(0, 40);
}

/**
 * Create a Git-backed stack, pull one update into it, and backdate the
 * resulting candidate directory past the orphan-candidate age threshold so a
 * claimant-blind sweep would reap it as stale. Each test then arranges only
 * the claimant pointers it exercises before running the sweep.
 */
async function stageStaleCandidate(
    stackName: string,
    shaSeed: string,
): Promise<{ appId: string; generationId: string; candidateAbs: string }> {
    const svc = GitSourceService.getInstance();
    mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine\n', sha: shaFromSeed(shaSeed) });
    const validateSpy = vi.spyOn(svc, 'validateCompose').mockResolvedValue({ ok: true });
    try {
        await svc.createStackFromGit({
            stackName,
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
        mockSuccessfulClone({ compose: 'services:\n  x:\n    image: alpine:2\n', sha: shaFromSeed(`${shaSeed}a`) });
        await svc.pull(stackName);
    } finally {
        validateSpy.mockRestore();
    }
    const store = GitOpsStore.getInstance();
    const app = store.getLiveDirectApplication(stackName)!;
    expect(app.candidate_generation_id).toBeTruthy();
    const generation = store.getGeneration(app.candidate_generation_id!)!;
    const candidateAbs = path.join(stackManagedRoot(stackName), generation.candidate_dir);
    expect(fs.existsSync(candidateAbs)).toBe(true);
    const staleMtime = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(candidateAbs, staleMtime, staleMtime);
    return { appId: app.id, generationId: generation.id, candidateAbs };
}

/** Drop the application row's own pointer at its staged candidate. */
function clearCandidatePointer(appId: string): void {
    DatabaseService.getInstance().getDb()
        .prepare('UPDATE gitops_applications SET candidate_generation_id = NULL WHERE id = ?')
        .run(appId);
}

/** Drop the pending fetch record, the claimant that is independent of the application row. */
function clearPendingFetch(stackName: string): void {
    DatabaseService.getInstance().getDb()
        .prepare('UPDATE stack_git_sources SET pending_commit_sha = NULL, pending_compose_content = NULL WHERE stack_name = ?')
        .run(stackName);
}

describe('GitSourceService.sweepOrphans candidate claimant preservation', () => {
    it('preserves a stale, complete candidate directory still referenced by the live application\'s candidate_generation_id', async () => {
        const { candidateAbs } = await stageStaleCandidate('sweep-claims-candidate', 'c1');

        await GitSourceService.getInstance().sweepOrphans();

        expect(fs.existsSync(candidateAbs)).toBe(true);
    });

    it('still reaps a stale, complete candidate directory nothing on the application row references', async () => {
        const { appId, candidateAbs } = await stageStaleCandidate('sweep-reaps-unclaimed', 'c2');
        // Nothing on the row, and nothing pending, points at this generation
        // any more: the exact "leftover from an earlier attempt" case the
        // sweep exists to clean up.
        clearCandidatePointer(appId);
        clearPendingFetch('sweep-reaps-unclaimed');

        await GitSourceService.getInstance().sweepOrphans();

        expect(fs.existsSync(candidateAbs)).toBe(false);
    });

    it('preserves a stale, complete candidate directory referenced only by the pending fetch record, with no generation row yet', async () => {
        const { appId, candidateAbs } = await stageStaleCandidate('sweep-claims-pending-only', 'c3');
        // Simulate the row-level pointer being gone (the exact
        // fetchedInvalid/no-live-application gap where a generation may never
        // have existed at all) while the pending fetch record, written
        // independently, still names this candidate.
        clearCandidatePointer(appId);

        await GitSourceService.getInstance().sweepOrphans();

        expect(fs.existsSync(candidateAbs)).toBe(true);
    });

    it('preserves a stale, complete candidate directory referenced only by accepted_generation_id', async () => {
        const { appId, generationId, candidateAbs } = await stageStaleCandidate('sweep-claims-accepted-only', 'c4');
        // Simulate the sourceAccepted-committed-but-not-yet-promoted window:
        // accepted_generation_id names this candidate, the row's own candidate
        // pointer is gone, and the pending record no longer references it
        // either, so this pointer alone must be what preserves the directory.
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE gitops_applications SET accepted_generation_id = ? WHERE id = ?')
            .run(generationId, appId);
        clearCandidatePointer(appId);
        clearPendingFetch('sweep-claims-accepted-only');

        await GitSourceService.getInstance().sweepOrphans();

        expect(fs.existsSync(candidateAbs)).toBe(true);
    });

    it('preserves a stale candidate referenced only by an unsettled attempt', async () => {
        const { appId, generationId, candidateAbs } = await stageStaleCandidate('sweep-claims-unsettled', 'c5');
        const generation = GitOpsStore.getInstance().getGeneration(generationId)!;
        clearCandidatePointer(appId);
        clearPendingFetch('sweep-claims-unsettled');
        DatabaseService.getInstance().getDb()
            .prepare("DELETE FROM gitops_history WHERE application_id = ? AND operation_id = ? AND stage = 'source_reconcile_settled'")
            .run(appId, generation.operation_id);

        await GitSourceService.getInstance().sweepOrphans();

        expect(fs.existsSync(candidateAbs)).toBe(true);
    });

    it('preserves stale candidates when pending claimant metadata is unreadable', async () => {
        const stackName = 'sweep-preserves-unreadable-claims';
        const { appId, candidateAbs } = await stageStaleCandidate(stackName, 'c6');
        clearCandidatePointer(appId);
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE stack_git_sources SET pending_compose_content = ? WHERE stack_name = ?')
            .run('{"v":4 invalid', stackName);

        await GitSourceService.getInstance().sweepOrphans();

        expect(fs.existsSync(candidateAbs)).toBe(true);
        expect(DatabaseService.getInstance().getGitSource(stackName)?.manifest_state).toBe('migration_required');
    });

    it('preserves stale candidates when a generation claimant pointer is dangling', async () => {
        const stackName = 'sweep-preserves-dangling-claim';
        const { appId, candidateAbs } = await stageStaleCandidate(stackName, 'c7');
        clearPendingFetch(stackName);
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE gitops_applications SET candidate_generation_id = ? WHERE id = ?')
            .run('missing-generation', appId);

        await GitSourceService.getInstance().sweepOrphans();

        expect(fs.existsSync(candidateAbs)).toBe(true);
        expect(DatabaseService.getInstance().getGitSource(stackName)?.manifest_state).toBe('migration_required');
    });

    it('preserves stale candidates when unsettled-attempt claimant lookup fails', async () => {
        const stackName = 'sweep-preserves-claim-query-failure';
        const { appId, candidateAbs } = await stageStaleCandidate(stackName, 'c8');
        clearCandidatePointer(appId);
        clearPendingFetch(stackName);
        const claimantSpy = vi.spyOn(GitOpsStore.prototype, 'listGenerationsClaimedByUnsettledAttempts')
            .mockImplementationOnce(() => { throw new Error('simulated claimant query failure'); });

        try {
            await GitSourceService.getInstance().sweepOrphans();

            expect(fs.existsSync(candidateAbs)).toBe(true);
            expect(DatabaseService.getInstance().getGitSource(stackName)?.manifest_state).toBe('migration_required');
        } finally {
            claimantSpy.mockRestore();
        }
    });
});
