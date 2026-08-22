/**
 * Unit tests for the native git transport seam:
 * - errors.ts: exit-code/stderr -> GitSourceErrorCode classification,
 *   including the two contractual behaviors (AUTH_FAILED->400 upstream
 *   mapping is pinned in git-source-http.test.ts; private-repo masking here).
 * - credentialHelper.ts: the secret reaches git ONLY via the child env.
 * - gitBinary.ts: probe caching, version floor, actionable absence.
 * - nativeGitTransport.ts: argv hardening, CA bridge, resolve/fetch/verify
 *   flow, and the size watchdog.
 */
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockExecFile } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockExecFile: vi.fn(),
}));

vi.mock('child_process', () => ({
    spawn: mockSpawn,
    execFile: mockExecFile,
}));

// Spawn history must never leak between tests: several assertions inspect a
// specific call index.
beforeEach(() => {
    mockSpawn.mockReset();
});

import { classifyGitFailure, isTransportFailure } from '../services/git/errors';
import { GIT_TOKEN_ENV_VAR, renderCredentialHelper, writeCredentialHelper } from '../services/git/credentialHelper';
import * as gitBinary from '../services/git/gitBinary';
import { nativeGitTransport, startSizeWatchdog } from '../services/git/nativeGitTransport';

const GIT_EXEC_PATH_STUB = 'C:/Program Files/Git/mingw64/libexec/git-core';

/**
 * Shared beforeEach body for the describes that spawn git: a healthy binary
 * probe plus an exec-path stub so CA-bundle detection never reads the real
 * developer installation.
 */
function stubHealthyGitBinary(): void {
    gitBinary.resetGitBinaryProbeForTests();
    mockExecFile.mockReset();
    mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, 'git version 2.45.2'),
    );
    vi.spyOn(gitBinary, 'getGitExecPath').mockResolvedValue(GIT_EXEC_PATH_STUB);
}

// ── Spawn harness ──────────────────────────────────────────────────────

interface ScriptedOutput {
    stdout?: string;
    stderr?: string;
    code?: number;
}

function fakeChild(): EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // killTree's ESRCH fallback on POSIX reaches this when the scripted PID
    // does not exist; the real ChildProcess always has this method.
    child.kill = () => {};
    return child;
}

/** Queue one scripted response per spawn call (last repeats). */
function scriptSpawn(outputs: ScriptedOutput[]): void {
    let i = 0;
    mockSpawn.mockImplementation(() => {
        const out = outputs[Math.min(i, outputs.length - 1)];
        i += 1;
        const child = fakeChild();
        queueMicrotask(() => {
            if (out.stdout !== undefined) child.stdout.emit('data', Buffer.from(out.stdout));
            if (out.stderr !== undefined) child.stderr.emit('data', Buffer.from(out.stderr));
            child.emit('close', out.code ?? 0);
        });
        return child;
    });
}

/** Spawn children that never close, for driving the timeout path. */
function scriptSpawnHanging(): void {
    mockSpawn.mockImplementation(() => fakeChild());
}

function spawnArgs(callIndex: number): string[] {
    return mockSpawn.mock.calls[callIndex][1] as string[];
}

function spawnEnv(callIndex: number): NodeJS.ProcessEnv {
    return mockSpawn.mock.calls[callIndex][2].env as NodeJS.ProcessEnv;
}

async function makeWorkspace(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'sencho-git-transport-test-'));
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// ── errors.ts ──────────────────────────────────────────────────────────

describe('classifyGitFailure (native git stderr corpus)', () => {
    it('maps an authentication refusal with a token to AUTH_FAILED with the contractual message', () => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "fatal: Authentication failed for 'https://github.com/example/repo.git/'",
            exitCode: 128,
            host: 'github.com',
            hasToken: true,
        });
        expect(c.code).toBe('AUTH_FAILED');
        expect(c.message).toBe('Repository authentication failed. Check your token.');
    });

    it('masks a credential prompt without a token as REPO_NOT_FOUND with the private-repo hint', () => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "fatal: could not read Username for 'https://github.com/example/repo.git': terminal prompts disabled",
            exitCode: 128,
            host: 'github.com',
            hasToken: false,
        });
        expect(c.code).toBe('REPO_NOT_FOUND');
        expect(c.message).toBe('Repository not found, or it is private. Add a Personal Access Token if the repo is private.');
    });

    it('gives the token-scope hint for not-found with a token', () => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "fatal: repository 'https://github.com/example/repo.git/' not found",
            exitCode: 128,
            host: 'github.com',
            hasToken: true,
        });
        expect(c.code).toBe('REPO_NOT_FOUND');
        expect(c.message).toBe('Repository not found. Verify the URL and that your token has read access to this repo.');
    });

    it.each([
        ['DNS', "fatal: unable to access 'https://h/x.git/': Could not resolve host: h", 'NETWORK_TIMEOUT'],
        ['refused', "fatal: unable to access 'https://h/x.git/': Failed to connect to h port 443: Connection refused", 'NETWORK_TIMEOUT'],
        ['reset', 'fatal: the remote end hung up unexpectedly', 'NETWORK_TIMEOUT'],
        ['timeout', "fatal: unable to access 'https://h/x.git/': Connection timed out", 'NETWORK_TIMEOUT'],
    ])('maps %s stderr to NETWORK_TIMEOUT', (_label, stderr, code) => {
        expect(classifyGitFailure({ transportFailure: true as const, reason: 'exit', stderr, exitCode: 128, host: 'github.com', hasToken: false }).code).toBe(code);
    });

    it('maps TLS problems to a certificate GIT_ERROR', () => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "fatal: unable to access 'https://h/x.git/': SSL certificate problem: self-signed certificate",
            exitCode: 128,
            host: 'github.com',
            hasToken: false,
        });
        expect(c.code).toBe('GIT_ERROR');
        expect(c.message).toMatch(/certificate/i);
    });

    it.each([
        ['size', { transportFailure: true as const, reason: 'size', maxBytes: 5 * 1024 * 1024, host: 'h', hasToken: false }, 'Repository exceeds the maximum clone size of 5 MB.'],
        ['tip-changed', { transportFailure: true as const, reason: 'tip-changed', host: 'h', hasToken: false }, 'Repository tip changed during fetch; retry the pull.'],
        ['ref-not-found', { transportFailure: true as const, reason: 'ref-not-found', host: 'h', hasToken: false }, 'Branch not found in the repository.'],
        ['timeout', { transportFailure: true as const, reason: 'timeout', host: 'github.com', hasToken: false }, 'Timed out reaching github.com.'],
    ] as const)('maps structured reason %s verbatim', (_label, failure, message) => {
        expect(classifyGitFailure(failure)).toMatchObject({ message });
    });

    it('scrubs credentials from the generic fallback tail', () => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "fatal: unable to access 'https://user:hunter2@h/x.git/': The requested URL returned error: 500",
            exitCode: 128,
            host: 'h',
            hasToken: false,
        });
        expect(c.message).toContain('***');
        expect(c.message).not.toContain('hunter2');
    });

    it('isTransportFailure accepts branded failures and rejects everything else', () => {
        expect(isTransportFailure({ transportFailure: true as const, reason: 'timeout', host: 'h', hasToken: false })).toBe(true);
        // A foreign error that happens to carry similar field names must NOT
        // be adopted at the service boundary: only the brand admits it.
        expect(isTransportFailure({ reason: 'timeout', host: 'h', hasToken: false })).toBe(false);
        expect(isTransportFailure(new Error('boom'))).toBe(false);
        expect(isTransportFailure(null)).toBe(false);
    });
});

// ── credentialHelper.ts ────────────────────────────────────────────────

describe('credential helper script', () => {
    it('references the env variable name and never a literal secret', () => {
        const posix = renderCredentialHelper(false);
        expect(posix).toContain('$SENCHO_GIT_TOKEN');
        expect(posix).toContain(GIT_TOKEN_ENV_VAR);
        expect(posix).not.toMatch(/sekrit/);

        const windows = renderCredentialHelper(true);
        // Delayed expansion (!VAR!) so token characters cannot break out of
        // the echo line during cmd parsing.
        expect(windows).toContain(`!${GIT_TOKEN_ENV_VAR}!`);
        expect(windows).toContain('enabledelayedexpansion');
        expect(windows).not.toMatch(/sekrit/);
    });

    it('writes the helper into the meta dir and returns a forward-slash path', async () => {
        const meta = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-git-helper-test-'));
        const helperPath = await writeCredentialHelper(meta);
        expect(helperPath).not.toContain('\\');
        const written = await fs.readFile(helperPath.replace(/\//g, path.sep), 'utf8');
        expect(written).toBe(renderCredentialHelper(process.platform === 'win32'));
        expect(written).toContain(GIT_TOKEN_ENV_VAR);
        await fs.rm(meta, { recursive: true, force: true });
    });
});

// ── gitBinary.ts ───────────────────────────────────────────────────────

describe('git binary probe', () => {
    beforeEach(() => {
        mockExecFile.mockReset();
        gitBinary.resetGitBinaryProbeForTests();
    });

    it('probes once and caches a healthy binary', async () => {
        mockExecFile.mockImplementation(
            (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, 'git version 2.45.2\n'),
        );
        await expect(gitBinary.ensureGitBinary()).resolves.toBe('git version 2.45.2');
        await expect(gitBinary.ensureGitBinary()).resolves.toBe('git version 2.45.2');
        expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('rejects binaries older than the supported floor and re-probes next time', async () => {
        mockExecFile.mockImplementation(
            (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, 'git version 2.30.0'),
        );
        await expect(gitBinary.ensureGitBinary()).rejects.toThrow(/too old/);
        await expect(gitBinary.ensureGitBinary()).rejects.toThrow(/too old/);
        expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('gives an actionable error when git is absent', async () => {
        mockExecFile.mockImplementation(
            (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(new Error('spawn git ENOENT'), ''),
        );
        await expect(gitBinary.ensureGitBinary()).rejects.toThrow(/could not be executed/);
    });
});

// ── nativeGitTransport.ts ──────────────────────────────────────────────

describe('transport argv hardening', () => {
    beforeEach(() => {
        stubHealthyGitBinary();
    });

    it('hardens every invocation and keeps the token out of argv', async () => {
        scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/main\n` }]);
        const root = await makeWorkspace();

        try {
            await nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                token: 'sekrit-token-value',
                timeoutMs: 5000,
                workspaceRoot: root,
            });

            const args = spawnArgs(0);
            const joined = args.join(' ');

            // Protocol allowlist: https only.
            expect(args).toContain('protocol.allow=never');
            expect(args).toContain('protocol.https.allow=always');

            // Windows pins the OpenSSL backend so http.sslCAInfo is honored
            // (schannel ignores it) and TLS behavior is not host-store-dependent.
            if (process.platform === 'win32') {
                expect(args).toContain('http.sslBackend=openssl');
            }

            // Hooks disabled via an empty dir we own (portable across OSes).
            expect(joined).toMatch(/core\.hooksPath=[^ ]*\.meta\/hooks/);

            // Credentials flow through our helper, which reads the env var.
            expect(joined).toMatch(/credential\.helper=[^ ]*\.meta\/credential-helper/);
            expect(joined).not.toContain('sekrit-token-value');

            const env = spawnEnv(0);
            expect(env.GIT_TERMINAL_PROMPT).toBe('0');
            expect(env.GIT_ASKPASS).toBe('');
            expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
            // Channels GIT_CONFIG_NOSYSTEM does not cover.
            expect(env.GIT_CONFIG_GLOBAL).toBe(os.devNull);
            expect(env.GIT_CONFIG_SYSTEM).toBe(os.devNull);
            expect(env.XDG_CONFIG_HOME).toBe('');
            expect(env.GIT_CONFIG_COUNT).toBe('0');
            expect(env.GIT_TRACE).toBe('');
            expect(env[GIT_TOKEN_ENV_VAR]).toBe('sekrit-token-value');
            expect(env.HOME).toContain('.meta');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('clears credential.helper entirely when no token is supplied', async () => {
        scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/main\n` }]);
        const root = await makeWorkspace();

        try {
            await nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 5000,
                workspaceRoot: root,
            });
            expect(spawnArgs(0)).toContain('credential.helper=');
            expect(spawnEnv(0)[GIT_TOKEN_ENV_VAR]).toBeUndefined();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('combines NODE_EXTRA_CA_CERTS with platform defaults into http.sslCAInfo when set (dev/E2E bridge)', async () => {
        const caPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-git-ca-test-')), 'ca.pem');
        await fs.writeFile(caPath, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
        const prev = process.env.NODE_EXTRA_CA_CERTS;

        try {
            process.env.NODE_EXTRA_CA_CERTS = caPath;
            scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/main\n` }]);
            const root = await makeWorkspace();
            // Machine-independent "Git installation": the exec-path stub points
            // here so detectWindowsCABundle finds OUR bundle, never the real
            // developer install.
            // The exec-path stub only matters on Windows, where the platform
            // default anchors come from Git's bundled bundle. On POSIX the
            // combined PEM is built from /etc/ssl candidates instead.
            const fakeInstall = path.join(root, 'gitroot');
            const fakeBundlePath = path.join(fakeInstall, 'etc', 'ssl', 'certs', 'ca-bundle.crt');
            await fs.mkdir(path.dirname(fakeBundlePath), { recursive: true });
            await fs.writeFile(fakeBundlePath, 'TEST-DEFAULT-BUNDLE-MARKER\n');
            vi.spyOn(gitBinary, 'getGitExecPath').mockResolvedValue(path.join(fakeInstall, 'libexec', 'git-core'));

            await nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 5000,
                workspaceRoot: root,
            });
            // The extra CA is COMBINED with platform defaults into a per-fetch
            // bundle (mirrors Node's add-not-replace semantics), never passed
            // as a lone replacement. Assert on CONTENT, not just the flag.
            const setArgs = spawnArgs(0);
            const combined = setArgs.find((a) => a.startsWith('http.sslCAInfo='));
            expect(combined).toBeDefined();
            expect(combined).toContain('.meta/combined-ca.pem');
            const combinedBody = await fs.readFile(
                (combined as string).slice('http.sslCAInfo='.length).replace(/\//g, path.sep),
                'utf8',
            );
            if (process.platform === 'win32') {
                expect(combinedBody).toContain('TEST-DEFAULT-BUNDLE-MARKER');
                expect(combinedBody).toContain('-----BEGIN CERTIFICATE-----');
            } else {
                expect(combinedBody).toContain('-----BEGIN CERTIFICATE-----');
            }

            // Without the variable: Windows anchors to the detected Git bundle
            // directly; POSIX passes nothing so system trust applies.
            delete process.env.NODE_EXTRA_CA_CERTS;
            scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/main\n` }]);
            const root2 = await makeWorkspace();
            await nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 5000,
                workspaceRoot: root2,
            });
            const caArgs = spawnArgs(mockSpawn.mock.calls.length - 1).filter((a) => a.startsWith('http.sslCAInfo='));
            if (process.platform === 'win32') {
                expect(caArgs.length).toBe(1);
                expect(caArgs[0]).toContain('gitroot');
                expect(caArgs[0]).toMatch(/ca-bundle\.crt$/);
            } else {
                expect(caArgs.length).toBe(0);
            }
            await fs.rm(root2, { recursive: true, force: true });
        } finally {
            if (prev === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
            else process.env.NODE_EXTRA_CA_CERTS = prev;
            await fs.rm(path.dirname(caPath), { recursive: true, force: true });
        }
    });

    it.each([
        ['plain http', 'http://github.com/example/repo.git'],
        ['embedded userinfo', 'https://user:pass@github.com/example/repo.git'],
    ])('rejects %s URLs before any process spawns', async (_label, repoUrl) => {
        await expect(nativeGitTransport.resolveRef({ repoUrl, ref: 'main', workspaceRoot: os.tmpdir() })).rejects.toMatchObject({ transportFailure: true as const, reason: 'invalid-url' });
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('rejects option-injecting ref names', async () => {
        await expect(nativeGitTransport.resolveRef({
            repoUrl: 'https://github.com/example/repo.git',
            ref: '--upload-pack=pwn',
            workspaceRoot: os.tmpdir(),
        })).rejects.toMatchObject({ transportFailure: true as const, reason: 'invalid-ref' });
        expect(mockSpawn).not.toHaveBeenCalled();
    });
});

describe('resolve/fetch/verify flow', () => {
    beforeEach(() => {
        stubHealthyGitBinary();
    });

    it('clones shallow/single-branch and verifies the checkout against the resolved SHA', async () => {
        // fetchAtCommit spawns clone first, then rev-parse; resolution happened
        // upstream (see resolveRef tests above).
        scriptSpawn([
            { code: 0 },              // clone
            { stdout: `${SHA_A}\n` }, // rev-parse HEAD
        ]);
        const root = await makeWorkspace();

        try {
            const result = await nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            });
            expect(result.commitSha).toBe(SHA_A);
            expect(result.dir).toBe(path.join(root, 'repo'));

            const cloneArgs = spawnArgs(0);
            for (const flag of ['--depth=1', '--single-branch', '--no-tags', '--no-recurse-submodules']) {
                expect(cloneArgs).toContain(flag);
            }
            const branchIdx = cloneArgs.indexOf('--branch');
            expect(branchIdx).toBeGreaterThan(-1);
            expect(cloneArgs[branchIdx + 1]).toBe('main');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('refuses to return content whose SHA diverges from the resolution (tip race)', async () => {
        scriptSpawn([
            { code: 0 },              // clone
            { stdout: `${SHA_B}\n` }, // rev-parse HEAD diverges
        ]);
        const root = await makeWorkspace();

        try {
            await expect(nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({ transportFailure: true as const, reason: 'tip-changed' });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('raises ref-not-found when ls-remote lists no matching head', async () => {
        scriptSpawn([{ stdout: '' }]);
        const root = await makeWorkspace();

        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'ghost',
                timeoutMs: 5000,
                workspaceRoot: root,
            })).rejects.toMatchObject({ transportFailure: true as const, reason: 'ref-not-found' });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    // Real clocks, short budget: a hanging child settles only through the
    // timeout path. (Fake timers here would freeze every later real-timer
    // test in this file if this test ever failed mid-way.)
    it('kills the child tree and reports a timeout when the fetch exceeds its budget', async () => {
        scriptSpawnHanging();
        const root = await makeWorkspace();

        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 250,
                workspaceRoot: root,
            })).rejects.toMatchObject({ transportFailure: true as const, reason: 'timeout' });

            // killTree on Windows tears the tree down via taskkill through the
            // same spawn seam ('/pid' is its first argument).
            if (process.platform === 'win32') {
                const killer = mockSpawn.mock.calls.find((c) => (c[1] as string[])?.[0] === '/pid');
                expect(killer).toBeDefined();
            }
        } finally {
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

// ── Size watchdog ──────────────────────────────────────────────────────

describe('startSizeWatchdog', () => {
    // Real timers on purpose: treeSize reads the real filesystem, and faking
    // setImmediate starves the FS completion callbacks under fake clocks.
    const WATCHDOG_WAIT_MS = 2_400; // > two 1s intervals

    it('fires once the workspace exceeds the cap', async () => {
        const root = await makeWorkspace();
        await fs.writeFile(path.join(root, 'blob.bin'), 'x'.repeat(10));
        let breached = false;
        const wd = startSizeWatchdog(root, 5, () => {
            breached = true;
        });

        try {
            await new Promise((r) => setTimeout(r, WATCHDOG_WAIT_MS));
            expect(breached).toBe(true);
        } finally {
            wd.stop();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('stays quiet while under the cap', async () => {
        const root = await makeWorkspace();
        await fs.writeFile(path.join(root, 'small.txt'), 'tiny');
        let breached = false;
        const wd = startSizeWatchdog(root, 1024 * 1024, () => {
            breached = true;
        });

        try {
            await new Promise((r) => setTimeout(r, WATCHDOG_WAIT_MS));
            expect(breached).toBe(false);
        } finally {
            wd.stop();
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

describe('clone failure classification and final size gate', () => {
    beforeEach(() => {
        stubHealthyGitBinary();
    });

    it('maps a failing ls-remote exit into an exit failure carrying stderr and argv', async () => {
        scriptSpawn([{ code: 128, stderr: "fatal: could not read Username for 'https://github.com/example/repo.git': terminal prompts disabled" }]);
        const root = await makeWorkspace();

        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 5000,
                workspaceRoot: root,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'exit',
                stderr: expect.stringContaining('could not read Username'),
                argv: expect.any(Array),
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('classifies a failed clone by its real stderr instead of falling through', async () => {
        scriptSpawn([
            { code: 128, stderr: "fatal: Authentication failed for 'https://github.com/example/repo.git/'" },
        ]);
        const root = await makeWorkspace();

        try {
            await expect(nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'exit',
                exitCode: 128,
                stderr: expect.stringContaining('Authentication failed'),
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('rejects when rev-parse emits a non-SHA', async () => {
        scriptSpawn([
            { code: 0 },
            { stdout: 'not-a-sha\n' },
        ]);
        const root = await makeWorkspace();

        try {
            await expect(nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'exit',
                stderr: expect.stringContaining('unexpected rev-parse output'),
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('enforces the size cap deterministically after a successful clone', async () => {
        // Pre-place an oversized tree so the final measure (not the interval
        // watchdog) is what catches it. No timers involved.
        scriptSpawn([
            { code: 0 },
            { stdout: `${SHA_A}
` },
        ]);
        const root = await makeWorkspace();
        await fs.mkdir(path.join(root, 'repo'), { recursive: true });
        await fs.writeFile(path.join(root, 'repo', 'blob.bin'), 'x'.repeat(64));

        try {
            await expect(nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 8,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'size',
                maxBytes: 8,
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('reports a clone-phase timeout and kills the child', async () => {
        scriptSpawnHanging();
        const root = await makeWorkspace();

        try {
            await expect(nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                commitSha: SHA_A,
                timeoutMs: 250,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({ reason: 'timeout' });
            if (process.platform === 'win32') {
                const killer = mockSpawn.mock.calls.find((c) => (c[1] as string[])?.[0] === '/pid');
                expect(killer).toBeDefined();
            }
        } finally {
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
