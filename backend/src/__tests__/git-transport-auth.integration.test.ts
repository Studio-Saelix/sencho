/**
 * Real end-to-end coverage for authenticated native-git transport.
 *
 * Every other transport test mocks `child_process` or bypasses the
 * transport module entirely, so nothing proves the credential helper, the
 * `x-access-token` username convention, argv quoting, and env-var handoff
 * actually work against a real git binary talking to a server that checks
 * Basic Auth. This file does: a local HTTPS smart-HTTP server that requires
 * a token and rejects everything else, driven through the real
 * `nativeGitTransport` with nothing mocked.
 *
 * Reuses the committed dev-only TLS fixture from the Git Sources E2E specs
 * (e2e/fixtures/git-ca.pem / git-server.pem|key) via direct file reads
 * rather than importing e2e/gitServer.helper.ts: backend's tsconfig pins
 * rootDir to backend/src, so a cross-directory import would fail `tsc
 * --noEmit`.
 *
 * Soft-skips when the system git binary is unavailable, mirroring the E2E
 * fixture server's own skip.
 */
import { spawn, spawnSync } from 'child_process';
import { promises as fs, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classifyGitFailure, isTransportFailure } from '../services/git/errors';
import { nativeGitTransport } from '../services/git/nativeGitTransport';

function gitAvailable(): boolean {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'e2e', 'fixtures');
const VALID_TOKEN = 'sencho-integration-test-token-do-not-leak';
const FILE_CONTENT = 'hello from the authenticated fixture repo\n';

/**
 * Build a bare repo with one committed file. Mirrors e2e/gitServer.helper.ts's
 * fixture builder. Returns both the served bare dir and every scratch
 * directory created along the way, so the caller can remove them all.
 */
function buildBareFixtureRepo(): { bareDir: string; scratchDirs: string[] } {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), 'sencho-git-auth-src-'));
    writeFileSync(path.join(srcDir, 'hello.txt'), FILE_CONTENT);
    const run = (args: string[]) => {
        const r = spawnSync('git', args, { cwd: srcDir, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    };
    run(['init', '-b', 'main']);
    run(['config', 'user.email', 'integration-test@sencho.test']);
    run(['config', 'user.name', 'Sencho Integration Test']);
    run(['add', '-A']);
    // Explicitly off: a developer machine or CI runner with commit.gpgsign=true
    // in its global gitconfig would otherwise fail this fixture commit.
    run(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);

    const bareRoot = mkdtempSync(path.join(os.tmpdir(), 'sencho-git-auth-bare-'));
    const bareDir = path.join(bareRoot, 'repo.git');
    const clone = spawnSync('git', ['clone', '--bare', '--quiet', srcDir, bareDir], { encoding: 'utf8' });
    if (clone.status !== 0) throw new Error(`git clone --bare failed: ${clone.stderr}`);
    return { bareDir, scratchDirs: [srcDir, bareRoot] };
}

/** Serve one bare repo over HTTPS smart-HTTP, rejecting any request without a valid Basic Auth token. */
function serveAuthedRepo(bareDir: string): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve, reject) => {
        const expectedAuth = `Basic ${Buffer.from(`x-access-token:${VALID_TOKEN}`).toString('base64')}`;
        const server = https.createServer(
            {
                cert: readFileSync(path.join(FIXTURES_DIR, 'git-server.pem')),
                key: readFileSync(path.join(FIXTURES_DIR, 'git-server.key')),
            },
            (req, res) => {
                if (req.headers.authorization !== expectedAuth) {
                    res.statusCode = 401;
                    res.setHeader('WWW-Authenticate', 'Basic realm="sencho-integration-test"');
                    res.end('authentication required');
                    return;
                }
                const url = req.url ?? '/';
                if (!url.startsWith('/repo.git/')) {
                    res.statusCode = 404;
                    res.end('unknown repo');
                    return;
                }
                const pathname = url.slice('/repo.git'.length).split('?')[0];
                if (pathname === '/info/refs' && (req.method === 'GET' || req.method === 'POST')) {
                    const ps = spawn('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bareDir]);
                    let out = Buffer.alloc(0);
                    ps.stdout.on('data', (d: Buffer) => {
                        out = Buffer.concat([out, d]);
                    });
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
                if (pathname === '/git-upload-pack' && req.method === 'POST') {
                    const ps = spawn('git', ['upload-pack', '--stateless-rpc', bareDir]);
                    res.setHeader('content-type', 'application/x-git-upload-pack-result');
                    ps.stdout.pipe(res);
                    ps.stdin.on('error', (err) => {
                        // EPIPE/ECONNRESET: the client aborted mid-stream.
                        // Anything else is a real bug in this fixture server.
                        const code = (err as NodeJS.ErrnoException).code;
                        if (code !== 'EPIPE' && code !== 'ECONNRESET') throw err;
                    });
                    req.pipe(ps.stdin);
                    return;
                }
                res.statusCode = 404;
                res.end('unsupported git endpoint');
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

describe.skipIf(!gitAvailable())('authenticated native git transport (real git, real TLS, real auth)', () => {
    let repoUrl: string;
    let closeServer: () => void;
    let prevExtraCaCerts: string | undefined;
    let fixtureScratchDirs: string[] = [];
    const workspaces: string[] = [];

    beforeAll(async () => {
        const { bareDir, scratchDirs } = buildBareFixtureRepo();
        fixtureScratchDirs = scratchDirs;
        const served = await serveAuthedRepo(bareDir);
        repoUrl = served.url;
        closeServer = served.close;
        prevExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS;
        process.env.NODE_EXTRA_CA_CERTS = path.join(FIXTURES_DIR, 'git-ca.pem');
    });

    afterAll(async () => {
        closeServer?.();
        if (prevExtraCaCerts === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
        else process.env.NODE_EXTRA_CA_CERTS = prevExtraCaCerts;
        await Promise.all(fixtureScratchDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    });

    afterEach(async () => {
        await Promise.all(workspaces.splice(0).map((w) => fs.rm(w, { recursive: true, force: true })));
    });

    async function makeWorkspace(): Promise<string> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-git-auth-ws-'));
        workspaces.push(dir);
        return dir;
    }

    /**
     * A workspace nested under a directory whose name contains a space, plus
     * the other characters git's shell treats specially. Git reads
     * `credential.helper` as a shell string, so a transport that interpolates
     * the helper's path into it breaks here (and on any host whose temp dir
     * sits under something like `C:/Users/Ada Lovelace/...`) while passing
     * every normal-path test.
     */
    async function makeAwkwardWorkspace(): Promise<string> {
        const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-git-auth-odd-'));
        workspaces.push(parent);
        const dir = path.join(parent, "a dir with spaces & 'quotes' $dollar");
        await fs.mkdir(dir);
        return dir;
    }

    it('clones a private repo end-to-end with a valid token', async () => {
        const workspaceRoot = await makeWorkspace();
        const resolved = await nativeGitTransport.resolveRef({
            repoUrl,
            ref: 'main',
            token: VALID_TOKEN,
            timeoutMs: 15_000,
            workspaceRoot,
        });
        expect(resolved.commitSha).toMatch(/^[0-9a-f]{40}$/);

        const fetchWorkspace = await makeWorkspace();
        const fetched = await nativeGitTransport.fetchAtCommit({
            repoUrl,
            ref: 'main',
            token: VALID_TOKEN,
            commitSha: resolved.commitSha,
            timeoutMs: 15_000,
            workspaceRoot: fetchWorkspace,
            maxBytes: 10 * 1024 * 1024,
        });
        expect(fetched.commitSha).toBe(resolved.commitSha);
        const content = await fs.readFile(path.join(fetched.dir, 'hello.txt'), 'utf8');
        expect(content).toBe(FILE_CONTENT);
    });

    it('clones a private repo end-to-end from a workspace path containing spaces and shell metacharacters', async () => {
        const workspaceRoot = await makeAwkwardWorkspace();
        const resolved = await nativeGitTransport.resolveRef({
            repoUrl,
            ref: 'main',
            token: VALID_TOKEN,
            timeoutMs: 15_000,
            workspaceRoot,
        });
        expect(resolved.commitSha).toMatch(/^[0-9a-f]{40}$/);

        const fetchWorkspace = await makeAwkwardWorkspace();
        const fetched = await nativeGitTransport.fetchAtCommit({
            repoUrl,
            ref: 'main',
            token: VALID_TOKEN,
            commitSha: resolved.commitSha,
            timeoutMs: 15_000,
            workspaceRoot: fetchWorkspace,
            maxBytes: 10 * 1024 * 1024,
        });
        expect(fetched.commitSha).toBe(resolved.commitSha);
        expect(await fs.readFile(path.join(fetched.dir, 'hello.txt'), 'utf8')).toBe(FILE_CONTENT);
    });

    it('still classifies a wrong token as AUTH_FAILED from an awkward workspace path', async () => {
        // Guards the subtler half of the same defect: when the helper cannot
        // execute, git sends no credentials at all and the server's 401 reads
        // like an anonymous request, so the failure silently downgrades to the
        // private-repo masking classification instead of AUTH_FAILED.
        const workspaceRoot = await makeAwkwardWorkspace();
        const failure = await nativeGitTransport
            .resolveRef({ repoUrl, ref: 'main', token: 'wrong-token', timeoutMs: 15_000, workspaceRoot })
            .then(() => null, (e: unknown) => e);

        expect(isTransportFailure(failure)).toBe(true);
        if (!isTransportFailure(failure)) throw new Error('unreachable');
        expect(failure.hasToken).toBe(true);
        expect(classifyGitFailure(failure).code).toBe('AUTH_FAILED');
    });

    it('fails with the private-repo masking classification when no token is supplied', async () => {
        const workspaceRoot = await makeWorkspace();
        const failure = await nativeGitTransport
            .resolveRef({ repoUrl, ref: 'main', timeoutMs: 15_000, workspaceRoot })
            .then(() => null, (e: unknown) => e);

        expect(isTransportFailure(failure)).toBe(true);
        if (!isTransportFailure(failure)) throw new Error('unreachable');
        expect(failure.hasToken).toBe(false);
        expect(classifyGitFailure(failure).code).toBe('REPO_NOT_FOUND');
    });

    it('fails with AUTH_FAILED when an invalid token is supplied, and never leaks it', async () => {
        const wrongToken = 'this-token-is-wrong-and-must-never-appear-in-output';
        const workspaceRoot = await makeWorkspace();
        const failure = await nativeGitTransport
            .resolveRef({ repoUrl, ref: 'main', token: wrongToken, timeoutMs: 15_000, workspaceRoot })
            .then(() => null, (e: unknown) => e);

        expect(isTransportFailure(failure)).toBe(true);
        if (!isTransportFailure(failure)) throw new Error('unreachable');
        expect(failure.hasToken).toBe(true);
        const classified = classifyGitFailure(failure);
        expect(classified.code).toBe('AUTH_FAILED');

        const serialized = JSON.stringify(failure) + classified.message;
        expect(serialized).not.toContain(wrongToken);
        expect(serialized).not.toContain(VALID_TOKEN);
    });
});
