/**
 * Unit tests for gitSourceLocalComposeFiles: the mapping from ordered repo
 * compose paths to the local relative filenames Sencho materializes under the
 * stack directory.
 *
 * Contract:
 *   - index 0 (primary) always maps to compose.yaml at the stack root
 *   - every additional file keeps its repo-relative path, with a leading "./" stripped
 */
import { describe, it, expect } from 'vitest';
import { gitSourceLocalComposeFiles, PRIMARY_COMPOSE_FILENAME } from '../utils/gitComposeFiles';

describe('gitSourceLocalComposeFiles', () => {
    it('maps the primary file to compose.yaml regardless of its repo name', () => {
        expect(gitSourceLocalComposeFiles(['infra/base.yml'])).toEqual([PRIMARY_COMPOSE_FILENAME]);
        expect(gitSourceLocalComposeFiles(['deploy/docker-compose.prod.yaml'])).toEqual(['compose.yaml']);
    });

    it('keeps additional files at their repo-relative paths', () => {
        expect(gitSourceLocalComposeFiles(['infra/base.yml', 'infra/prod.yml']))
            .toEqual(['compose.yaml', 'infra/prod.yml']);
    });

    it('strips a leading "./" only from additional files', () => {
        expect(gitSourceLocalComposeFiles(['./base.yml', './override/prod.yml']))
            .toEqual(['compose.yaml', 'override/prod.yml']);
    });

    it('preserves order across a larger set', () => {
        expect(gitSourceLocalComposeFiles(['a/base.yml', 'b/x.yml', 'c/y.yml', 'd/z.yml']))
            .toEqual(['compose.yaml', 'b/x.yml', 'c/y.yml', 'd/z.yml']);
    });

    it('returns just compose.yaml for a single-file selection', () => {
        expect(gitSourceLocalComposeFiles(['compose.yaml'])).toEqual(['compose.yaml']);
    });
});
