/**
 * Unit tests for GitChangePlanService: path-kind matrix, candidate invocation
 * in the plan, live applied_deploy_spec not used as candidate invocation, and
 * high-sensitivity paths absent from the public projection.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { BuildContextPlan, ComposeInputEntry, GitProjectManifest } from '../types/gitProjectManifest';
import { GIT_CHANGE_PLAN_SCHEMA_VERSION } from '../types/gitChangePlan';

let tmpDir: string;
let GitChangePlanService: typeof import('../services/GitChangePlanService').GitChangePlanService;
let GitProjectManifestService: typeof import('../services/GitProjectManifestService').GitProjectManifestService;
let buildCandidateComposeInvocation: typeof import('../utils/candidateComposeInvocation').buildCandidateComposeInvocation;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ GitChangePlanService } = await import('../services/GitChangePlanService'));
    ({ GitProjectManifestService } = await import('../services/GitProjectManifestService'));
    ({ buildCandidateComposeInvocation } = await import('../utils/candidateComposeInvocation'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    // Each test uses a unique stack name; no extra cleanup required.
});

function sha(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function stackDir(stackName: string): string {
    const dir = path.join(process.env.COMPOSE_DIR!, stackName);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeStackFile(stackName: string, rel: string, content: string): void {
    const abs = path.join(stackDir(stackName), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

function managedEntry(partial: Partial<ComposeInputEntry> & { materializedPath: string; content: string }): ComposeInputEntry {
    return {
        sourcePath: partial.sourcePath ?? partial.materializedPath,
        materializedPath: partial.materializedPath,
        role: partial.role ?? 'compose-primary',
        dependencyKind: partial.dependencyKind ?? 'explicit',
        ownership: partial.ownership ?? 'managed',
        provenance: partial.provenance ?? 'fetch',
        sensitivity: partial.sensitivity ?? 'medium',
        contentSha256: sha(partial.content),
        sizeBytes: Buffer.byteLength(partial.content, 'utf8'),
        state: partial.state ?? 'present',
        deletionAuthority: partial.deletionAuthority ?? 'sencho',
        note: partial.note ?? null,
    };
}

function buildManifest(
    stackName: string,
    inputs: ComposeInputEntry[],
    invocation: string[] = ['-f', 'compose.yaml', '-p', stackName],
    contexts: BuildContextPlan[] = [],
): GitProjectManifest {
    return GitProjectManifestService.getInstance().buildManifest({
        stackName,
        repoUrl: 'https://github.com/example/repo.git',
        branch: 'main',
        commitSha: 'abc123def456',
        projectRoot: null,
        composeFiles: ['compose.yaml'],
        projectName: stackName,
        invocation,
        inputs,
        refusals: [],
        buildContexts: contexts,
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
}

describe('buildCandidateComposeInvocation', () => {
    it('returns [] for a single-file selection with no context dir (auto-discovery)', () => {
        expect(buildCandidateComposeInvocation({
            stackName: 'web',
            composePaths: ['compose.yaml'],
            contextDir: null,
            stackDir: '/app/compose/web',
            syncEnv: false,
            envContentPresent: false,
        })).toEqual([]);
    });

    it('emits ordered -f / -p / --project-directory from the candidate selection, not a live spec', () => {
        const stackDirAbs = path.resolve('/tmp/compose/web');
        const args = buildCandidateComposeInvocation({
            stackName: 'web',
            composePaths: ['infra/base.yml', 'infra/prod.yml'],
            contextDir: 'infra',
            stackDir: stackDirAbs,
            syncEnv: false,
            envContentPresent: false,
        });
        expect(args).toEqual([
            '-f', 'compose.yaml',
            '-f', 'infra/prod.yml',
            '-p', 'web',
            '--project-directory', path.resolve(stackDirAbs, 'infra'),
        ]);
    });

    it('adds --env-file for sync-env when a context dir is set', () => {
        const stackDirAbs = path.resolve('/tmp/compose/web');
        const args = buildCandidateComposeInvocation({
            stackName: 'web',
            composePaths: ['infra/compose.yaml'],
            contextDir: 'infra',
            stackDir: stackDirAbs,
            syncEnv: true,
            envContentPresent: true,
        });
        expect(args).toEqual([
            '-f', 'compose.yaml',
            '-p', 'web',
            '--project-directory', path.resolve(stackDirAbs, 'infra'),
            '--env-file', path.resolve(stackDirAbs, '.env'),
        ]);
    });

    it('adds --env-file for a context-dir stack when root .env is already present', () => {
        const stackDirAbs = path.resolve('/tmp/compose/web');
        const args = buildCandidateComposeInvocation({
            stackName: 'web',
            composePaths: ['infra/compose.yaml'],
            contextDir: 'infra',
            stackDir: stackDirAbs,
            syncEnv: false,
            envContentPresent: false,
            rootEnvFilePresent: true,
        });
        expect(args).toContain('--env-file');
        expect(args).toContain(path.resolve(stackDirAbs, '.env'));
    });

    it('does not keep --env-file when sync-env omits the candidate .env', () => {
        const stackDirAbs = path.resolve('/tmp/compose/web');
        const args = buildCandidateComposeInvocation({
            stackName: 'web',
            composePaths: ['infra/compose.yaml'],
            contextDir: 'infra',
            stackDir: stackDirAbs,
            syncEnv: true,
            envContentPresent: false,
            rootEnvFilePresent: true,
        });
        expect(args).not.toContain('--env-file');
        expect(args).not.toContain(path.resolve(stackDirAbs, '.env'));
    });

    it('does not add --env-file for a single-file selection (Compose auto-loads .env)', () => {
        const stackDirAbs = path.resolve('/tmp/compose/web');
        expect(buildCandidateComposeInvocation({
            stackName: 'web',
            composePaths: ['compose.yaml'],
            contextDir: null,
            stackDir: stackDirAbs,
            syncEnv: true,
            envContentPresent: true,
        })).toEqual([]);
    });
});

describe('GitChangePlanService.build', () => {
    it('classifies unmodified matching files as unchanged and does not block', async () => {
        const stack = 'plan-unchanged';
        const content = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', content);
        const entry = managedEntry({ materializedPath: 'compose.yaml', content });
        const prior = buildManifest(stack, [entry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [entry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(false);
        expect(plan.operations.find((o) => o.pathKey === 'compose.yaml')?.op).toBe('unchanged');
        expect(plan.counts.unchanged).toBe(1);
    });

    it('classifies a live hash mismatch as local-modified and blocks', async () => {
        const stack = 'plan-local-mod';
        writeStackFile(stack, 'compose.yaml', 'services:\n  web:\n    image: nginx:local\n');
        const priorContent = 'services:\n  web:\n    image: nginx\n';
        const candidateContent = 'services:\n  web:\n    image: nginx:git\n';
        const priorEntry = managedEntry({ materializedPath: 'compose.yaml', content: priorContent });
        const candEntry = managedEntry({ materializedPath: 'compose.yaml', content: candidateContent });
        const prior = buildManifest(stack, [priorEntry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [candEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'compose.yaml')?.op).toBe('local-modified');
    });

    it('still blocks when live bytes match the candidate but not the last-applied hash', async () => {
        const stack = 'plan-local-match-cand';
        const priorContent = 'services:\n  web:\n    image: nginx\n';
        const candidateContent = 'services:\n  web:\n    image: nginx:git\n';
        writeStackFile(stack, 'compose.yaml', candidateContent);
        const priorEntry = managedEntry({ materializedPath: 'compose.yaml', content: priorContent });
        const candEntry = managedEntry({ materializedPath: 'compose.yaml', content: candidateContent });
        const prior = buildManifest(stack, [priorEntry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [candEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        const localOp = plan.operations.find((o) => o.pathKey === 'compose.yaml');
        expect(localOp?.op).toBe('local-modified');
        expect(localOp?.liveHash).toBe(localOp?.candidateHash);
        expect(localOp?.liveHash).not.toBe(localOp?.priorHash);
    });

    it('classifies a missing live file as local-missing and blocks', async () => {
        const stack = 'plan-missing';
        stackDir(stack);
        const content = 'services:\n  web:\n    image: nginx\n';
        const entry = managedEntry({ materializedPath: 'compose.yaml', content });
        const prior = buildManifest(stack, [entry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [entry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'compose.yaml')?.op).toBe('local-missing');
    });

    it('classifies a new candidate path over an unmanaged live file as unmanaged-collision', async () => {
        const stack = 'plan-collision';
        writeStackFile(stack, 'extra.yaml', 'services: {}\n');
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        const priorEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const extra = managedEntry({
            materializedPath: 'extra.yaml',
            content: 'services:\n  db:\n    image: postgres\n',
            role: 'compose-additional',
        });
        const prior = buildManifest(stack, [priorEntry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [priorEntry, extra],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'extra.yaml')?.op).toBe('unmanaged-collision');
    });

    it('classifies a removed sencho-authority file as delete when live still matches', async () => {
        const stack = 'plan-delete';
        const compose = 'services:\n  web:\n    image: nginx\n';
        const extra = 'services:\n  db:\n    image: postgres\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'extra.yaml', extra);
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const extraEntry = managedEntry({
            materializedPath: 'extra.yaml',
            content: extra,
            role: 'compose-additional',
        });
        const prior = buildManifest(stack, [composeEntry, extraEntry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(false);
        expect(plan.operations.find((o) => o.pathKey === 'extra.yaml')?.op).toBe('delete');
    });

    it('pairs a same-hash delete+add as rename (presentation only)', async () => {
        const stack = 'plan-rename';
        const compose = 'services:\n  web:\n    image: nginx\n';
        const shared = 'FOO=bar\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'old.env', shared);
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const oldEnv = managedEntry({
            materializedPath: 'old.env',
            content: shared,
            role: 'env',
            dependencyKind: 'env_file',
        });
        const newEnv = managedEntry({
            materializedPath: 'new.env',
            content: shared,
            role: 'env',
            dependencyKind: 'env_file',
        });
        const prior = buildManifest(stack, [composeEntry, oldEnv]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry, newEnv],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        const rename = plan.operations.find((o) => o.op === 'rename');
        expect(rename).toBeDefined();
        expect(rename?.fromPath).toBe('old.env');
        expect(rename?.pathKey).toBe('new.env');
        expect(plan.operations.some((o) => o.op === 'delete' && o.pathKey === 'old.env')).toBe(false);
        expect(plan.operations.some((o) => o.op === 'add' && o.pathKey === 'new.env')).toBe(false);
    });

    it('classifies a live directory at a file path as type-changed', async () => {
        const stack = 'plan-type';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        fs.mkdirSync(path.join(stackDir(stack), 'config.yaml'));
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const configEntry = managedEntry({
            materializedPath: 'config.yaml',
            content: 'x: 1\n',
            role: 'config',
            dependencyKind: 'config',
        });
        const prior = buildManifest(stack, [composeEntry, configEntry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry, configEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'config.yaml')?.op).toBe('type-changed');
    });

    it('treats create mode as add even when live files already exist', async () => {
        const stack = 'plan-create';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        const entry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'create',
            priorManifest: null,
            candidateInputs: [entry],
            candidateBuildContexts: [],
            candidateInvocation: [],
            liveInvocation: [],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.operations.find((o) => o.pathKey === 'compose.yaml')?.op).toBe('add');
    });

    it('classifies a live hash that drifted since review as local-modified', async () => {
        const stack = 'plan-reviewed-drift';
        const reviewed = 'services:\n  web:\n    image: nginx\n';
        const drifted = 'services:\n  web:\n    image: nginx:local\n';
        writeStackFile(stack, 'compose.yaml', drifted);
        const entry = managedEntry({ materializedPath: 'compose.yaml', content: reviewed });
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: null,
            candidateInputs: [entry],
            candidateBuildContexts: [],
            candidateInvocation: [],
            liveInvocation: [],
            legacyOwnedPaths: ['compose.yaml'],
            reviewedLiveHashes: new Map([['compose.yaml', sha(reviewed)]]),
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'compose.yaml')?.op).toBe('local-modified');
    });

    it('records candidate invocation change as informational when live still matches prior', async () => {
        const stack = 'plan-inv-info';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const prior = buildManifest(stack, [composeEntry], ['-f', 'compose.yaml', '-p', stack]);
        const prod = managedEntry({
            materializedPath: 'prod.yaml',
            content: 'services:\n  web:\n    restart: always\n',
            role: 'compose-additional',
        });
        const candidateInv = ['-f', 'compose.yaml', '-f', 'prod.yaml', '-p', stack];
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry, prod],
            candidateBuildContexts: [],
            candidateInvocation: candidateInv,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(false);
        expect(plan.invocationBlocked).toBe(false);
        expect(plan.operations.some((o) => o.op === 'invocation')).toBe(true);
        expect(plan.candidateInvocation).toEqual(candidateInv);
    });

    it('records live invocation divergence without a file-conflict block', async () => {
        const stack = 'plan-inv-block';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        const entry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const priorInv = ['-f', 'compose.yaml', '-p', stack];
        const prior = buildManifest(stack, [entry], priorInv);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [entry],
            candidateBuildContexts: [],
            candidateInvocation: priorInv,
            liveInvocation: ['-f', 'compose.yaml', '-f', 'override.yaml', '-p', stack],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.invocationBlocked).toBe(true);
        expect(plan.operations.some((o) => o.op === 'invocation')).toBe(true);
        const pub = GitChangePlanService.getInstance().toPublic(plan);
        expect(pub.blocked).toBe(false);
        expect(pub.invocation.liveDiverged).toBe(true);
        expect(pub.operations.some((o) => o.op === 'invocation')).toBe(true);
        expect(pub.operations.find((o) => o.op === 'invocation')?.path).toBeNull();
    });

    it('redacts high-sensitivity paths from the public projection and omits hashes', async () => {
        const stack = 'plan-secret';
        const compose = 'services:\n  web:\n    image: nginx\n';
        const secret = 'SUPERSECRET=1\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, '.env', secret);
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const secretEntry = managedEntry({
            materializedPath: '.env',
            content: secret,
            role: 'env',
            dependencyKind: 'sync-env',
            sensitivity: 'high',
        });
        const prior = buildManifest(stack, [composeEntry, secretEntry]);
        const nextSecret = managedEntry({
            materializedPath: '.env',
            content: 'SUPERSECRET=2\n',
            role: 'env',
            dependencyKind: 'sync-env',
            sensitivity: 'high',
        });
        // Live still matches prior, candidate changes the secret: modify, not blocked.
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry, nextSecret],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        const pub = GitChangePlanService.getInstance().toPublic(plan);
        const serialized = JSON.stringify(pub);
        expect(serialized).not.toContain('.env');
        expect(serialized).not.toContain('SUPERSECRET');
        expect(serialized).not.toContain(sha(secret));
        expect(pub.operations.find((o) => o.op === 'modify')?.path).toBeNull();
        expect(plan.fingerprint).toHaveLength(64);
        expect(plan.schemaVersion).toBe(GIT_CHANGE_PLAN_SCHEMA_VERSION);
    });

    it('includes build-context files in the path universe', async () => {
        const stack = 'plan-ctx';
        const compose = 'services:\n  web:\n    image: nginx\n    build: ./app\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'app/Dockerfile', 'FROM alpine\n');
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const ctx: BuildContextPlan = {
            repoPath: 'app',
            dockerfile: 'Dockerfile',
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'Dockerfile', sha256: sha('FROM alpine\n'), sizeBytes: 12 }],
        };
        const prior = buildManifest(stack, [composeEntry], ['-f', 'compose.yaml', '-p', stack], [ctx]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [ctx],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.operations.find((o) => o.pathKey === 'app/Dockerfile')?.op).toBe('unchanged');
    });

    it('blocks locally added files inside a retained build context', async () => {
        const stack = 'plan-ctx-local-add';
        const compose = 'services:\n  web:\n    image: nginx\n    build: ./app\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'app/Dockerfile', 'FROM alpine\n');
        writeStackFile(stack, 'app/extra.txt', 'local-only\n');
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const ctx: BuildContextPlan = {
            repoPath: 'app',
            dockerfile: 'Dockerfile',
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'Dockerfile', sha256: sha('FROM alpine\n'), sizeBytes: 12 }],
        };
        const prior = buildManifest(stack, [composeEntry], ['-f', 'compose.yaml', '-p', stack], [ctx]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [ctx],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'app/extra.txt')?.op).toBe('unmanaged-collision');
    });

    it('classifies a prior-only upstream delete with an already-missing live file as local-missing', async () => {
        const stack = 'plan-prior-missing';
        const compose = 'services:\n  web:\n    image: nginx\n';
        const extra = 'services:\n  db:\n    image: postgres\n';
        writeStackFile(stack, 'compose.yaml', compose);
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const extraEntry = managedEntry({
            materializedPath: 'extra.yaml',
            content: extra,
            role: 'compose-additional',
        });
        const prior = buildManifest(stack, [composeEntry, extraEntry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'extra.yaml')?.op).toBe('local-missing');
    });

    it('binds configured project env files into the fingerprint and blocks reviewed drift', async () => {
        const stack = 'plan-project-env';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'prod.env', 'FOO=1\n');
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const prior = buildManifest(stack, [composeEntry]);
        const { DatabaseService } = await import('../services/DatabaseService');
        const { NodeRegistry } = await import('../services/NodeRegistry');
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stack, ['prod.env']);

        const stable = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
            projectEnvFiles: ['prod.env'],
        });
        expect(stable.operations.find((o) => o.pathKey === 'prod.env')?.op).toBe('unchanged');

        writeStackFile(stack, 'prod.env', 'FOO=2\n');
        const drifted = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
            projectEnvFiles: ['prod.env'],
            reviewedLiveHashes: new Map([['prod.env', sha('FOO=1\n')]]),
        });
        expect(drifted.blocked).toBe(true);
        expect(drifted.operations.find((o) => o.pathKey === 'prod.env')?.op).toBe('local-modified');
    });

    it('records ownership, provenance, and source revision on managed operations', async () => {
        const stack = 'plan-metadata';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const prior = buildManifest(stack, [composeEntry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'deadbeef',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        const row = plan.operations.find((o) => o.pathKey === 'compose.yaml');
        expect(row?.ownership).toBe('managed');
        expect(row?.provenance).toBe('fetch');
        expect(row?.sourceRevision).toBe('deadbeef');
        expect(row?.reason).toBeTruthy();
        expect(plan.operations.every((o) => o.ownership && o.provenance && o.sourceRevision && o.reason)).toBe(true);
    });

    it.runIf(process.platform !== 'win32')('classifies fifo nodes as type-changed without reading them', async () => {
        const stack = 'plan-fifo';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        const fifoPath = path.join(stackDir(stack), 'pipe.fifo');
        const created = spawnSync('mkfifo', [fifoPath], { stdio: 'ignore' });
        expect(created.status).toBe(0);
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const fifoEntry = managedEntry({
            materializedPath: 'pipe.fifo',
            content: 'ignored',
            role: 'config',
            dependencyKind: 'config',
        });
        const prior = buildManifest(stack, [composeEntry, fifoEntry]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry, fifoEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'pipe.fifo')?.op).toBe('type-changed');
    });

    it('blocks a locally added file inside a removed build context', async () => {
        const stack = 'plan-removed-ctx-extra';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'app/Dockerfile', 'FROM alpine\n');
        writeStackFile(stack, 'app/notes.txt', 'keep-me\n');
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const ctx: BuildContextPlan = {
            repoPath: 'app',
            dockerfile: 'Dockerfile',
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'Dockerfile', sha256: sha('FROM alpine\n'), sizeBytes: 12 }],
        };
        const prior = buildManifest(stack, [composeEntry], ['-f', 'compose.yaml', '-p', stack], [ctx]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(true);
        expect(plan.operations.find((o) => o.pathKey === 'app/notes.txt')?.op).toBe('unmanaged-collision');
        expect(fs.readFileSync(path.join(stackDir(stack), 'app', 'notes.txt'), 'utf8')).toBe('keep-me\n');
    });

    it('classifies a clean removed context as delete of owned files only', async () => {
        const stack = 'plan-removed-ctx-clean';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'app/Dockerfile', 'FROM alpine\n');
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const ctx: BuildContextPlan = {
            repoPath: 'app',
            dockerfile: 'Dockerfile',
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'Dockerfile', sha256: sha('FROM alpine\n'), sizeBytes: 12 }],
        };
        const prior = buildManifest(stack, [composeEntry], ['-f', 'compose.yaml', '-p', stack], [ctx]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        expect(plan.blocked).toBe(false);
        expect(plan.operations.find((o) => o.pathKey === 'app/Dockerfile')?.op).toBe('delete');
    });

    it('redacts a secret-bearing locally added context file from the public plan', async () => {
        const stack = 'plan-ctx-secret-extra';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'app/Dockerfile', 'FROM alpine\n');
        writeStackFile(stack, 'app/.env', 'TOKEN=supersecret\n');
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const ctx: BuildContextPlan = {
            repoPath: 'app',
            dockerfile: 'Dockerfile',
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'Dockerfile', sha256: sha('FROM alpine\n'), sizeBytes: 12 }],
        };
        const prior = buildManifest(stack, [composeEntry], ['-f', 'compose.yaml', '-p', stack], [ctx]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [ctx],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        const extra = plan.operations.find((o) => o.pathKey === 'app/.env');
        expect(extra?.op).toBe('unmanaged-collision');
        expect(extra?.sensitivity).toBe('high');
        const pub = GitChangePlanService.getInstance().toPublic(plan);
        expect(JSON.stringify(pub)).not.toContain('.env');
        expect(JSON.stringify(pub)).not.toContain('TOKEN');
    });

    it('redacts .env.local and .env.production context extras from the public plan', async () => {
        const stack = 'plan-ctx-env-dot-names';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, 'app/Dockerfile', 'FROM alpine\n');
        writeStackFile(stack, 'app/.env.local', 'TOKEN=local\n');
        writeStackFile(stack, 'app/.env.production', 'TOKEN=prod\n');
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const ctx: BuildContextPlan = {
            repoPath: 'app',
            dockerfile: 'Dockerfile',
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'Dockerfile', sha256: sha('FROM alpine\n'), sizeBytes: 12 }],
        };
        const prior = buildManifest(stack, [composeEntry], ['-f', 'compose.yaml', '-p', stack], [ctx]);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [ctx],
            candidateInvocation: prior.project.invocation,
            liveInvocation: prior.project.invocation,
        });
        const local = plan.operations.find((o) => o.pathKey === 'app/.env.local');
        const prod = plan.operations.find((o) => o.pathKey === 'app/.env.production');
        expect(local?.op).toBe('unmanaged-collision');
        expect(local?.sensitivity).toBe('high');
        expect(prod?.op).toBe('unmanaged-collision');
        expect(prod?.sensitivity).toBe('high');
        const pub = GitChangePlanService.getInstance().toPublic(plan);
        const collisions = pub.operations.filter((o) => o.op === 'unmanaged-collision');
        expect(collisions).toHaveLength(2);
        expect(collisions.every((o) => o.path === null)).toBe(true);
        expect(JSON.stringify(pub)).not.toContain('.env.local');
        expect(JSON.stringify(pub)).not.toContain('.env.production');
        expect(JSON.stringify(pub)).not.toContain('TOKEN');
    });

    it('records an invocation change when a synced .env disappears from the candidate', async () => {
        const stack = 'plan-sync-env-removed';
        const compose = 'services:\n  web:\n    image: nginx\n';
        const env = 'TAG=live\n';
        writeStackFile(stack, 'compose.yaml', compose);
        writeStackFile(stack, '.env', env);
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const envEntry = managedEntry({
            materializedPath: '.env',
            content: env,
            role: 'env',
            dependencyKind: 'sync-env',
            sensitivity: 'high',
        });
        const stackDirAbs = path.resolve(stackDir(stack));
        const invOpts = {
            stackName: stack,
            composePaths: ['app/compose.yaml'],
            contextDir: 'app',
            stackDir: stackDirAbs,
            syncEnv: true,
        };
        const priorInv = buildCandidateComposeInvocation({ ...invOpts, envContentPresent: true });
        const candidateInv = buildCandidateComposeInvocation({
            ...invOpts,
            envContentPresent: false,
            rootEnvFilePresent: true,
        });
        expect(priorInv).toContain('--env-file');
        expect(candidateInv).not.toContain('--env-file');
        const prior = buildManifest(stack, [composeEntry, envEntry], priorInv);
        const plan = await GitChangePlanService.getInstance().build({
            stackName: stack,
            commitSha: 'cafebabe',
            mode: 'update',
            priorManifest: prior,
            candidateInputs: [composeEntry],
            candidateBuildContexts: [],
            candidateInvocation: candidateInv,
            liveInvocation: priorInv,
        });
        expect(plan.blocked).toBe(false);
        expect(plan.operations.find((o) => o.pathKey === '.env')?.op).toBe('delete');
        expect(plan.operations.find((o) => o.op === 'invocation')).toBeTruthy();
        expect(plan.candidateInvocation).toEqual(candidateInv);
        expect(plan.candidateInvocation).not.toContain('--env-file');
    });

    it('changes the fingerprint when rename source, ownership, sensitivity, or reason changes', () => {
        const fingerprintOf = (overrides: Record<string, unknown>): string => {
            const svc = GitChangePlanService.getInstance() as unknown as {
                fingerprint: (input: {
                    commitSha: string;
                    priorManifestVersion: number | null;
                    priorAppliedDir: string | null;
                    operations: unknown[];
                }) => string;
            };
            const base = {
                pathKey: 'compose.yaml',
                op: 'modify',
                role: 'compose-primary',
                deletionAuthority: 'sencho',
                priorHash: 'aa',
                candidateHash: 'bb',
                liveHash: 'aa',
                sensitivity: 'medium',
                ownership: 'managed',
                provenance: 'fetch',
                sourceRevision: 'deadbeef',
                reason: 'candidate content differs from prior',
            };
            return svc.fingerprint({
                commitSha: 'deadbeef',
                priorManifestVersion: 1,
                priorAppliedDir: 'generations/applied',
                operations: [{ ...base, ...overrides }],
            });
        };
        const base = fingerprintOf({});
        expect(fingerprintOf({ fromPath: 'old.yaml' })).not.toBe(base);
        expect(fingerprintOf({ ownership: 'unmanaged' })).not.toBe(base);
        expect(fingerprintOf({ sensitivity: 'high' })).not.toBe(base);
        expect(fingerprintOf({ reason: 'live hash differs from prior managed hash' })).not.toBe(base);
        expect(fingerprintOf({ provenance: 'adopted' })).not.toBe(base);
    });

    it.runIf(process.platform !== 'win32')('blocks a context-root symlink without enumerating the target', async () => {
        const stack = 'plan-ctx-root-symlink';
        const compose = 'services:\n  web:\n    image: nginx\n';
        writeStackFile(stack, 'compose.yaml', compose);
        const outside = path.join(process.env.COMPOSE_DIR!, '..', 'outside-ctx-root');
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'should-not-be-read\n');
        const appDir = path.join(stackDir(stack), 'app');
        fs.symlinkSync(outside, appDir, 'dir');
        const composeEntry = managedEntry({ materializedPath: 'compose.yaml', content: compose });
        const ctx: BuildContextPlan = {
            repoPath: 'app',
            dockerfile: 'Dockerfile',
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'Dockerfile', sha256: sha('FROM alpine\n'), sizeBytes: 12 }],
        };
        const prior = buildManifest(stack, [composeEntry], ['-f', 'compose.yaml', '-p', stack], [ctx]);
        const hashSpy = vi.spyOn(GitProjectManifestService.getInstance(), 'hashStackFile');
        try {
            const plan = await GitChangePlanService.getInstance().build({
                stackName: stack,
                commitSha: 'cafebabe',
                mode: 'update',
                priorManifest: prior,
                candidateInputs: [composeEntry],
                candidateBuildContexts: [ctx],
                candidateInvocation: prior.project.invocation,
                liveInvocation: prior.project.invocation,
            });
            expect(plan.blocked).toBe(true);
            expect(plan.operations.find((o) => o.pathKey === 'app')?.op).toBe('type-changed');
            expect(plan.operations.some((o) => o.pathKey.includes('secret.txt'))).toBe(false);
            expect(JSON.stringify(plan.operations)).not.toContain('outside-ctx-root');
            const hashedOutside = hashSpy.mock.calls.some((c) => String(c[1]).includes('secret.txt') || String(c[1]).includes('outside'));
            expect(hashedOutside).toBe(false);
        } finally {
            hashSpy.mockRestore();
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});
