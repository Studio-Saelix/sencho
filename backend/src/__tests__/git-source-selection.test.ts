/**
 * Unit tests for the compose-selection parser used by the git-source routes.
 *
 * parseComposeSelection normalizes a request body into an ordered compose-path
 * list plus an optional context dir, enforcing the file-count cap, duplicate
 * rejection, the reserved-primary-name rule, and context-dir validation. Pure
 * function, no DB or filesystem.
 */
import { describe, it, expect } from 'vitest';
import { parseComposeSelection, defaultEnvPath, MAX_COMPOSE_FILES } from '../helpers/gitSourceSelection';

/** Narrow the result union to its ok branch (throws if the parse failed). */
function expectOk(result: ReturnType<typeof parseComposeSelection>) {
    if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
    return result.value;
}

describe('parseComposeSelection', () => {
    it('maps a legacy single compose_path string to a one-element array', () => {
        const value = expectOk(parseComposeSelection({ compose_path: 'stacks/web/compose.yaml' }));
        expect(value.composePaths).toEqual(['stacks/web/compose.yaml']);
        expect(value.contextDir).toBeNull();
    });

    it('accepts an ordered compose_paths array', () => {
        const value = expectOk(parseComposeSelection({ compose_paths: ['infra/base.yml', 'infra/prod.yml'] }));
        expect(value.composePaths).toEqual(['infra/base.yml', 'infra/prod.yml']);
    });

    it('prefers compose_paths over a legacy compose_path when both are present', () => {
        const value = expectOk(parseComposeSelection({
            compose_paths: ['a.yml', 'b.yml'],
            compose_path: 'ignored.yml',
        }));
        expect(value.composePaths).toEqual(['a.yml', 'b.yml']);
    });

    it('rejects an empty selection', () => {
        expect(parseComposeSelection({ compose_paths: [] }).ok).toBe(false);
        expect(parseComposeSelection({}).ok).toBe(false);
    });

    it('rejects more than the file-count cap', () => {
        const tooMany = Array.from({ length: MAX_COMPOSE_FILES + 1 }, (_, i) => `f${i}.yml`);
        const result = parseComposeSelection({ compose_paths: tooMany });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/exceed/i);
    });

    it('accepts exactly the file-count cap', () => {
        const exact = Array.from({ length: MAX_COMPOSE_FILES }, (_, i) => `f${i}.yml`);
        expect(parseComposeSelection({ compose_paths: exact }).ok).toBe(true);
    });

    it('rejects duplicate compose paths', () => {
        const result = parseComposeSelection({ compose_paths: ['compose.yaml', 'infra/prod.yml', 'infra/prod.yml'] });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/duplicate/i);
    });

    it('rejects a non-first entry named compose.yaml (reserved for the primary)', () => {
        const result = parseComposeSelection({ compose_paths: ['infra/base.yml', 'compose.yaml'] });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/compose\.yaml/i);
    });

    it('rejects a non-first entry that normalizes to compose.yaml via "./"', () => {
        const result = parseComposeSelection({ compose_paths: ['infra/base.yml', './compose.yaml'] });
        expect(result.ok).toBe(false);
    });

    it('rejects an additional file nested under the primary compose.yaml', () => {
        // 'compose.yaml/prod.yml' would try to write under the root compose.yaml file.
        const result = parseComposeSelection({ compose_paths: ['infra/base.yml', 'compose.yaml/prod.yml'] });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/collides/i);
    });

    it('rejects two selected files where one is a directory ancestor of another', () => {
        const result = parseComposeSelection({ compose_paths: ['base.yml', 'sub.yml', 'sub.yml/deep.yml'] });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/collides/i);
    });

    it('allows compose.yaml as the primary (index 0)', () => {
        const value = expectOk(parseComposeSelection({ compose_paths: ['compose.yaml', 'infra/prod.yml'] }));
        expect(value.composePaths).toEqual(['compose.yaml', 'infra/prod.yml']);
    });

    it('rejects a path that escapes the repo with traversal', () => {
        expect(parseComposeSelection({ compose_paths: ['../escape.yml'] }).ok).toBe(false);
        expect(parseComposeSelection({ compose_path: '/etc/passwd' }).ok).toBe(false);
    });

    it('rejects a path targeting the .git directory', () => {
        expect(parseComposeSelection({ compose_paths: ['.git/config'] }).ok).toBe(false);
    });

    it('accepts a valid multi-file selection with a context_dir', () => {
        const value = expectOk(parseComposeSelection({
            compose_paths: ['infra/base.yml', 'infra/prod.yml'],
            context_dir: 'app',
        }));
        expect(value.contextDir).toBe('app');
    });

    it('normalizes an empty context_dir to null', () => {
        expect(expectOk(parseComposeSelection({ compose_paths: ['compose.yaml'], context_dir: '' })).contextDir).toBeNull();
        expect(expectOk(parseComposeSelection({ compose_paths: ['compose.yaml'], context_dir: '   ' })).contextDir).toBeNull();
    });

    it('rejects a context_dir with traversal', () => {
        const result = parseComposeSelection({ compose_paths: ['compose.yaml'], context_dir: '../escape' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/context_dir/i);
    });

    it('rejects a context_dir that targets the .git directory', () => {
        const result = parseComposeSelection({ compose_paths: ['compose.yaml'], context_dir: '.git' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/\.git/i);
    });

    it('rejects a context_dir equal to compose.yaml', () => {
        const result = parseComposeSelection({ compose_paths: ['compose.yaml'], context_dir: 'compose.yaml' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/context_dir/i);
    });

    it('rejects a context_dir equal to a selected additional compose path', () => {
        const result = parseComposeSelection({
            compose_paths: ['compose.yaml', 'infra/prod.yml'],
            context_dir: 'infra/prod.yml',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/context_dir/i);
    });

    it('rejects a context_dir nested under the primary compose.yaml', () => {
        const result = parseComposeSelection({ compose_paths: ['infra/base.yml'], context_dir: 'compose.yaml/app' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/context_dir/i);
    });

    it('rejects a context_dir nested under a selected additional compose file', () => {
        const result = parseComposeSelection({
            compose_paths: ['compose.yaml', 'infra/prod.yml'],
            context_dir: 'infra/prod.yml/sub',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/context_dir/i);
    });
});

describe('defaultEnvPath', () => {
    it('returns the explicit env path when provided', () => {
        expect(defaultEnvPath('infra/base.yml', 'custom/.env')).toBe('custom/.env');
    });

    it('defaults to a sibling .env of the primary compose file', () => {
        expect(defaultEnvPath('infra/base.yml', undefined)).toBe('infra/.env');
        expect(defaultEnvPath('infra/base.yml', '')).toBe('infra/.env');
    });

    it('defaults to .env at the repo root when the primary is at the root', () => {
        expect(defaultEnvPath('compose.yaml', undefined)).toBe('.env');
    });
});
