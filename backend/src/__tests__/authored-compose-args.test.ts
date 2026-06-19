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
});
