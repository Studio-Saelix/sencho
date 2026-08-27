import { spawn, type ChildProcess } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { ensureGitBinary, getGitExecPath } from './gitBinary';
import { GIT_TOKEN_ENV_VAR, writeCredentialHelper } from './credentialHelper';
import { isTransportFailure, type TransportFailure } from './errors';
import type { FetchRequest, FetchResult, GitTransport, ResolveRequest } from './types';

/**
 * Native git transport: every Git operation is an `execFile`-style spawn of
 * the real git CLI with an argv array (never a shell), a hardened
 * environment, and per-invocation config flags.
 *
 * Hardening applied to every invocation:
 * - `GIT_CONFIG_NOSYSTEM=1` plus an isolated empty HOME/USERPROFILE so the
 *   operator's ~/.gitconfig (credential helpers, insteadOf rewrites, hooks)
 *   cannot influence fetches.
 * - `protocol.allow=never` with only https re-enabled: no file://, git://,
 *   ext::, or ssh:// this early in the program.
 * - `core.hooksPath` pointed at an empty directory we own, so repository
 *   scripts can never run. (A literal /dev/null works on Linux but not
 *   Windows; an empty dir is portable.)
 * - `GIT_TERMINAL_PROMPT=0` and a neutralized GIT_ASKPASS so a missing or
 *   wrong credential fails fast instead of hanging on a prompt.
 * - Every remaining git-config channel is pinned empty (GIT_CONFIG_GLOBAL /
 *   GIT_CONFIG_SYSTEM to the null device, XDG_CONFIG_HOME cleared,
 *   GIT_CONFIG_COUNT zeroed) and inherited GIT_TRACE is cleared so packet
 *   dumps cannot carry URL material.
 * - The token reaches git ONLY through the credential helper reading
 *   SENCHO_GIT_TOKEN from the child env; it never appears in argv or URLs.
 *
 * Dev/E2E certificate bridge: when NODE_EXTRA_CA_CERTS is set (the existing
 * dev/CI wiring for the e2e TLS fixture server), its CAs are combined with
 * platform defaults into <workspace>/.meta/combined-ca.pem and passed as
 * http.sslCAInfo, mirroring Node's add-not-replace semantics. Without the
 * variable, POSIX passes nothing (OpenSSL uses system trust) and Windows
 * pins Git's own bundled bundle (see detectWindowsCABundle).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const LS_REMOTE_MAX_MS = 10_000;
const STDERR_CAP = 16_384;
const WATCHDOG_INTERVAL_MS = 1_000;
const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

interface RunOptions {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onSpawn?: (child: ChildProcess) => void;
}

function isTimeoutError(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as { gitTimedOut?: unknown }).gitTimedOut === true;
}

/** Flag an error as a git timeout so `isTimeoutError` recognises it downstream. */
function asTimeoutError<T extends Error>(err: T): T {
    return Object.assign(err, { gitTimedOut: true });
}

/**
 * Kill the whole child tree. POSIX uses the process group; Windows taskkill.
 * Does not itself confirm termination: the caller learns that from the
 * child's own `close` event, which fires whether the process died from this
 * kill, a prior natural exit, or (via the fallback below) a second kill
 * attempt.
 */
function killTree(child: ChildProcess | undefined): void {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        // 'error' and 'close' can both fire for one spawn attempt; only the
        // first should trigger the fallback so a single kill never falls back
        // (or logs) twice.
        let fellBack = false;
        const fallBack = (why: string) => {
            if (fellBack) return;
            fellBack = true;
            console.warn(`[GitSource:transport] taskkill ${why} for pid ${child.pid}; falling back to child.kill() (tree-kill guarantee no longer holds: descendants of ${child.pid} may still be running)`);
            child.kill();
        };
        killer.on('error', (err) => fallBack(`failed to spawn (${err.message})`));
        killer.on('close', (code) => {
            if (code !== 0) fallBack(`exited ${code}`);
        });
        return;
    }
    try {
        // The child is spawned detached, so it leads its own process group.
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
}

/** Bound on how long to wait for a confirmed close after a kill is issued, so a kill that never reports back cannot hang the caller forever. */
const KILL_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Spawn git and collect output. On timeout, kills the entire child tree and
 * waits for its `close` event before rejecting: settling as soon as the kill
 * is merely issued (rather than confirmed) would let the caller start
 * cleaning up the workspace while the child tree, or the platform kill
 * helper (taskkill), is still running. Resolves with whatever exit code git
 * reported when it closes on its own.
 */
function runGit(args: string[], opts: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let killConfirmTimer: NodeJS.Timeout | undefined;
        const append = (cur: string, chunk: Buffer) => (cur.length < STDERR_CAP ? cur + chunk.toString('utf8') : cur);

        const timer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            killTree(child);
            killConfirmTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                console.error(`[GitSource:transport] kill not confirmed within ${KILL_CONFIRM_TIMEOUT_MS}ms for pid ${child.pid}; the process may still be running`);
                reject(asTimeoutError(new Error('git timed out (kill unconfirmed)')));
            }, KILL_CONFIRM_TIMEOUT_MS);
        }, opts.timeoutMs);

        child.stdout?.on('data', (c: Buffer) => {
            stdout = append(stdout, c);
        });
        child.stderr?.on('data', (c: Buffer) => {
            stderr = append(stderr, c);
        });
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killConfirmTimer);
            // 'error' can also fire after the kill has been issued (e.g. the
            // process could not be killed); preserve the timeout flag so
            // callers still classify this as a timeout rather than a bare
            // exit failure.
            reject(timedOut ? asTimeoutError(err) : err);
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killConfirmTimer);
            if (timedOut) {
                reject(asTimeoutError(new Error('git timed out')));
            } else {
                resolve({ stdout, stderr, exitCode: code ?? -1 });
            }
        });

        opts.onSpawn?.(child);
    });
}

// ─── Workspace layout ────────────────────────────────────────────────────────

interface WorkspaceLayout {
    /** Scratch dir for transport-owned files (credential helper script, combined CA bundle, isolated HOME). */
    metaDir: string;
    hooksDir: string;
    homeDir: string;
}

async function prepareWorkspace(root: string): Promise<WorkspaceLayout> {
    const metaDir = path.join(root, '.meta');
    const hooksDir = path.join(metaDir, 'hooks');
    const homeDir = path.join(metaDir, 'home');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    return { metaDir, hooksDir, homeDir };
}

function buildEnv(homeDir: string, token?: string | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        // GIT_CONFIG_NOSYSTEM does not block explicit config-file pointers or
        // XDG lookups; pin every channel git could read operator config from.
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        XDG_CONFIG_HOME: '',
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        // An inherited trace flag would widen the log surface with packet
        // dumps that can carry URL material.
        GIT_TRACE: '',
        HOME: homeDir,
    };
    if (process.platform === 'win32') {
        env.USERPROFILE = homeDir;
    }
    if (token) {
        env[GIT_TOKEN_ENV_VAR] = token;
    }
    return env;
}

/**
 * Windows-only: locate the CA bundle bundled with Git for Windows. Stripping
 * system gitconfig (GIT_CONFIG_NOSYSTEM) also strips the installer's
 * http.sslCAInfo pointer to this file, and unlike Linux there is no /etc/ssl
 * default for the OpenSSL backend to fall back on.
 */
async function detectWindowsCABundle(): Promise<string | null> {
    try {
        const execPath = await getGitExecPath();
        const installRoot = path.resolve(execPath, '..', '..'); // <install>/mingw64/libexec/git-core -> <install>/mingw64
        const candidates = [
            path.join(installRoot, 'etc', 'ssl', 'certs', 'ca-bundle.crt'),
            path.resolve(execPath, '..', '..', '..', 'usr', 'ssl', 'certs', 'ca-bundle.crt'),
        ];
        for (const candidate of candidates) {
            if (existsSync(candidate)) return candidate.split(path.sep).join('/');
        }
    } catch {
        // Fall through: without a bundle the fetch fails with a clear TLS
        // classification instead of a silent trust downgrade.
    }
    return null;
}

/** First existing system CA bundle for OpenSSL-backed git on POSIX. */
const POSIX_CA_BUNDLE_CANDIDATES = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
];

/**
 * Build the CA-anchor configuration for one fetch.
 *
 * Mirrors Node's own NODE_EXTRA_CA_CERTS semantics (extra anchors ADDED to
 * the defaults, never replacing them) by writing a combined PEM bundle into
 * the fetch workspace's `.meta` dir:
 * - No NODE_EXTRA_CA_CERTS: production posture. POSIX passes nothing and
 *   lets OpenSSL use system trust; Windows pins Git's own bundled bundle,
 *   because stripping system gitconfig also strips the installer's pointer
 *   to it.
 * - With NODE_EXTRA_CA_CERTS: defaults PLUS the extra CAs, so the dev/E2E
 *   fixture server and public hosts validate in the same process state.
 */
async function resolveCaArgs(layout: WorkspaceLayout): Promise<string[]> {
    const extraPath = process.env.NODE_EXTRA_CA_CERTS;
    const hasExtra = Boolean(extraPath && existsSync(extraPath));
    const isWindows = process.platform === 'win32';

    if (!hasExtra && !isWindows) {
        return [];
    }

    if (isWindows && !hasExtra) {
        // Windows without an override: anchor to Git's bundled bundle directly.
        const bundle = await detectWindowsCABundle();
        return bundle ? ['-c', `http.sslCAInfo=${bundle}`] : [];
    }

    let defaultPem = '';
    let winBundle: string | null = null;
    if (isWindows) {
        winBundle = await detectWindowsCABundle();
        if (winBundle) {
            try {
                defaultPem = await fs.readFile(winBundle.replace(/\//g, path.sep), 'utf8');
            } catch {
                console.warn(`[GitSource:transport] could not read system CA bundle at ${winBundle}; combined anchors will contain only NODE_EXTRA_CA_CERTS entries.`);
            }
        }
    } else {
        for (const candidate of POSIX_CA_BUNDLE_CANDIDATES) {
            if (!existsSync(candidate)) continue;
            try {
                defaultPem = await fs.readFile(candidate, 'utf8');
                break;
            } catch {
                // Try the next candidate.
            }
        }
        if (!defaultPem) {
            console.warn('[GitSource:transport] no readable system CA bundle found; combined anchors will contain only NODE_EXTRA_CA_CERTS entries.');
        }
    }

    let extraPem = '';
    try {
        extraPem = await fs.readFile(extraPath as string, 'utf8');
    } catch {
        console.warn('[GitSource:transport] could not read the file configured via NODE_EXTRA_CA_CERTS; ignoring custom anchors.');
        // Windows still has working defaults; fall back to them instead of
        // dropping every anchor.
        return isWindows && winBundle ? ['-c', `http.sslCAInfo=${winBundle}`] : [];
    }
    const combinedPath = path.join(layout.metaDir, 'combined-ca.pem');
    await fs.writeFile(combinedPath, `${defaultPem}\n${extraPem}`, { mode: 0o600 });
    return ['-c', `http.sslCAInfo=${combinedPath.split(path.sep).join('/')}`];
}

/**
 * Config shared by every invocation. With no token, credential.helper is
 * explicitly cleared so nothing from the environment can answer prompts.
 */
async function commonArgs(layout: WorkspaceLayout, token?: string | null): Promise<string[]> {
    const args = [
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        '-c', `core.hooksPath=${layout.hooksDir.split(path.sep).join('/')}`,
    ];
    if (process.platform === 'win32') {
        // With every config channel neutralized above, git falls back to its
        // build-default TLS backend, which on Git for Windows can be
        // schannel. Schannel ignores http.sslCAInfo (breaking the dev/E2E CA
        // bridge) and trusts per-Windows-cert-store state, so pin the
        // OpenSSL backend that ships with Git for Windows. Production Alpine
        // git is OpenSSL-backed and unaffected by this flag's absence.
        args.push('-c', 'http.sslBackend=openssl');
    }
    args.push(...await resolveCaArgs(layout));
    if (token) {
        const helperPath = await writeCredentialHelper(layout.metaDir);
        // Verbatim, no wrapping quotes: per gitcredentials(7) a helper string
        // counts as an absolute-path command only if it literally begins with
        // an absolute path. Unlike a gitconfig file value, `-c key=value` on
        // argv keeps the quotes, so quoting makes the value start with `"`
        // and git silently degrades to the short-name form
        // (`git credential-"<path>"`), which does not exist. Residual risk: a
        // workspace root containing a space still word-splits, as it would
        // for any unquoted absolute-path helper.
        args.push('-c', `credential.helper=${helperPath}`);
    } else {
        args.push('-c', 'credential.helper=');
    }
    return args;
}

// ─── Input validation ────────────────────────────────────────────────────────

function invalidUrl(host: string, hasToken: boolean): TransportFailure {
    return { transportFailure: true as const, reason: 'invalid-url', host, hasToken };
}

function assertValidRepoUrl(repoUrl: string, hasToken: boolean): URL {
    let url: URL;
    try {
        url = new URL(repoUrl);
    } catch {
        throw invalidUrl('unknown', hasToken);
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
        throw invalidUrl(url.host || 'unknown', hasToken);
    }
    return url;
}

const REF_MAX_LEN = 200;
// ASCII control characters, space, and the characters git's own
// check-ref-format forbids anywhere in a ref (~^:?*[\). Everything else,
// including non-ASCII scripts, is a legitimate branch-name character.
const REF_DISALLOWED_CHARS = /[\x00-\x20\x7f~^:?*[\\]/;

/**
 * Validates a ref name against the rules `git check-ref-format --branch`
 * applies to a branch: no control characters, space, or `~^:?*[\`; no `..`
 * or `@{`; no path component starting with `.` or ending in `.lock`; no
 * leading `-` (git's own `--branch` mode already refuses this, since a
 * leading dash makes the name ambiguous with a flag on argv, which is
 * exactly the injection risk this validator exists to close).
 */
function assertValidRef(ref: string, host: string, hasToken: boolean): void {
    const segments = ref.split('/');
    const valid = ref.length > 0
        && ref.length <= REF_MAX_LEN
        && !ref.startsWith('-')
        && !REF_DISALLOWED_CHARS.test(ref)
        && !ref.includes('..')
        && !ref.includes('@{')
        && !ref.endsWith('.')
        && segments.every((seg) => seg.length > 0 && !seg.startsWith('.') && !seg.endsWith('.lock'));
    if (!valid) {
        throw { transportFailure: true as const, reason: 'invalid-ref', host, hasToken } satisfies TransportFailure;
    }
}

// ─── Size watchdog ───────────────────────────────────────────────────────────

async function treeSize(root: string): Promise<number> {
    let total = 0;
    const stack: string[] = [root];
    while (stack.length) {
        const dir = stack.pop();
        if (!dir) break;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(p);
            } else if (entry.isFile()) {
                total += (await fs.stat(p)).size;
            }
            // Symlinks are neither followed nor counted; clones made here do
            // not create them and counting targets could inflate the sum.
        }
    }
    return total;
}

interface Watchdog {
    stop(): void;
}

/**
 * Polls the workspace's on-disk size and fires `onBreach` once it exceeds
 * `maxBytes`. Exported for tests.
 */
export function startSizeWatchdog(
    root: string,
    maxBytes: number,
    onBreach: () => void,
): Watchdog {
    let stopped = false;
    let busy = false;
    let readFailures = 0;
    const timer = setInterval(() => {
        if (stopped || busy) return;
        busy = true;
        void treeSize(root)
            .then((size) => {
                readFailures = 0;
                if (!stopped && size > maxBytes) {
                    stopped = true;
                    clearInterval(timer);
                    onBreach();
                }
            })
            .catch(() => {
                // Benign right after teardown (ENOENT mid-walk), but a
                // persistent inability to measure the workspace silently
                // disables the documented cap; say so once per streak.
                readFailures += 1;
                if (!stopped && readFailures === 3) {
                    console.warn('[GitSource:transport] could not stat clone workspace; GITSOURCE_MAX_CLONE_BYTES enforcement is degraded for this fetch.');
                }
            })
            .finally(() => {
                busy = false;
            });
    }, WATCHDOG_INTERVAL_MS);
    return {
        stop(): void {
            stopped = true;
            clearInterval(timer);
        },
    };
}

// ─── Transport implementation ────────────────────────────────────────────────

async function ensureBinaryReady(hasToken: boolean): Promise<void> {
    try {
        await ensureGitBinary();
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const stale = /too old/.test(message);
        throw { transportFailure: true as const, reason: stale ? 'git-old' : 'git-missing', stderr: message, host: 'unknown', hasToken } satisfies TransportFailure;
    }
}

function parseLsRemoteLine(line: string, fullRef: string): string | null {
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) return null;
    if (line.slice(tabIndex + 1).trim() !== fullRef) return null;
    const sha = line.slice(0, tabIndex).trim();
    return SHA_PATTERN.test(sha) ? sha.toLowerCase() : null;
}

async function lsRemoteHead(
    url: URL,
    ref: string,
    env: NodeJS.ProcessEnv,
    baseArgs: string[],
    timeoutMs: number,
    hasToken: boolean,
): Promise<string> {
    let res: RunResult;
    try {
        res = await runGit(
            [...baseArgs, 'ls-remote', '--heads', url.href, `refs/heads/${ref}`],
            { env, timeoutMs: Math.min(timeoutMs, LS_REMOTE_MAX_MS) },
        );
    } catch (e) {
        // A resolution-phase timeout must classify like any other network
        // timeout, not leak the internal flagged error to callers.
        if (isTimeoutError(e)) {
            throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
        }
        throw e;
    }
    if (res.exitCode !== 0) {
        throw { transportFailure: true as const, reason: 'exit', stderr: res.stderr, exitCode: res.exitCode, argv: baseArgs, host: url.host, hasToken } satisfies TransportFailure;
    }
    const fullRef = `refs/heads/${ref}`;
    for (const line of res.stdout.split(/\r?\n/)) {
        const sha = parseLsRemoteLine(line, fullRef);
        if (sha) return sha;
    }
    throw { transportFailure: true as const, reason: 'ref-not-found', host: url.host, hasToken } satisfies TransportFailure;
}

export const nativeGitTransport: GitTransport = {
    async resolveRef(req: ResolveRequest): Promise<{ commitSha: string }> {
        const hasToken = Boolean(req.token);
        await ensureBinaryReady(hasToken);
        const url = assertValidRepoUrl(req.repoUrl, hasToken);
        assertValidRef(req.ref, url.host, hasToken);

        const layout = await prepareWorkspace(req.workspaceRoot);
        const env = buildEnv(layout.homeDir, req.token);
        const baseArgs = await commonArgs(layout, req.token);
        const commitSha = await lsRemoteHead(
            url, req.ref, env, baseArgs,
            req.timeoutMs ?? DEFAULT_TIMEOUT_MS, hasToken,
        );
        return { commitSha };
    },

    async fetchAtCommit(req: FetchRequest): Promise<FetchResult> {
        const hasToken = Boolean(req.token);
        await ensureBinaryReady(hasToken);
        const url = assertValidRepoUrl(req.repoUrl, hasToken);
        assertValidRef(req.ref, url.host, hasToken);

        const layout = await prepareWorkspace(req.workspaceRoot);
        const env = buildEnv(layout.homeDir, req.token);
        const baseArgs = await commonArgs(layout, req.token);
        const checkout = path.join(req.workspaceRoot, 'repo');
        const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // Shared between the watchdog breach flag and the active child handle:
        // whichever fires first tears the clone down; the other becomes a no-op.
        let sizeExceeded = false;
        let activeChild: ChildProcess | undefined;
        const watchdog = startSizeWatchdog(req.workspaceRoot, req.maxBytes, () => {
            sizeExceeded = true;
            killTree(activeChild);
        });

        try {
            let cloneResult: RunResult;
            try {
                cloneResult = await runGit(
                    [
                        ...baseArgs, 'clone',
                        '--depth=1', '--single-branch', '--no-tags', '--no-recurse-submodules',
                        '--branch', req.ref, url.href, checkout,
                    ],
                    { cwd: layout.homeDir, env, timeoutMs, onSpawn: (child) => { activeChild = child; } },
                );
            } catch (e) {
                // A size breach wins over the timeout wording: both kills are
                // ours, but the operator guidance differs.
                if (sizeExceeded) {
                    throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: url.host, hasToken } satisfies TransportFailure;
                }
                if (isTimeoutError(e)) {
                    throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
                }
                throw { transportFailure: true as const, reason: 'exit', stderr: e instanceof Error ? e.message : String(e), argv: [...baseArgs, 'clone'], host: url.host, hasToken } satisfies TransportFailure;
            }

            // A watchdog-triggered SIGKILL settles runGit's promise via the
            // child's normal 'close' event (code null -> exitCode -1), not a
            // rejection, so this branch is the common path for an in-flight
            // breach and must check sizeExceeded before the generic mapping.
            if (sizeExceeded) {
                throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: url.host, hasToken } satisfies TransportFailure;
            }

            // runGit resolves on any exit code: a failed clone (auth, missing
            // repo, TLS) must classify by its real stderr here rather than
            // fall through to rev-parse and surface as a generic GIT_ERROR.
            if (cloneResult.exitCode !== 0) {
                throw {
                    transportFailure: true as const,
                    reason: 'exit',
                    stderr: cloneResult.stderr,
                    exitCode: cloneResult.exitCode,
                    argv: [...baseArgs, 'clone'],
                    host: url.host,
                    hasToken,
                } satisfies TransportFailure;
            }

            let actual: string;
            try {
                const head = await runGit([...baseArgs, 'rev-parse', 'HEAD'], {
                    cwd: checkout,
                    env,
                    timeoutMs: Math.min(timeoutMs, LS_REMOTE_MAX_MS),
                });
                actual = head.stdout.trim().toLowerCase();
                if (!SHA_PATTERN.test(actual)) {
                    throw { transportFailure: true as const, reason: 'exit', stderr: `unexpected rev-parse output: ${head.stdout}`, exitCode: head.exitCode, host: url.host, hasToken } satisfies TransportFailure;
                }
            } catch (e) {
                if (isTransportFailure(e)) throw e;
                if (isTimeoutError(e)) {
                    throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
                }
                throw { transportFailure: true as const, reason: 'exit', stderr: e instanceof Error ? e.message : String(e), host: url.host, hasToken } satisfies TransportFailure;
            }

            if (actual !== req.commitSha.toLowerCase()) {
                // The branch tip moved between resolution and fetch. Refuse
                // rather than materialize content nobody reviewed.
                throw { transportFailure: true as const, reason: 'tip-changed', host: url.host, hasToken } satisfies TransportFailure;
            }

            // Deterministic final measure: a breach landing between the last
            // watchdog tick and successful verification must not slip through
            // as an over-cap success. A read failure here (permissions,
            // workspace removed mid-walk) must fail closed rather than treat
            // an unmeasurable workspace as within budget.
            const finalSize = await treeSize(req.workspaceRoot).catch((e: unknown) => {
                console.warn(`[GitSource:transport] final size measurement failed for ${req.workspaceRoot}, failing closed: ${e instanceof Error ? e.message : String(e)}`);
                return -1;
            });
            if (sizeExceeded || finalSize < 0 || finalSize > req.maxBytes) {
                throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: url.host, hasToken } satisfies TransportFailure;
            }

            return { commitSha: actual, dir: checkout };
        } finally {
            watchdog.stop();
        }
    },
};
