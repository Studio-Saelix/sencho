/**
 * Real end-to-end proof that a Git host throttle response classifies as
 * RATE_LIMITED, not AUTH_FAILED or GIT_ERROR.
 *
 * The other classifier fixtures (git-transport.test.ts) construct stderr
 * strings by hand; this file proves the string a real git binary actually
 * produces, since git does not surface an HTTP response body over the
 * smart-HTTP protocol; only the status line reaches stderr. A server that
 * intercepts every request before touching a real repository is enough:
 * resolveRef fails at ls-remote, before any fetch would need real
 * repository content.
 *
 * Soft-skips when the system git binary is unavailable, mirroring the other
 * native-git integration suites (see __helpers__/externalDeps.ts).
 */
import { promises as fs, readFileSync } from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classifyGitFailure, isTransportFailure } from '../services/git/errors';
import { nativeGitTransport } from '../services/git/nativeGitTransport';
import { requireGitBinary } from './__helpers__/externalDeps';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'e2e', 'fixtures');

/** Throttle wording a real host would put in the response body, which git never shows. */
const THROTTLE_BODY = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';

/** Serve a fixed HTTP status to every request, regardless of path or method. */
function serveStatus(status: number): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve, reject) => {
        const server = https.createServer(
            {
                cert: readFileSync(path.join(FIXTURES_DIR, 'git-server.pem')),
                key: readFileSync(path.join(FIXTURES_DIR, 'git-server.key')),
            },
            (req, res) => {
                res.statusCode = status;
                res.end(THROTTLE_BODY);
            },
        );
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                reject(new Error('server did not bind'));
                return;
            }
            resolve({ url: `https://127.0.0.1:${address.port}/repo.git`, close: () => server.close() });
        });
    });
}

describe.skipIf(!requireGitBinary())('native git transport rate-limit classification (real git, real TLS)', () => {
    let prevExtraCaCerts: string | undefined;
    const workspaces: string[] = [];

    beforeAll(() => {
        prevExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS;
        process.env.NODE_EXTRA_CA_CERTS = path.join(FIXTURES_DIR, 'git-ca.pem');
    });

    afterAll(() => {
        if (prevExtraCaCerts === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
        else process.env.NODE_EXTRA_CA_CERTS = prevExtraCaCerts;
    });

    afterEach(async () => {
        await Promise.all(workspaces.splice(0).map((w) => fs.rm(w, { recursive: true, force: true })));
    });

    async function makeWorkspace(): Promise<string> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-git-ratelimit-ws-'));
        workspaces.push(dir);
        return dir;
    }

    // Both statuses are served with the same throttle body, which is the
    // point of the pair: git shows only the status line, so a host that
    // signals a throttle as a bare 403 is indistinguishable from a rejected
    // credential and must still classify as AUTH_FAILED.
    it.each([
        [429, 'RATE_LIMITED'],
        [403, 'AUTH_FAILED'],
    ] as const)('classifies a real %d response from the host as %s', async (status, code) => {
        const served = await serveStatus(status);
        try {
            const workspaceRoot = await makeWorkspace();
            const failure = await nativeGitTransport
                .resolveRef({ repoUrl: served.url, ref: 'main', token: 'irrelevant-token', timeoutMs: 15_000, workspaceRoot })
                .then(() => null, (e: unknown) => e);

            expect(isTransportFailure(failure)).toBe(true);
            if (!isTransportFailure(failure)) throw new Error('unreachable');
            expect(failure.reason).toBe('exit');
            if (failure.reason === 'exit') {
                // Pins the real stderr shape the classifier's hand-written
                // fixtures (git-transport.test.ts) assume: the status line
                // reaches stderr, the served body never does.
                expect(failure.stderr).toMatch(new RegExp(`requested url returned error:\\s*${status}\\b`, 'i'));
                expect(failure.stderr).not.toMatch(/secondary rate limit/i);
            }
            expect(classifyGitFailure(failure).code).toBe(code);
        } finally {
            served.close();
        }
    });
});
