/**
 * Unit tests for GitChangePlanService: path-kind matrix, candidate invocation
 * in the plan, live applied_deploy_spec not used as candidate invocation, and
 * high-sensitivity paths absent from the public projection.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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

    it('blocks when live invocation diverges from the prior manifest', async () => {
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
        expect(plan.blocked).toBe(true);
        expect(plan.invocationBlocked).toBe(true);
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
});
