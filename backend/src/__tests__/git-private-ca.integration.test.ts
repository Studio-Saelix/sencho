/**
 * Proves per-source CA bundles work without the process-wide NODE_EXTRA_CA_CERTS bridge.
 */
import { spawn, spawnSync } from 'child_process';
import { promises as fs, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nativeGitTransport } from '../services/git/nativeGitTransport';

function gitAvailable(): boolean {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'e2e', 'fixtures');
const CA_PEM = readFileSync(path.join(FIXTURES_DIR, 'git-ca.pem'), 'utf8');

function buildBareRepo(): string {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), 'sencho-ca-src-'));
    const run = (args: string[]) => {
        const r = spawnSync('git', args, { cwd: srcDir, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    };
    run(['init', '-b', 'main']);
    run(['config', 'user.email', 'ca-test@sencho.test']);
    run(['config', 'user.name', 'Sencho CA Test']);
    writeFileSync(path.join(srcDir, 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
    run(['add', '-A']);
    run(['commit', '-m', 'fixture']);
    const bareRoot = mkdtempSync(path.join(os.tmpdir(), 'sencho-ca-bare-'));
    const bareDir = path.join(bareRoot, 'repo.git');
    const clone = spawnSync('git', ['clone', '--bare', '--quiet', srcDir, bareDir], { encoding: 'utf8' });
    if (clone.status !== 0) throw new Error(`git clone --bare failed: ${clone.stderr}`);
    return bareDir;
}

function serveRepo(bareDir: string): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve, reject) => {
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
                if (pathname === '/info/refs' && (req.method === 'GET' || req.method === 'POST')) {
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
                if (pathname === '/git-upload-pack' && req.method === 'POST') {
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
            resolve({ url: `https://127.0.0.1:${address.port}/repo.git`, close: () => server.close() });
        });
    });
}

describe.skipIf(!gitAvailable())('per-source private CA transport (real git)', () => {
    let repoUrl: string;
    let closeServer: () => void;
    let prevExtraCaCerts: string | undefined;
    const workspaces: string[] = [];

    beforeAll(async () => {
        const bareDir = buildBareRepo();
        const served = await serveRepo(bareDir);
        repoUrl = served.url;
        closeServer = served.close;
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

    it('clones a private-CA HTTPS repo when the per-source CA PEM is supplied', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-ca-ws-'));
        workspaces.push(workspaceRoot);
        const resolved = await nativeGitTransport.resolveRef({
            repoUrl,
            ref: 'main',
            caBundlePem: CA_PEM,
            workspaceRoot,
            timeoutMs: 30_000,
        });
        const fetched = await nativeGitTransport.fetchAtCommit({
            repoUrl,
            ref: 'main',
            refKind: resolved.kind,
            commitSha: resolved.commitSha,
            caBundlePem: CA_PEM,
            workspaceRoot,
            maxBytes: 50 * 1024 * 1024,
        });
        expect(fetched.commitSha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('fails TLS verification without a matching per-source CA when NODE_EXTRA_CA_CERTS is unset', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-ca-ws-'));
        workspaces.push(workspaceRoot);
        await expect(nativeGitTransport.resolveRef({
            repoUrl,
            ref: 'main',
            workspaceRoot,
            timeoutMs: 30_000,
        })).rejects.toMatchObject({ transportFailure: true });
    });
});
