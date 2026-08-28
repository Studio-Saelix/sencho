import { spawn, type ChildProcess } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { ensureGitBinary, getGitExecPath } from './gitBinary';
import {
    CREDENTIAL_HELPER_CONFIG_VALUE,
    GIT_HELPER_PATH_ENV_VAR,
    GIT_TOKEN_ENV_VAR,
    writeCredentialHelper,
} from './credentialHelper';
import { isTransportFailure, type TransportFailure } from './errors';
import type { FetchRequest, FetchResult, GitTransport, ResolveRequest, ResolveResult } from './types';

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
 *
 * Resolves when the kill OPERATION is finished, which on Windows means
 * taskkill has itself exited. That matters because taskkill walks the tree in
 * a separate process: the direct git child can close while taskkill is still
 * terminating its descendants, so a caller that settled on the child's close
 * alone could start deleting the workspace out from under processes that are
 * still running in it. On POSIX the group signal is delivered synchronously,
 * so there is nothing further to await.
 *
 * Never rejects: a kill that cannot be confirmed is reported through the
 * fallback warning, and the caller's own confirmation timeout bounds the wait.
 */
function killTree(child: ChildProcess | undefined): Promise<void> {
    if (!child?.pid) return Promise.resolve();
    if (process.platform === 'win32') {
        return new Promise<void>((resolve) => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            // 'error' and 'close' can both fire for one spawn attempt; only the
            // first should trigger the fallback so a single kill never falls back
            // (or logs) twice.
            let finished = false;
            const finish = (why?: string) => {
                if (finished) return;
                finished = true;
                if (why) {
                    console.warn(`[GitSource:transport] taskkill ${why} for pid ${child.pid}; falling back to child.kill() (tree-kill guarantee no longer holds: descendants of ${child.pid} may still be running)`);
                    // This runs in an event callback, where a throw would be an
                    // uncaught exception rather than a rejection of this promise.
                    try {
                        child.kill();
                    } catch (e) {
                        console.warn(`[GitSource:transport] fallback kill for pid ${child.pid} failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                resolve();
            };
            killer.on('error', (err) => finish(`failed to spawn (${err.message})`));
            killer.on('close', (code) => finish(code === 0 ? undefined : `exited ${code}`));
        });
    }
    try {
        // The child is spawned detached, so it leads its own process group.
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        try {
            child.kill('SIGKILL');
        } catch (e) {
            console.warn(`[GitSource:transport] fallback kill for pid ${child.pid} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return Promise.resolve();
}

/**
 * Await a kill that has already been issued, but never longer than
 * KILL_CONFIRM_TIMEOUT_MS. A platform kill helper that wedges must not turn
 * into a caller that hangs forever with nothing logged; past the bound we say
 * so and carry on, exactly as runGit's own confirmation timer does.
 */
async function awaitKillConfirmed(kill: Promise<void> | undefined, what: string): Promise<void> {
    if (!kill) return;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            console.warn(`[GitSource:transport] ${what} not confirmed within ${KILL_CONFIRM_TIMEOUT_MS}ms; continuing cleanup while it may still be running`);
            resolve();
        }, KILL_CONFIRM_TIMEOUT_MS);
    });
    try {
        await Promise.race([kill, bound]);
    } finally {
        clearTimeout(timer);
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
        // Resolves once the kill operation itself is done (see killTree); a
        // timed-out run must not settle before BOTH this and the child's own
        // close event.
        let killFinished: Promise<void> | undefined;
        const append = (cur: string, chunk: Buffer) => (cur.length < STDERR_CAP ? cur + chunk.toString('utf8') : cur);

        const timer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            killFinished = killTree(child);
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
        const finishSettle = (): boolean => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killConfirmTimer);
            return true;
        };

        /**
         * Reject a timed-out run, but only once the kill operation has also
         * finished. The direct child can be gone while the platform kill
         * helper (taskkill) is still walking its descendants, and settling in
         * that window releases the caller to delete a workspace those
         * descendants are still using. Both settle paths below go through
         * here; the kill-confirmation timer above still bounds the wait.
         */
        const rejectAfterKill = (err: Error): void => {
            void (killFinished ?? Promise.resolve()).then(() => {
                if (finishSettle()) reject(asTimeoutError(err));
            });
        };

        child.on('error', (err) => {
            if (settled) return;
            // 'error' can also fire after the kill has been issued (e.g. the
            // process could not be killed); preserve the timeout flag so
            // callers still classify this as a timeout rather than a bare
            // exit failure, and wait for the kill exactly as 'close' does.
            if (timedOut) {
                rejectAfterKill(err);
                return;
            }
            if (finishSettle()) reject(err);
        });
        child.on('close', (code) => {
            if (settled) return;
            if (timedOut) {
                rejectAfterKill(new Error('git timed out'));
                return;
            }
            if (finishSettle()) resolve({ stdout, stderr, exitCode: code ?? -1 });
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

function buildEnv(homeDir: string, token?: string | null, helperPath?: string | null): NodeJS.ProcessEnv {
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
    if (helperPath) {
        // The helper's location, kept out of the credential.helper config
        // value so no workspace path character can change how git's shell
        // parses it. See credentialHelper.ts.
        env[GIT_HELPER_PATH_ENV_VAR] = helperPath;
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
 * Config shared by every invocation. With no helper, credential.helper is
 * explicitly cleared so nothing from the environment can answer prompts.
 */
async function commonArgs(layout: WorkspaceLayout, helperPath: string | null): Promise<string[]> {
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
    if (helperPath !== null) {
        // A fixed value: the helper's path reaches git through the child env
        // instead of being interpolated here, so a workspace path containing
        // a space (or a quote, `$`, `;`, ...) cannot change how git's shell
        // parses it. See credentialHelper.ts for the parsing rule.
        args.push('-c', `credential.helper=${CREDENTIAL_HELPER_CONFIG_VALUE}`);
    } else {
        args.push('-c', 'credential.helper=');
    }
    return args;
}

/**
 * Everything one invocation needs: the workspace layout, the child env, and
 * the shared config argv.
 *
 * The credential handoff is assembled in exactly this one place because its
 * three parts have to agree. If the config named the helper variable but the
 * env did not export it, git would find nothing to run, fall back to an
 * anonymous fetch, and a private repo's 401 would then classify as
 * REPO_NOT_FOUND instead of AUTH_FAILED. That is a silent downgrade, so the
 * config arg is keyed off the helper actually having been written rather than
 * off the token being present.
 */
async function prepareInvocation(
    workspaceRoot: string,
    token?: string | null,
): Promise<{ layout: WorkspaceLayout; env: NodeJS.ProcessEnv; baseArgs: string[] }> {
    const layout = await prepareWorkspace(workspaceRoot);
    const helperPath = token ? await writeCredentialHelper(layout.metaDir) : null;
    const env = buildEnv(layout.homeDir, token, helperPath);
    // The same helperPath drives the env export and the config arg, so the two
    // cannot describe different worlds.
    const baseArgs = await commonArgs(layout, helperPath);
    return { layout, env, baseArgs };
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

/**
 * Ceiling on a ref name. Git itself imposes no branch-length limit worth
 * matching (`check-ref-format --branch` accepts names into the thousands, up
 * to the filesystem's own path limits), so this is Sencho's bound, not git's,
 * and the API and the transport have to agree on it: a name the route accepts
 * and stores must not be rejected later by the transport that fetches it.
 * `routes/gitSources.ts` imports this constant for exactly that reason.
 */
export const REF_MAX_LEN = 256;
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
 * exactly the injection risk this validator exists to close). The one rule
 * that is ours rather than git's is REF_MAX_LEN, shared with the route so the
 * two cannot disagree.
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

interface ResolvedRemoteRefs {
    branchSha: string | null;
    tagSha: string | null;
}

/**
 * Ask the remote where a bare ref name lives. One `ls-remote` with explicit
 * refspecs for both namespaces keeps the response tiny (a name matches at
 * most a couple of lines even on huge repos), so the stdout cap can never
 * truncate the answer we need. For an annotated tag the peeled `^{}` entry
 * carries the commit, so it wins over the raw tag-object line; a lightweight
 * tag's raw line already points at the commit.
 */
async function lsRemoteRefs(
    url: URL,
    ref: string,
    env: NodeJS.ProcessEnv,
    baseArgs: string[],
    timeoutMs: number,
    hasToken: boolean,
): Promise<ResolvedRemoteRefs> {
    let res: RunResult;
    try {
        res = await runGit(
            [...baseArgs, 'ls-remote', url.href, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
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
    const found: ResolvedRemoteRefs = { branchSha: null, tagSha: null };
    for (const line of res.stdout.split(/\r?\n/)) {
        const tabIndex = line.indexOf('\t');
        if (tabIndex === -1) continue;
        const sha = line.slice(0, tabIndex).trim();
        if (!SHA_PATTERN.test(sha)) continue;
        const full = line.slice(tabIndex + 1).trim();
        if (full === `refs/heads/${ref}`) {
            found.branchSha = sha.toLowerCase();
        } else if (full === `refs/tags/${ref}^{}`) {
            found.tagSha = sha.toLowerCase();
        } else if (full === `refs/tags/${ref}` && found.tagSha === null) {
            found.tagSha = sha.toLowerCase();
        }
    }
    return found;
}

/** Remote fetch rounds allowed after the initial shallow tip fetch. */
const MAX_FF_FETCH_ROUNDS = 14;
/** Per-round deepen step cap for exponential backoff. */
const MAX_FF_DEEPEN_STEP = 2048;

/**
 * Whether `descendantSha` is a fast-forward from `ancestorSha` on the remote.
 * Distinguishes a normal branch advance from a force-push after ls-remote has
 * already resolved the ref to a new tip.
 *
 * Fetches the descendant tip once, then deepens that shallow boundary with
 * exponentially increasing steps until the prior commit is reachable, the
 * downloaded history is complete, or a safety budget is exhausted. Operational
 * failures throw a classified TransportFailure; only a proven non-fast-forward
 * returns false.
 */
export async function verifyFastForward(req: {
    repoUrl: string;
    ancestorSha: string;
    descendantSha: string;
    token?: string | null;
    timeoutMs?: number;
    workspaceRoot: string;
    maxBytes: number;
}): Promise<boolean> {
    const ancestor = req.ancestorSha.toLowerCase();
    const descendant = req.descendantSha.toLowerCase();
    if (ancestor === descendant) return true;

    const hasToken = Boolean(req.token);
    await ensureBinaryReady(hasToken);
    const url = assertValidRepoUrl(req.repoUrl, hasToken);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const remainingMs = (): number => Math.max(1, deadline - Date.now());
    const assertTimeBudget = (): void => {
        if (Date.now() >= deadline) {
            throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
        }
    };
    const { env, baseArgs } = await prepareInvocation(req.workspaceRoot, req.token);
    const repoDir = path.join(req.workspaceRoot, 'ff-check');
    await fs.mkdir(repoDir, { recursive: true });

    let sizeExceeded = false;
    let activeChild: ChildProcess | undefined;
    let breachKill: Promise<void> | undefined;
    const watchdog = startSizeWatchdog(req.workspaceRoot, req.maxBytes, () => {
        sizeExceeded = true;
        breachKill = killTree(activeChild);
    });

    const throwIfSizeExceeded = (): void => {
        if (sizeExceeded) {
            throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: url.host, hasToken } satisfies TransportFailure;
        }
    };

    try {
        const materialize = async (args: string[]): Promise<RunResult> => {
            assertTimeBudget();
            let res: RunResult;
            try {
                res = await runGit(args, {
                    cwd: repoDir,
                    env,
                    timeoutMs: remainingMs(),
                    onSpawn: (child) => { activeChild = child; },
                });
            } catch (e) {
                throwIfSizeExceeded();
                if (isTimeoutError(e)) {
                    throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
                }
                throw { transportFailure: true as const, reason: 'exit', stderr: e instanceof Error ? e.message : String(e), argv: args, host: url.host, hasToken } satisfies TransportFailure;
            }
            throwIfSizeExceeded();
            if (res.exitCode !== 0) {
                throw { transportFailure: true as const, reason: 'exit', stderr: res.stderr, exitCode: res.exitCode, argv: args, host: url.host, hasToken } satisfies TransportFailure;
            }
            return res;
        };

        const probeFailure = (res: RunResult, argv: string[]): never => {
            throw {
                transportFailure: true as const,
                reason: 'exit',
                stderr: res.stderr,
                exitCode: res.exitCode,
                argv,
                host: url.host,
                hasToken,
            } satisfies TransportFailure;
        };

        const runProbe = async (args: string[]): Promise<RunResult> => {
            assertTimeBudget();
            try {
                const res = await runGit(args, {
                    cwd: repoDir,
                    env,
                    timeoutMs: Math.min(remainingMs(), LS_REMOTE_MAX_MS),
                });
                throwIfSizeExceeded();
                return res;
            } catch (e) {
                throwIfSizeExceeded();
                if (isTimeoutError(e)) {
                    throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
                }
                throw {
                    transportFailure: true as const,
                    reason: 'exit',
                    stderr: e instanceof Error ? e.message : String(e),
                    argv: args,
                    host: url.host,
                    hasToken,
                } satisfies TransportFailure;
            }
        };

        const isMissingObjectProbe = (res: RunResult): boolean => {
            if (res.exitCode === 0) return false;
            if (res.exitCode === 1) return true;
            const err = res.stderr.toLowerCase();
            return err.includes('not a valid object name')
                || err.includes('bad object')
                || err.includes('could not get');
        };

        await materialize([...baseArgs, 'init']);
        await materialize([...baseArgs, 'fetch', '--depth=1', url.href, descendant]);

        const countReachable = async (): Promise<number> => {
            const argv = [...baseArgs, 'rev-list', '--count', descendant];
            const listed = await runProbe(argv);
            if (listed.exitCode !== 0) {
                return probeFailure(listed, argv);
            }
            const parsed = Number.parseInt(listed.stdout.trim(), 10);
            if (!Number.isFinite(parsed) || parsed < 0) {
                throw {
                    transportFailure: true as const,
                    reason: 'exit',
                    stderr: `unexpected rev-list output: ${listed.stdout}`,
                    exitCode: listed.exitCode,
                    argv,
                    host: url.host,
                    hasToken,
                } satisfies TransportFailure;
            }
            return parsed;
        };

        const isShallowRepository = async (): Promise<boolean> => {
            const argv = [...baseArgs, 'rev-parse', '--is-shallow-repository'];
            const shallow = await runProbe(argv);
            if (shallow.exitCode !== 0) {
                return probeFailure(shallow, argv);
            }
            const flag = shallow.stdout.trim();
            if (flag === 'true') return true;
            if (flag === 'false') return false;
            throw {
                transportFailure: true as const,
                reason: 'exit',
                stderr: `unexpected shallow-repository output: ${shallow.stdout}`,
                exitCode: shallow.exitCode,
                argv,
                host: url.host,
                hasToken,
            } satisfies TransportFailure;
        };

        const isProvenAncestor = async (): Promise<boolean> => {
            const argv = [...baseArgs, 'merge-base', '--is-ancestor', ancestor, descendant];
            const ancestry = await runProbe(argv);
            if (ancestry.exitCode === 0) return true;
            if (ancestry.exitCode === 1) return false;
            return probeFailure(ancestry, argv);
        };

        let reachableCount = await countReachable();
        let fetchRounds = 1;
        let deepenStep = 1;

        const assertWithinSizeBudget = async (): Promise<void> => {
            const finalSize = await treeSize(req.workspaceRoot).catch((e: unknown) => {
                console.warn(`[GitSource:transport] final size measurement failed for ${req.workspaceRoot}, failing closed: ${e instanceof Error ? e.message : String(e)}`);
                return -1;
            });
            if (sizeExceeded || finalSize < 0 || finalSize > req.maxBytes) {
                throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: url.host, hasToken } satisfies TransportFailure;
            }
        };

        while (true) {
            assertTimeBudget();

            const ancestorArgv = [...baseArgs, 'cat-file', '-e', `${ancestor}^{commit}`];
            const hasAncestor = await runProbe(ancestorArgv);
            if (hasAncestor.exitCode === 0) {
                await assertWithinSizeBudget();
                return await isProvenAncestor();
            }
            if (!isMissingObjectProbe(hasAncestor)) {
                return probeFailure(hasAncestor, ancestorArgv);
            }

            if (!(await isShallowRepository())) {
                await assertWithinSizeBudget();
                return false;
            }

            if (fetchRounds >= MAX_FF_FETCH_ROUNDS) {
                throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
            }

            const previousCount = reachableCount;
            await materialize([...baseArgs, 'fetch', `--deepen=${deepenStep}`, url.href, descendant]);
            fetchRounds += 1;
            reachableCount = await countReachable();

            if (reachableCount <= previousCount) {
                if (!(await isShallowRepository())) {
                    await assertWithinSizeBudget();
                    return false;
                }
                throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
            }

            deepenStep = Math.min(deepenStep * 2, MAX_FF_DEEPEN_STEP);
        }
    } finally {
        watchdog.stop();
        await awaitKillConfirmed(breachKill, `size-breach kill for ${url.host}`);
        await fs.rm(repoDir, { recursive: true, force: true }).catch((e: unknown) => {
            console.warn(`[GitSource:transport] failed to remove fast-forward scratch repo ${repoDir}: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
}

export const nativeGitTransport: GitTransport = {
    async resolveRef(req: ResolveRequest): Promise<ResolveResult> {
        const hasToken = Boolean(req.token);
        await ensureBinaryReady(hasToken);
        const url = assertValidRepoUrl(req.repoUrl, hasToken);

        if (SHA_PATTERN.test(req.ref)) {
            // A full SHA is self-resolving: the immutable identity IS the
            // value, so there is nothing to look up. Reachability is verified
            // at fetch, where the host either serves the object or refuses it
            // (classified as UNSUPPORTED_REF).
            return { commitSha: req.ref.toLowerCase(), kind: 'sha' };
        }

        assertValidRef(req.ref, url.host, hasToken);
        const { env, baseArgs } = await prepareInvocation(req.workspaceRoot, req.token);
        const found = await lsRemoteRefs(
            url, req.ref, env, baseArgs,
            req.timeoutMs ?? DEFAULT_TIMEOUT_MS, hasToken,
        );
        if (found.branchSha) return { commitSha: found.branchSha, kind: 'branch' };
        if (found.tagSha) return { commitSha: found.tagSha, kind: 'tag' };
        throw { transportFailure: true as const, reason: 'ref-not-found', host: url.host, hasToken } satisfies TransportFailure;
    },

    async fetchAtCommit(req: FetchRequest): Promise<FetchResult> {
        const hasToken = Boolean(req.token);
        await ensureBinaryReady(hasToken);
        const url = assertValidRepoUrl(req.repoUrl, hasToken);
        assertValidRef(req.ref, url.host, hasToken);

        const { layout, env, baseArgs } = await prepareInvocation(req.workspaceRoot, req.token);
        const checkout = path.join(req.workspaceRoot, 'repo');
        const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // Shared between the watchdog breach flag and the active child handle:
        // whichever fires first tears the clone down; the other becomes a no-op.
        let sizeExceeded = false;
        let activeChild: ChildProcess | undefined;
        // A breach kill is subject to the same ordering hazard as a timeout
        // kill: the caller deletes this workspace as soon as we return, so the
        // kill has to be finished first, not merely issued.
        let breachKill: Promise<void> | undefined;
        const watchdog = startSizeWatchdog(req.workspaceRoot, req.maxBytes, () => {
            sizeExceeded = true;
            breachKill = killTree(activeChild);
        });

        try {
            // Run each materialization step through one failure mapper. A size
            // breach wins over the timeout wording: both kills are ours, but
            // the operator guidance differs. runGit resolves on any exit code,
            // so a non-zero exit is classified here by its real stderr rather
            // than leaking a generic GIT_ERROR upstream.
            const materialize = async (args: string[]): Promise<RunResult> => {
                let res: RunResult;
                try {
                    res = await runGit(args, {
                        cwd: layout.homeDir, env, timeoutMs,
                        onSpawn: (child) => { activeChild = child; },
                    });
                } catch (e) {
                    // A size breach wins over the timeout wording.
                    if (sizeExceeded) {
                        throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: url.host, hasToken } satisfies TransportFailure;
                    }
                    if (isTimeoutError(e)) {
                        throw { transportFailure: true as const, reason: 'timeout', host: url.host, hasToken } satisfies TransportFailure;
                    }
                    throw { transportFailure: true as const, reason: 'exit', stderr: e instanceof Error ? e.message : String(e), argv: args, host: url.host, hasToken } satisfies TransportFailure;
                }
                // A watchdog-triggered SIGKILL settles runGit's promise via the
                // child's normal 'close' event (code null -> exitCode -1), not
                // a rejection, so this is the common path for an in-flight
                // breach and must check sizeExceeded before the generic mapping.
                if (sizeExceeded) {
                    throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: url.host, hasToken } satisfies TransportFailure;
                }
                if (res.exitCode !== 0) {
                    throw { transportFailure: true as const, reason: 'exit', stderr: res.stderr, exitCode: res.exitCode, argv: args, host: url.host, hasToken } satisfies TransportFailure;
                }
                return res;
            };

            if (req.refKind === 'sha') {
                // `--branch` cannot take a bare SHA, so a pinned commit uses a
                // third strategy: init a repo, fetch exactly that object, and
                // check it out detached. The host must allow fetching a direct
                // SHA (GitHub does by default); a refusal surfaces as a
                // non-zero `git fetch` here and classifies as UNSUPPORTED_REF.
                await materialize([...baseArgs, 'init', checkout]);
                await materialize([...baseArgs, '-C', checkout, 'fetch', '--depth=1', url.href, req.ref]);
                await materialize([...baseArgs, '-C', checkout, 'checkout', '--detach', req.ref]);
            } else {
                // A bare name works for both branches and tags: `--branch`
                // detaches at the named ref's commit either way, and passing a
                // fully-qualified `refs/tags/<ref>` is rejected by git
                // (`Remote branch ... not found`). The resolved kind is
                // already pinned by ls-remote, and the rev-parse HEAD
                // verification below confirms the checkout matched it.
                const branchArg = req.ref;
                await materialize([
                    ...baseArgs, 'clone',
                    '--depth=1', '--single-branch', '--no-tags', '--no-recurse-submodules',
                    '--branch', branchArg, url.href, checkout,
                ]);
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
            await awaitKillConfirmed(breachKill, `size-breach kill for ${url.host}`);
        }
    },
};
