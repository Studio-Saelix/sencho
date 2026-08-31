/**
 * Redirect policy against real HTTPS servers.
 *
 * These run in-process (no git subprocess), so they exercise the preflight
 * walk itself: which destinations are approved, which are refused, and
 * crucially whether a refused destination is contacted at all. Each fixture
 * counts its own requests, so "rejected before contact" is asserted as an
 * observed request count rather than inferred from the thrown error.
 */
import { readFileSync } from 'fs';
import https from 'https';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRedirectedRepoUrl } from '../services/git/redirectPreflight';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'e2e', 'fixtures');
const CA_PEM = readFileSync(path.join(FIXTURES_DIR, 'git-ca.pem'), 'utf8');
const TLS_OPTS = {
    cert: readFileSync(path.join(FIXTURES_DIR, 'git-server.pem')),
    key: readFileSync(path.join(FIXTURES_DIR, 'git-server.key')),
};

interface Fixture {
    port: number;
    origin: string;
    /** Every path this server was asked for, in order. */
    hits: string[];
    close: () => void;
}

const open: Fixture[] = [];

/** Start a TLS server whose handler may redirect; records every request path. */
function serve(handler: (url: string, res: import('http').ServerResponse) => void): Promise<Fixture> {
    return new Promise((resolve, reject) => {
        const hits: string[] = [];
        const server = https.createServer(TLS_OPTS, (req, res) => {
            hits.push(req.url ?? '');
            handler(req.url ?? '', res);
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                reject(new Error('fixture did not bind'));
                return;
            }
            const fixture: Fixture = {
                port: address.port,
                origin: `https://127.0.0.1:${address.port}`,
                hits,
                close: () => server.close(),
            };
            open.push(fixture);
            resolve(fixture);
        });
    });
}

/** Answers the ref-advertise with a 200 so a chain can terminate successfully. */
function ok(res: import('http').ServerResponse): void {
    res.statusCode = 200;
    res.end('refs');
}

afterEach(() => {
    open.splice(0).forEach((f) => f.close());
});

describe('redirect preflight', () => {
    it('approves a same-origin redirect and returns the relocated repository URL', async () => {
        const server = await serve((url, res) => {
            if (url.startsWith('/old.git/')) {
                res.statusCode = 302;
                res.setHeader('location', url.replace('/old.git/', '/new.git/'));
                res.end();
                return;
            }
            ok(res);
        });

        const resolved = await resolveRedirectedRepoUrl({
            repoUrl: `${server.origin}/old.git`,
            hasToken: true,
            reportHost: '127.0.0.1',
            caPem: CA_PEM,
        });

        expect(resolved).toBe(`${server.origin}/new.git`);
    });

    it('refuses a cross-origin redirect without ever contacting the destination', async () => {
        // The destination is a fully working server: if the policy leaked, the
        // chain would resolve successfully rather than merely failing, so a
        // rejection here cannot be an accident of the target being broken.
        const destination = await serve((_url, res) => ok(res));
        const source = await serve((url, res) => {
            res.statusCode = 302;
            res.setHeader('location', `${destination.origin}${url}`);
            res.end();
        });

        await expect(
            resolveRedirectedRepoUrl({
                repoUrl: `${source.origin}/repo.git`,
                hasToken: true,
                reportHost: '127.0.0.1',
                caPem: CA_PEM,
            }),
        ).rejects.toMatchObject({ transportFailure: true, reason: 'redirect-scope' });

        expect(source.hits).toHaveLength(1);
        expect(destination.hits).toHaveLength(0);
    });

    it('refuses a redirect that only changes the port, destination uncontacted', async () => {
        const destination = await serve((_url, res) => ok(res));
        const source = await serve((url, res) => {
            res.statusCode = 302;
            res.setHeader('location', `https://127.0.0.1:${destination.port}${url}`);
            res.end();
        });

        await expect(
            resolveRedirectedRepoUrl({
                repoUrl: `${source.origin}/repo.git`,
                hasToken: false,
                reportHost: '127.0.0.1',
                caPem: CA_PEM,
            }),
        ).rejects.toMatchObject({ reason: 'redirect-scope' });
        expect(destination.hits).toHaveLength(0);
    });

    it('refuses a downgrade to plain http', async () => {
        const source = await serve((_url, res) => {
            res.statusCode = 302;
            res.setHeader('location', 'http://127.0.0.1:9/repo.git/info/refs?service=git-upload-pack');
            res.end();
        });

        await expect(
            resolveRedirectedRepoUrl({
                repoUrl: `${source.origin}/repo.git`,
                hasToken: true,
                reportHost: '127.0.0.1',
                caPem: CA_PEM,
            }),
        ).rejects.toMatchObject({ reason: 'redirect-scope' });
    });

    it('refuses a chain longer than the hop cap instead of following it forever', async () => {
        const source = await serve((url, res) => {
            res.statusCode = 302;
            res.setHeader('location', `${url}x`);
            res.end();
        });

        await expect(
            resolveRedirectedRepoUrl({
                repoUrl: `${source.origin}/repo.git`,
                hasToken: false,
                reportHost: '127.0.0.1',
                caPem: CA_PEM,
            }),
        ).rejects.toMatchObject({ reason: 'redirect-scope' });
    });

    it('refuses a same-origin redirect that leaves the ref-advertise endpoint', async () => {
        // Only the path prefix may move. A destination that no longer ends in
        // /info/refs is not this repository relocating.
        const source = await serve((_url, res) => {
            res.statusCode = 302;
            res.setHeader('location', '/somewhere/else');
            res.end();
        });

        await expect(
            resolveRedirectedRepoUrl({
                repoUrl: `${source.origin}/repo.git`,
                hasToken: true,
                reportHost: '127.0.0.1',
                caPem: CA_PEM,
            }),
        ).rejects.toMatchObject({ reason: 'redirect-scope' });
    });

    it('returns null when the source does not redirect, leaving git\'s own error intact', async () => {
        const server = await serve((_url, res) => {
            res.statusCode = 404;
            res.end('nope');
        });

        await expect(
            resolveRedirectedRepoUrl({
                repoUrl: `${server.origin}/repo.git`,
                hasToken: true,
                reportHost: '127.0.0.1',
                caPem: CA_PEM,
            }),
        ).resolves.toBeNull();
    });

    it('returns null when the probe itself cannot complete', async () => {
        // Untrusted certificate: the chain cannot be proven safe, so no retry
        // is authorised and the caller keeps git's original failure.
        const server = await serve((_url, res) => {
            res.statusCode = 302;
            res.setHeader('location', '/other.git/info/refs?service=git-upload-pack');
            res.end();
        });

        await expect(
            resolveRedirectedRepoUrl({
                repoUrl: `${server.origin}/repo.git`,
                hasToken: true,
                reportHost: '127.0.0.1',
            }),
        ).resolves.toBeNull();
    });
});
