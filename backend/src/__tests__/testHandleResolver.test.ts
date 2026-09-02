import { describe, expect, it } from 'vitest';
import { resolveTestHandle } from './__helpers__/testHandleResolver';

const FILE = 'fixture.test.ts';

describe('resolveTestHandle', () => {
    it('resolves a plain it() declaration', () => {
        const src = `it('does the thing', () => { expect(1).toBe(1); });`;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: true });
    });

    it('resolves a plain test() declaration', () => {
        const src = `test('does the thing', () => {});`;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: true });
    });

    it('fails when the title is not present', () => {
        const src = `it('does something else', () => {});`;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'not-found' });
    });

    it('fails on a duplicate title with two runnable declarations', () => {
        const src = `
            it('does the thing', () => {});
            it('does the thing', () => {});
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'duplicate' });
    });

    it('fails when the test itself is .skip', () => {
        const src = `it.skip('does the thing', () => {});`;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'skipped-directly' });
    });

    it('fails when the test itself is .todo', () => {
        const src = `it.todo('does the thing');`;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'skipped-directly' });
    });

    it('fails when the test itself is .failing', () => {
        const src = `it.failing('does the thing', () => {});`;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'skipped-directly' });
    });

    it('fails when the test itself is .skipIf', () => {
        const src = `it.skipIf(true)('does the thing', () => {});`;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'skipped-directly' });
    });

    it('fails under an unconditionally skipped describe', () => {
        const src = `
            describe.skip('suite', () => {
                it('does the thing', () => {});
            });
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'unapproved-ancestor-skip' });
    });

    it('fails under a describe.runIf, approved-looking predicate or not', () => {
        const src = `
            describe.runIf(requireGitBinary())('suite', () => {
                it('does the thing', () => {});
            });
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'unapproved-ancestor-skip' });
    });

    it('fails under a describe.skipIf with an arbitrary, unapproved predicate', () => {
        const src = `
            describe.skipIf(!someLocalCheck())('suite', () => {
                it('does the thing', () => {});
            });
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'unapproved-ancestor-skip' });
    });

    it('passes under a describe.skipIf that calls the approved requireGitBinary helper', () => {
        const src = `
            describe.skipIf(!requireGitBinary())('suite', () => {
                it('does the thing', () => {});
            });
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: true });
    });

    it('passes under a describe.skipIf that calls the approved requireSshd helper alongside other checks', () => {
        const src = `
            describe.skipIf(!requireGitBinary() || !requireSshd())('suite', () => {
                it('does the thing', () => {});
            });
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: true });
    });

    it('fails when an approved outer describe.skipIf wraps an unapproved inner describe.skip', () => {
        const src = `
            describe.skipIf(!requireGitBinary())('outer', () => {
                describe.skip('inner', () => {
                    it('does the thing', () => {});
                });
            });
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'unapproved-ancestor-skip' });
    });

    it('resolves a title nested two levels inside approved describe.skipIf blocks', () => {
        const src = `
            describe.skipIf(!requireGitBinary())('outer', () => {
                describe('inner (no modifier)', () => {
                    it('does the thing', () => {});
                });
            });
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: true });
    });

    it('does not resolve a title only present in a comment', () => {
        const src = `
            // it('does the thing', () => {});
            it('does another thing', () => {});
        `;
        expect(resolveTestHandle(FILE, src, 'does the thing')).toEqual({ ok: false, reason: 'not-found' });
    });
});
