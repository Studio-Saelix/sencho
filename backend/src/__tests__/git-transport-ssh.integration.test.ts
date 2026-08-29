/**
 * End-to-end SSH deploy-key transport with strict known_hosts verification.
 *
 * Spins up a local openssh-server with a forced `git-upload-pack` command and
 * drives the real `nativeGitTransport` through GIT_SSH_COMMAND (no mocks).
 */
import { spawn, spawnSync } from 'child_process';
import { promises as fs, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classifyGitFailure, isTransportFailure } from '../services/git/errors';
import { nativeGitTransport } from '../services/git/nativeGitTransport';
import { scanHostKeys } from '../services/git/sshTrust';

function gitAvailable(): boolean {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

function sshdAvailable(): boolean {
    return spawnSync('/usr/sbin/sshd', ['-V'], { stdio: 'ignore' }).status === 0;
}

const FILE_CONTENT = 'hello from the ssh fixture repo\n';

function runGit(cwd: string, args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
}

function generateKeyPair(dir: string, name: string): { privatePath: string; publicPath: string; privatePem: string; publicLine: string } {
    const privatePath = path.join(dir, name);
    const publicPath = `${privatePath}.pub`;
    const gen = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', privatePath, '-q'], { encoding: 'utf8' });
    if (gen.status !== 0) throw new Error(`ssh-keygen failed: ${gen.stderr}`);
    const privatePem = readFileSync(privatePath, 'utf8');
    const publicLine = readFileSync(publicPath, 'utf8').trim();
    return { privatePath, publicPath, privatePem, publicLine };
}

function buildBareRepo(): { bareDir: string; mainSha: string; scratchDirs: string[] } {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), 'sencho-ssh-src-'));
    writeFileSync(path.join(srcDir, 'hello.txt'), FILE_CONTENT);
    runGit(srcDir, ['init', '-b', 'main']);
    runGit(srcDir, ['config', 'user.email', 'integration-test@sencho.test']);
    runGit(srcDir, ['config', 'user.name', 'Sencho SSH Integration Test']);
    runGit(srcDir, ['add', '-A']);
    runGit(srcDir, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
    const mainSha = runGit(srcDir, ['rev-parse', 'HEAD']);

    const bareRoot = mkdtempSync(path.join(os.tmpdir(), 'sencho-ssh-bare-'));
    const bareDir = path.join(bareRoot, 'repo.git');
    const clone = spawnSync('git', ['clone', '--bare', '--quiet', srcDir, bareDir], { encoding: 'utf8' });
    if (clone.status !== 0) throw new Error(`git clone --bare failed: ${clone.stderr}`);
    return { bareDir, mainSha, scratchDirs: [srcDir, bareRoot] };
}

async function waitForPort(host: string, port: number, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await new Promise<void>((resolve, reject) => {
                const socket = net.connect({ host, port }, () => {
                    socket.end();
                    resolve();
                });
                socket.on('error', reject);
            });
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}

interface SshGitFixture {
    port: number;
    bareDir: string;
    mainSha: string;
    repoUrlScp: string;
    repoUrlSsh: string;
    deployPrivateKey: string;
    knownHostsEntry: string;
    wrongPrivateKey: string;
    close: () => void;
    scratchDirs: string[];
}

const DEFAULT_SSH_PORT = 22;

async function startSshGitServer(bareDir: string, port: number): Promise<Omit<SshGitFixture, 'repoUrlScp' | 'repoUrlSsh' | 'mainSha'>> {
    const sshRoot = mkdtempSync(path.join(os.tmpdir(), 'sencho-ssh-sshd-'));
    const deploy = generateKeyPair(sshRoot, 'deploy');
    const wrong = generateKeyPair(sshRoot, 'wrong');
    const hostKey = generateKeyPair(sshRoot, 'host');

    const authorizedKeysPath = path.join(sshRoot, 'authorized_keys');
    const forced = `command="git-upload-pack '${bareDir}'",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ${deploy.publicLine}`;
    writeFileSync(authorizedKeysPath, `${forced}\n`, { mode: 0o600 });

    const configPath = path.join(sshRoot, 'sshd_config');
    const pidPath = path.join(sshRoot, 'sshd.pid');
    writeFileSync(
        configPath,
        [
            `Port ${port}`,
            'ListenAddress 127.0.0.1',
            `HostKey ${hostKey.privatePath}`,
            `AuthorizedKeysFile ${authorizedKeysPath}`,
            `PidFile ${pidPath}`,
            'UsePAM no',
            'PasswordAuthentication no',
            'PubkeyAuthentication yes',
            'X11Forwarding no',
            'StrictModes no',
            'LogLevel ERROR',
        ].join('\n'),
        { mode: 0o600 },
    );

    const child = spawn('/usr/sbin/sshd', ['-D', '-f', configPath, '-e'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    try {
        await waitForPort('127.0.0.1', port);
    } catch (e) {
        // sshd reports its own startup failures on stderr; without this the only
        // CI signal is an opaque port timeout. Kill first so no orphan holds the
        // port and turns the next run into a misleading "address already in use".
        child.kill('SIGKILL');
        throw new Error(`sshd did not come up on port ${port}: ${stderr.trim() || '(no stderr)'}`, { cause: e });
    }

    const scanned = await scanHostKeys('127.0.0.1', port);
    const knownHostsEntry = scanned.map((k) => k.line).join('\n');

    return {
        port,
        bareDir,
        deployPrivateKey: deploy.privatePem,
        knownHostsEntry,
        wrongPrivateKey: wrong.privatePem,
        close: () => {
            child.kill('SIGTERM');
        },
        scratchDirs: [sshRoot],
    };
}

describe.skipIf(!gitAvailable() || !sshdAvailable())('SSH deploy-key native git transport (real git, real sshd, strict host keys)', () => {
    let fixture: SshGitFixture;
    let standardPortFixture: SshGitFixture | null = null;
    const workspaces: string[] = [];
    let scratchDirs: string[] = [];

    beforeAll(async () => {
        const repo = buildBareRepo();
        scratchDirs = repo.scratchDirs;
        const nonstandardPort = 22222;
        const sshUser = os.userInfo().username;
        const sshd = await startSshGitServer(repo.bareDir, nonstandardPort);
        fixture = {
            ...sshd,
            mainSha: repo.mainSha,
            repoUrlScp: `${sshUser}@127.0.0.1:${nonstandardPort}:${repo.bareDir}`,
            repoUrlSsh: `ssh://${sshUser}@127.0.0.1:${nonstandardPort}${repo.bareDir}`,
            scratchDirs: [...scratchDirs, ...sshd.scratchDirs],
        };
        try {
            const standardSshd = await startSshGitServer(repo.bareDir, DEFAULT_SSH_PORT);
            standardPortFixture = {
                ...standardSshd,
                mainSha: repo.mainSha,
                repoUrlScp: `${sshUser}@127.0.0.1:${repo.bareDir}`,
                repoUrlSsh: `ssh://${sshUser}@127.0.0.1${repo.bareDir}`,
                scratchDirs: [...scratchDirs, ...standardSshd.scratchDirs],
            };
        } catch {
            standardPortFixture = null;
        }
    });

    afterAll(async () => {
        fixture?.close?.();
        standardPortFixture?.close?.();
        await Promise.all(scratchDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    });

    afterEach(async () => {
        await Promise.all(workspaces.splice(0).map((w) => fs.rm(w, { recursive: true, force: true })));
    });

    async function makeWorkspace(): Promise<string> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-ssh-ws-'));
        workspaces.push(dir);
        return dir;
    }

    it('resolves and fetches over SSH with a deploy key and trusted host key', async () => {
        const workspaceRoot = await makeWorkspace();
        const sshAuth = { privateKey: fixture.deployPrivateKey, knownHostsEntry: fixture.knownHostsEntry };
        const resolved = await nativeGitTransport.resolveRef({
            repoUrl: fixture.repoUrlSsh,
            ref: 'main',
            sshAuth,
            timeoutMs: 20_000,
            workspaceRoot,
        });
        expect(resolved.commitSha).toBe(fixture.mainSha);

        const fetchWorkspace = await makeWorkspace();
        const fetched = await nativeGitTransport.fetchAtCommit({
            repoUrl: fixture.repoUrlSsh,
            ref: 'main',
            sshAuth,
            refKind: 'branch',
            commitSha: resolved.commitSha,
            timeoutMs: 20_000,
            workspaceRoot: fetchWorkspace,
            maxBytes: 10 * 1024 * 1024,
        });
        expect(fetched.commitSha).toBe(fixture.mainSha);
        const content = await fs.readFile(path.join(fetched.dir, 'hello.txt'), 'utf8');
        expect(content).toBe(FILE_CONTENT);
    });

    it('resolves over ssh:// with a nonstandard port', async () => {
        const workspaceRoot = await makeWorkspace();
        const sshAuth = { privateKey: fixture.deployPrivateKey, knownHostsEntry: fixture.knownHostsEntry };
        const resolved = await nativeGitTransport.resolveRef({
            repoUrl: fixture.repoUrlSsh,
            ref: 'main',
            sshAuth,
            timeoutMs: 20_000,
            workspaceRoot,
        });
        expect(resolved.commitSha).toBe(fixture.mainSha);
    });

    it.skipIf(!standardPortFixture)('resolves over scp-style URL on the default SSH port', async () => {
        const active = standardPortFixture!;
        const workspaceRoot = await makeWorkspace();
        const sshAuth = { privateKey: active.deployPrivateKey, knownHostsEntry: active.knownHostsEntry };
        const resolved = await nativeGitTransport.resolveRef({
            repoUrl: active.repoUrlScp,
            ref: 'main',
            sshAuth,
            timeoutMs: 20_000,
            workspaceRoot,
        });
        expect(resolved.commitSha).toBe(active.mainSha);
    });

    it('classifies a wrong deploy key as AUTH_FAILED', async () => {
        const workspaceRoot = await makeWorkspace();
        const failure = await nativeGitTransport
            .resolveRef({
                repoUrl: fixture.repoUrlSsh,
                ref: 'main',
                sshAuth: { privateKey: fixture.wrongPrivateKey, knownHostsEntry: fixture.knownHostsEntry },
                timeoutMs: 20_000,
                workspaceRoot,
            })
            .then(() => null, (e: unknown) => e);

        expect(isTransportFailure(failure)).toBe(true);
        if (!isTransportFailure(failure)) throw new Error('unreachable');
        expect(classifyGitFailure(failure).code).toBe('AUTH_FAILED');
    });

    it('classifies a mismatched known_hosts entry as SSH_HOST_KEY_FAILED', async () => {
        const workspaceRoot = await makeWorkspace();
        const bogusLine = '|1|abcdef1234567890abcdef1234567890|abcdef1234567890abcdef1234567890 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIInvalidKeyMaterialForTestOnly';
        const failure = await nativeGitTransport
            .resolveRef({
                repoUrl: fixture.repoUrlSsh,
                ref: 'main',
                sshAuth: { privateKey: fixture.deployPrivateKey, knownHostsEntry: bogusLine },
                timeoutMs: 20_000,
                workspaceRoot,
            })
            .then(() => null, (e: unknown) => e);

        expect(isTransportFailure(failure)).toBe(true);
        if (!isTransportFailure(failure)) throw new Error('unreachable');
        expect(classifyGitFailure(failure).code).toBe('SSH_HOST_KEY_FAILED');
    });
});
