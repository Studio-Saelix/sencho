/**
 * Live redirect fixture: prove that a cross-host redirect during a clone
 * receives no credentials from the host-scoped helper and the fetch fails
 * closed. Cross-host credential safety is enforced by the host-scoped
 * helper, not by disabling redirects: same-host redirects must continue to
 * work, so this test pins both halves of the contract.
 */
import { spawn, spawnSync } from 'child_process';
import { promises as fs, readFileSync } from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nativeGitTransport } from '../services/git/nativeGitTransport';
import { buildBareRepo } from './__helpers__/gitFixture';

function gitAvailable(): boolean {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'e2e', 'fixtures');
const CA_PEM = readFileSync(path.join(FIXTURES_DIR, 'git-ca.pem'), 'utf8');

type RedirectServer = { url: string; close: () => void };

/** Stand up a TLS-backed git server that 302-redirects the first ref-advertise
 *  request to `redirectTo` and serves normally on the second request. */
function makeRedirectingServer(bareDir: string, redirectTo: string | null): Promise<RedirectServer> {
    return new Promise<RedirectServer>((resolve, reject) => {
        let redirectedOnce = false;
        const server = https.createServer(
            {
                cert: readFileSync(path.join(FIXTURES_DIR, 'git-server.pem')),
                key: readFileSync(path.join(FIXTURES_DIR, 'git-server.key')),
            },
            (req, res) => {
                const url = req.url ?? '/';
                if (!url.startsWith('/repo.git/')) {
                    res.statusCode = 404;
                    res.end('unknown repo');
                    return;
                }
                const pathname = url.slice('/repo.git'.length).split('?')[0];
                if (pathname === '/info/refs') {
                    if (redirectTo && !redirectedOnce) {
                        redirectedOnce = true;
                        res.statusCode = 302;
                        res.setHeader('location', redirectTo);
                        res.end();
                        return;
                    }
                    const ps = spawn('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bareDir]);
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
                    const ps = spawn('git', ['upload-pack', '--stateless-rpc', bareDir]);
                    res.setHeader('content-type', 'application/x-git-upload-pack-result');
                    ps.stdout.pipe(res);
                    req.pipe(ps.stdin);
                    return;
                }
                res.statusCode = 404;
                res.end('unsupported');
            },
        );
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                reject(new Error('server did not bind'));
                return;
            }
            resolve({
                url: `https://127.0.0.1:${address.port}/repo.git`,
                close: () => server.close(),
            });
        });
    });
}

describe.skipIf(!gitAvailable())('redirect destination revalidation (real git)', () => {
    let bareDir: string;
    let closeServer: () => void;
    let prevExtraCaCerts: string | undefined;
    const workspaces: string[] = [];

    beforeAll(() => {
        bareDir = buildBareRepo({ srcPrefix: 'sencho-redir-src-', barePrefix: 'sencho-redir-bare-', userEmail: 'redir-test@sencho.test', userName: 'Sencho Redirect Test' });
        prevExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS;
        delete process.env.NODE_EXTRA_CA_CERTS;
    });

    afterAll(() => {
        closeServer?.();
        if (prevExtraCaCerts === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
        else process.env.NODE_EXTRA_CA_CERTS = prevExtraCaCerts;
    });

    afterEach(async () => {
        await Promise.all(workspaces.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
    });

    it('a cross-host redirect receives no credentials and the fetch fails closed', async () => {
        // Stand up a "victim" server on a second loopback port whose
        // /info/refs handler records whatever Authorization header git sent.
        // The "attacker" server replies to the first ref-advertise with a
        // 302 to the victim. The helper sees the redirected host is
        // 127.0.0.1:<victim-port>, which differs from the configured
        // 127.0.0.1:<attacker-port>, so it refuses to emit credentials.
        // The victim therefore records no Authorization header.
        const victim = await new Promise<{ port: number; authHeader: () => string | null; close: () => void }>((resolve, reject) => {
            let captured: string | null = null;
            const v = https.createServer(
                {
                    cert: readFileSync(path.join(FIXTURES_DIR, 'git-server.pem')),
                    key: readFileSync(path.join(FIXTURES_DIR, 'git-server.key')),
                },
                (req, res) => {
                    if (req.headers.authorization !== undefined) {
                        captured = req.headers.authorization;
                    }
                    res.statusCode = 404;
                    res.end('victim');
                },
            );
            v.listen(0, '127.0.0.1', () => {
                const address = v.address();
                if (address === null || typeof address === 'string') {
                    reject(new Error('victim did not bind'));
                    return;
                }
                resolve({ port: address.port, authHeader: () => captured, close: () => v.close() });
            });
        });

        const crossHost = `https://127.0.0.1:${victim.port}/repo.git/info/refs?service=git-upload-pack`;
        const attacker = await makeRedirectingServer(bareDir, crossHost);
        closeServer = () => {
            attacker.close();
            victim.close();
        };

        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-redir-ws-'));
        workspaces.push(workspaceRoot);
        await expect(
            nativeGitTransport.resolveRef({
                repoUrl: attacker.url,
                ref: 'main',
                token: 'sensitive-pat-do-not-leak',
                caBundlePem: CA_PEM,
                workspaceRoot,
                timeoutMs: 30_000,
            }),
        ).rejects.toBeDefined();
        // Settle: give the victim a moment to record any auth header git
        // might have leaked on the follow-up.
        await new Promise((r) => setTimeout(r, 250));
        const leaked = victim.authHeader();
        expect(leaked).toBeNull();
    });
});
