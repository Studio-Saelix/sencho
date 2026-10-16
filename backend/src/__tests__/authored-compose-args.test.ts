/**
 * Unit tests for authoredComposeFileArgs: the docker compose global-flag prefix
 * (`-f` per file, `-p <project>`, optional `--project-directory`) derived from a
 * stack's applied deploy spec.
 *
 * Contract:
 *   - no applied spec (single-file / non-git) -> [] so runtime stays plain auto-discovery
 *   - a multi-file applied spec -> ordered -f flags, then -p <stack>, then
 *     --project-directory <abs> when a context dir is set
 *   - any spec file path or context dir that is absolute / contains ".." throws
 *     before any args are returned (it is spliced straight into child-process argv)
 */
import { execFileSync } from 'child_process';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let authoredComposeFileArgs: typeof import('../utils/authoredComposeArgs').authoredComposeFileArgs;
let authoredComposeEnvFileArgs: typeof import('../utils/authoredComposeArgs').authoredComposeEnvFileArgs;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ authoredComposeFileArgs, authoredComposeEnvFileArgs } = await import('../utils/authoredComposeArgs'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    const db = DatabaseService.getInstance();
    for (const s of db.getGitSources()) db.deleteGitSource(s.stack_name);
});

/** Seed a git-source row (no applied spec yet) so setGitSourceAppliedSpec can target it. */
function seedSource(stackName: string, composePaths: string[]): void {
    DatabaseService.getInstance().upsertGitSource({
        stack_name: stackName,
        repo_url: 'https://github.com/example/repo.git',
        branch: 'main',
        compose_path: composePaths[0],
        compose_paths: composePaths,
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

describe('authoredComposeFileArgs', () => {
    it('returns [] for a stack with no git source at all', () => {
        expect(authoredComposeFileArgs('no-such-stack')).toEqual([]);
    });

    it('returns [] for a git-source stack with no applied spec (single-file)', () => {
        seedSource('single-stack', ['compose.yaml']);
        // No setGitSourceAppliedSpec call -> applied_deploy_spec stays null.
        expect(authoredComposeFileArgs('single-stack')).toEqual([]);
    });

    it('returns ordered -f / -p / --project-directory for a multi-file spec', () => {
        const stackName = 'multi-stack';
        seedSource(stackName, ['infra/base.yml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', 'infra/prod.yml'],
            contextDir: 'app',
        });

        const args = authoredComposeFileArgs(stackName);

        const baseDir = NodeRegistry.getInstance().getComposeDir(NodeRegistry.getInstance().getDefaultNodeId());
        const expectedCtx = path.resolve(baseDir, stackName, 'app');
        expect(args).toEqual([
            '-f', 'compose.yaml',
            '-f', 'infra/prod.yml',
            '-p', stackName,
            '--project-directory', expectedCtx,
        ]);
    });

    it('omits --project-directory when the spec has no context dir', () => {
        const stackName = 'multi-no-ctx';
        seedSource(stackName, ['infra/base.yml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', 'infra/prod.yml'],
            contextDir: null,
        });

        expect(authoredComposeFileArgs(stackName)).toEqual([
            '-f', 'compose.yaml',
            '-f', 'infra/prod.yml',
            '-p', stackName,
        ]);
    });

    it('throws when a spec file path is absolute', () => {
        const stackName = 'abs-file';
        seedSource(stackName, ['compose.yaml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', '/etc/passwd'],
            contextDir: null,
        });
        expect(() => authoredComposeFileArgs(stackName)).toThrow();
    });

    it('throws when a spec file path contains a ".." traversal', () => {
        const stackName = 'dotdot-file';
        seedSource(stackName, ['compose.yaml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', '../escape.yml'],
            contextDir: null,
        });
        expect(() => authoredComposeFileArgs(stackName)).toThrow();
    });

    it('throws when the context dir contains a ".." traversal', () => {
        const stackName = 'dotdot-ctx';
        seedSource(stackName, ['compose.yaml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', 'infra/prod.yml'],
            contextDir: '../escape',
        });
        expect(() => authoredComposeFileArgs(stackName)).toThrow();
    });
});

/**
 * authoredComposeEnvFileArgs: the `--env-file <stackDir>/.env` flag a multi-file
 * Git deploy needs when a context dir is set. With `--project-directory <ctx>`,
 * Compose treats the context dir as the project directory and stops auto-finding
 * the root `.env` Sencho writes, so validation (which passes --env-file) and
 * deploy would otherwise resolve different env. Single-file / no-context stacks
 * keep Compose's default `.env` discovery from the stack dir, so they get no flag.
 */
describe('authoredComposeEnvFileArgs', () => {
    /** Create the on-disk stack directory and optionally a root .env for it. */
    function makeStackDir(stackName: string, withEnv: boolean): string {
        const baseDir = NodeRegistry.getInstance().getComposeDir(NodeRegistry.getInstance().getDefaultNodeId());
        const stackDir = path.join(baseDir, stackName);
        fs.mkdirSync(stackDir, { recursive: true });
        if (withEnv) fs.writeFileSync(path.join(stackDir, '.env'), 'TAG=1\n', 'utf-8');
        else fs.rmSync(path.join(stackDir, '.env'), { force: true });
        return stackDir;
    }

    it('returns [] for a stack with no git source at all', async () => {
        expect(await authoredComposeEnvFileArgs('no-such-stack')).toEqual([]);
    });

    it('returns [] when the context dir is set but no .env exists', async () => {
        const stackName = 'ctx-no-env';
        seedSource(stackName, ['compose.yaml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', 'infra/prod.yml'],
            contextDir: 'app',
        });
        makeStackDir(stackName, false);
        expect(await authoredComposeEnvFileArgs(stackName)).toEqual([]);
    });

    it('returns [] when a .env exists but the spec has no context dir', async () => {
        // No --project-directory, so the project dir stays the stack dir (cwd) and
        // Compose auto-discovers the root .env; an explicit flag is not needed.
        const stackName = 'env-no-ctx';
        seedSource(stackName, ['compose.yaml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', 'infra/prod.yml'],
            contextDir: null,
        });
        makeStackDir(stackName, true);
        expect(await authoredComposeEnvFileArgs(stackName)).toEqual([]);
    });

    it('returns --env-file <stackDir>/.env when a context dir is set and a .env exists', async () => {
        const stackName = 'ctx-with-env';
        seedSource(stackName, ['compose.yaml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', 'infra/prod.yml'],
            contextDir: 'app',
        });
        const stackDir = makeStackDir(stackName, true);
        expect(await authoredComposeEnvFileArgs(stackName)).toEqual([
            '--env-file', path.join(stackDir, '.env'),
        ]);
    });

    it('returns [] for a stack name that escapes the compose base (path-injection guard)', async () => {
        // The inline barrier rejects a traversal name before the fs access, so no
        // --env-file is emitted for a path outside the compose base.
        const stackName = '../escape';
        seedSource(stackName, ['infra/base.yml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', 'infra/prod.yml'],
            contextDir: 'app',
        });
        expect(await authoredComposeEnvFileArgs(stackName)).toEqual([]);
    });

    it('rethrows a non-ENOENT access error instead of silently dropping the env file', async () => {
        // An EACCES on an existing .env must surface, not be treated as "no env
        // file": dropping --env-file there would deploy a different effective config
        // than the one validated.
        const stackName = 'ctx-eacces';
        seedSource(stackName, ['compose.yaml', 'infra/prod.yml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml', 'infra/prod.yml'],
            contextDir: 'app',
        });
        const spy = vi.spyOn(fs.promises, 'access').mockRejectedValueOnce(
            Object.assign(new Error('permission denied'), { code: 'EACCES' }),
        );
        await expect(authoredComposeEnvFileArgs(stackName)).rejects.toThrow(/permission denied/);
        spy.mockRestore();
    });

    it('reads a configured .env from a decrypt overlay and rejects an arbitrary override', async () => {
        const stackName = 'env-overlay-root';
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const liveDir = makeStackDir(stackName, true);
        fs.writeFileSync(path.join(liveDir, '.env'), 'TOKEN=stale-live\n');
        DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['.env']);
        const { gitSecretsAreaBase } = await import('../services/gitops/managedPaths');
        const overlay = path.join(gitSecretsAreaBase(), String(nodeId), stackName, 'op-overlay');
        fs.mkdirSync(overlay, { recursive: true });
        fs.writeFileSync(path.join(overlay, '.env'), 'TOKEN=from-overlay\n');
        const args = await authoredComposeEnvFileArgs(stackName, nodeId, overlay);
        expect(args).toEqual(['--env-file', await fs.promises.realpath(path.join(overlay, '.env'))]);
        expect(args[1]).not.toBe(await fs.promises.realpath(path.join(liveDir, '.env')));

        const evil = path.join(tmpDir, 'evil-env-root');
        fs.mkdirSync(evil, { recursive: true });
        fs.writeFileSync(path.join(evil, '.env'), 'TOKEN=evil\n');
        await expect(authoredComposeEnvFileArgs(stackName, nodeId, evil)).rejects.toThrow(/escapes/);
    });

    it('rejects an implicit .env override outside the live stack and decrypt areas', async () => {
        const stackName = 'ctx-implicit-evil';
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        seedSource(stackName, ['compose.yaml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml'],
            contextDir: 'context',
        });
        const liveDir = makeStackDir(stackName, true);
        const evil = path.join(tmpDir, 'evil-implicit-env');
        fs.mkdirSync(path.join(evil, 'context'), { recursive: true });
        fs.writeFileSync(path.join(evil, '.env'), 'TOKEN=evil\n');
        await expect(authoredComposeEnvFileArgs(stackName, nodeId, evil)).rejects.toThrow(/escapes/);
        expect(fs.readFileSync(path.join(liveDir, '.env'), 'utf8')).toBe('TAG=1\n');
    });

    it('returns [] when an authorized overlay has no root .env', async () => {
        const stackName = 'ctx-overlay-no-env';
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        seedSource(stackName, ['compose.yaml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml'],
            contextDir: 'context',
        });
        makeStackDir(stackName, false);
        const { gitSecretsAreaBase } = await import('../services/gitops/managedPaths');
        const overlay = path.join(gitSecretsAreaBase(), String(nodeId), stackName, 'op-empty');
        fs.mkdirSync(overlay, { recursive: true });
        try {
            expect(await authoredComposeEnvFileArgs(stackName, nodeId, overlay)).toEqual([]);
        } finally {
            fs.rmSync(overlay, { recursive: true, force: true });
        }
    });

    it('rejects an overlay .env symlink that resolves outside the decrypt area', async () => {
        const stackName = 'ctx-implicit-symlink';
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        seedSource(stackName, ['compose.yaml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml'],
            contextDir: 'context',
        });
        makeStackDir(stackName, false);
        const { gitSecretsAreaBase } = await import('../services/gitops/managedPaths');
        const overlay = path.join(gitSecretsAreaBase(), String(nodeId), stackName, 'op-link');
        fs.mkdirSync(overlay, { recursive: true });
        const outsideEnv = path.join(tmpDir, 'outside-implicit-env');
        fs.writeFileSync(outsideEnv, 'TOKEN=escaped-secret\n');
        fs.symlinkSync(outsideEnv, path.join(overlay, '.env'));
        try {
            await expect(authoredComposeEnvFileArgs(stackName, nodeId, overlay)).rejects.toThrow(/resolves outside/);
        } finally {
            fs.rmSync(overlay, { recursive: true, force: true });
        }
        expect(fs.readFileSync(outsideEnv, 'utf8')).toBe('TOKEN=escaped-secret\n');
    });

    it('accepts an implicit .env when the data directory itself is a symlink', async () => {
        const stackName = 'ctx-implicit-relocated';
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        seedSource(stackName, ['compose.yaml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml'],
            contextDir: 'context',
        });
        const realData = fs.mkdtempSync(path.join(tmpDir, 'real-data-'));
        const linkData = path.join(tmpDir, 'linked-data-dir');
        fs.symlinkSync(realData, linkData);
        const previous = process.env.DATA_DIR;
        process.env.DATA_DIR = linkData;
        try {
            const { gitSecretsAreaBase } = await import('../services/gitops/managedPaths');
            const overlay = path.join(gitSecretsAreaBase(), String(nodeId), stackName, 'op-relocated');
            fs.mkdirSync(overlay, { recursive: true });
            fs.writeFileSync(path.join(overlay, '.env'), 'TOKEN=relocated\n');
            const args = await authoredComposeEnvFileArgs(stackName, nodeId, overlay);
            expect(args).toEqual(['--env-file', await fs.promises.realpath(path.join(overlay, '.env'))]);
            expect(args[1].startsWith(await fs.promises.realpath(realData) + path.sep)).toBe(true);
        } finally {
            process.env.DATA_DIR = previous;
            fs.rmSync(linkData, { force: true });
            fs.rmSync(realData, { recursive: true, force: true });
        }
    });

    it('passes the overlay root .env for a context directory when no project env files are configured', async () => {
        const stackName = 'ctx-overlay-implicit-env';
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        seedSource(stackName, ['compose.yaml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml'],
            contextDir: 'context',
        });
        const liveDir = makeStackDir(stackName, false);
        const age = await import('age-encryption');
        const identity = await age.generateIdentity();
        const recipient = await age.identityToRecipient(identity);
        const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
        const ciphertext = await buildSopsAgeDotenvDocument({
            values: { PORT: '8080', TOKEN: 'audit-plain-token' },
            identity,
            recipient,
        });
        fs.writeFileSync(path.join(liveDir, '.env'), ciphertext);
        const { gitSecretsAreaBase, managedAreaBase } = await import('../services/gitops/managedPaths');
        const overlay = path.join(gitSecretsAreaBase(), String(nodeId), stackName, 'op-ctx');
        const managed = path.join(managedAreaBase(), String(nodeId), stackName, 'candidate-ctx');
        fs.mkdirSync(path.join(overlay, 'context'), { recursive: true });
        fs.mkdirSync(path.join(managed, 'context'), { recursive: true });
        const compose = [
            'services:',
            '  web:',
            '    image: nginx:1.27-alpine',
            '    environment:',
            '      TOKEN: ${TOKEN}',
            '    ports:',
            '      - "${PORT}:80"',
            '',
        ].join('\n');
        const plaintext = 'PORT=8080\nTOKEN=audit-plain-token\n';
        fs.writeFileSync(path.join(overlay, 'compose.yaml'), compose);
        fs.writeFileSync(path.join(overlay, '.env'), plaintext);
        fs.writeFileSync(path.join(managed, 'compose.yaml'), compose);
        fs.writeFileSync(path.join(managed, '.env'), plaintext);
        try {
            const fileArgs = authoredComposeFileArgs(stackName, nodeId, overlay);
            const deployEnv = await authoredComposeEnvFileArgs(stackName, nodeId, overlay);
            const managedEnv = await authoredComposeEnvFileArgs(stackName, nodeId, managed);
            const { candidateValidationEnvFileArgs } = await import('../utils/authoredComposeArgs');
            const validationEnv = await candidateValidationEnvFileArgs({
                stackName,
                nodeId,
                candidateAbs: overlay,
                contextDir: 'context',
                syncEnv: true,
            });
            const overlayEnvReal = await fs.promises.realpath(path.join(overlay, '.env'));
            const managedEnvReal = await fs.promises.realpath(path.join(managed, '.env'));
            expect(deployEnv).toEqual(['--env-file', overlayEnvReal]);
            expect(managedEnv).toEqual(['--env-file', managedEnvReal]);
            expect(await fs.promises.realpath(validationEnv[1])).toBe(overlayEnvReal);
            expect(fileArgs).toContain(path.resolve(overlay, 'context'));
            expect(overlayEnvReal).not.toBe(path.join(liveDir, '.env'));

            const deployModel = composeEffectiveModel(overlay, [...fileArgs, ...deployEnv]);
            const validationModel = composeEffectiveModel(overlay, [...fileArgs, ...validationEnv]);
            expect(deployModel).toEqual({ token: 'audit-plain-token', published: '8080' });
            expect(validationModel).toEqual(deployModel);

            const liveAfter = fs.readFileSync(path.join(liveDir, '.env'), 'utf8');
            expect(liveAfter).toBe(ciphertext);
            expect(liveAfter).toContain('ENC[AES256_GCM');
            expect(liveAfter).not.toContain('audit-plain-token');
        } finally {
            fs.rmSync(overlay, { recursive: true, force: true });
            fs.rmSync(managed, { recursive: true, force: true });
            expect(fs.existsSync(overlay)).toBe(false);
            expect(fs.existsSync(managed)).toBe(false);
        }
    });

    /**
     * An authorized git-secrets/git-managed area can sit inside the compose
     * root when DATA_DIR is nested beneath COMPOSE_DIR. Deployment must
     * recognize the area override there exactly as candidate validation does,
     * or a source that validates cannot deploy.
     */
    describe('authorized area inside the compose root', () => {
        const compose = [
            'services:',
            '  web:',
            '    image: nginx:1.27-alpine',
            '    ports:',
            '      - "${PORT}:80"',
            '    environment:',
            '      TOKEN: ${TOKEN}',
            '',
        ].join('\n');

        it.each([
            { area: 'git-secrets' as const, nested: false, label: 'sibling data root' },
            { area: 'git-secrets' as const, nested: true, label: 'data root nested under COMPOSE_DIR' },
            { area: 'git-managed' as const, nested: false, label: 'sibling data root' },
            { area: 'git-managed' as const, nested: true, label: 'data root nested under COMPOSE_DIR' },
        ])('$area override: $label', async ({ area, nested }) => {
            const stackName = `ctx-area-${area}-${nested ? 'nested' : 'sibling'}`;
            const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
            seedSource(stackName, ['compose.yaml']);
            DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
                files: ['compose.yaml'],
                contextDir: 'context',
            });
            const liveDir = makeStackDir(stackName, false);
            const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
            const dataDir = nested ? path.join(composeDir, '.sencho-data') : path.join(tmpDir, 'sibling-data');
            fs.mkdirSync(dataDir, { recursive: true });
            const previousDataDir = process.env.DATA_DIR;
            process.env.DATA_DIR = dataDir;
            try {
                const { gitSecretsAreaBase, managedAreaBase } = await import('../services/gitops/managedPaths');
                const areaRoot = area === 'git-secrets' ? gitSecretsAreaBase() : managedAreaBase();
                const areaStack = path.join(areaRoot, String(nodeId), stackName, 'area-ctx');
                fs.mkdirSync(path.join(areaStack, 'context'), { recursive: true });
                const areaEnv = path.join(areaStack, '.env');
                fs.writeFileSync(areaEnv, 'TOKEN=from-area\nPORT=8080\n');
                fs.writeFileSync(path.join(areaStack, 'compose.yaml'), compose);

                const { candidateValidationEnvFileArgs } = await import('../utils/authoredComposeArgs');
                const fileArgs = authoredComposeFileArgs(stackName, nodeId, areaStack);
                const deployEnv = await authoredComposeEnvFileArgs(stackName, nodeId, areaStack);
                const validationEnv = await candidateValidationEnvFileArgs({
                    stackName,
                    nodeId,
                    candidateAbs: areaStack,
                    contextDir: 'context',
                    syncEnv: true,
                });
                const areaEnvReal = await fs.promises.realpath(areaEnv);
                expect(deployEnv).toEqual(['--env-file', areaEnvReal]);
                expect(validationEnv).toEqual(deployEnv);
                expect(deployEnv.join(' ')).not.toContain(path.join(liveDir, '.env'));

                const deployModel = composeEffectiveModel(areaStack, [...fileArgs, ...deployEnv]);
                const validationModel = composeEffectiveModel(areaStack, [...fileArgs, ...validationEnv]);
                expect(deployModel).toEqual({ token: 'from-area', published: '8080' });
                expect(validationModel).toEqual(deployModel);
            } finally {
                process.env.DATA_DIR = previousDataDir;
            }
        });
    });

    /**
     * A relocated data directory (a symlinked DATA_DIR) must not be mistaken
     * for an escaping path when project env files are configured: the candidate
     * and decrypt-overlay copies are selected by their physical location, while
     * links that leave the authorized tree stay rejected. A symlinked compose
     * root behaves the same way for the live copy.
     */
    describe('configured project env files under relocated roots', () => {
        it('selects the candidate and overlay copy and still rejects escaping links', async () => {
            const stackName = 'env-configured-relocated';
            const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
            const liveDir = makeStackDir(stackName, true);
            fs.writeFileSync(path.join(liveDir, '.env'), 'TOKEN=live\n');
            DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['.env']);
            const realData = fs.mkdtempSync(path.join(tmpDir, 'real-configured-data-'));
            const linkData = path.join(tmpDir, 'linked-configured-data');
            fs.symlinkSync(realData, linkData);
            const previousDataDir = process.env.DATA_DIR;
            process.env.DATA_DIR = linkData;
            try {
                const { gitSecretsAreaBase, managedAreaBase } = await import('../services/gitops/managedPaths');
                const overlay = path.join(gitSecretsAreaBase(), String(nodeId), stackName, 'op-relocated');
                const candidate = path.join(managedAreaBase(), String(nodeId), stackName, 'candidate-relocated');
                fs.mkdirSync(overlay, { recursive: true });
                fs.mkdirSync(candidate, { recursive: true });
                fs.writeFileSync(path.join(overlay, '.env'), 'TOKEN=overlay-relocated\n');
                fs.writeFileSync(path.join(candidate, '.env'), 'TOKEN=candidate-relocated\n');
                const overlayEnvReal = await fs.promises.realpath(path.join(overlay, '.env'));
                const candidateEnvReal = await fs.promises.realpath(path.join(candidate, '.env'));

                const { candidateValidationEnvFileArgs } = await import('../utils/authoredComposeArgs');
                expect(await authoredComposeEnvFileArgs(stackName, nodeId, overlay)).toEqual([
                    '--env-file', overlayEnvReal,
                ]);
                const validation = await candidateValidationEnvFileArgs({
                    stackName,
                    nodeId,
                    candidateAbs: candidate,
                    contextDir: null,
                    syncEnv: true,
                });
                expect(validation).toEqual(['--env-file', candidateEnvReal]);
                expect(await authoredComposeEnvFileArgs(stackName, nodeId)).toEqual([
                    '--env-file', path.join(liveDir, '.env'),
                ]);

                // A link inside the area but outside this stack's own tree is
                // still refused: the file must resolve to where its name claims.
                const otherStackDir = path.join(gitSecretsAreaBase(), String(nodeId), 'env-configured-other');
                fs.mkdirSync(otherStackDir, { recursive: true });
                fs.writeFileSync(path.join(otherStackDir, '.env'), 'TOKEN=other-stack\n');
                fs.rmSync(path.join(overlay, '.env'));
                fs.symlinkSync(path.join(otherStackDir, '.env'), path.join(overlay, '.env'));
                await expect(authoredComposeEnvFileArgs(stackName, nodeId, overlay)).rejects.toThrow(/resolves outside/);

                const outside = path.join(tmpDir, 'outside-relocated-env');
                fs.writeFileSync(outside, 'TOKEN=escaped\n');
                fs.rmSync(path.join(overlay, '.env'));
                fs.symlinkSync(outside, path.join(overlay, '.env'));
                await expect(authoredComposeEnvFileArgs(stackName, nodeId, overlay)).rejects.toThrow(/resolves outside/);
                expect(fs.readFileSync(outside, 'utf8')).toBe('TOKEN=escaped\n');
            } finally {
                process.env.DATA_DIR = previousDataDir;
                fs.rmSync(linkData, { force: true });
                fs.rmSync(realData, { recursive: true, force: true });
            }
        });

        it('selects the live .env under a symlinked compose root and still rejects an escaping link', async () => {
            const stackName = 'env-configured-compose-link';
            const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
            const db = DatabaseService.getInstance();
            const realCompose = fs.mkdtempSync(path.join(tmpDir, 'real-compose-'));
            const linkCompose = path.join(tmpDir, 'linked-compose-dir');
            fs.symlinkSync(realCompose, linkCompose);
            const previousComposeDir = db.getNode(nodeId)?.compose_dir ?? null;
            db.updateNode(nodeId, { compose_dir: linkCompose });
            try {
                const liveDir = path.join(linkCompose, stackName);
                fs.mkdirSync(liveDir, { recursive: true });
                fs.writeFileSync(path.join(liveDir, '.env'), 'TOKEN=live-linked-compose\n');
                db.setStackProjectEnvFiles(nodeId, stackName, ['.env']);

                const liveEnvReal = await fs.promises.realpath(path.join(liveDir, '.env'));
                expect(await authoredComposeEnvFileArgs(stackName, nodeId)).toEqual([
                    '--env-file', liveEnvReal,
                ]);

                const outside = path.join(tmpDir, 'outside-compose-link-env');
                fs.writeFileSync(outside, 'TOKEN=escaped\n');
                fs.rmSync(path.join(liveDir, '.env'));
                fs.symlinkSync(outside, path.join(liveDir, '.env'));
                await expect(authoredComposeEnvFileArgs(stackName, nodeId)).rejects.toThrow(/resolves outside/);
                expect(fs.readFileSync(outside, 'utf8')).toBe('TOKEN=escaped\n');
            } finally {
                db.setStackProjectEnvFiles(nodeId, stackName, []);
                if (previousComposeDir) db.updateNode(nodeId, { compose_dir: previousComposeDir });
                fs.rmSync(linkCompose, { force: true });
                fs.rmSync(realCompose, { recursive: true, force: true });
            }
        });
    });
});

function composeEffectiveModel(cwd: string, args: string[]): { token: string; published: string } {
    const stdout = execFileSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
        cwd,
        encoding: 'utf8',
        timeout: 20_000,
    });
    const parsed = JSON.parse(stdout) as {
        services?: Record<string, {
            environment?: Record<string, string>;
            ports?: Array<{ published?: string | number }>;
        }>;
    };
    const web = parsed.services?.web;
    if (!web) throw new Error(`compose config has no web service: ${stdout}`);
    const published = web.ports?.[0]?.published;
    return {
        token: web.environment?.TOKEN ?? '',
        published: published == null ? '' : String(published),
    };
}

describe('candidateValidationEnvFileArgs', () => {
    let candidateValidationEnvFileArgs: typeof import('../utils/authoredComposeArgs').candidateValidationEnvFileArgs;

    beforeAll(async () => {
        ({ candidateValidationEnvFileArgs } = await import('../utils/authoredComposeArgs'));
    });

    function makeStackDir(stackName: string, withEnv: boolean): string {
        const baseDir = NodeRegistry.getInstance().getComposeDir(NodeRegistry.getInstance().getDefaultNodeId());
        const stackDir = path.join(baseDir, stackName);
        fs.mkdirSync(stackDir, { recursive: true });
        if (withEnv) fs.writeFileSync(path.join(stackDir, '.env'), 'TAG=live\n', 'utf-8');
        else fs.rmSync(path.join(stackDir, '.env'), { force: true });
        return stackDir;
    }

    it('uses candidate .env for context-dir sync-env, not the live stack .env', async () => {
        const stackName = 'val-sync-env';
        seedSource(stackName, ['compose.yaml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml'],
            contextDir: 'app',
        });
        const liveDir = makeStackDir(stackName, true);
        const candidateAbs = path.join(tmpDir, 'candidate-sync-env');
        fs.mkdirSync(candidateAbs, { recursive: true });
        fs.writeFileSync(path.join(candidateAbs, '.env'), 'TAG=candidate\n', 'utf-8');
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const args = await candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: 'app',
            syncEnv: true,
        });
        expect(args).toEqual(['--env-file', await fs.promises.realpath(path.join(candidateAbs, '.env'))]);
        expect(args).not.toContain(path.resolve(liveDir, '.env'));
    });

    it('rejects a candidate .env symlink that leaves the candidate', async () => {
        const stackName = 'val-env-symlink';
        seedSource(stackName, ['compose.yaml']);
        const candidateAbs = path.join(tmpDir, 'candidate-env-link');
        fs.mkdirSync(candidateAbs, { recursive: true });
        const outside = path.join(tmpDir, 'outside-candidate-env');
        fs.writeFileSync(outside, 'TOKEN=escaped\n');
        fs.symlinkSync(outside, path.join(candidateAbs, '.env'));
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        await expect(candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: 'app',
            syncEnv: true,
        })).rejects.toThrow(/resolves outside/);
        expect(fs.readFileSync(outside, 'utf8')).toBe('TOKEN=escaped\n');
    });

    it('does not fall back to a live .env when sync-env omits the candidate file', async () => {
        const stackName = 'val-sync-env-removed';
        seedSource(stackName, ['compose.yaml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml'],
            contextDir: 'app',
        });
        const liveDir = makeStackDir(stackName, true);
        const candidateAbs = path.join(tmpDir, 'candidate-sync-env-removed');
        fs.mkdirSync(candidateAbs, { recursive: true });
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const args = await candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: 'app',
            syncEnv: true,
        });
        expect(args).toEqual([]);
        expect(args).not.toContain(path.resolve(liveDir, '.env'));
        const deploy = await authoredComposeEnvFileArgs(stackName, nodeId);
        expect(deploy).toEqual(['--env-file', path.resolve(liveDir, '.env')]);
    });

    it('falls back to the live .env when an unmanaged candidate file is absent', async () => {
        const stackName = 'val-unmanaged-env-fallback';
        seedSource(stackName, ['compose.yaml']);
        DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
            files: ['compose.yaml'],
            contextDir: 'app',
        });
        const liveDir = makeStackDir(stackName, true);
        const candidateAbs = path.join(tmpDir, 'candidate-unmanaged-env');
        fs.mkdirSync(candidateAbs, { recursive: true });
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const args = await candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: 'app',
            syncEnv: false,
        });
        expect(args).toEqual(['--env-file', path.resolve(liveDir, '.env')]);
    });

    it('uses only configured project env files even when candidate .env exists', async () => {
        const stackName = 'val-project-env';
        seedSource(stackName, ['compose.yaml']);
        const liveDir = makeStackDir(stackName, true);
        fs.writeFileSync(path.join(liveDir, 'prod.env'), 'FOO=1\n', 'utf-8');
        DatabaseService.getInstance().setStackProjectEnvFiles(
            NodeRegistry.getInstance().getDefaultNodeId(),
            stackName,
            ['prod.env'],
        );
        const candidateAbs = path.join(tmpDir, 'candidate-project-env');
        fs.mkdirSync(candidateAbs, { recursive: true });
        fs.writeFileSync(path.join(candidateAbs, '.env'), 'TAG=candidate\n', 'utf-8');
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const validation = await candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: 'app',
            syncEnv: true,
        });
        const deploy = await authoredComposeEnvFileArgs(stackName, nodeId);
        expect(validation).toEqual(deploy);
        expect(validation).toEqual(['--env-file', path.resolve(liveDir, 'prod.env')]);
        expect(validation.join(' ')).not.toContain(path.join(candidateAbs, '.env'));
    });

    it('throws when a configured project env file is missing', async () => {
        const stackName = 'val-missing-env';
        seedSource(stackName, ['compose.yaml']);
        makeStackDir(stackName, false);
        DatabaseService.getInstance().setStackProjectEnvFiles(
            NodeRegistry.getInstance().getDefaultNodeId(),
            stackName,
            ['missing.env'],
        );
        const candidateAbs = path.join(tmpDir, 'candidate-missing-env');
        fs.mkdirSync(candidateAbs, { recursive: true });
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        await expect(candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: null,
            syncEnv: false,
        })).rejects.toThrow(/missing/);
    });

    it('uses the candidate copy of a configured .env when the live file is missing or stale', async () => {
        const stackName = 'val-configured-env';
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const liveDir = makeStackDir(stackName, false);
        DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['.env']);
        const candidateAbs = path.join(tmpDir, 'candidate-configured-env');
        fs.mkdirSync(candidateAbs, { recursive: true });
        fs.writeFileSync(path.join(candidateAbs, '.env'), 'PORT=8080\n');
        const absent = await candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: null,
            syncEnv: true,
        });
        expect(absent).toEqual(['--env-file', await fs.promises.realpath(path.join(candidateAbs, '.env'))]);

        fs.writeFileSync(path.join(liveDir, '.env'), 'PORT=stale-live-sentinel\n');
        const stale = await candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: null,
            syncEnv: true,
        });
        expect(stale).toEqual(absent);
        expect(stale.join(' ')).not.toContain(path.join(liveDir, '.env'));
    });

    it('keeps a configured file the candidate does not carry on the live stack', async () => {
        const stackName = 'val-configured-mixed';
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const liveDir = makeStackDir(stackName, false);
        fs.writeFileSync(path.join(liveDir, 'prod.env'), 'FOO=live\n');
        DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['.env', 'prod.env']);
        const candidateAbs = path.join(tmpDir, 'candidate-configured-mixed');
        fs.mkdirSync(candidateAbs, { recursive: true });
        fs.writeFileSync(path.join(candidateAbs, '.env'), 'PORT=8080\n');
        const args = await candidateValidationEnvFileArgs({
            stackName,
            nodeId,
            candidateAbs,
            contextDir: 'app',
            syncEnv: true,
        });
        expect(args).toEqual([
            '--env-file', await fs.promises.realpath(path.join(candidateAbs, '.env')),
            '--env-file', await fs.promises.realpath(path.join(liveDir, 'prod.env')),
        ]);
    });
});
