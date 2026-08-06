import { describe, it, expect } from 'vitest';
import { compileDockerIgnore } from '../utils/dockerIgnoreMatch';

function matches(lines: string[], path: string, isDir = false): boolean {
    return compileDockerIgnore(lines).matches(path, isDir);
}

describe('compileDockerIgnore', () => {
    it('ignores empty lines and comment lines', () => {
        const m = compileDockerIgnore(['', '   ', '# comment', '*']);
        expect(m.matches('anything.txt')).toBe(true);
    });

    it('star matches everything including dotfiles', () => {
        expect(matches(['*'], 'compose.yaml')).toBe(true);
        expect(matches(['*'], '.env')).toBe(true);
        expect(matches(['*'], 'a/b/c.txt')).toBe(true);
    });

    it('slash-less patterns match basenames at any depth', () => {
        expect(matches(['*.md'], 'README.md')).toBe(true);
        expect(matches(['*.md'], 'docs/README.md')).toBe(true);
        expect(matches(['*.md'], 'docs/nested/README.md')).toBe(true);
        expect(matches(['*.md'], 'notes.txt')).toBe(false);
        expect(matches(['foo'], 'foo')).toBe(true);
        expect(matches(['foo'], 'a/foo')).toBe(true);
        expect(matches(['foo'], 'foobar')).toBe(false);
    });

    it('slash-bearing patterns are anchored to the context root', () => {
        expect(matches(['/foo'], 'foo')).toBe(true);
        expect(matches(['/foo'], 'sub/foo')).toBe(false);
        expect(matches(['a/b'], 'a/b')).toBe(true);
        expect(matches(['a/b'], 'x/a/b')).toBe(false);
    });

    it('trailing slash restricts to directories', () => {
        expect(matches(['build/'], 'build', true)).toBe(true);
        expect(matches(['build/'], 'build')).toBe(false);
        expect(matches(['build/'], 'sub/build', true)).toBe(true);
        expect(matches(['build/'], 'build/output.txt')).toBe(false);
    });

    it('double-star crosses directories', () => {
        expect(matches(['**/logs'], 'logs')).toBe(true);
        expect(matches(['**/logs'], 'a/logs')).toBe(true);
        expect(matches(['**/logs'], 'a/b/logs')).toBe(true);
        expect(matches(['**/logs'], 'a/b/log.txt')).toBe(false);
        expect(matches(['a/**/z'], 'a/z')).toBe(true);
        expect(matches(['a/**/z'], 'a/b/c/z')).toBe(true);
    });

    it('single star does not cross directory boundaries', () => {
        expect(matches(['a/*.log'], 'a/x.log')).toBe(true);
        expect(matches(['a/*.log'], 'a/b/x.log')).toBe(false);
    });

    it('question mark matches exactly one character', () => {
        expect(matches(['temp?'], 'temp1')).toBe(true);
        expect(matches(['temp?'], 'temp10')).toBe(false);
    });

    it('character classes match within a segment', () => {
        expect(matches(['[ab].txt'], 'a.txt')).toBe(true);
        expect(matches(['[ab].txt'], 'b.txt')).toBe(true);
        expect(matches(['[ab].txt'], 'c.txt')).toBe(false);
    });

    it('last matching pattern wins, negation re-includes at any depth', () => {
        expect(matches(['*.md', '!README.md'], 'README.md')).toBe(false);
        expect(matches(['*.md', '!README.md'], 'docs/README.md')).toBe(false);
        expect(matches(['!README.md', '*.md'], 'README.md')).toBe(true);
        expect(matches(['*', '!keep'], 'keep')).toBe(false);
        expect(matches(['*', '!keep'], 'other')).toBe(true);
    });

    it('escaped hash starts a literal pattern, bare hash is a comment', () => {
        expect(matches(['\\#file'], '#file')).toBe(true);
        expect(matches(['\\#file'], 'other')).toBe(false);
        expect(matches(['#file'], '#file')).toBe(false);
    });

    it('bare negation is a no-op', () => {
        expect(matches(['!'], 'anything')).toBe(false);
    });

    it('directory matches prune via the caller: dir check on the dir path', () => {
        // The matcher reports a matched directory as ignored (isDir is only
        // consulted for dir-only patterns); the CALLER prunes the subtree, so
        // children are never queried individually.
        expect(matches(['node_modules'], 'node_modules', true)).toBe(true);
        expect(matches(['node_modules'], 'node_modules')).toBe(true);
        // A file that merely lives under a matched directory is not itself
        // matched by the basename pattern; the caller's prune handles it.
        expect(matches(['node_modules'], 'pkg/index.js')).toBe(false);
    });
});
