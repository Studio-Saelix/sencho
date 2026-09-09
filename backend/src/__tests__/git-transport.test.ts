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
import { promises as fs, rmSync, existsSync } from 'fs';
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
import {
    CREDENTIAL_HELPER_CONFIG_VALUE,
    GIT_HELPER_PATH_ENV_VAR,
    GIT_TOKEN_ENV_VAR,
    renderCredentialHelper,
    writeCredentialHelper,
} from '../services/git/credentialHelper';
import * as gitBinary from '../services/git/gitBinary';
import { nativeGitTransport, REF_MAX_LEN, startSizeWatchdog, verifyFastForward } from '../services/git/nativeGitTransport';
import { withLoopbackTargetProtection } from './helpers/allowLoopbackTargets';
import { GIT_ALLOWED_HOST_ENV_VAR } from '../services/git/credentialHelper';

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
    // does not exist (the real ChildProcess always has this method). A real
    // kill eventually produces a 'close' event, which runGit now waits for
    // before settling; mirror that here so hanging-timeout tests behave like
    // a real killed process instead of hanging until the safety-net fires.
    child.kill = () => {
        queueMicrotask(() => child.emit('close', null));
    };
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
        ['curl refused', "fatal: unable to access 'https://h/x.git/': Failed to connect to h port 443 after 1 ms: Could not connect to server", 'NETWORK_TIMEOUT'],
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
        ['ref-not-found', { transportFailure: true as const, reason: 'ref-not-found', host: 'h', hasToken: false }, 'The configured branch, tag, or commit was not found in the repository.'],
        ['ssh-auth-required', { transportFailure: true as const, reason: 'ssh-auth-required', host: 'h', hasToken: false }, 'SSH repository URLs require a deploy key.'],
        ['unsupported-ref', { transportFailure: true as const, reason: 'unsupported-ref', host: 'h', hasToken: false }, 'The configured commit is not reachable on this repository host. Use a branch or tag, or a commit the host advertises.'],
        ['timeout', { transportFailure: true as const, reason: 'timeout', host: 'github.com', hasToken: false }, 'Timed out reaching github.com.'],
    ] as const)('maps structured reason %s verbatim', (_label, failure, message) => {
        expect(classifyGitFailure(failure)).toMatchObject({ message });
    });

    it('classifies a server SHA-fetch refusal as UNSUPPORTED_REF', () => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "error: Server does not allow request for unadvertised object 3b18e5d",
            exitCode: 128,
            host: 'github.com',
            hasToken: false,
        });
        expect(c.code).toBe('UNSUPPORTED_REF');
    });

    it('classifies GitHub not-our-ref SHA refusal as UNSUPPORTED_REF', () => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: 'fatal: remote error: upload-pack: not our ref abcdef0123456789abcdef0123456789abcdef',
            exitCode: 128,
            host: 'github.com',
            hasToken: true,
        });
        expect(c.code).toBe('UNSUPPORTED_REF');
    });

    it.each([
        // The HTTP shapes are verified against a real git binary talking to a
        // fixture server (git-transport-ratelimit.integration.test.ts): git
        // reports the status line only, never the response body.
        ['bare 429 from the host', "fatal: unable to access 'https://h/x.git/': The requested URL returned error: 429"],
        ['429 with trailing text', "fatal: unable to access 'https://h/x.git/': The requested URL returned error: 429 Too Many Requests"],
        // Text a host sends through the pack stream does reach stderr as a
        // remote: line, unlike an HTTP response body.
        ['remote sideband rate-limit message', "remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.\nfatal: the remote end hung up unexpectedly"],
        ['remote sideband abuse-detection message', "remote: You have triggered an abuse detection mechanism.\nfatal: the remote end hung up unexpectedly"],
    ])('classifies %s as RATE_LIMITED', (_label, stderr) => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr,
            exitCode: 128,
            host: 'github.com',
            hasToken: true,
        });
        expect(c.code).toBe('RATE_LIMITED');
        expect(c.message).toMatch(/rate limited/i);
    });

    it('classifies an unambiguous rate limit as RATE_LIMITED even without a token', () => {
        // Rule 3 (see the module header) takes precedence over rule 2's
        // no-token private-repo masking: a throttle leaks nothing about repo
        // existence, so it should not be reported as REPO_NOT_FOUND.
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "remote: You have exceeded a secondary rate limit.\nfatal: the remote end hung up unexpectedly",
            exitCode: 128,
            host: 'github.com',
            hasToken: false,
        });
        expect(c.code).toBe('RATE_LIMITED');
    });

    it('does not send a rate-limited operator to rotate a working credential', () => {
        // A sideband throttle message can arrive alongside a 403 fatal line,
        // which the auth branch below would otherwise claim. Both the code
        // and the message are asserted: reporting RATE_LIMITED while still
        // saying "check your token" would leave the operator with the same
        // wrong action.
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "remote: You have exceeded a secondary rate limit.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
            exitCode: 128,
            host: 'github.com',
            hasToken: true,
        });
        expect(c.code).toBe('RATE_LIMITED');
        expect(c.message).not.toMatch(/check your token/i);
    });

    it('leaves a bare 403 with no rate-limit wording as an auth failure', () => {
        // Guards the other direction, and pins a real constraint: git does
        // not surface an HTTP response body, so a host that signals a
        // throttle as a bare 403 is indistinguishable from a rejected
        // credential. Widening the rate-limit branch to cover every 403
        // would make a genuinely bad token read as a throttle to wait out.
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
            exitCode: 128,
            host: 'github.com',
            hasToken: true,
        });
        expect(c.code).toBe('AUTH_FAILED');
    });

    it('does not mistake a repository named "rate-limiter" for a rate-limit signal', () => {
        // git's fatal line echoes the full repo URL verbatim, so an
        // unscoped rate-limit word match would fire on the path itself. A
        // genuinely bad token against a repo whose name happens to contain
        // rate-limit wording must still classify as an auth failure.
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "fatal: unable to access 'https://github.com/acme/rate-limiter.git/': The requested URL returned error: 403",
            exitCode: 128,
            host: 'github.com',
            hasToken: true,
        });
        expect(c.code).toBe('AUTH_FAILED');
    });

    it('does not mistake an upload-pack progress counter for a 429 status', () => {
        // Progress lines like "Counting objects: 100% (429/429)" reach
        // stderr from the server sideband and can contain the literal digits
        // 429 with no connection to an HTTP status at all.
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "remote: Counting objects: 100% (429/429), done.\nfatal: the remote end hung up unexpectedly",
            exitCode: 128,
            host: 'github.com',
            hasToken: false,
        });
        expect(c.code).toBe('NETWORK_TIMEOUT');
    });

    it('does not mistake an unrelated transient-error sideband for a rate limit', () => {
        const c = classifyGitFailure({
            transportFailure: true as const,
            reason: 'exit',
            stderr: "remote: Internal server error, please retry later\nfatal: the remote end hung up unexpectedly",
            exitCode: 128,
            host: 'github.com',
            hasToken: false,
        });
        expect(c.code).toBe('NETWORK_TIMEOUT');
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
        const script = renderCredentialHelper();
        expect(script).toContain('$SENCHO_GIT_TOKEN');
        expect(script).toContain(GIT_TOKEN_ENV_VAR);
        expect(script).not.toMatch(/sekrit/);
    });

    it('writes the helper into the meta dir and returns a forward-slash path', async () => {
        const meta = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-git-helper-test-'));
        const helperPath = await writeCredentialHelper(meta);
        expect(helperPath).not.toContain('\\');
        const written = await fs.readFile(helperPath.replace(/\//g, path.sep), 'utf8');
        expect(written).toBe(renderCredentialHelper());
        expect(written).toContain(GIT_TOKEN_ENV_VAR);
        await fs.rm(meta, { recursive: true, force: true });
    });

    it('names the helper through an env variable so no workspace path can reach the shell string', () => {
        // Git parses credential.helper as a shell string, so any path
        // interpolated here would word-split on a space (and worse on a quote).
        // The value must therefore be a constant that mentions no path at all.
        expect(CREDENTIAL_HELPER_CONFIG_VALUE).toBe(`!"$${GIT_HELPER_PATH_ENV_VAR}"`);
        expect(CREDENTIAL_HELPER_CONFIG_VALUE).not.toMatch(/[/\\]/);
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

            // Credentials flow through our helper, named by env variable so
            // the config value carries no path that a space could split.
            expect(args).toContain(`credential.helper=${CREDENTIAL_HELPER_CONFIG_VALUE}`);
            expect(joined).not.toMatch(/credential\.helper=[^ ]*\.meta/);
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
            expect(env[GIT_HELPER_PATH_ENV_VAR]).toMatch(/\.meta\/credential-helper\.sh$/);
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
            // No helper is written at all, so nothing can answer a prompt.
            expect(spawnEnv(0)[GIT_HELPER_PATH_ENV_VAR]).toBeUndefined();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('keeps the helper config value and the helper env variable in lockstep', async () => {
        // These three have to agree: the script on disk, the env variable
        // naming it, and the config value referencing that variable. If the
        // config named a variable nothing exported, git would find no helper,
        // fetch anonymously, and a private repo's 401 would classify as
        // REPO_NOT_FOUND instead of AUTH_FAILED, with no error to show for it.
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
            const referencesHelper = spawnArgs(0).includes(`credential.helper=${CREDENTIAL_HELPER_CONFIG_VALUE}`);
            const helperPath = spawnEnv(0)[GIT_HELPER_PATH_ENV_VAR];
            expect(referencesHelper).toBe(true);
            expect(helperPath).toBeDefined();
            // And the path the variable names is a script that actually exists.
            const body = await fs.readFile((helperPath as string).replace(/\//g, path.sep), 'utf8');
            expect(body).toBe(renderCredentialHelper());
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('exports the configured HTTPS host[:port] to the credential helper so a cross-host redirect cannot match', async () => {
        scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/main\n` }]);
        const root = await makeWorkspace();
        try {
            await nativeGitTransport.resolveRef({
                repoUrl: 'https://git.example.com/example/repo.git',
                ref: 'main',
                token: 'sekrit',
                timeoutMs: 5000,
                workspaceRoot: root,
            });
            const env = spawnEnv(0);
            expect(env[GIT_ALLOWED_HOST_ENV_VAR]).toBe('git.example.com');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('does not export the allowed host when no token is supplied (no credentials to scope)', async () => {
        scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/main\n` }]);
        const root = await makeWorkspace();
        try {
            await nativeGitTransport.resolveRef({
                repoUrl: 'https://git.example.com/example/repo.git',
                ref: 'main',
                timeoutMs: 5000,
                workspaceRoot: root,
            });
            const env = spawnEnv(0);
            expect(env[GIT_ALLOWED_HOST_ENV_VAR]).toBeUndefined();
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

    it('combines a per-source CA PEM into http.sslCAInfo without NODE_EXTRA_CA_CERTS', async () => {
        const prev = process.env.NODE_EXTRA_CA_CERTS;
        delete process.env.NODE_EXTRA_CA_CERTS;
        try {
            scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/main\n` }]);
            const root = await makeWorkspace();
            const perSourcePem = '-----BEGIN CERTIFICATE-----\nPER-SOURCE-CA-MARKER\n-----END CERTIFICATE-----\n';
            await nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                caBundlePem: perSourcePem,
                timeoutMs: 5000,
                workspaceRoot: root,
            });
            const setArgs = spawnArgs(0);
            // Git never follows a redirect itself; an approved destination is
            // resolved by the preflight and retried explicitly.
            expect(setArgs).toContain('http.followRedirects=false');
            const combined = setArgs.find((a) => a.startsWith('http.sslCAInfo='));
            expect(combined).toBeDefined();
            if (process.platform !== 'win32') {
                const combinedBody = await fs.readFile(
                    (combined as string).slice('http.sslCAInfo='.length).replace(/\//g, path.sep),
                    'utf8',
                );
                expect(combinedBody).toContain('PER-SOURCE-CA-MARKER');
            }
            await fs.rm(root, { recursive: true, force: true });
        } finally {
            if (prev === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
            else process.env.NODE_EXTRA_CA_CERTS = prev;
        }
    });

    it.each([
        ['plain http', 'http://github.com/example/repo.git'],
        ['embedded userinfo', 'https://user:pass@github.com/example/repo.git'],
    ])('rejects %s URLs before any process spawns', async (_label, repoUrl) => {
        await expect(nativeGitTransport.resolveRef({ repoUrl, ref: 'main', workspaceRoot: os.tmpdir() })).rejects.toMatchObject({ transportFailure: true as const, reason: 'invalid-url' });
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('rejects SSH repository URLs without deploy-key authentication before spawning git', async () => {
        await expect(nativeGitTransport.resolveRef({
            repoUrl: 'ssh://git@ssh.example/org/repo.git',
            ref: 'main',
            workspaceRoot: os.tmpdir(),
        })).rejects.toMatchObject({ transportFailure: true as const, reason: 'ssh-auth-required' });
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

    // Every case here was checked against the real `git check-ref-format
    // --branch` on the local git binary; the allow-list regex this replaces
    // rejected all four even though git accepts them as branch names.
    it.each([
        ['leading underscore', '_feature'],
        ['non-ASCII path segment', 'feature/café'],
        ['fully non-ASCII', '分支'],
        ['hash character', 'issue#123'],
    ])('accepts the git-valid ref name: %s', async (_label, ref) => {
        scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/${ref}\n` }]);
        const root = await makeWorkspace();
        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref,
                timeoutMs: 5000,
                workspaceRoot: root,
            })).resolves.toMatchObject({ commitSha: SHA_A });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it.each([
        ['leading dash (option injection)', '-flag'],
        ['embedded double-dot', 'wip..x'],
        ['trailing dot', 'foo.'],
        ['.lock suffix', 'foo.lock'],
        ['mid-path .lock segment', 'a/foo.lock/b'],
        ['leading dot component', '.hidden'],
        ['trailing slash', 'foo/'],
        ['double slash', 'foo//bar'],
        ['reflog syntax', 'foo@{upstream}'],
        ['embedded space', 'foo bar'],
        ['embedded tilde', 'foo~1'],
    ])('rejects the git-invalid ref name: %s', async (_label, ref) => {
        await expect(nativeGitTransport.resolveRef({
            repoUrl: 'https://github.com/example/repo.git',
            ref,
            workspaceRoot: os.tmpdir(),
        })).rejects.toMatchObject({ transportFailure: true as const, reason: 'invalid-ref' });
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    // The API accepts branches up to REF_MAX_LEN and stores them; a branch
    // that survived creation must still be fetchable. Real git imposes no
    // comparable limit (check-ref-format --branch accepts names into the
    // thousands), so the only bound that matters is the one both sides share.
    it.each([
        ['at the shared limit', REF_MAX_LEN],
        ['just under the shared limit', REF_MAX_LEN - 1],
        ['longer than the old transport-only cap', 220],
    ])('accepts a long but valid branch name %s (%i chars)', async (_label, length) => {
        const ref = 'b'.repeat(length);
        scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/${ref}\n` }]);
        const root = await makeWorkspace();
        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref,
                timeoutMs: 5000,
                workspaceRoot: root,
            })).resolves.toMatchObject({ commitSha: SHA_A });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('rejects a branch name one character past the shared limit', async () => {
        await expect(nativeGitTransport.resolveRef({
            repoUrl: 'https://github.com/example/repo.git',
            ref: 'b'.repeat(REF_MAX_LEN + 1),
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
                refKind: 'branch',
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
                refKind: 'branch',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({ transportFailure: true as const, reason: 'tip-changed' });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('fetches a tag through a bare --branch name', async () => {
        scriptSpawn([
            { code: 0 },              // clone
            { stdout: `${SHA_A}\n` }, // rev-parse HEAD
        ]);
        const root = await makeWorkspace();
        try {
            const result = await nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'v1',
                refKind: 'tag',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            });
            expect(result.commitSha).toBe(SHA_A);
            const cloneArgs = spawnArgs(0);
            const branchIdx = cloneArgs.indexOf('--branch');
            expect(branchIdx).toBeGreaterThan(-1);
            expect(cloneArgs[branchIdx + 1]).toBe('v1');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('fetches a pinned SHA via init + fetch + detached checkout', async () => {
        scriptSpawn([
            { code: 0 },              // init
            { code: 0 },              // fetch <sha>
            { code: 0 },              // checkout --detach
            { stdout: `${SHA_A}\n` }, // rev-parse HEAD
        ]);
        const root = await makeWorkspace();
        try {
            const result = await nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: SHA_A,
                refKind: 'sha',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            });
            expect(result.commitSha).toBe(SHA_A);
            const initArgs = spawnArgs(0);
            expect(initArgs).toContain('init');
            const fetchArgs = spawnArgs(1);
            expect(fetchArgs).toContain('fetch');
            expect(fetchArgs).toContain(SHA_A);
            const checkoutArgs = spawnArgs(2);
            expect(checkoutArgs).toContain('checkout');
            expect(checkoutArgs).toContain('--detach');
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

    it('resolves a branch over a tag of the same name and records kind branch', async () => {
        scriptSpawn([{
            stdout: `${SHA_A}\trefs/heads/release\n${SHA_B}\trefs/tags/release\n`,
        }]);
        const root = await makeWorkspace();
        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'release',
                timeoutMs: 5000,
                workspaceRoot: root,
            })).resolves.toMatchObject({ commitSha: SHA_A, kind: 'branch' });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('pins HTTPS to the validated address while resolving an annotated tag', async () => {
        scriptSpawn([{
            stdout: `${SHA_B}\trefs/tags/v1\n${SHA_A}\trefs/tags/v1^{}\n`,
        }]);
        const root = await makeWorkspace();
        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://pinned.example:8443/example/repo.git',
                ref: 'v1',
                timeoutMs: 5000,
                workspaceRoot: root,
            })).resolves.toMatchObject({ commitSha: SHA_A, kind: 'tag' });
            const lsRemoteArgs = mockSpawn.mock.calls[0][1] as string[];
            expect(lsRemoteArgs).toContain('refs/tags/v1^{}');
            expect(lsRemoteArgs).toContain('http.followRedirects=false');
            expect(lsRemoteArgs).toContain('http.proxy=');
            expect(lsRemoteArgs).toContain('http.curloptResolve=pinned.example:8443:93.184.216.34');
            const env = spawnEnv(0);
            expect(env.HTTP_PROXY).toBe('');
            expect(env.HTTPS_PROXY).toBe('');
            expect(env.ALL_PROXY).toBe('');
            expect(env.http_proxy).toBe('');
            expect(env.https_proxy).toBe('');
            expect(env.all_proxy).toBe('');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('pins SSH to the validated address while retaining host identity and port', async () => {
        scriptSpawn([{ stdout: `${SHA_A}\trefs/heads/main\n` }]);
        const root = await makeWorkspace();
        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'ssh://git@pinned.example:2222/example/repo.git',
                ref: 'main',
                sshAuth: {
                    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nYWJj\n-----END OPENSSH PRIVATE KEY-----\n',
                    knownHostsEntry: 'pinned.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb3JzL3Rlc3Q=\n',
                },
                timeoutMs: 5000,
                workspaceRoot: root,
            })).resolves.toMatchObject({ commitSha: SHA_A, kind: 'branch' });

            const sshCommand = spawnEnv(0).GIT_SSH_COMMAND;
            expect(sshCommand).toContain('Hostname=93.184.216.34');
            expect(sshCommand).toContain('HostKeyAlias=[pinned.example]:2222');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('resolves a lightweight tag from its raw ref line', async () => {
        scriptSpawn([{ stdout: `${SHA_A}\trefs/tags/v1\n` }]);
        const root = await makeWorkspace();
        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'v1',
                timeoutMs: 5000,
                workspaceRoot: root,
            })).resolves.toMatchObject({ commitSha: SHA_A, kind: 'tag' });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('self-resolves a full SHA without a network round trip', async () => {
        const root = await makeWorkspace();
        try {
            await expect(withLoopbackTargetProtection(() => nativeGitTransport.resolveRef({
                repoUrl: 'https://127.0.0.1/example/repo.git',
                ref: SHA_A.toUpperCase(),
                timeoutMs: 5000,
                workspaceRoot: root,
            }))).resolves.toMatchObject({ commitSha: SHA_A, kind: 'sha' });
            // The SHA needs no ls-remote: the identity IS the value.
            expect(mockSpawn).not.toHaveBeenCalled();
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
                refKind: 'branch',
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
                refKind: 'branch',
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
                refKind: 'branch',
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

    it('enforces the size cap during fast-forward verification', async () => {
        scriptSpawn([
            { code: 0 },
            { code: 0 },
            { stdout: '1\n' },
            { code: 1 },
            { stdout: 'true\n' },
            { code: 0 },
            { stdout: '2\n' },
            { code: 0 },
            { code: 0 },
        ]);
        const root = await makeWorkspace();
        await fs.writeFile(path.join(root, 'blob.bin'), 'x'.repeat(64));

        try {
            await expect(verifyFastForward({
                repoUrl: 'https://github.com/example/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
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

    it('rejects unsafe targets during fast-forward verification', async () => {
        const root = await makeWorkspace();
        try {
            await expect(withLoopbackTargetProtection(() => verifyFastForward({
                repoUrl: 'https://127.0.0.1/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            }))).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'unsafe-target',
            });
            expect(mockSpawn).not.toHaveBeenCalled();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('deepens history exponentially with a bounded number of remote fetches', async () => {
        scriptSpawn([
            { code: 0 },
            { code: 0 },
            { stdout: '1\n' },
            { code: 1 },
            { stdout: 'true\n' },
            { code: 0 },
            { stdout: '2\n' },
            { code: 1 },
            { stdout: 'true\n' },
            { code: 0 },
            { stdout: '4\n' },
            { code: 0 },
            { code: 0 },
        ]);
        const root = await makeWorkspace();

        try {
            await expect(verifyFastForward({
                repoUrl: 'https://github.com/example/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).resolves.toBe(true);

            const deepenArgs = mockSpawn.mock.calls
                .map((call) => call[1] as string[])
                .filter((args) => args.includes('fetch'));
            expect(deepenArgs).toHaveLength(3);
            expect(deepenArgs[1]).toContain('--deepen=1');
            expect(deepenArgs[2]).toContain('--deepen=2');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('throws a timeout when fetch rounds are exhausted before ancestry is proven', async () => {
        const scripted: ScriptedOutput[] = [{ code: 0 }, { code: 0 }, { stdout: '1\n' }];
        for (let i = 0; i < 13; i += 1) {
            scripted.push(
                { code: 1 },
                { stdout: 'true\n' },
                { code: 0 },
                { stdout: `${i + 2}\n` },
            );
        }
        scripted.push({ code: 1 }, { stdout: 'true\n' });
        scriptSpawn(scripted);
        const root = await makeWorkspace();

        try {
            await expect(verifyFastForward({
                repoUrl: 'https://github.com/example/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'timeout',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('classifies a hanging ancestry probe as a timeout transport failure', async () => {
        mockSpawn.mockImplementation((_cmd, args) => {
            const argv = args as string[];
            const child = fakeChild();
            if (argv.includes('cat-file')) {
                return child;
            }
            queueMicrotask(() => {
                if (argv.includes('rev-list')) {
                    child.stdout.emit('data', Buffer.from('1\n'));
                }
                if (argv.includes('rev-parse') && argv.includes('--is-shallow-repository')) {
                    child.stdout.emit('data', Buffer.from('true\n'));
                }
                child.emit('close', 0);
            });
            return child;
        });
        const root = await makeWorkspace();

        try {
            await expect(verifyFastForward({
                repoUrl: 'https://github.com/example/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
                timeoutMs: 250,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'timeout',
            });
        } finally {
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('treats an invalid shallow-repository probe as a transport failure', async () => {
        scriptSpawn([
            { code: 0 },
            { code: 0 },
            { stdout: '1\n' },
            { code: 1 },
            { stdout: 'maybe\n' },
        ]);
        const root = await makeWorkspace();

        try {
            await expect(verifyFastForward({
                repoUrl: 'https://github.com/example/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'exit',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('treats merge-base operational failures as transport failures', async () => {
        scriptSpawn([
            { code: 0 },
            { code: 0 },
            { stdout: '1\n' },
            { code: 0 },
            { code: 128, stderr: 'fatal: bad object\n' },
        ]);
        const root = await makeWorkspace();

        try {
            await expect(verifyFastForward({
                repoUrl: 'https://github.com/example/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'exit',
                exitCode: 128,
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('throws a timeout when deepen stagnates while history remains shallow', async () => {
        scriptSpawn([
            { code: 0 },
            { code: 0 },
            { stdout: '1\n' },
            { code: 1 },
            { stdout: 'true\n' },
            { code: 0 },
            { stdout: '1\n' },
            { stdout: 'true\n' },
        ]);
        const root = await makeWorkspace();

        try {
            await expect(verifyFastForward({
                repoUrl: 'https://github.com/example/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({
                transportFailure: true as const,
                reason: 'timeout',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('removes the fast-forward scratch repo so shared workspace size checks stay accurate', async () => {
        scriptSpawn([
            { code: 0 },
            { code: 0 },
            { stdout: '1\n' },
            { code: 1 },
            { stdout: 'true\n' },
            { code: 0 },
            { stdout: '2\n' },
            { code: 0 },
            { code: 0 },
        ]);
        const root = await makeWorkspace();

        try {
            await expect(verifyFastForward({
                repoUrl: 'https://github.com/example/repo.git',
                ancestorSha: SHA_B,
                descendantSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).resolves.toBe(true);
            expect(existsSync(path.join(root, 'ff-check'))).toBe(false);
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
                refKind: 'branch',
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

    // Real timers: the interval watchdog polls the real filesystem once a
    // second, so this exercises the actual breach-during-active-clone race
    // rather than a scripted stand-in for it.
    it('classifies a watchdog breach that kills an in-flight clone as a size failure, not a generic exit', async () => {
        const root = await makeWorkspace();
        await fs.writeFile(path.join(root, 'blob.bin'), 'x'.repeat(64));

        let killed = false;
        mockSpawn.mockImplementation(() => {
            const child = fakeChild();
            // Simulates killTree's POSIX SIGKILL path: the child never closes
            // on its own, only once the watchdog's breach kill reaches it.
            child.kill = () => {
                killed = true;
                queueMicrotask(() => child.emit('close', null));
            };
            return child;
        });

        try {
            await expect(nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                refKind: 'branch',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 8,
            })).rejects.toMatchObject({ transportFailure: true as const, reason: 'size', maxBytes: 8 });
            expect(killed).toBe(true);
        } finally {
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('fails closed when the final size measurement cannot be read', async () => {
        const root = await makeWorkspace();
        let call = 0;
        mockSpawn.mockImplementation(() => {
            const child = fakeChild();
            const idx = call++;
            queueMicrotask(() => {
                if (idx === 0) {
                    child.emit('close', 0); // clone
                } else {
                    child.stdout.emit('data', Buffer.from(`${SHA_A}\n`)); // rev-parse
                    // Destroy the workspace so the final treeSize measurement
                    // cannot read it; a real fetch would have the checkout
                    // vanish out from under it the same way (deleted volume,
                    // permission change mid-walk).
                    rmSync(root, { recursive: true, force: true });
                    child.emit('close', 0);
                }
            });
            return child;
        });

        try {
            await expect(nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                refKind: 'branch',
                commitSha: SHA_A,
                timeoutMs: 5000,
                workspaceRoot: root,
                maxBytes: 100 * 1024 * 1024,
            })).rejects.toMatchObject({ transportFailure: true as const, reason: 'size', maxBytes: 100 * 1024 * 1024 });
        } finally {
            mockSpawn.mockReset();
        }
    });

    it('does not settle a timed-out fetch until the child tree confirms termination', async () => {
        let killInvoked = false;
        let settled = false;
        mockSpawn.mockImplementation(() => {
            const child = fakeChild();
            child.kill = () => {
                killInvoked = true;
                // Simulate a real OS termination confirmation arriving after
                // a short, non-zero delay rather than synchronously with the
                // kill call.
                setTimeout(() => child.emit('close', null), 150);
            };
            return child;
        });
        const root = await makeWorkspace();

        try {
            const promise = nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 50,
                workspaceRoot: root,
            });
            promise.catch(() => {}).finally(() => {
                settled = true;
            });

            // The timeout has fired and the kill has been issued, but the
            // simulated confirmation has not arrived yet: settling here
            // would let a caller start cleaning up the workspace while the
            // child tree is still alive.
            await vi.waitFor(() => expect(killInvoked).toBe(true), { timeout: 250 });
            expect(settled).toBe(false);

            await expect(promise).rejects.toMatchObject({ transportFailure: true as const, reason: 'timeout' });
            expect(settled).toBe(true);
        } finally {
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('waits for taskkill to finish even when the direct child closes first (stubbed as win32 so this runs on every CI platform)', async () => {
        const origPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        let taskkillDone = false;
        let settled = false;
        mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === '/pid') {
                // taskkill is a separate process walking the tree; it outlives
                // the direct child it was asked to kill.
                const killer = fakeChild();
                killer.kill = () => {};
                setTimeout(() => {
                    taskkillDone = true;
                    killer.emit('close', 0);
                }, 600);
                return killer;
            }
            const child = fakeChild();
            // The direct git child dies on its own clock, after the 50ms
            // budget issues the kill and long before taskkill has finished
            // with its descendants. Deliberately NOT tied to child.kill():
            // the successful-taskkill path never calls that, so a mock which
            // only closed from it would let a transport that ignores taskkill
            // entirely still look correct here.
            setTimeout(() => child.emit('close', null), 100);
            return child;
        });
        const root = await makeWorkspace();

        try {
            const promise = nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 50,
                workspaceRoot: root,
            });
            promise.catch(() => {}).finally(() => {
                settled = true;
            });

            // Sampled inside the window where the direct child has closed
            // (100ms) but taskkill has not (600ms). Settling here would
            // release the caller to delete a workspace that still has live
            // descendants in it. The margins either side of the 300ms sample
            // are wide enough to stay meaningful under CI load, and a
            // mistimed sample can only produce a false failure, never a pass
            // against a transport that settles early.
            await new Promise((r) => setTimeout(r, 300));
            expect(taskkillDone).toBe(false);
            expect(settled).toBe(false);

            await expect(promise).rejects.toMatchObject({ transportFailure: true as const, reason: 'timeout' });
            expect(taskkillDone).toBe(true);
        } finally {
            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('waits for taskkill when the timed-out child reports an error instead of closing (stubbed as win32 so this runs on every CI platform)', async () => {
        // A killed child can surface an 'error' rather than a 'close'; that
        // settle path owes the caller the same ordering guarantee as 'close',
        // or the wait is only as good as which event the OS happened to emit.
        const origPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        let taskkillDone = false;
        let settled = false;
        mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === '/pid') {
                const killer = fakeChild();
                killer.kill = () => {};
                setTimeout(() => {
                    taskkillDone = true;
                    killer.emit('close', 0);
                }, 600);
                return killer;
            }
            const child = fakeChild();
            child.kill = () => {};
            setTimeout(() => child.emit('error', new Error('kill failed: ESRCH')), 100);
            return child;
        });
        const root = await makeWorkspace();

        try {
            const promise = nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 50,
                workspaceRoot: root,
            });
            promise.catch(() => {}).finally(() => {
                settled = true;
            });

            await new Promise((r) => setTimeout(r, 300));
            expect(taskkillDone).toBe(false);
            expect(settled).toBe(false);

            await expect(promise).rejects.toMatchObject({ transportFailure: true as const, reason: 'timeout' });
            expect(taskkillDone).toBe(true);
        } finally {
            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('does not return from a size-breached fetch until the breach kill has finished (stubbed as win32 so this runs on every CI platform)', async () => {
        // The timeout kill and the watchdog's breach kill are separate code
        // paths with the same hazard: fetchAtCommit's caller deletes this
        // workspace as soon as it returns, so a taskkill still walking the
        // tree must be finished first, not merely issued.
        const origPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        let taskkillDone = false;
        const root = await makeWorkspace();
        await fs.writeFile(path.join(root, 'blob.bin'), 'x'.repeat(64));

        // The watchdog polls once a second, so the breach kill is issued at
        // roughly 1s. The clone child then dies at 1.5s while taskkill runs on
        // to 2.2s: the window in which an unawaited breach kill would let
        // fetchAtCommit return early.
        mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === '/pid') {
                const killer = fakeChild();
                killer.kill = () => {};
                setTimeout(() => {
                    taskkillDone = true;
                    killer.emit('close', 0);
                }, 1_200);
                return killer;
            }
            const child = fakeChild();
            // Not tied to child.kill(): taskkill succeeding here means the
            // fallback kill is never called, so a mock that only closed from
            // it would simply hang instead of testing the ordering.
            child.kill = () => {};
            setTimeout(() => child.emit('close', null), 1_500);
            return child;
        });

        try {
            await expect(nativeGitTransport.fetchAtCommit({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                refKind: 'branch',
                commitSha: SHA_A,
                timeoutMs: 30_000,
                workspaceRoot: root,
                maxBytes: 8,
            })).rejects.toMatchObject({ transportFailure: true as const, reason: 'size', maxBytes: 8 });
            // Returning before this is what would let the caller delete the
            // workspace out from under a live process tree.
            expect(taskkillDone).toBe(true);
        } finally {
            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('falls back to child.kill() when taskkill exits non-zero (stubbed as win32 so this runs on every CI platform)', async () => {
        const origPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        let fallbackKillInvoked = false;
        mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === '/pid') {
                // The taskkill child itself: report a failed kill (exit 1).
                const killer = fakeChild();
                killer.kill = () => {};
                queueMicrotask(() => killer.emit('close', 1));
                return killer;
            }
            const child = fakeChild();
            const originalKill = child.kill;
            child.kill = () => {
                fallbackKillInvoked = true;
                originalKill();
            };
            return child;
        });
        const root = await makeWorkspace();

        try {
            await expect(nativeGitTransport.resolveRef({
                repoUrl: 'https://github.com/example/repo.git',
                ref: 'main',
                timeoutMs: 50,
                workspaceRoot: root,
            })).rejects.toMatchObject({ transportFailure: true as const, reason: 'timeout' });
            expect(fallbackKillInvoked).toBe(true);
        } finally {
            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
            mockSpawn.mockReset();
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
