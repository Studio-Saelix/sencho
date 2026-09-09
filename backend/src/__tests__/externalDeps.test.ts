import { afterEach, describe, expect, it } from 'vitest';
import { requireGitBinary, requireSshd } from './__helpers__/externalDeps';

describe('external dependency probes', () => {
    const originalCi = process.env.CI;

    afterEach(() => {
        if (originalCi === undefined) delete process.env.CI;
        else process.env.CI = originalCi;
    });

    describe('requireGitBinary', () => {
        it('returns true when git is present, locally or in CI', () => {
            delete process.env.CI;
            expect(requireGitBinary(() => true)).toBe(true);
            process.env.CI = '1';
            expect(requireGitBinary(() => true)).toBe(true);
        });

        it('returns false when git is absent locally', () => {
            delete process.env.CI;
            expect(requireGitBinary(() => false)).toBe(false);
        });

        it('throws when git is absent under CI', () => {
            process.env.CI = '1';
            expect(() => requireGitBinary(() => false)).toThrow(/git is required in CI/);
        });
    });

    describe('requireSshd', () => {
        it('returns true when sshd is present, locally or in CI', () => {
            delete process.env.CI;
            expect(requireSshd(() => true)).toBe(true);
            process.env.CI = '1';
            expect(requireSshd(() => true)).toBe(true);
        });

        it('returns false when sshd is absent locally', () => {
            delete process.env.CI;
            expect(requireSshd(() => false)).toBe(false);
        });

        it('throws when sshd is absent under CI', () => {
            process.env.CI = '1';
            expect(() => requireSshd(() => false)).toThrow(/sshd is required in CI/);
        });
    });
});
