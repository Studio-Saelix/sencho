import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { GitProjectManifestService, PROMOTION_MARKER, CANDIDATE_COMPLETE_MARKER } from '../services/GitProjectManifestService';
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

function buildManifest(stackName: string, inputs: ComposeInputEntry[], prior: GitProjectManifest | null = null): GitProjectManifest {
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
        buildContexts: [],
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
        await svc.promoteGeneration(stackName, { sha: 'abc123', candidateRelPath: candidateRel, manifest, priorManifest: null });

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
    });

    it('refuses to promote a candidate without the completion marker', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'promote-incomplete';
        writeStackFile(stackName, 'compose.yaml', 'old\n');
        const clone = makeClone({ 'compose.yaml': 'new\n' });
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
        const marker = { sha: 'crash', candidateRelPath: candidateRel, written: ['compose.yaml'] };
        fs.writeFileSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER), JSON.stringify(marker), 'utf8');

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('PRIOR\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
    });

    it('declines to restore over a hand-repaired stack dir and flags migration_required', async () => {
        const svc = GitProjectManifestService.getInstance();
        const stackName = 'sweep-decline';
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
        const marker = { sha: 'crash2', candidateRelPath: candidateRel, written: ['compose.yaml'] };
        fs.writeFileSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER), JSON.stringify(marker), 'utf8');

        await svc.sweepManagedArea(stackName, { repoUrl: REPO.repo_url, branch: REPO.branch, stackExists: true });

        expect(readStackFile(stackName, 'compose.yaml')).toBe('OPERATOR FIXED ME\n');
        expect(fs.existsSync(path.join(tmpDir, 'git-managed', '1', stackName, PROMOTION_MARKER))).toBe(false);
        const row = DatabaseService.getInstance().getGitSource(stackName);

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
        await svc.promoteGeneration(stackName, { sha: 'invalidate', candidateRelPath: candidateRel, manifest, priorManifest: null });
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
});
