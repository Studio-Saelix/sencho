/**
 * Redirect behaviour end to end through real git against real TLS servers.
 *
 * The matrix pins both halves of the contract that the transport has to hold
 * at once: a repository that relocates on its own host stays usable, and a
 * redirect that leaves that host is refused without the destination being
 * contacted or a credential being offered to it.
 *
 * Every fixture records the requests it receives, including the Authorization
 * header, so credential scope and "never contacted" are asserted from what the
 * servers actually observed rather than inferred from the thrown error.
 */
import { spawn, spawnSync } from 'child_process';
import { promises as fs, readFileSync } from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nativeGitTransport } from '../services/git/nativeGitTransport';
import { buildBareRepo } from './__helpers__/gitFixture';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'e2e', 'fixtures');
const CA_PEM = readFileSync(path.join(FIXTURES_DIR, 'git-ca.pem'), 'utf8');
const TLS_OPTS = {
    cert: readFileSync(path.join(FIXTURES_DIR, 'git-server.pem')),
    key: readFileSync(path.join(FIXTURES_DIR, 'git-server.key')),
};
const GOOD_TOKEN = 'correct-horse-battery-staple';

function gitAvailable(): boolean {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

interface Request { url: string; authorization: string | null }

interface Fixture {
    origin: string;
    requests: Request[];
    close: () => void;
}

const openFixtures: Fixture[] = [];
const workspaces: string[] = [];

/**
 * A TLS git server. Paths under `/old.git/` are 302-redirected by `redirect`
 * (returning an absolute URL, or null to serve normally); paths under
 * `/new.git/` are served from the bare repo, behind Basic auth when
 * `requireAuth` is set.
 */
function serveGit(opts: {
    bareDir: string;
    redirect?: (fixture: Fixture, url: string) => string | null;
    requireAuth?: boolean;
}): Promise<Fixture> {
    return new Promise((resolve, reject) => {
        const requests: Request[] = [];
        let self: Fixture;
        const server = https.createServer(TLS_OPTS, (req, res) => {
            const url = req.url ?? '/';
            requests.push({ url, authorization: req.headers.authorization ?? null });

            if (url.startsWith('/old.git/') && opts.redirect) {
                const target = opts.redirect(self, url);
                if (target) {
                    res.statusCode = 302;
                    res.setHeader('location', target);
                    res.end();
                    return;
                }
            }
            if (!url.startsWith('/new.git/')) {
                res.statusCode = 404;
                res.end('unknown repo');
                return;
            }
            if (opts.requireAuth) {
                const expected = `Basic ${Buffer.from(`x-access-token:${GOOD_TOKEN}`).toString('base64')}`;
                if (req.headers.authorization !== expected) {
                    res.statusCode = 401;
                    res.setHeader('www-authenticate', 'Basic realm="git"');
                    res.end('unauthorized');
                    return;
                }
            }
            const pathname = url.slice('/new.git'.length).split('?')[0];
            if (pathname === '/info/refs') {
                const ps = spawn('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', opts.bareDir]);
                let out = Buffer.alloc(0);
                ps.stdout.on('data', (d: Buffer) => { out = Buffer.concat([out, d]); });
                ps.on('close', (code) => {
                    if (code !== 0) {
                        res.statusCode = 500;
                        res.end('git upload-pack failed');
                        return;
                    }
                    res.setHeader('content-type', 'application/x-git-upload-pack-advertisement');
                    res.end(Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), out]));
                });
                return;
            }
            if (pathname === '/git-upload-pack') {
                const ps = spawn('git', ['upload-pack', '--stateless-rpc', opts.bareDir]);
                res.setHeader('content-type', 'application/x-git-upload-pack-result');
                ps.stdout.pipe(res);
                req.pipe(ps.stdin);
                return;
            }
            res.statusCode = 404;
            res.end('unsupported');
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                reject(new Error('fixture did not bind'));
                return;
            }
            self = {
                origin: `https://127.0.0.1:${address.port}`,
                requests,
                close: () => server.close(),
            };
            openFixtures.push(self);
            resolve(self);
        });
    });
}

async function workspace(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-redir-ws-'));
    workspaces.push(dir);
    return dir;
}

describe.skipIf(!gitAvailable())('redirect destination revalidation (real git)', () => {
    let bareDir: string;
    let headSha: string;
    let prevExtraCaCerts: string | undefined;

    beforeAll(async () => {
        bareDir = buildBareRepo({
            srcPrefix: 'sencho-redir-src-',
            barePrefix: 'sencho-redir-bare-',
            userEmail: 'redir-test@sencho.test',
            userName: 'Sencho Redirect Test',
        });
        headSha = spawnSync('git', ['-C', bareDir, 'rev-parse', 'main'], { encoding: 'utf8' })
            .stdout.trim().toLowerCase();
        prevExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS;
        delete process.env.NODE_EXTRA_CA_CERTS;
    });

    afterEach(async () => {
        openFixtures.splice(0).forEach((f) => f.close());
        await Promise.all(workspaces.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
        if (prevExtraCaCerts === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
        else process.env.NODE_EXTRA_CA_CERTS = prevExtraCaCerts;
    });

    it('resolves a ref through an unauthenticated same-host redirect', async () => {
        const server = await serveGit({
            bareDir,
            redirect: (self, url) => `${self.origin}${url.replace('/old.git/', '/new.git/')}`,
        });

        const resolved = await nativeGitTransport.resolveRef({
            repoUrl: `${server.origin}/old.git`,
            ref: 'main',
            caBundlePem: CA_PEM,
            workspaceRoot: await workspace(),
            timeoutMs: 30_000,
        });

        expect(resolved).toEqual({ commitSha: headSha, kind: 'branch' });
    });

    it('resolves a ref through an authenticated same-host redirect and sends the token to the relocated path', async () => {
        const server = await serveGit({
            bareDir,
            requireAuth: true,
            redirect: (self, url) => `${self.origin}${url.replace('/old.git/', '/new.git/')}`,
        });

        const resolved = await nativeGitTransport.resolveRef({
            repoUrl: `${server.origin}/old.git`,
            ref: 'main',
            token: GOOD_TOKEN,
            caBundlePem: CA_PEM,
            workspaceRoot: await workspace(),
            timeoutMs: 30_000,
        });

        expect(resolved).toEqual({ commitSha: headSha, kind: 'branch' });
        // The credential is scoped to the host, not to the original path, so
        // the relocated endpoint on that same host must have received it.
        const authorized = server.requests.filter(
            (r) => r.url.startsWith('/new.git/') && r.authorization !== null,
        );
        expect(authorized.length).toBeGreaterThan(0);
    });

    it('reports an authentication failure, not a redirect failure, when the token is wrong behind a same-host redirect', async () => {
        const server = await serveGit({
            bareDir,
            requireAuth: true,
            redirect: (self, url) => `${self.origin}${url.replace('/old.git/', '/new.git/')}`,
        });

        await expect(
            nativeGitTransport.resolveRef({
                repoUrl: `${server.origin}/old.git`,
                ref: 'main',
                token: 'not-the-right-token',
                caBundlePem: CA_PEM,
                workspaceRoot: await workspace(),
                timeoutMs: 30_000,
            }),
        ).rejects.toMatchObject({ transportFailure: true, reason: 'exit' });
    });

    it('refuses a cross-host redirect without contacting the destination or offering it the token', async () => {
        // The destination is a fully working repository server. If the policy
        // leaked, this fetch would SUCCEED, so the rejection below cannot be an
        // artefact of a target that was broken anyway.
        const destination = await serveGit({ bareDir });
        const source = await serveGit({
            bareDir,
            redirect: (_self, url) => `${destination.origin}${url.replace('/old.git/', '/new.git/')}`,
        });

        await expect(
            nativeGitTransport.resolveRef({
                repoUrl: `${source.origin}/old.git`,
                ref: 'main',
                token: 'sensitive-pat-do-not-leak',
                caBundlePem: CA_PEM,
                workspaceRoot: await workspace(),
                timeoutMs: 30_000,
            }),
        ).rejects.toMatchObject({ transportFailure: true, reason: 'redirect-scope' });

        // Settle, so a late request would still be counted rather than raced past.
        await new Promise((r) => setTimeout(r, 250));
        expect(destination.requests).toHaveLength(0);
    });

    it('proves the cross-host destination would otherwise serve the same ref', async () => {
        const destination = await serveGit({ bareDir });
        const resolved = await nativeGitTransport.resolveRef({
            repoUrl: `${destination.origin}/new.git`,
            ref: 'main',
            caBundlePem: CA_PEM,
            workspaceRoot: await workspace(),
            timeoutMs: 30_000,
        });
        expect(resolved.commitSha).toBe(headSha);
    });
});
