import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService } from '../services/CryptoService';
import {
    classifySnapshotFileContent,
    isEnvelopeLikeDamage,
    isStructurallyValidSnapshotEnvelope,
} from '../helpers/snapshotFileDecrypt';

describe('snapshotFileDecrypt classification', () => {
    const encrypt = (plain: string) => CryptoService.getInstance().encrypt(plain);

    it('returns plaintext for non-enc values including empty string', () => {
        expect(classifySnapshotFileContent('')).toEqual({ kind: 'usable', content: '' });
        expect(classifySnapshotFileContent('services:\n  web:\n')).toEqual({
            kind: 'usable',
            content: 'services:\n  web:\n',
        });
    });

    it('decrypts a structurally valid envelope', () => {
        const cipher = encrypt('SECRET=1\n');
        expect(isStructurallyValidSnapshotEnvelope(cipher)).toBe(true);
        expect(classifySnapshotFileContent(cipher)).toEqual({ kind: 'usable', content: 'SECRET=1\n' });
    });

    it('marks auth-failing valid envelopes unavailable', () => {
        const cipher = encrypt('ok');
        // Flip last hex nibble of ciphertext to keep structure valid but break auth
        const parts = cipher.split(':');
        const last = parts[parts.length - 1];
        const flipped = (last.slice(0, -1) + (last.endsWith('0') ? '1' : '0'));
        const tampered = [...parts.slice(0, -1), flipped].join(':');
        expect(isStructurallyValidSnapshotEnvelope(tampered)).toBe(true);
        expect(classifySnapshotFileContent(tampered)).toEqual(
            expect.objectContaining({ kind: 'unavailable', reason: 'decrypt_failed' }),
        );
    });

    it('preserves clearly non-envelope legacy enc: prose', () => {
        expect(classifySnapshotFileContent('enc:hello')).toEqual({ kind: 'usable', content: 'enc:hello' });
        expect(classifySnapshotFileContent('enc:FOO_BAR=baz')).toEqual({
            kind: 'usable',
            content: 'enc:FOO_BAR=baz',
        });
        expect(isEnvelopeLikeDamage('enc:hello')).toBe(false);
    });

    describe('encrypt-then-corrupt detectable family', () => {
        let good: string;
        beforeEach(() => {
            good = encrypt('compose content\n');
        });

        const envelopeDamage = { kind: 'unavailable' as const, reason: 'envelope_damage' as const };

        it('fails closed on empty truncation to enc:', () => {
            expect(classifySnapshotFileContent('enc:')).toEqual(envelopeDamage);
        });

        it('fails closed on short hex-only truncation', () => {
            expect(classifySnapshotFileContent('enc:deadbeef')).toEqual(envelopeDamage);
        });

        it('fails closed when IV is truncated', () => {
            const payload = good.slice('enc:'.length);
            const [iv, tag, ct] = payload.split(':');
            const damaged = `enc:${iv.slice(0, 10)}:${tag}:${ct}`;
            expect(classifySnapshotFileContent(damaged)).toEqual(envelopeDamage);
        });

        it('fails closed when tag is truncated', () => {
            const payload = good.slice('enc:'.length);
            const [iv, tag, ct] = payload.split(':');
            const damaged = `enc:${iv}:${tag.slice(0, 8)}:${ct}`;
            expect(classifySnapshotFileContent(damaged)).toEqual(envelopeDamage);
        });

        it('fails closed when ciphertext is truncated or odd-length', () => {
            const payload = good.slice('enc:'.length);
            const [iv, tag, ct] = payload.split(':');
            expect(classifySnapshotFileContent(`enc:${iv}:${tag}:${ct.slice(0, -1)}`)).toEqual(envelopeDamage);
            expect(classifySnapshotFileContent(`enc:${iv}:${tag}:${ct.slice(0, 3)}`)).toEqual(envelopeDamage);
        });

        it('fails closed on non-hex mutation in IV, tag, and ciphertext', () => {
            const payload = good.slice('enc:'.length);
            const [iv, tag, ct] = payload.split(':');
            const ivDamaged = `enc:${iv.slice(0, 5)}g${iv.slice(6)}:${tag}:${ct}`;
            const tagDamaged = `enc:${iv}:${tag.slice(0, 5)}g${tag.slice(6)}:${ct}`;
            const ctDamaged = `enc:${iv}:${tag}:${ct.slice(0, 5)}g${ct.slice(6)}`;
            expect(classifySnapshotFileContent(ivDamaged)).toEqual(envelopeDamage);
            expect(classifySnapshotFileContent(tagDamaged)).toEqual(envelopeDamage);
            expect(classifySnapshotFileContent(ctDamaged)).toEqual(envelopeDamage);
        });

        it('fails closed when a delimiter is removed or added', () => {
            const payload = good.slice('enc:'.length);
            const [iv, tag, ct] = payload.split(':');
            expect(classifySnapshotFileContent(`enc:${iv}:${tag}${ct}`)).toEqual(envelopeDamage);
            expect(classifySnapshotFileContent(`enc:${iv}:${tag}:${ct}:00`)).toEqual(envelopeDamage);
        });
    });
});
