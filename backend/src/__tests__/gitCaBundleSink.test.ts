/**
 * The CA bundle sink is the only place a per-fetch PEM file is written for
 * git to read via http.sslCAInfo. These tests pin the invariants CodeQL was
 * asked to ignore: every output path is inside the supplied metaDir, the
 * written content is concatenated PEM only, and a non-PEM NODE_EXTRA_CA_CERTS
 * file is dropped rather than passed through to git.
 */
import { promises as fs, mkdtempSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCombinedCaBundle } from '../services/git/gitCaBundleSink';

const SAMPLE_CA_A = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHHCgVZU1w0MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxv\n-----END CERTIFICATE-----\n';
const SAMPLE_CA_B = '-----BEGIN CERTIFICATE-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END CERTIFICATE-----\n';

describe('writeCombinedCaBundle', () => {
    let metaDir: string;
    let prevExtraCaCerts: string | undefined;

    beforeEach(() => {
        metaDir = mkdtempSync(path.join(os.tmpdir(), 'sencho-ca-sink-'));
        prevExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS;
    });

    afterEach(async () => {
        if (prevExtraCaCerts === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
        else process.env.NODE_EXTRA_CA_CERTS = prevExtraCaCerts;
        await fs.rm(metaDir, { recursive: true, force: true });
    });

    it('returns null when no per-source PEM and no NODE_EXTRA_CA_CERTS is set', async () => {
        delete process.env.NODE_EXTRA_CA_CERTS;
        const result = await writeCombinedCaBundle(metaDir, null);
        expect(result).toBeNull();
    });

    it('writes a file inside the supplied metaDir and returns its absolute path', async () => {
        delete process.env.NODE_EXTRA_CA_CERTS;
        const result = await writeCombinedCaBundle(metaDir, SAMPLE_CA_A);
        expect(result).not.toBeNull();
        // The returned path is the metaDir/combined-ca.pem, with forward slashes
        // for git. The test must compare resolved paths, not string prefixes,
        // because the metaDir may itself contain a forward-slash via mkdtemp
        // (which it does not on POSIX, but path.resolve normalizes either way).
        const expected = path.resolve(metaDir, 'combined-ca.pem');
        expect(result!.path.replace(/\//g, path.sep)).toBe(expected);
        expect(result!.path.endsWith('combined-ca.pem')).toBe(true);
        const body = await fs.readFile(result!.path, 'utf8');
        expect(body).toContain('BEGIN CERTIFICATE');
        expect(body).toContain('END CERTIFICATE');
    });

    it('writes the file with mode 0600', async () => {
        if (process.platform === 'win32') {
            // POSIX-only check; Windows ignores mode bits on fs.writeFile.
            return;
        }
        delete process.env.NODE_EXTRA_CA_CERTS;
        const result = await writeCombinedCaBundle(metaDir, SAMPLE_CA_A);
        const stat = statSync(result!.path);
        // 0o600 -> owner read+write, no group/other bits.
        expect(stat.mode & 0o777).toBe(0o600);
    });

    it('concatenates a per-source PEM and a NODE_EXTRA_CA_CERTS file', async () => {
        const extraPath = path.join(metaDir, '..', 'extra-ca.pem');
        writeFileSync(extraPath, SAMPLE_CA_B);
        process.env.NODE_EXTRA_CA_CERTS = extraPath;
        const result = await writeCombinedCaBundle(metaDir, SAMPLE_CA_A);
        expect(result).not.toBeNull();
        const body = await fs.readFile(result!.path, 'utf8');
        // Both certificates should be present in the combined file.
        expect(body.split('-----BEGIN CERTIFICATE-----').length - 1).toBe(2);
    });

    it('drops a NODE_EXTRA_CA_CERTS file that is not valid PEM rather than writing it through', async () => {
        const extraPath = path.join(metaDir, '..', 'extra-ca.pem');
        writeFileSync(extraPath, 'this is not a certificate');
        process.env.NODE_EXTRA_CA_CERTS = extraPath;
        // No per-source PEM either: nothing valid to write, so null.
        const result = await writeCombinedCaBundle(metaDir, null);
        expect(result).toBeNull();
    });

    it('drops a non-PEM per-source input rather than writing it through', async () => {
        delete process.env.NODE_EXTRA_CA_CERTS;
        const result = await writeCombinedCaBundle(metaDir, 'not a cert at all');
        expect(result).toBeNull();
    });
});
