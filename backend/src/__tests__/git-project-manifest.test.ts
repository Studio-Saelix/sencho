import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { GitProjectManifestService, PROMOTION_MARKER, CANDIDATE_COMPLETE_MARKER, PromoteGenerationError } from '../services/GitProjectManifestService';
import type { ComposeInputEntry, GitProjectManifest, ManifestBounds } from '../types/gitProjectManifest';

const BOUNDS: ManifestBounds = {
    maxFiles: 10_000,
    maxBytes: 512 * 1024 * 1024,
    maxContextBytes: 256 * 1024 * 1024,
    maxPathDepth: 64,
    maxFileBytes: 10 * 1024 * 1024,
};

let tmpDir: string;

beforeAll(async () => {
    tmpDir = await setupTestDb();
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

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

function readStackFile(stackName: string, rel: string): string {
    return fs.readFileSync(path.join(stackDir(stackName), rel), 'utf8');
}

function managedEntry(partial: Partial<ComposeInputEntry> & { materializedPath: string }): ComposeInputEntry {
    return {
        sourcePath: partial.materializedPath,
        materializedPath: partial.materializedPath,
        role: partial.role ?? 'compose-primary',
        dependencyKind: partial.dependencyKind ?? 'explicit',
        ownership: partial.ownership ?? 'managed',
        provenance: partial.provenance ?? 'fetch',
        sensitivity: partial.sensitivity ?? 'medium',
        contentSha256: partial.contentSha256 ?? null,
        sizeBytes: partial.sizeBytes ?? 10,
        state: partial.state ?? 'present',
        deletionAuthority: partial.deletionAuthority ?? 'sencho',
        note: partial.note ?? null,
    };
}

function buildManifest(stackName: string, inputs: ComposeInputEntry[], prior: GitProjectManifest | null = null, contexts: import('../types/gitProjectManifest').BuildContextPlan[] = []): GitProjectManifest {
    return GitProjectManifestService.getInstance().buildManifest({
        stackName,
        repoUrl: 'https://github.com/example/repo.git',
        branch: 'main',
        commitSha: 'abc123',
        projectRoot: null,
        composeFiles: ['compose.yaml'],
        projectName: stackName,
        invocation: ['-f', 'compose.yaml', '-p', stackName],
        inputs,
        refusals: [],
        buildContexts: contexts,
        bounds: BOUNDS,
        priorManifest: prior,
        state: prior ? 'active' : 'active',
    });
}

function makeClone(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-clone-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return dir;
}

const REPO = { repo_url: 'https://github.com/example/repo.git', branch: 'main' };

function seedGitSource(stackName: string): void {
    DatabaseService.getInstance().upsertGitSource({
        stack_name: stackName,
        repo_url: REPO.repo_url,
        branch: REPO.branch,
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

function writePromotionMarker(stackName: string, marker: {
    phase?: 'applying' | 'committing';
    sha: string;
    manifestVersion: number;
    candidateRelPath: string;
    appliedRelPath: string;
    affected: string[];
    introduced?: string[];
}): void {
    fs.writeFileSync(
        path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER),
        JSON.stringify({ schemaVersion: 2, phase: marker.phase ?? 'applying', introduced: [], ...marker }),
        'utf8',
    );
}

describe('toPublicRefusals (audit round 9 S-1)', () => {
    it('redacts high-sensitivity refusals and leaves others untouched', () => {
        const svc = GitProjectManifestService.getInstance();
        const projected = svc.toPublicRefusals([
            { sourcePath: 'secrets/db.env', kind: 'missing-file', reason: 'File not found in repository: secrets/db.env', actionable: true, sensitivity: 'high' },
            { sourcePath: 'configs/app.conf', kind: 'missing-file', reason: 'File not found in repository: configs/app.conf', actionable: true, sensitivity: 'high' },
            { sourcePath: 'compose.yaml', kind: 'missing-file', reason: 'File not found in repository: compose.yaml', actionable: true, sensitivity: 'medium' },
            { sourcePath: 'web', kind: 'unsafe-context', reason: 'Build context web contains a symlink', actionable: true },
        ]);
        expect(projected[0].sourcePath).toBeNull();
        expect(projected[0].reason).toBe('File not found in repository: [redacted]');
        expect(projected[0].reason).not.toContain('secrets/db.env');
        expect(projected[1].sourcePath).toBeNull();
        expect(projected[1].reason).not.toContain('configs/app.conf');
        // Medium and unspecified sensitivity pass through unchanged.
        expect(projected[2]).toEqual({ sourcePath: 'compose.yaml', kind: 'missing-file', reason: 'File not found in repository: compose.yaml', actionable: true, sensitivity: 'medium' });
        expect(projected[3].sourcePath).toBe('web');
        expect(projected[3].reason).toBe('Build context web contains a symlink');
    });
});

describe('readManifest / writeManifest', () => {
    it('round-trips and bumps the manifest version', async () => {
        const svc = GitProjectManifestService.getInstance();
        const m1 = buildManifest('roundtrip', [managedEntry({ materializedPath: 'compose.yaml' })]);
        await svc.writeManifest('roundtrip', m1);
        const read = await svc.readManifest('roundtrip', REPO.repo_url, REPO.branch);
        expect(read).not.toBeNull();
        if (read === null || 'corrupt' in read) throw new Error('expected a manifest');
        expect(read.manifestVersion).toBe(1);
        expect(read.identity.stackName).toBe('roundtrip');

        const m2 = buildManifest('roundtrip', [managedEntry({ materializedPath: 'compose.yaml' })], read);
        await svc.writeManifest('roundtrip', m2);
        const read2 = await svc.readManifest('roundtrip', REPO.repo_url, REPO.branch);
        if (read2 === null || 'corrupt' in read2) throw new Error('expected a manifest');
        expect(read2.manifestVersion).toBe(2);
    });

    it('rejects non-JSON manifests as corrupt', async () => {
        const svc = GitProjectManifestService.getInstance();
        fs.mkdirSync(path.join(tmpDir, 'git-managed', '1', 'corrupt-json'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'git-managed', '1', 'corrupt-json', 'manifest.v1.json'), 'not json', 'utf8');
        const read = await svc.readManifest('corrupt-json', REPO.repo_url, REPO.branch);
        expect(read).not.toBeNull();
        expect(read && 'corrupt' in read).toBe(true);
    });

    it('rejects a hand-tampered deletionAuthority as corrupt', async () => {
        const svc = GitProjectManifestService.getInstance();
        const m = buildManifest('tampered', [managedEntry({ materializedPath: 'compose.yaml' })]);
        await svc.writeManifest('tampered', m);
        const manifestPath = path.join(tmpDir, 'git-managed', '1', 'tampered', 'manifest.v1.json');
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        raw.inputs[0].deletionAuthority = 'attacker';
        fs.writeFileSync(manifestPath, JSON.stringify(raw), 'utf8');
        const read = await svc.readManifest('tampered', REPO.repo_url, REPO.branch);
        expect(read && 'corrupt' in read).toBe(true);
    });

    it('rejects an identity mismatch (orphan adoption) as corrupt', async () => {
        const svc = GitProjectManifestService.getInstance();
        const m = buildManifest('identity-a', [managedEntry({ materializedPath: 'compose.yaml' })]);
        await svc.writeManifest('identity-a', m);
        // A same-named successor pointing at a different repository must not adopt it.
        const read = await svc.readManifest('identity-a', 'https://github.com/other/repo.git', 'main');
        expect(read && 'corrupt' in read).toBe(true);
    });

    it('degrades legacy context inventories without file sizes to directory granularity', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'legacy-context-sizes';
        const manifest = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })], null, [{
            repoPath: 'app',
            dockerfile: null,
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'file.txt', sha256: 'a'.repeat(64), sizeBytes: 12 }],
        }]);
        await svc.writeManifest(stackName, manifest);
        const manifestPath = path.join(tmpDir, 'git-managed', '1', stackName, 'manifest.v1.json');
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        delete raw.buildContexts[0].files[0].sizeBytes;
        fs.writeFileSync(manifestPath, JSON.stringify(raw), 'utf8');

        const read = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        if (read === null || 'corrupt' in read) throw new Error('expected a legacy manifest');
        expect(read.buildContexts[0].files).toEqual([]);
    });

    it('rejects empty file paths and malformed nested counters', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'deep-validation';
        const manifest = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        await svc.writeManifest(stackName, manifest);
        const manifestPath = path.join(tmpDir, 'git-managed', '1', stackName, 'manifest.v1.json');

        const emptyPath = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        emptyPath.inputs[0].materializedPath = '';
        fs.writeFileSync(manifestPath, JSON.stringify(emptyPath), 'utf8');
        const emptyRead = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        expect(emptyRead && 'corrupt' in emptyRead).toBe(true);

        await svc.writeManifest(stackName, manifest);
        const malformed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        malformed.bounds.maxFiles = -1;
        fs.writeFileSync(manifestPath, JSON.stringify(malformed), 'utf8');
        const malformedRead = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        expect(malformedRead && 'corrupt' in malformedRead).toBe(true);
    });

    it('returns null after the managed area is deleted', async () => {
        const svc = GitProjectManifestService.getInstance();
        const m = buildManifest('deleted-area', [managedEntry({ materializedPath: 'compose.yaml' })]);
        await svc.writeManifest('deleted-area', m);
        await svc.deleteManagedArea('deleted-area');
        expect(await svc.readManifest('deleted-area', REPO.repo_url, REPO.branch)).toBeNull();
    });
});

describe('promoteGeneration', () => {
    it('promotes a candidate transactionally and persists the manifest', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-ok';
        DatabaseService.getInstance().upsertGitSource({
            stack_name: stackName,
            repo_url: REPO.repo_url,
            branch: REPO.branch,
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
        writeStackFile(stackName, 'compose.yaml', 'services:\n  web:\n    image: nginx:old\n');
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx:new\n    configs: [app]\nconfigs:\n  app:\n    file: config/app.conf\n',
            'config/app.conf': 'new config\n',
        });
        const inventory = await import('../services/ComposeInputDiscoveryService').then((m) =>
            m.ComposeInputDiscoveryService.getInstance().discoverFromClone({
                cloneDir: clone,
                composePaths: ['compose.yaml'],
                contextDir: null,
                bounds: BOUNDS,
            }),
        );
        const inputs = inventory.inputs.filter((i) => i.ownership === 'managed');
        const manifest = buildManifest(stackName, inputs);
        const candidateRel = await svc.buildCandidate(
            stackName,
            'abc123',
            clone,
            inputs.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })),
            inventory.contextCopyPlans,
            BOUNDS,
        );
        await svc.promoteGeneration(stackName, { sha: 'abc123', candidateRelPath: candidateRel, manifest, priorManifest: null, adoptExistingMaterializedPaths: 'all' });

        expect(readStackFile(stackName, 'compose.yaml')).toContain('nginx:new');
        expect(readStackFile(stackName, 'config/app.conf')).toContain('new config');
        const read = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        if (read === null || 'corrupt' in read) throw new Error('expected a manifest');
        expect(read.resolvedRevision.commitSha).toBe('abc123');
        expect(read.generation.appliedDir).toContain('applied-abc123');
        // Marker is gone after a clean promotion.
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
        // DB cache agrees with the file.
        const row = DatabaseService.getInstance().getGitSource(stackName);
        expect(row?.manifest_state).toBe(read.state);
    });

    it('refuses to promote a candidate without the completion marker', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-incomplete';
        writeStackFile(stackName, 'compose.yaml', 'old\n');
        const candidateRel = `generations/candidate-deadbeef`;
        const candidateAbs = path.join(tmpDir, 'git-managed', '1', stackName, candidateRel);
        fs.mkdirSync(candidateAbs, { recursive: true });
        fs.writeFileSync(path.join(candidateAbs, 'compose.yaml'), 'new\n'); // no completion marker
        const manifest = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml', contentSha256: 'x' })]);
        await expect(
            svc.promoteGeneration(stackName, { sha: 'deadbeef', candidateRelPath: candidateRel, manifest, priorManifest: null }),
        ).rejects.toThrow(/Candidate is incomplete/);
        expect(readStackFile(stackName, 'compose.yaml')).toBe('old\n');
    });

    it('cleanup honors deletion authority and tombstones removed paths', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-authority';
        writeStackFile(stackName, 'compose.yaml', 'v1\n');
        writeStackFile(stackName, 'stale.yaml', 'stale\n');
        writeStackFile(stackName, 'user-owned.yaml', 'user\n');
        const priorInputs = [
            managedEntry({ materializedPath: 'compose.yaml' }),
            managedEntry({ materializedPath: 'stale.yaml' }),
            managedEntry({ materializedPath: 'user-owned.yaml', deletionAuthority: 'user' }),
        ];
        const prior = buildManifest(stackName, priorInputs);
        const priorRel = `generations/applied-prior`;
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        for (const p of ['compose.yaml', 'stale.yaml', 'user-owned.yaml']) {
            fs.copyFileSync(path.join(stackDir(stackName), p), path.join(priorAbs, p));
        }
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        const next = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })], prior);
        const clone = makeClone({ 'compose.yaml': 'v2\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'sha2',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }],
            [],
            BOUNDS,
        );
        await svc.promoteGeneration(stackName, { sha: 'sha2', candidateRelPath: candidateRel, manifest: next, priorManifest: prior });

        expect(fs.existsSync(path.join(stackDir(stackName), 'stale.yaml'))).toBe(false); // sencho authority -> removed
        expect(readStackFile(stackName, 'user-owned.yaml')).toBe('user\n'); // user authority -> untouched
        const read = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        if (read === null || 'corrupt' in read) throw new Error('expected a manifest');
        const tombstone = read.inputs.find((i) => i.materializedPath === 'stale.yaml');
        expect(tombstone?.state).toBe('tombstoned');
    });

    it('keeps the prior snapshot when reapplying the same commit', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-same-sha';
        writeStackFile(stackName, 'compose.yaml', 'PRIOR\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = 'generations/applied-abc123-1';
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);
        const next = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })], prior);
        const clone = makeClone({ 'compose.yaml': 'NEW\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'abc123',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }],
            [],
            BOUNDS,
        );

        await svc.promoteGeneration(stackName, { sha: 'abc123', candidateRelPath: candidateRel, manifest: next, priorManifest: prior });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('NEW\n');
        expect(fs.readFileSync(path.join(priorAbs, 'compose.yaml'), 'utf8')).toBe('PRIOR\n');
        const current = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        if (current === null || 'corrupt' in current) throw new Error('expected a manifest');
        expect(current.generation.appliedDir).toBe('generations/applied-abc123-2');
        expect(current.generation.previousDir).toBe(priorRel);
        expect(fs.existsSync(path.join(priorAbs, 'compose.yaml'))).toBe(true);
    });

    it('refuses case-only managed path changes before mutating the stack', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-case-only';
        writeStackFile(stackName, 'Config.yml', 'PRIOR\n');
        const prior = buildManifest(stackName, [managedEntry({
            materializedPath: 'Config.yml',
            role: 'config',
            dependencyKind: 'config',
        })]);
        const incoming = buildManifest(stackName, [managedEntry({
            materializedPath: 'config.yml',
            role: 'config',
            dependencyKind: 'config',
        })], prior);
        const clone = makeClone({ 'config.yml': 'NEW\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'case-only',
            clone,
            [{ srcRel: 'config.yml', destRel: 'config.yml' }],
            [],
            BOUNDS,
        );

        await expect(svc.promoteGeneration(stackName, {
            sha: 'case-only',
            candidateRelPath: candidateRel,
            manifest: incoming,
            priorManifest: prior,
        })).rejects.toSatisfy((err: unknown) =>
            err instanceof PromoteGenerationError
            && err.phase === 'pre_mutation'
            && /Case-only managed path changes/.test(err.message),
        );
        expect(readStackFile(stackName, 'Config.yml')).toBe('PRIOR\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('refuses to overwrite an unowned local file at an introduced path', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-introduced-collision';
        writeStackFile(stackName, 'compose.yaml', 'v1\n');
        // A local file Sencho never owned.
        writeStackFile(stackName, 'local-secret.txt', 'user data\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = 'generations/applied-prior';
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'v1\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        const incoming = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml' }),
            managedEntry({ materializedPath: 'local-secret.txt', dependencyKind: 'config', role: 'config' }),
        ], prior);
        const clone = makeClone({ 'compose.yaml': 'v2\n', 'local-secret.txt': 'repo version\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'sha-collide',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }, { srcRel: 'local-secret.txt', destRel: 'local-secret.txt' }],
            [],
            BOUNDS,
        );

        await expect(svc.promoteGeneration(stackName, {
            sha: 'sha-collide',
            candidateRelPath: candidateRel,
            manifest: incoming,
            priorManifest: prior,
        })).rejects.toThrow(/does not manage/);

        // Nothing changed on disk and no promotion marker was written.
        expect(readStackFile(stackName, 'local-secret.txt')).toBe('user data\n');
        expect(readStackFile(stackName, 'compose.yaml')).toBe('v1\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('refuses to overwrite an unowned file introduced inside a root-context file set', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-rootctx-collision';
        writeStackFile(stackName, 'compose.yaml', 'v1\n');
        writeStackFile(stackName, 'src/main.go', 'user code\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = 'generations/applied-prior';
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'v1\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build: .\n',
            'src/main.go': 'repo code\n',
        });
        const inventory = await import('../services/ComposeInputDiscoveryService').then((m) =>
            m.ComposeInputDiscoveryService.getInstance().discoverFromClone({
                cloneDir: clone,
                composePaths: ['compose.yaml'],
                contextDir: null,
                bounds: BOUNDS,
            }),
        );
        const incoming = buildManifest(stackName, inventory.inputs.filter((i) => i.ownership === 'managed'), prior, inventory.buildContexts);
        const candidateRel = await svc.buildCandidate(
            stackName,
            'sha-rootctx',
            clone,
            inventory.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null)
                .map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })),
            inventory.contextCopyPlans,
            BOUNDS,
        );

        await expect(svc.promoteGeneration(stackName, {
            sha: 'sha-rootctx',
            candidateRelPath: candidateRel,
            manifest: incoming,
            priorManifest: prior,
        })).rejects.toThrow(/does not manage/);
        expect(readStackFile(stackName, 'src/main.go')).toBe('user code\n');
    });

    it('refuses an unowned collision on a pre-manifest stack even with no prior manifest (audit round 9 B-1)', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-premanifest-collision';
        // An existing pre-manifest stack: the legacy compose file plus a local
        // file Sencho never owned.
        writeStackFile(stackName, 'compose.yaml', 'legacy v1\n');
        writeStackFile(stackName, 'configs/app.json', 'local user data\n');

        const incoming = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml' }),
            managedEntry({ materializedPath: 'configs/app.json', dependencyKind: 'config', role: 'config' }),
        ]);
        const clone = makeClone({ 'compose.yaml': 'v2\n', 'configs/app.json': 'repo version\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'sha-pre',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }, { srcRel: 'configs/app.json', destRel: 'configs/app.json' }],
            [],
            BOUNDS,
        );

        // The allowlist covers only the legacy-owned compose file; the local
        // config file must be refused and preserved byte-for-byte.
        await expect(svc.promoteGeneration(stackName, {
            sha: 'sha-pre',
            candidateRelPath: candidateRel,
            manifest: incoming,
            priorManifest: null,
            adoptExistingMaterializedPaths: ['compose.yaml'],
        })).rejects.toThrow(/does not manage/);
        expect(readStackFile(stackName, 'configs/app.json')).toBe('local user data\n');
        expect(readStackFile(stackName, 'compose.yaml')).toBe('legacy v1\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('adopts exactly the allowlisted legacy paths on a pre-manifest stack (audit round 9 B-1)', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-premanifest-adopt';
        writeStackFile(stackName, 'compose.yaml', 'legacy v1\n');
        writeStackFile(stackName, '.env', 'SYNC=1\n');

        const incoming = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml' }),
            {
                sourcePath: null,
                materializedPath: '.env',
                role: 'env',
                dependencyKind: 'sync-env',
                ownership: 'managed',
                provenance: 'fetch',
                sensitivity: 'high',
                contentSha256: 'a'.repeat(64),
                sizeBytes: 4,
                state: 'present',
                deletionAuthority: 'sencho',
                note: null,
            },
        ]);
        const clone = makeClone({ 'compose.yaml': 'v2\n', '.env': 'SYNC=2\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'sha-adopt',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }, { srcRel: '.env', destRel: '.env' }],
            [],
            BOUNDS,
        );

        await svc.promoteGeneration(stackName, {
            sha: 'sha-adopt',
            candidateRelPath: candidateRel,
            manifest: incoming,
            priorManifest: null,
            adoptExistingMaterializedPaths: ['compose.yaml', '.env'],
        });
        expect(readStackFile(stackName, 'compose.yaml')).toBe('v2\n');
        expect(readStackFile(stackName, '.env')).toBe('SYNC=2\n');
    });

    it('allows the synced stack-root .env to adopt an existing file when sync_env is enabled', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-sync-env-adoption';
        writeStackFile(stackName, 'compose.yaml', 'v1\n');
        writeStackFile(stackName, '.env', 'EXISTING=1\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = 'generations/applied-prior';
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'v1\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        const syncEnvEntry: ComposeInputEntry = {
            sourcePath: null,
            materializedPath: '.env',
            role: 'env',
            dependencyKind: 'sync-env',
            ownership: 'managed',
            provenance: 'fetch',
            sensitivity: 'high',
            contentSha256: 'a'.repeat(64),
            sizeBytes: 4,
            state: 'present',
            deletionAuthority: 'sencho',
            note: null,
        };
        const incoming = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml' }),
            syncEnvEntry,
        ], prior);
        const clone = makeClone({ 'compose.yaml': 'v2\n', '.env': 'NEW=1\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'sha-syncenv',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }, { srcRel: '.env', destRel: '.env' }],
            [],
            BOUNDS,
        );

        await svc.promoteGeneration(stackName, {
            sha: 'sha-syncenv',
            candidateRelPath: candidateRel,
            manifest: incoming,
            priorManifest: prior,
        });
        expect(readStackFile(stackName, '.env')).toBe('NEW=1\n');
    });
});

describe('sweepManagedArea (crash recovery)', () => {
    it('restores the previous applied generation when the marker matches the stack dir', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-restore';
        writeStackFile(stackName, 'compose.yaml', 'PRIOR\n');
        writeStackFile(stackName, 'app.env', 'A=1\n');
        const prior = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml' }),
            managedEntry({ materializedPath: 'app.env', dependencyKind: 'env_file', role: 'env', sensitivity: 'high' }),
        ]);
        const priorRel = `generations/applied-prior`;
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        fs.writeFileSync(path.join(priorAbs, 'app.env'), 'A=1\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        // Crash mid-promotion: candidate written, compose.yaml already swapped.
        const candidateRel = `generations/candidate-crash`;
        const candidateAbs = path.join(tmpDir, 'git-managed', '1', stackName, candidateRel);
        fs.mkdirSync(candidateAbs, { recursive: true });
        fs.writeFileSync(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER), 'crash');
        fs.writeFileSync(path.join(candidateAbs, 'compose.yaml'), 'NEW\n');
        writeStackFile(stackName, 'compose.yaml', 'NEW\n');
        writePromotionMarker(stackName, {
            sha: 'crash',
            manifestVersion: prior.manifestVersion + 1,
            candidateRelPath: candidateRel,
            appliedRelPath: 'generations/applied-crash-2',
            affected: ['app.env', 'compose.yaml'],
        });

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('PRIOR\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('declines to restore over a hand-repaired stack dir and flags migration_required', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-decline';
        DatabaseService.getInstance().upsertGitSource({
            stack_name: stackName,
            repo_url: REPO.repo_url,
            branch: REPO.branch,
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
        writeStackFile(stackName, 'compose.yaml', 'PRIOR\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = `generations/applied-prior`;
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        const candidateRel = `generations/candidate-crash2`;
        const candidateAbs = path.join(tmpDir, 'git-managed', '1', stackName, candidateRel);
        fs.mkdirSync(candidateAbs, { recursive: true });
        fs.writeFileSync(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER), 'crash2');
        fs.writeFileSync(path.join(candidateAbs, 'compose.yaml'), 'NEW\n');
        writeStackFile(stackName, 'compose.yaml', 'OPERATOR FIXED ME\n'); // hand-repaired
        writePromotionMarker(stackName, {
            sha: 'crash2',
            manifestVersion: prior.manifestVersion + 1,
            candidateRelPath: candidateRel,
            appliedRelPath: 'generations/applied-crash2-2',
            affected: ['compose.yaml'],
        });

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('OPERATOR FIXED ME\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
        const row = DatabaseService.getInstance().getGitSource(stackName);
        expect(row?.manifest_state).toBe('migration_required');
    });

    it('restores through the candidate-to-applied rename window', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-rename-window';
        writeStackFile(stackName, 'compose.yaml', 'PRIOR\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = 'generations/applied-prior';
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        const candidateRel = 'generations/candidate-rename';
        const appliedRel = 'generations/applied-rename-2';
        const appliedAbs = path.join(tmpDir, 'git-managed', '1', stackName, appliedRel);
        fs.mkdirSync(appliedAbs, { recursive: true });
        fs.writeFileSync(path.join(appliedAbs, CANDIDATE_COMPLETE_MARKER), 'rename');
        fs.writeFileSync(path.join(appliedAbs, 'compose.yaml'), 'NEW\n');
        writeStackFile(stackName, 'compose.yaml', 'NEW\n');
        writePromotionMarker(stackName, {
            sha: 'rename',
            manifestVersion: prior.manifestVersion + 1,
            candidateRelPath: candidateRel,
            appliedRelPath: appliedRel,
            affected: ['compose.yaml'],
        });

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('PRIOR\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('finalizes a committed manifest instead of rolling it back', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-post-manifest';
        seedGitSource(stackName);
        writeStackFile(stackName, 'compose.yaml', 'NEW\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        prior.generation.appliedDir = 'generations/applied-prior';
        const incoming = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })], prior);
        incoming.resolvedRevision.commitSha = 'committed';
        const appliedRel = `generations/applied-committed-${incoming.manifestVersion}`;
        const appliedAbs = path.join(tmpDir, 'git-managed', '1', stackName, appliedRel);
        fs.mkdirSync(appliedAbs, { recursive: true });
        fs.writeFileSync(path.join(appliedAbs, CANDIDATE_COMPLETE_MARKER), 'committed');
        fs.writeFileSync(path.join(appliedAbs, 'compose.yaml'), 'NEW\n');
        incoming.generation = {
            candidateDir: 'generations/candidate-committed',
            appliedDir: appliedRel,
            previousDir: prior.generation.appliedDir,
        };
        await svc.writeManifest(stackName, incoming);
        writePromotionMarker(stackName, {
            phase: 'committing',
            sha: 'committed',
            manifestVersion: incoming.manifestVersion,
            candidateRelPath: incoming.generation.candidateDir,
            appliedRelPath: appliedRel,
            affected: ['compose.yaml'],
        });

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('NEW\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
        const read = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        if (read === null || 'corrupt' in read) throw new Error('expected committed manifest');
        expect(read.manifestVersion).toBe(incoming.manifestVersion);
        const row = DatabaseService.getInstance().getGitSource(stackName);
        expect(row?.manifest_version).toBe(incoming.manifestVersion);
        expect(row?.manifest_state).toBe(incoming.state);
        expect(row?.manifest_generation).toBe(appliedRel);
    });

    it('rolls back a committing marker while the prior manifest is still authoritative', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-pre-manifest';
        seedGitSource(stackName);
        writeStackFile(stackName, 'compose.yaml', 'NEW\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = 'generations/applied-prior';
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        const appliedRel = `generations/applied-committing-${prior.manifestVersion + 1}`;
        const appliedAbs = path.join(tmpDir, 'git-managed', '1', stackName, appliedRel);
        fs.mkdirSync(appliedAbs, { recursive: true });
        fs.writeFileSync(path.join(appliedAbs, CANDIDATE_COMPLETE_MARKER), 'committing');
        fs.writeFileSync(path.join(appliedAbs, 'compose.yaml'), 'NEW\n');
        writePromotionMarker(stackName, {
            phase: 'committing',
            sha: 'committing',
            manifestVersion: prior.manifestVersion + 1,
            candidateRelPath: 'generations/candidate-committing',
            appliedRelPath: appliedRel,
            affected: ['compose.yaml'],
        });

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('PRIOR\n');
        const row = DatabaseService.getInstance().getGitSource(stackName);
        expect(row?.manifest_version).toBe(prior.manifestVersion);
        expect(row?.manifest_state).toBe(prior.state);
        expect(row?.manifest_generation).toBe(priorRel);
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('detects a hand edit in the former marker batch tail', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-batch-tail';
        seedGitSource(stackName);
        writeStackFile(stackName, 'compose.yaml', 'NEW\n');
        writeStackFile(stackName, 'app.env', 'OPERATOR\n');
        const prior = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml' }),
            managedEntry({ materializedPath: 'app.env', dependencyKind: 'env_file', role: 'env' }),
        ]);
        const priorRel = 'generations/applied-prior';
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        fs.writeFileSync(path.join(priorAbs, 'app.env'), 'A=1\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        const candidateRel = 'generations/candidate-tail';
        const candidateAbs = path.join(tmpDir, 'git-managed', '1', stackName, candidateRel);
        fs.mkdirSync(candidateAbs, { recursive: true });
        fs.writeFileSync(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER), 'tail');
        fs.writeFileSync(path.join(candidateAbs, 'compose.yaml'), 'NEW\n');
        fs.writeFileSync(path.join(candidateAbs, 'app.env'), 'A=2\n');
        writePromotionMarker(stackName, {
            sha: 'tail',
            manifestVersion: prior.manifestVersion + 1,
            candidateRelPath: candidateRel,
            appliedRelPath: 'generations/applied-tail-2',
            affected: ['app.env', 'compose.yaml'],
        });

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('NEW\n');
        expect(readStackFile(stackName, 'app.env')).toBe('OPERATOR\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
        expect(DatabaseService.getInstance().getGitSource(stackName)?.manifest_state).toBe('migration_required');
    });

    it('drops the managed area when the stack no longer exists', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-orphan';
        await svc.writeManifest(stackName, buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]));
        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: false });
        expect(await svc.readManifest(stackName, REPO.repo_url, REPO.branch)).toBeNull();
    });
});

describe('buildMigratedManifest', () => {
    it('builds a conservative single-file migrated manifest', async () => {
        const stackName = 'migrate-single';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');
        const svc = GitProjectManifestService.getInstance();
        const manifest = await svc.buildMigratedManifest(stackName, {
            ...REPO,
            sync_env: false,
            applied_deploy_spec: null,
        });
        expect(manifest.state).toBe('migrated');
        expect(manifest.inputs.some((i) => i.materializedPath === 'compose.yaml' && i.deletionAuthority === 'sencho')).toBe(true);
        await svc.writeManifest(stackName, manifest);
        const read = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        expect(read).not.toBeNull();
        expect(read && 'corrupt' in read).toBe(false);
    });

    it('grants sencho authority only for spec files and grants none to contextDir contents', async () => {
        const stackName = 'migrate-multi';
        writeStackFile(stackName, 'compose.yaml', 'base\n');
        writeStackFile(stackName, 'deploy/prod.yaml', 'prod\n');
        writeStackFile(stackName, 'deploy/settings.env', 'X=1\n');
        writeStackFile(stackName, '.env', 'A=1\n');
        const svc = GitProjectManifestService.getInstance();
        const manifest = await svc.buildMigratedManifest(stackName, {
            ...REPO,
            sync_env: true,
            applied_deploy_spec: { files: ['compose.yaml', 'deploy/prod.yaml'], contextDir: 'deploy' },
        });
        const byPath = (p: string) => manifest.inputs.find((i) => i.materializedPath === p);
        expect(byPath('compose.yaml')?.deletionAuthority).toBe('sencho');
        expect(byPath('deploy/prod.yaml')?.deletionAuthority).toBe('sencho');
        expect(byPath('.env')?.deletionAuthority).toBe('sencho');
        expect(byPath('.env')?.dependencyKind).toBe('sync-env');
        // The contextDir subtree is a single note entry with no deletion authority.
        const dirNote = manifest.inputs.find((i) => i.materializedPath === 'deploy' && i.role === 'build-context');
        expect(dirNote?.deletionAuthority).toBe('none');
        expect(manifest.generation.appliedDir).toContain('applied-migration');
        // Snapshot dir exists for crash recovery before the first fresh pull.
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, manifest.generation.appliedDir, 'compose.yaml'))).toBe(true);
    });
});

describe('exportForDetach', () => {
    it('returns the rendered yaml when valid', async () => {
        const svc = GitProjectManifestService.getInstance();
        const out = await svc.exportForDetach('detach-ok', async () => 'services:\n  web:\n    image: nginx\n');
        expect(out).toContain('image: nginx');
    });

    it('throws on empty render output', async () => {
        const svc = GitProjectManifestService.getInstance();
        await expect(svc.exportForDetach('detach-empty', async () => '')).rejects.toThrow(/empty/);
    });

    it('throws on invalid yaml render output', async () => {
        const svc = GitProjectManifestService.getInstance();
        await expect(svc.exportForDetach('detach-bad', async () => 'services: [unclosed\n')).rejects.toThrow(/parse/);
    });
});

describe('detach crash recovery', () => {
    it('restores the durable snapshot when the managed area was staged before a crash', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'detach-crash';
        const original = Buffer.from('services:\n  web:\n    image: nginx:old\n');
        writeStackFile(stackName, 'compose.yaml', original.toString('utf8'));
        await svc.writeManifest(stackName, buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]));
        await svc.prepareDetachRecovery(stackName, REPO.repo_url, REPO.branch, [{ path: 'compose.yaml', existed: true, content: original }]);
        writeStackFile(stackName, 'compose.yaml', 'services:\n  web:\n    image: nginx:new\n');
        expect(await svc.stageManagedAreaForDetach(stackName)).toBe(true);

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe(original.toString('utf8'));
        const restored = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        expect(restored).not.toBeNull();
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', `.detach-${stackName}`))).toBe(false);
    });

    it('round-trips snapshots larger than the former fixed entry limit', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'detach-many-files';
        stackDir(stackName);
        const snapshots = Array.from({ length: 17 }, (_, index) => ({
            path: `override-${index}.yaml`,
            existed: false as const,
            content: null,
        }));
        await svc.prepareDetachRecovery(stackName, REPO.repo_url, REPO.branch, snapshots);

        expect(await svc.recoverInterruptedDetach(stackName, REPO.repo_url, REPO.branch)).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName))).toBe(false);
    });

    it('rejects duplicate snapshot paths before writing a recovery marker', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'detach-duplicate';
        await expect(svc.prepareDetachRecovery(stackName, REPO.repo_url, REPO.branch, [
            { path: 'compose.yaml', existed: false, content: null },
            { path: 'compose.yaml', existed: false, content: null },
        ])).rejects.toThrow(/duplicate paths/);
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName))).toBe(false);
    });

    it('does not treat an unreadable staged detach as absent', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'detach-stage-io';
        const staged = path.join(tmpDir, 'git-managed', '1', `.detach-${stackName}`);
        const originalAccess = fs.promises.access.bind(fs.promises);
        const accessSpy = vi.spyOn(fs.promises, 'access').mockImplementation(async (...args: Parameters<typeof fs.promises.access>) => {
            if (path.resolve(String(args[0])) === path.resolve(staged)) {
                throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            }
            return originalAccess(...args);
        });
        try {
            await expect(svc.recoverInterruptedDetach(stackName, REPO.repo_url, REPO.branch)).rejects.toThrow(/permission denied/);
        } finally {
            accessSpy.mockRestore();
        }
    });

    it('reports when a staged detach has no recovery snapshot to restore', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'detach-missing-snapshot';
        await svc.writeManifest(stackName, buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]));
        expect(await svc.stageManagedAreaForDetach(stackName)).toBe(true);

        expect(await svc.rollbackStagedDetach(stackName, REPO.repo_url, REPO.branch)).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName))).toBe(true);
    });
});

describe('FileSystemService interaction', () => {
    it('promotion invalidates the stack file roots', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-invalidate';
        writeStackFile(stackName, 'compose.yaml', 'v1\n');
        const clone = makeClone({ 'compose.yaml': 'v2\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'invalidate',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }],
            [],
            BOUNDS,
        );
        const manifest = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        await svc.promoteGeneration(stackName, { sha: 'invalidate', candidateRelPath: candidateRel, manifest, priorManifest: null, adoptExistingMaterializedPaths: 'all' });
        expect(readStackFile(stackName, 'compose.yaml')).toBe('v2\n');
        expect(await FileSystemService.getInstance().getStackContent(stackName)).toBe('v2\n');
    });
});

describe('promoteGeneration mid-write failure recovery', () => {
    it('restores the previous generation and manifest when a write fails mid-promotion', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-midfail';
        writeStackFile(stackName, 'compose.yaml', 'PRIOR\n');
        writeStackFile(stackName, 'app.env', 'A=1\n');
        const prior = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml' }),
            managedEntry({ materializedPath: 'app.env', dependencyKind: 'env_file', role: 'env', sensitivity: 'high' }),
        ]);
        const priorRel = `generations/applied-prior`;
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        fs.writeFileSync(path.join(priorAbs, 'app.env'), 'A=1\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        // Force the failure at PROMOTION time (a rejected stack write after
        // the marker was written), not during candidate staging.
        const clone = makeClone({ 'compose.yaml': 'NEW\n', 'app.env': 'B=2\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'midfail',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }, { srcRel: 'app.env', destRel: 'app.env' }],
            [],
            BOUNDS,
        );
        const next = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml', contentSha256: 'x' }),
            managedEntry({ materializedPath: 'app.env', dependencyKind: 'env_file', role: 'env', sensitivity: 'high' }),
        ], prior);
        // Fail exactly the promotion's first write; the restore path's writes
        // must succeed for the recovery assertions below.
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockRejectedValueOnce(new Error('simulated disk failure'));
        try {
            await expect(
                svc.promoteGeneration(stackName, { sha: 'midfail', candidateRelPath: candidateRel, manifest: next, priorManifest: prior }),
            ).rejects.toThrow(/simulated disk failure/);
        } finally {
            saveSpy.mockRestore();
        }

        // The prior generation and the prior manifest FILE are both restored,
        // so a subsequent apply reads hashes that match the disk.
        expect(readStackFile(stackName, 'compose.yaml')).toBe('PRIOR\n');
        const restored = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        if (restored === null || 'corrupt' in restored) throw new Error('expected a manifest');
        expect(restored.manifestVersion).toBe(prior.manifestVersion);
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('restores files, manifest, and cache when the manifest commit write fails', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-commit-fail';
        seedGitSource(stackName);
        writeStackFile(stackName, 'compose.yaml', 'PRIOR\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = 'generations/applied-prior';
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);
        DatabaseService.getInstance().setGitSourceManifestState(stackName, prior.manifestVersion, prior.state, priorRel);

        const clone = makeClone({ 'compose.yaml': 'NEW\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'commit-fail',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }],
            [],
            BOUNDS,
        );
        const next = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })], prior);
        const manifestWriteSpy = vi.spyOn(svc, 'writeManifest').mockRejectedValueOnce(new Error('simulated manifest write failure'));
        try {
            await expect(svc.promoteGeneration(stackName, {
                sha: 'commit-fail',
                candidateRelPath: candidateRel,
                manifest: next,
                priorManifest: prior,
            })).rejects.toThrow(/simulated manifest write failure/);
        } finally {
            manifestWriteSpy.mockRestore();
        }

        expect(readStackFile(stackName, 'compose.yaml')).toBe('PRIOR\n');
        const restored = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        if (restored === null || 'corrupt' in restored) throw new Error('expected the prior manifest');
        expect(restored.manifestVersion).toBe(prior.manifestVersion);
        const row = DatabaseService.getInstance().getGitSource(stackName);
        expect(row?.manifest_version).toBe(prior.manifestVersion);
        expect(row?.manifest_state).toBe(prior.state);
        expect(row?.manifest_generation).toBe(priorRel);
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('cleans protected files after a failed first promotion', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-first-fail';
        seedGitSource(stackName);
        stackDir(stackName);
        const clone = makeClone({ 'compose.yaml': 'NEW\n', 'new.txt': 'NEW FILE\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'first-fail',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }, { srcRel: 'new.txt', destRel: 'new.txt' }],
            [],
            BOUNDS,
        );
        const manifest = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml' }),
            managedEntry({ materializedPath: 'new.txt', role: 'other', dependencyKind: 'config' }),
        ]);
        const writeSpy = vi.spyOn(FileSystemService.prototype, 'writeStackFile').mockRejectedValueOnce(new Error('simulated second write failure'));
        try {
            await expect(
                svc.promoteGeneration(stackName, { sha: 'first-fail', candidateRelPath: candidateRel, manifest, priorManifest: null, adoptExistingMaterializedPaths: 'all' }),
            ).rejects.toThrow(/simulated second write failure/);
        } finally {
            writeSpy.mockRestore();
        }

        expect(fs.existsSync(path.join(stackDir(stackName), 'compose.yaml'))).toBe(false);
        expect(fs.existsSync(path.join(stackDir(stackName), 'new.txt'))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
        expect(DatabaseService.getInstance().getGitSource(stackName)?.manifest_state).toBe('migration_required');
    });

    it('treats a corrupt promotion marker as recovery-required, not a clean slate', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-corrupt-marker';
        writeStackFile(stackName, 'compose.yaml', 'ANY\n');
        DatabaseService.getInstance().upsertGitSource({
            stack_name: stackName,
            repo_url: REPO.repo_url,
            branch: REPO.branch,
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
        fs.mkdirSync(path.join(tmpDir, 'git-managed', '1', stackName), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER), '{"v":3 torn', 'utf8');
        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
        expect(DatabaseService.getInstance().getGitSource(stackName)?.manifest_state).toBe('migration_required');
    });

    it('rejects a null candidate path without attempting snapshot recovery', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-null-candidate';
        writeStackFile(stackName, 'compose.yaml', 'ANY\n');
        fs.mkdirSync(path.join(tmpDir, 'git-managed', '1', stackName), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER), JSON.stringify({
            schemaVersion: 2,
            phase: 'applying',
            sha: 'abc123',
            manifestVersion: 1,
            candidateRelPath: null,
            appliedRelPath: 'generations/applied-abc123-1',
            affected: ['compose.yaml'],
            introduced: ['compose.yaml'],
        }), 'utf8');
        const stateSpy = vi.spyOn(DatabaseService.getInstance(), 'setGitSourceManifestState');
        try {
            await expect(svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true })).resolves.toBeUndefined();
            expect(stateSpy).toHaveBeenCalledWith(stackName, null, 'migration_required', null);
        } finally {
            stateSpy.mockRestore();
        }
    });

    it('retains a corrupt promotion marker when persisting recovery state fails', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-state-failure';
        writeStackFile(stackName, 'compose.yaml', 'ANY\n');
        const markerPath = path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER);
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(markerPath, '{"broken":', 'utf8');
        const stateSpy = vi.spyOn(DatabaseService.getInstance(), 'setGitSourceManifestState').mockImplementationOnce(() => {
            throw new Error('database unavailable');
        });
        try {
            await expect(svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true })).rejects.toThrow(/database unavailable/);
            expect(fs.existsSync(markerPath)).toBe(true);
        } finally {
            stateSpy.mockRestore();
        }
    });

    it('retains the promotion marker when a recovery snapshot cannot be inspected', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-snapshot-io';
        writeStackFile(stackName, 'compose.yaml', 'ANY\n');
        const markerPath = path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER);
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        writePromotionMarker(stackName, {
            sha: 'snapshot-io',
            manifestVersion: 1,
            candidateRelPath: 'generations/candidate-snapshot-io',
            appliedRelPath: 'generations/applied-snapshot-io-1',
            affected: ['compose.yaml'],
        });
        const originalAccess = fs.promises.access.bind(fs.promises);
        const accessSpy = vi.spyOn(fs.promises, 'access').mockImplementation(async (...args: Parameters<typeof fs.promises.access>) => {
            if (String(args[0]).endsWith(CANDIDATE_COMPLETE_MARKER)) {
                throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            }
            return originalAccess(...args);
        });
        try {
            await expect(svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true })).rejects.toThrow(/permission denied/);
            expect(fs.existsSync(markerPath)).toBe(true);
        } finally {
            accessSpy.mockRestore();
        }
    });

    it('does not treat an unreadable introduced path as absent during restore', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'restore-path-error';
        writeStackFile(stackName, 'new.txt', 'NEW\n');
        const pathKindSpy = vi.spyOn(FileSystemService.prototype, 'pathKind').mockRejectedValueOnce(new Error('permission denied'));
        const deleteSpy = vi.spyOn(FileSystemService.prototype, 'deleteStackPath');
        try {
            await expect(svc.restorePreviousGeneration(stackName, {
                priorManifest: null,
                incoming: { introducedPaths: ['new.txt'] },
            })).resolves.toBe(false);
            expect(deleteSpy).not.toHaveBeenCalled();
            expect(readStackFile(stackName, 'new.txt')).toBe('NEW\n');
        } finally {
            pathKindSpy.mockRestore();
            deleteSpy.mockRestore();
        }
    });
});

describe('byte-exact materialization (audit C-1)', () => {
    it('promotes binary files byte-identically and keeps the divergence guard silent', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-binary';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');
        // A real PNG header + arbitrary binary payload.
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xc0, 0x80, 0x00, 0x01, 0x02, 0xfe, 0xfd]);
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n    configs: [bin]\nconfigs:\n  bin:\n    file: blob.bin\n',
            'blob.bin': pngBytes.toString('latin1'),
        });
        // makeClone writes via fs.writeFileSync(utf8 default); reconstruct the exact bytes on disk.
        fs.writeFileSync(path.join(clone, 'blob.bin'), pngBytes);

        const inventory = await import('../services/ComposeInputDiscoveryService').then((m) =>
            m.ComposeInputDiscoveryService.getInstance().discoverFromClone({
                cloneDir: clone,
                composePaths: ['compose.yaml'],
                contextDir: null,
                bounds: BOUNDS,
            }),
        );
        const inputs = inventory.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null);
        const blobEntry = inputs.find((i) => i.materializedPath === 'blob.bin');
        expect(blobEntry?.contentSha256).toBeTruthy();

        const manifest = buildManifest(stackName, inputs);
        const candidateRel = await svc.buildCandidate(
            stackName,
            'bin-sha',
            clone,
            inputs.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })),
            inventory.contextCopyPlans,
            BOUNDS,
        );
        await svc.promoteGeneration(stackName, { sha: 'bin-sha', candidateRelPath: candidateRel, manifest, priorManifest: null, adoptExistingMaterializedPaths: 'all' });

        // The stack-dir file is byte-identical to the clone source.
        const onDisk = fs.readFileSync(path.join(stackDir(stackName), 'blob.bin'));
        expect(onDisk.equals(pngBytes)).toBe(true);
        // The divergence guard hashes the same bytes the manifest recorded.
        expect(await svc.hashStackFile(stackName, 'blob.bin')).toBe(blobEntry?.contentSha256);
    });
});

describe('partial manifest state', () => {
    it('builds a partial-state manifest when refusals exist and the summary surfaces them', () => {
        const svc = GitProjectManifestService.getInstance();
        const manifest = svc.buildManifest({
            stackName: 'partial-state',
            repoUrl: 'https://github.com/example/repo.git',
            branch: 'main',
            commitSha: 'abc',
            projectRoot: null,
            composeFiles: ['compose.yaml'],
            projectName: 'partial-state',
            invocation: ['-f', 'compose.yaml', '-p', 'partial-state'],
            inputs: [managedEntry({ materializedPath: 'compose.yaml' })],
            refusals: [{ sourcePath: 'x.yaml', kind: 'url-include', reason: 'x', actionable: false }],
            buildContexts: [],
            bounds: BOUNDS,
            priorManifest: null,
            state: 'partial',
        });
        expect(manifest.state).toBe('partial');
        expect(svc.summaryFrom(manifest).state).toBe('partial');
        // Tolerated (non-actionable) refusals reach the manifest; actionable
        // ones abort the pull before a manifest is built.
        expect(svc.summaryFrom(manifest).refused).toHaveLength(0);
    });
});

describe('exact-generation restore (audit round 2 C-1)', () => {
    it('removes files the failed promotion introduced', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'restore-exact';
        writeStackFile(stackName, 'compose.yaml', 'PRIOR\n');
        const prior = buildManifest(stackName, [managedEntry({ materializedPath: 'compose.yaml' })]);
        const priorRel = `generations/applied-prior`;
        const priorAbs = path.join(tmpDir, 'git-managed', '1', stackName, priorRel);
        fs.mkdirSync(priorAbs, { recursive: true });
        fs.writeFileSync(path.join(priorAbs, 'compose.yaml'), 'PRIOR\n');
        prior.generation.appliedDir = priorRel;
        await svc.writeManifest(stackName, prior);

        // The incoming revision introduces new.txt and updates compose.yaml.
        const clone = makeClone({ 'compose.yaml': 'NEW\n', 'new.txt': 'fresh\n' });
        const candidateRel = await svc.buildCandidate(
            stackName,
            'exact',
            clone,
            [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }, { srcRel: 'new.txt', destRel: 'new.txt' }],
            [],
            BOUNDS,
        );
        const next = buildManifest(stackName, [
            managedEntry({ materializedPath: 'compose.yaml', contentSha256: 'x' }),
            managedEntry({ materializedPath: 'new.txt', contentSha256: 'y' }),
        ], prior);
        const saveSpy = vi.spyOn(FileSystemService.prototype, 'saveStackContent').mockRejectedValueOnce(new Error('simulated disk failure'));
        try {
            await expect(
                svc.promoteGeneration(stackName, { sha: 'exact', candidateRelPath: candidateRel, manifest: next, priorManifest: prior }),
            ).rejects.toThrow(/simulated disk failure/);
        } finally {
            saveSpy.mockRestore();
        }

        // The prior generation is exact: compose.yaml restored, new.txt removed.
        expect(readStackFile(stackName, 'compose.yaml')).toBe('PRIOR\n');
        expect(fs.existsSync(path.join(stackDir(stackName), 'new.txt'))).toBe(false);
        const restored = await svc.readManifest(stackName, REPO.repo_url, REPO.branch);
        if (restored === null || 'corrupt' in restored) throw new Error('expected a manifest');
        expect(restored.manifestVersion).toBe(prior.manifestVersion);
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });
});

describe('build-context file-level ownership (audit round 2 C-2)', () => {
    it('removes context files deleted upstream and detects local edits', async () => {
        const svc = GitProjectManifestService.getInstance();
        const { ComposeInputDiscoveryService } = await import('../services/ComposeInputDiscoveryService');
        const discovery = ComposeInputDiscoveryService.getInstance();
        const stackName = 'context-reconcile';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');

        // Revision 1: context web with keep.txt + drop.txt.
        const clone1 = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n',
            'web/keep.txt': 'keep\n',
            'web/drop.txt': 'drop\n',
        });
        const inv1 = await discovery.discoverFromClone({ cloneDir: clone1, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        const managed1 = inv1.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null);
        const manifest1 = buildManifest(stackName, managed1, null, inv1.buildContexts);
        const fileList1 = managed1.filter((i) => i.dependencyKind !== 'build-context');
        const cand1 = await svc.buildCandidate(stackName, 'rev1', clone1, fileList1.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })), inv1.contextCopyPlans, BOUNDS);
        await svc.promoteGeneration(stackName, { sha: 'rev1', candidateRelPath: cand1, manifest: manifest1, priorManifest: null, adoptExistingMaterializedPaths: 'all' });
        expect(fs.existsSync(path.join(stackDir(stackName), 'web', 'drop.txt'))).toBe(true);

        // Revision 2: drop.txt removed upstream.
        const clone2 = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n',
            'web/keep.txt': 'keep\n',
        });
        const inv2 = await discovery.discoverFromClone({ cloneDir: clone2, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        const managed2 = inv2.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null);
        const manifest2 = buildManifest(stackName, managed2, manifest1, inv2.buildContexts);
        const fileList2 = managed2.filter((i) => i.dependencyKind !== 'build-context');
        const cand2 = await svc.buildCandidate(stackName, 'rev2', clone2, fileList2.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })), inv2.contextCopyPlans, BOUNDS);
        await svc.promoteGeneration(stackName, { sha: 'rev2', candidateRelPath: cand2, manifest: manifest2, priorManifest: manifest1 });
        expect(fs.existsSync(path.join(stackDir(stackName), 'web', 'drop.txt'))).toBe(false);
        expect(fs.existsSync(path.join(stackDir(stackName), 'web', 'keep.txt'))).toBe(true);

        // A local edit inside the context is divergence on the next apply path.
        const diverged = await svc.verifyContextOnDisk(stackName, manifest2.buildContexts[0]);
        expect(diverged).toEqual([]);
        fs.writeFileSync(path.join(stackDir(stackName), 'web', 'keep.txt'), 'locally edited\n');
        const divergedAfter = await svc.verifyContextOnDisk(stackName, manifest2.buildContexts[0]);
        expect(divergedAfter.some((p) => p.includes('keep.txt'))).toBe(true);
    });

    it('preserves an unowned file when a non-root context is removed', async () => {
        const svc = GitProjectManifestService.getInstance();
        const { ComposeInputDiscoveryService } = await import('../services/ComposeInputDiscoveryService');
        const discovery = ComposeInputDiscoveryService.getInstance();
        const stackName = 'context-removed-unowned';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');
        const clone1 = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n',
            'web/keep.txt': 'keep\n',
        });
        const inv1 = await discovery.discoverFromClone({ cloneDir: clone1, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        const managed1 = inv1.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null);
        const manifest1 = buildManifest(stackName, managed1, null, inv1.buildContexts);
        const fileList1 = managed1.filter((i) => i.dependencyKind !== 'build-context');
        const cand1 = await svc.buildCandidate(stackName, 'rev1', clone1, fileList1.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })), inv1.contextCopyPlans, BOUNDS);
        await svc.promoteGeneration(stackName, { sha: 'rev1', candidateRelPath: cand1, manifest: manifest1, priorManifest: null, adoptExistingMaterializedPaths: 'all' });
        fs.writeFileSync(path.join(stackDir(stackName), 'web', 'notes.txt'), 'local\n');

        const clone2 = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n',
        });
        const inv2 = await discovery.discoverFromClone({ cloneDir: clone2, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        const managed2 = inv2.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null);
        const manifest2 = buildManifest(stackName, managed2, manifest1, inv2.buildContexts);
        const fileList2 = managed2.filter((i) => i.dependencyKind !== 'build-context');
        const cand2 = await svc.buildCandidate(stackName, 'rev2', clone2, fileList2.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })), inv2.contextCopyPlans, BOUNDS);
        await svc.promoteGeneration(stackName, { sha: 'rev2', candidateRelPath: cand2, manifest: manifest2, priorManifest: manifest1 });
        expect(fs.existsSync(path.join(stackDir(stackName), 'web', 'keep.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(stackDir(stackName), 'web', 'notes.txt'), 'utf8')).toBe('local\n');
    });

    it('removes a clean non-root context directory after owned files are gone', async () => {
        const svc = GitProjectManifestService.getInstance();
        const { ComposeInputDiscoveryService } = await import('../services/ComposeInputDiscoveryService');
        const discovery = ComposeInputDiscoveryService.getInstance();
        const stackName = 'context-removed-clean';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');
        const clone1 = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n',
            'web/keep.txt': 'keep\n',
        });
        const inv1 = await discovery.discoverFromClone({ cloneDir: clone1, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        const managed1 = inv1.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null);
        const manifest1 = buildManifest(stackName, managed1, null, inv1.buildContexts);
        const fileList1 = managed1.filter((i) => i.dependencyKind !== 'build-context');
        const cand1 = await svc.buildCandidate(stackName, 'rev1', clone1, fileList1.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })), inv1.contextCopyPlans, BOUNDS);
        await svc.promoteGeneration(stackName, { sha: 'rev1', candidateRelPath: cand1, manifest: manifest1, priorManifest: null, adoptExistingMaterializedPaths: 'all' });

        const clone2 = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n',
        });
        const inv2 = await discovery.discoverFromClone({ cloneDir: clone2, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        const managed2 = inv2.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null);
        const manifest2 = buildManifest(stackName, managed2, manifest1, inv2.buildContexts);
        const fileList2 = managed2.filter((i) => i.dependencyKind !== 'build-context');
        const cand2 = await svc.buildCandidate(stackName, 'rev2', clone2, fileList2.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })), inv2.contextCopyPlans, BOUNDS);
        await svc.promoteGeneration(stackName, { sha: 'rev2', candidateRelPath: cand2, manifest: manifest2, priorManifest: manifest1 });
        expect(fs.existsSync(path.join(stackDir(stackName), 'web'))).toBe(false);
    });

    it('removes root-context managed files individually and leaves unowned stack files', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'context-root-removed';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');
        writeStackFile(stackName, 'Dockerfile', 'FROM alpine\n');
        writeStackFile(stackName, 'local-notes.txt', 'keep\n');
        const composeEntry = {
            sourcePath: 'compose.yaml',
            materializedPath: 'compose.yaml',
            role: 'compose-primary' as const,
            dependencyKind: 'explicit' as const,
            ownership: 'managed' as const,
            provenance: 'fetch' as const,
            sensitivity: 'medium' as const,
            contentSha256: crypto.createHash('sha256').update('services: {}\n').digest('hex'),
            sizeBytes: 12,
            state: 'present' as const,
            deletionAuthority: 'sencho' as const,
            note: null,
        };
        const priorCtx = {
            repoPath: '',
            dockerfile: 'Dockerfile',
            contextBytes: 12,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'Dockerfile', sha256: crypto.createHash('sha256').update('FROM alpine\n').digest('hex'), sizeBytes: 12 }],
        };
        const prior = buildManifest(stackName, [composeEntry], null, [priorCtx]);
        const clone = makeClone({ 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
        const nextCompose = {
            ...composeEntry,
            contentSha256: crypto.createHash('sha256').update('services:\n  web:\n    image: nginx\n').digest('hex'),
            sizeBytes: Buffer.byteLength('services:\n  web:\n    image: nginx\n'),
        };
        const next = buildManifest(stackName, [nextCompose], prior, []);
        const cand = await svc.buildCandidate(stackName, 'root-rm', clone, [{ srcRel: 'compose.yaml', destRel: 'compose.yaml' }], [], BOUNDS);
        await svc.promoteGeneration(stackName, { sha: 'root-rm', candidateRelPath: cand, manifest: next, priorManifest: prior });
        expect(fs.existsSync(path.join(stackDir(stackName), 'Dockerfile'))).toBe(false);
        expect(fs.readFileSync(path.join(stackDir(stackName), 'local-notes.txt'), 'utf8')).toBe('keep\n');
        expect(fs.existsSync(path.join(stackDir(stackName), 'compose.yaml'))).toBe(true);
    });

    it('fails closed when live context scanning exceeds the file bound', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'context-scan-bound';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');
        writeStackFile(stackName, 'web/a.txt', 'a\n');
        writeStackFile(stackName, 'web/b.txt', 'b\n');
        writeStackFile(stackName, 'web/c.txt', 'c\n');
        const ctx = {
            repoPath: 'web',
            dockerfile: null,
            contextBytes: 0,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'a.txt', sha256: 'x', sizeBytes: 1 }],
        };
        const diverged = await svc.verifyContextOnDisk(stackName, ctx, undefined, { ...BOUNDS, maxFiles: 1 });
        expect(diverged.some((p) => p.includes('scan limit exceeded'))).toBe(true);
    });

    it('fails closed when live context scanning exceeds the path-depth bound', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'context-scan-depth';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');
        writeStackFile(stackName, 'web/a/b/c.txt', 'deep\n');
        const ctx = {
            repoPath: 'web',
            dockerfile: null,
            contextBytes: 0,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'a/b/c.txt', sha256: 'x', sizeBytes: 1 }],
        };
        const diverged = await svc.verifyContextOnDisk(stackName, ctx, undefined, { ...BOUNDS, maxPathDepth: 1 });
        expect(diverged.some((p) => p.includes('scan limit exceeded'))).toBe(true);
    });

    it('fails closed when a live context file exceeds maxFileBytes before hashing', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'context-scan-file-bytes';
        writeStackFile(stackName, 'compose.yaml', 'services: {}\n');
        writeStackFile(stackName, 'web/big.txt', 'abcdefghij\n');
        const ctx = {
            repoPath: 'web',
            dockerfile: null,
            contextBytes: 0,
            ignoredCount: 0,
            dockerignoreApplied: false,
            excludedFromCopy: false,
            note: null,
            files: [{ path: 'big.txt', sha256: 'x', sizeBytes: 1 }],
        };
        const hashSpy = vi.spyOn(svc, 'hashStackFile');
        try {
            const diverged = await svc.verifyContextOnDisk(stackName, ctx, undefined, { ...BOUNDS, maxFileBytes: 4 });
            expect(diverged.some((p) => p.includes('scan limit exceeded'))).toBe(true);
            expect(hashSpy).not.toHaveBeenCalled();
        } finally {
            hashSpy.mockRestore();
        }
    });
});
